import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalDigest,
  compileExecutorGuard,
  evaluateActionWithRelation,
  evaluateExecutorCall,
  loadJsonl,
  validateRelationBundle,
} from "../packages/core/src/index.js";
import ompGuard, {
  createOmpExtension,
  type OmpAdaptiveDecision,
  type OmpContext,
  type OmpShadowSnapshot,
  type OmpToolCall,
} from "../packages/omp/src/index.js";

async function fixture(): Promise<{
  events: Awaited<ReturnType<typeof loadJsonl>>;
  proposal: Record<string, unknown>;
  review: Record<string, unknown>;
}> {
  const events = await loadJsonl("examples/stale-action.jsonl");
  const proposal = JSON.parse(
    await readFile("examples/relation-proposal.json", "utf8"),
  ) as Record<string, unknown>;
  const review = JSON.parse(
    await readFile("examples/relation-review.json", "utf8"),
  ) as Record<string, unknown>;
  return { events, proposal, review };
}

test("reviewed relation is accepted but stale candidate action is blocked", async () => {
  const { events, proposal, review } = await fixture();
  const verdict = validateRelationBundle(events, proposal, review);
  assert.equal(verdict.status, "ACCEPTED");
  const action = evaluateActionWithRelation(
    events,
    verdict,
    "old-action-replay",
  );
  assert.equal(action.status, "BLOCK");
  assert.deepEqual(action.changed_fields, [
    "environment",
    "timeout",
    "edit_protected",
    "target_file",
  ]);
});

test("review is cryptographically bound to immutable proposal", async () => {
  const { events, proposal, review } = await fixture();
  const changed = structuredClone(proposal);
  changed.confidence = 0.9;
  assert.equal(
    validateRelationBundle(events, changed, review).status,
    "REJECTED",
  );
});

test("planner-authored privilege increase is rejected", async () => {
  const { events, proposal, review } = await fixture();
  const plannerNew = events.find(
    (event) => event.event_id === "ticket-current",
  )!;
  plannerNew.source = "planner";
  plannerNew.facts.edit_protected = true;
  plannerNew.facts.protected_scope = ["production/config.json"];
  const editChange = (proposal.changes as Array<Record<string, unknown>>).find(
    (item) => item.field === "edit_protected",
  )!;
  editChange.operation = "allow";
  editChange.new_value = true;
  proposal.proposal_id = "self-auth";
  review.proposal_id = proposal.proposal_id;
  review.proposal_sha256 = canonicalDigest(proposal);
  const fieldReview = (
    review.field_reviews as Array<Record<string, unknown>>
  ).find((item) => item.field === "edit_protected")!;
  fieldReview.operation = "allow";
  fieldReview.new_value = true;
  assert.equal(
    validateRelationBundle(events, proposal, review).status,
    "REJECTED",
  );
});

test("executor guard blocks stale target and stale scalar", async () => {
  const { events, proposal, review } = await fixture();
  const guard = compileExecutorGuard(events, proposal, review);
  const staleTarget = evaluateExecutorCall(
    "omp",
    {
      tool_name: "write",
      tool_input: { path: "staging/config.json", content: '{"timeout":30}' },
      cwd: "/repo",
    },
    guard,
  );
  assert.equal(staleTarget.decision, "BLOCK");
  assert.ok(staleTarget.matched_changes?.includes("target_file"));
  assert.ok(staleTarget.matched_changes?.includes("edit_protected"));
  assert.ok(staleTarget.matched_changes?.includes("timeout"));
});

test("executor guard allows current reviewed tool arguments", async () => {
  const { events, proposal, review } = await fixture();
  const guard = compileExecutorGuard(events, proposal, review);
  const current = evaluateExecutorCall(
    "omp",
    {
      tool_name: "write",
      tool_input: { path: "production/config.json", content: '{"timeout":60}' },
      cwd: "/repo",
    },
    guard,
  );
  assert.equal(current.decision, "ALLOW");
});

test("executor guard blocks an unrelated path even when it is not protected", async () => {
  const { events, proposal, review } = await fixture();
  const guard = compileExecutorGuard(events, proposal, review);
  const unrelated = evaluateExecutorCall(
    "omp",
    {
      tool_name: "write",
      tool_input: { path: "notes.txt", content: "looks harmless" },
    },
    guard,
  );
  assert.equal(unrelated.decision, "BLOCK");
  assert.match(unrelated.reasons.join(" "), /unreviewed path/i);
});

test("opaque and targetless mutation fails closed", async () => {
  const { events, proposal, review } = await fixture();
  const guard = compileExecutorGuard(events, proposal, review);
  assert.equal(
    evaluateExecutorCall(
      "omp",
      { tool_name: "python", tool_input: { code: "write something" } },
      guard,
    ).decision,
    "BLOCK",
  );
  assert.equal(
    evaluateExecutorCall(
      "codex",
      { tool_name: "apply_patch", tool_input: { command: "not a patch" } },
      guard,
    ).decision,
    "BLOCK",
  );
});

test("read-only shell commands remain outside mutation scope", async () => {
  const { events, proposal, review } = await fixture();
  const guard = compileExecutorGuard(events, proposal, review);
  const decision = evaluateExecutorCall(
    "omp",
    { tool_name: "bash", tool_input: { command: "git status" } },
    guard,
  );
  assert.equal(decision.decision, "ALLOW");
  assert.equal(decision.tool.in_scope, false);
});

test("native OMP extension blocks a stale write in process", async () => {
  const { events, proposal, review } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-omp-test-"));
  const policy = join(directory, "guard.json");
  await writeFile(
    policy,
    JSON.stringify(compileExecutorGuard(events, proposal, review)),
  );
  let handler:
    | ((
        event: OmpToolCall,
        context: OmpContext,
      ) => Promise<{ block: true; reason: string } | undefined>)
    | undefined;
  ompGuard({
    on: (event, received) => {
      if (event === "tool_call") handler = received as typeof handler;
    },
  });
  const previous = process.env.CONTEXTADAPT_GUARD;
  process.env.CONTEXTADAPT_GUARD = policy;
  try {
    assert.ok(handler);
    const result = await handler!(
      {
        toolName: "write",
        input: { path: "staging/config.json", content: '{"timeout":30}' },
      },
      { cwd: directory },
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /stale path/);
  } finally {
    if (previous === undefined) delete process.env.CONTEXTADAPT_GUARD;
    else process.env.CONTEXTADAPT_GUARD = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("OMP native lifecycle records, selects 400K, and gates the actual write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-omp-runtime-"));
  await mkdir(join(directory, "production"));
  await writeFile(
    join(directory, "production/config.json"),
    JSON.stringify({ timeout: 45, retries: 3 }),
  );
  const old: Awaited<ReturnType<typeof loadJsonl>>[number] = {
    event_id: "old-task",
    source: "user",
    kind: "state",
    entity: "ticket:deploy",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "production/config.json",
      environment: "production",
      timeout: 30,
      semantic_reviewed: true,
      semantic_run_ids: ["codex:old-a", "codex:old-b"],
    },
    links: {},
    text: "OLD task uses production/config.json in production with timeout 30.",
  };
  const prompt =
    "Correction: keep production/config.json in production and use timeout 60.";
  const current = {
    event_id: "current-task",
    source: "user",
    kind: "state" as const,
    entity: "ticket:deploy",
    sequence: 2,
    observed_at: null,
    success: null,
    facts: {
      target_file: "production/config.json",
      environment: "production",
      timeout: 60,
      field_sources: {
        target_file: "current-task",
        environment: "old-task",
        timeout: "current-task",
      },
      semantic_reviewed: true,
      semantic_run_ids: ["codex:new-a", "codex:new-b"],
    },
    links: { replaces: "old-task" },
    text: prompt,
  };
  const handlers = new Map<
    string,
    (event: unknown, context: OmpContext) => Promise<unknown>
  >();
  let adaptiveDecision: OmpAdaptiveDecision | undefined;
  let shadowSnapshot: OmpShadowSnapshot | undefined;
  createOmpExtension({
    initialEvents: [old],
    persist: false,
    fixedInputTokens: 0,
    captureTask: () => ({
      event: current,
      preflight_input_tokens: 200,
      run_attestations: [{}, {}],
    }),
    countTokens: (text) =>
      text.includes("OLD task")
        ? 80_000
        : text.includes("NOISE")
          ? 250_000
          : 30_000,
    onDecision: (decision) => {
      adaptiveDecision = decision;
    },
    onShadowSnapshot: (snapshot) => {
      shadowSnapshot = snapshot;
    },
  })({
    on: (event, handler) => {
      handlers.set(event, async (value, context) => handler(value, context));
    },
  });
  const context: OmpContext = {
    cwd: directory,
    model: { contextWindow: 1_000_000 },
    getContextUsage: () => ({
      tokens: 360_000,
      contextWindow: 1_000_000,
      percent: 36,
    }),
    sessionManager: { getSessionId: () => "omp-runtime-test" },
  };
  try {
    const before = await handlers.get("before_agent_start")!(
      { prompt, systemPrompt: [] },
      context,
    );
    assert.equal(before, undefined);
    const messages = [
      { role: "user", content: old.text },
      { role: "user", content: "NOISE from completed tool loops." },
      { role: "user", content: prompt },
    ];
    const selected = (await handlers.get("context")!(
      { messages },
      context,
    )) as { messages: unknown[] };
    assert.equal(adaptiveDecision?.recommended_tier, "400K");
    assert.equal(selected.messages.length, 4);
    assert.equal(shadowSnapshot?.source, "omp_native_context");
    assert.equal(shadowSnapshot?.adaptive_message_count, 4);
    assert.equal(shadowSnapshot?.largest_message_count, messages.length + 1);
    assert.ok((shadowSnapshot?.full_input_tokens ?? 0) > 0);
    assert.ok((shadowSnapshot?.adaptive_input_tokens ?? 0) > 0);
    assert.ok(
      (shadowSnapshot?.adaptive_input_tokens ?? 0) <=
        (shadowSnapshot?.largest_input_tokens ?? 0),
    );
    assert.equal(shadowSnapshot?.full_context_sha256.length, 64);
    const frozenMessageCount = shadowSnapshot?.messages.length;
    messages.push({ role: "assistant", content: "later host mutation" });
    assert.equal(shadowSnapshot?.messages.length, frozenMessageCount);
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify(shadowSnapshot?.messages))
        .digest("hex"),
      shadowSnapshot?.full_context_sha256,
    );

    const stale = (await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "stale",
        input: {
          path: "production/config.json",
          content: '{"timeout":30,"retries":3}',
        },
      },
      context,
    )) as { block?: boolean; reason?: string } | undefined;
    assert.equal(stale?.block, true);
    assert.match(stale?.reason ?? "", /stale timeout/i);

    const currentWrite = await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "current",
        input: {
          path: "production/config.json",
          content: '{"timeout":60,"retries":3}',
        },
      },
      context,
    );
    assert.equal(currentWrite, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
