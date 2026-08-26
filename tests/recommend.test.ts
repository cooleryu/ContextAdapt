import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseRecommendationInput,
  recommendContext,
  renderRecommendation,
} from "../packages/core/src/index.js";

function recommendationInput(): Record<string, unknown> {
  return {
    schema_version: "contextadapt.recommendation-input.v1",
    task_id: "deploy-production-timeout",
    required_evidence: [
      {
        evidence_id: "tool-460",
        kind: "observation",
        description: "Verified production config state",
      },
      {
        evidence_id: "policy-461",
        kind: "permission",
        description: "Production config is not protected",
      },
      {
        evidence_id: "user-482",
        kind: "correction",
        description: "Latest production target and timeout",
      },
    ],
    tiers: [
      {
        tier: "200K",
        estimated_input_tokens: 197800,
        available_evidence: ["tool-460"],
        stale_evidence: [],
        unauthorized_evidence: [],
        unresolved_contradictions: [],
      },
      {
        tier: "400K",
        estimated_input_tokens: 393700,
        available_evidence: ["tool-460", "policy-461", "user-482"],
        stale_evidence: [],
        unauthorized_evidence: [],
        unresolved_contradictions: [],
      },
      {
        tier: "1M_WINDOW",
        estimated_input_tokens: 883300,
        available_evidence: ["tool-460", "policy-461", "user-482"],
        stale_evidence: [],
        unauthorized_evidence: [],
        unresolved_contradictions: [],
      },
    ],
    prior_attempt_input_tokens: [],
    maximum_escalations: 1,
  };
}

test("recommends the smallest tier with complete current evidence", () => {
  const input = parseRecommendationInput(recommendationInput());
  const result = recommendContext(input);
  assert.equal(result.recommendation, "USE_400K");
  assert.equal(result.recommended_tier, "400K");
  assert.equal(result.expected_total_input_tokens, 393700);
  assert.equal(result.always_largest_input_tokens, 883300);
  assert.equal(result.estimated_savings_tokens, 489600);
  assert.equal(result.estimated_savings_percent, 55.43);
  assert.deepEqual(result.tier_assessments[0]?.missing_evidence, [
    "policy-461",
    "user-482",
  ]);
  assert.equal(result.tier_assessments[1]?.safe, true);
  assert.equal(result.gate_required, true);
});

test("recommends 200K when it is already safe", () => {
  const value = recommendationInput();
  const tiers = value.tiers as Array<Record<string, unknown>>;
  tiers[0]!.available_evidence = ["tool-460", "policy-461", "user-482"];
  const result = recommendContext(parseRecommendationInput(value));
  assert.equal(result.recommendation, "USE_200K");
  assert.equal(result.estimated_savings_tokens, 685500);
});

test("uses the 1M-window tier when smaller tiers are stale or contradictory", () => {
  const value = recommendationInput();
  const tiers = value.tiers as Array<Record<string, unknown>>;
  tiers[1]!.stale_evidence = ["user-482"];
  tiers[1]!.unresolved_contradictions = ["user-17 conflicts with user-482"];
  const result = recommendContext(parseRecommendationInput(value));
  assert.equal(result.recommendation, "USE_1M_WINDOW");
  assert.equal(result.recommended_tier, "1M_WINDOW");
  assert.equal(result.estimated_savings_tokens, 0);
});

test("fails closed when no tier contains safe evidence", () => {
  const value = recommendationInput();
  for (const tier of value.tiers as Array<Record<string, unknown>>) {
    tier.unauthorized_evidence = ["policy-461"];
  }
  const result = recommendContext(parseRecommendationInput(value));
  assert.equal(result.recommendation, "BLOCK_AND_REFRESH");
  assert.equal(result.recommended_tier, null);
  assert.equal(result.expected_total_input_tokens, 0);
  assert.equal(result.estimated_savings_tokens, null);
  assert.match(renderRecommendation(result), /BLOCK_AND_REFRESH/);
  assert.match(renderRecommendation(result), /policy-461/);
});

test("counts prior failed attempts in total cost", () => {
  const value = recommendationInput();
  value.prior_attempt_input_tokens = [197800];
  const result = recommendContext(parseRecommendationInput(value));
  assert.equal(result.expected_total_input_tokens, 591500);
  assert.equal(result.estimated_savings_tokens, 291800);
  assert.equal(result.attempted_input_tokens, 197800);
});

test("counts semantic preflight cost before claiming savings", () => {
  const value = recommendationInput();
  value.preflight_input_tokens = 10_000;
  const result = recommendContext(parseRecommendationInput(value));
  assert.equal(result.preflight_input_tokens, 10_000);
  assert.equal(result.expected_total_input_tokens, 403_700);
  assert.equal(result.estimated_savings_tokens, 479_600);
});

test("reports negative savings when escalation costs more than starting large", () => {
  const value = recommendationInput();
  value.prior_attempt_input_tokens = [197800];
  const tiers = value.tiers as Array<Record<string, unknown>>;
  tiers[1]!.stale_evidence = ["user-482"];
  const result = recommendContext(parseRecommendationInput(value));
  assert.equal(result.recommendation, "USE_1M_WINDOW");
  assert.equal(result.expected_total_input_tokens, 1081100);
  assert.equal(result.estimated_savings_tokens, -197800);
  assert.equal(result.estimated_savings_percent, -22.39);
});

test("rejects incomplete, duplicate, and unknown evidence contracts", () => {
  assert.throws(() => parseRecommendationInput({}), /schema_version/);

  const duplicate = recommendationInput();
  (duplicate.required_evidence as unknown[]).push(
    (duplicate.required_evidence as unknown[])[0],
  );
  assert.throws(
    () => parseRecommendationInput(duplicate),
    /duplicate evidence_id/,
  );

  const unknown = recommendationInput();
  (
    (unknown.tiers as Array<Record<string, unknown>>)[0]!
      .available_evidence as string[]
  ).push("invented-by-planner");
  assert.throws(() => parseRecommendationInput(unknown), /unknown evidence_id/);

  const typo = recommendationInput();
  (typo.tiers as Array<Record<string, unknown>>)[0]!.stale_evidnce = [
    "user-482",
  ];
  assert.throws(
    () => parseRecommendationInput(typo),
    /unsupported field.*stale_evidnce/,
  );
});

test("CLI recommends 400K in text and JSON and blocks invalid input", () => {
  const root = process.cwd();
  const fixture = resolve(root, "examples/context-recommendation.json");
  const run = (args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/bin.ts", ...args],
      { cwd: root, encoding: "utf8", input },
    );

  const text = run(["recommend", fixture]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /ContextAdapt: use 400K/);
  assert.match(text.stdout, /55\.43%/);
  assert.match(text.stdout, /tool call is still gated/);
  assert.equal(text.stdout.trim().split("\n").length, 4);

  const detailed = run(["recommend", fixture, "--details"]);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.match(detailed.stdout, /RECOMMENDATION\s+USE_400K/);
  assert.match(detailed.stdout, /Execution gate:\s+REQUIRED/);

  const json = run(["recommend", fixture, "--format", "json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).recommendation, "USE_400K");

  const invalid = run(["recommend", "package.json"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /schema_version|unsupported field/);

  const blockedInput = recommendationInput();
  for (const tier of blockedInput.tiers as Array<Record<string, unknown>>) {
    tier.unauthorized_evidence = ["policy-461"];
  }
  const blocked = run(
    ["recommend", "-", "--format", "json"],
    JSON.stringify(blockedInput),
  );
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).recommendation, "BLOCK_AND_REFRESH");
});
