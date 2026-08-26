import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildTraceEvidenceMap,
  parseJsonl,
  recommendFromTrace,
  renderCompactRecommendation,
} from "../packages/core/src/index.js";

const root = process.cwd();
const measuredTracePath = resolve(root, "examples/auto-context-trace.jsonl");
const staleTracePath = resolve(root, "examples/stale-action.jsonl");

function measuredTrace() {
  return parseJsonl(readFileSync(measuredTracePath, "utf8"));
}

test("automatically maps current task evidence without a user manifest", () => {
  const map = buildTraceEvidenceMap(measuredTrace(), "auto-context-trace");
  assert.equal(map.active_task_event_id, "ticket-current");
  assert.deepEqual(
    map.recommendation_input.required_evidence.map((item) => item.evidence_id),
    ["ticket-current", "policy-production-config", "read-production-ok"],
  );
  assert.deepEqual(map.recommendation_input.tiers[0]?.available_evidence, []);
  assert.deepEqual(map.recommendation_input.tiers[1]?.available_evidence, [
    "ticket-current",
    "policy-production-config",
    "read-production-ok",
  ]);
});

test("selects 400K from host-measured spans and explains it in four lines", () => {
  const result = recommendFromTrace(measuredTrace(), "auto-context-trace");
  assert.equal(result.recommendation, "USE_400K");
  assert.equal(result.recommended_tier, "400K");
  assert.equal(result.expected_total_input_tokens, 393700);
  assert.equal(result.estimated_savings_percent, 55.43);

  const rendered = renderCompactRecommendation(result).trim().split("\n");
  assert.equal(rendered.length, 4);
  assert.match(rendered[0]!, /use 400K/i);
  assert.match(rendered[1]!, /200K.*latest production.*permission/i);
  assert.match(rendered[2]!, /393,700.*55\.43%/);
  assert.match(rendered[3]!, /tool call.*gated/i);
});

test("fails closed when a trace lacks trusted host context measurements", () => {
  const result = recommendFromTrace(
    parseJsonl(readFileSync(staleTracePath, "utf8")),
    "stale-action",
  );
  assert.equal(result.recommendation, "BLOCK_AND_REFRESH");
  assert.equal(result.recommended_tier, null);
  assert.match(result.reasons[0]!, /host context profile/i);

  const rendered = renderCompactRecommendation(result).trim().split("\n");
  assert.equal(rendered.length, 4);
  assert.match(rendered[0]!, /stop and refresh/i);
  assert.match(rendered[3]!, /do not mutate/i);
});

test("treats a partially clipped evidence event as unavailable", () => {
  const events = measuredTrace();
  const task = events.find((event) => event.event_id === "ticket-current")!;
  task.context_span = { start_token: 489500, end_token: 530260 };
  const result = recommendFromTrace(events, "partial-event");
  assert.equal(result.recommendation, "USE_1M_WINDOW");
  assert.deepEqual(result.tier_assessments[1]?.missing_evidence, [
    "ticket-current",
  ]);
});

test("fails closed for forged profiles, missing policies, and ambiguous tasks", () => {
  const forged = measuredTrace();
  forged.find((event) => event.event_id === "context-profile")!.source =
    "planner";
  assert.match(
    recommendFromTrace(forged, "forged-profile").reasons[0]!,
    /trusted host context profile is missing/i,
  );

  const missingPolicy = measuredTrace().filter(
    (event) => event.event_id !== "policy-production-config",
  );
  assert.match(
    recommendFromTrace(missingPolicy, "missing-policy").reasons[0]!,
    /resource policy is missing/i,
  );

  const ambiguous = measuredTrace();
  ambiguous.push({
    event_id: "second-task",
    source: "user",
    kind: "state",
    entity: "ticket:second",
    sequence: 70,
    observed_at: null,
    success: null,
    facts: { target_file: "production/config.json", timeout: 70 },
    links: {},
    text: "A second active production task.",
    context_span: { start_token: 540000, end_token: 540100 },
  });
  assert.match(
    recommendFromTrace(ambiguous, "ambiguous-task").reasons[0]!,
    /multiple active tasks are ambiguous/i,
  );
});

test("rejects planner observations, unsupported window math, and invalid replacements", () => {
  const plannerObservation = measuredTrace();
  plannerObservation.find(
    (event) => event.event_id === "read-production-ok",
  )!.source = "planner";
  const untrusted = recommendFromTrace(
    plannerObservation,
    "planner-observation",
  );
  assert.equal(untrusted.recommendation, "BLOCK_AND_REFRESH");
  assert.deepEqual(untrusted.tier_assessments[2]?.unauthorized_evidence, [
    "read-production-ok",
  ]);

  const unsupportedWindow = measuredTrace();
  unsupportedWindow.find(
    (event) => event.event_id === "context-profile",
  )!.facts.window_policy = "unknown_compaction";
  assert.match(
    recommendFromTrace(unsupportedWindow, "bad-window").reasons[0]!,
    /window_policy must be suffix_window_v1/i,
  );

  const badReplacement = measuredTrace();
  badReplacement.find(
    (event) => event.event_id === "ticket-current",
  )!.links.replaces = "missing-old-task";
  assert.match(
    recommendFromTrace(badReplacement, "bad-replacement").reasons[0]!,
    /replacement evidence missing-old-task does not exist/i,
  );
});

test("CLI accepts a trace directly and hides the evidence data structure by default", () => {
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/bin.ts", ...args],
      { cwd: root, encoding: "utf8" },
    );

  const recommended = run(["recommend", measuredTracePath]);
  assert.equal(recommended.status, 0, recommended.stderr);
  assert.equal(recommended.stdout.trim().split("\n").length, 4);
  assert.match(recommended.stdout, /use 400K/i);
  assert.doesNotMatch(recommended.stdout, /ticket-current|evidence_id/);

  const details = run(["recommend", measuredTracePath, "--format", "json"]);
  assert.equal(details.status, 0, details.stderr);
  assert.equal(JSON.parse(details.stdout).recommendation, "USE_400K");
  assert.equal(JSON.parse(details.stdout).required_evidence.length, 3);

  const blocked = run(["recommend", staleTracePath]);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stdout, /stop and refresh/i);
});
