import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type OmpContext,
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
    on: (_event, received) => {
      handler = received;
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
