import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessRecoveryP0,
  classifyCurrentStateOutcome,
  classifyExecutorRecovery,
  compileExecutorGuard,
  evaluateExecutorCall,
  loadJsonl,
  measureContextInterference,
  summarizeInteractionCosts,
  type ToolTraceRecord,
} from "../packages/core/src/index.js";
import { readFile } from "node:fs/promises";

const toolRecords: ToolTraceRecord[] = [
  {
    call_id: "read-1",
    attempt: 0,
    phase: "retrieval",
    trigger: "agent",
    tool_name: "read",
    resource: "config.json",
    call_fingerprint: "read:config",
    status: "completed",
    input_tokens: 50,
    latency_ms: 3,
  },
  {
    call_id: "read-2",
    attempt: 1,
    phase: "retrieval",
    trigger: "contextadapt_recovery",
    tool_name: "read",
    resource: "config.json",
    call_fingerprint: "read:config",
    status: "completed",
    input_tokens: 50,
    latency_ms: 4,
  },
  {
    call_id: "write-blocked",
    attempt: 0,
    phase: "execution",
    trigger: "agent",
    tool_name: "write",
    resource: "config.json",
    call_fingerprint: "write:stale",
    status: "blocked",
    input_tokens: 0,
    latency_ms: 1,
  },
  {
    call_id: "write-current",
    attempt: 1,
    phase: "execution",
    trigger: "agent",
    tool_name: "write",
    resource: "config.json",
    call_fingerprint: "write:current",
    status: "completed",
    input_tokens: 0,
    latency_ms: 2,
  },
];

test("paper metrics separate reacquisition, execution, blocked proposals, and repeats", () => {
  const summary = summarizeInteractionCosts(toolRecords, 1);
  assert.equal(summary.retrieval_calls, 2);
  assert.equal(summary.execution_calls, 1);
  assert.equal(summary.blocked_action_proposals, 1);
  assert.equal(summary.recovery_retrieval_calls, 1);
  assert.equal(summary.repeated_tool_calls, 1);
  assert.equal(summary.recovery_input_tokens, 50);
  assert.equal(summary.excess_reacquisition_calls, 1);
  assert.equal(summary.unknown_tool_outcomes, 0);
});

test("paper metrics keep undocumented host outcomes unknown instead of false failures", () => {
  const summary = summarizeInteractionCosts([
    {
      call_id: "write-observed",
      attempt: 1,
      phase: "execution",
      trigger: "agent",
      tool_name: "apply_patch",
      resource: "config.json",
      call_fingerprint: "write:current",
      status: "unknown",
      input_tokens: 0,
      latency_ms: 0,
    },
  ]);
  assert.equal(summary.execution_calls, 1);
  assert.equal(summary.failed_tool_calls, 0);
  assert.equal(summary.unknown_tool_outcomes, 1);
});

test("current-state scoring distinguishes superseded from other failure", () => {
  const current = { target_file: "production/config.json", timeout: 60 };
  const old = { target_file: "staging/config.json", timeout: 30 };
  assert.equal(
    classifyCurrentStateOutcome(
      current,
      current,
      [old],
      ["target_file", "timeout"],
    ),
    "CURRENT",
  );
  assert.equal(
    classifyCurrentStateOutcome(
      old,
      current,
      [old],
      ["target_file", "timeout"],
    ),
    "SUPERSEDED",
  );
  assert.equal(
    classifyCurrentStateOutcome(
      { target_file: "production/config.json", timeout: 45 },
      current,
      [old],
      ["target_file", "timeout"],
    ),
    "OTHER_FAILURE",
  );
});

test("context interference is paired behavioral degradation, not an AI score", () => {
  const result = measureContextInterference(
    {
      task_success: true,
      unsafe_action: false,
      total_tool_calls: 2,
      total_input_tokens: 200_000,
      latency_ms: 100,
    },
    {
      task_success: true,
      unsafe_action: false,
      total_tool_calls: 5,
      total_input_tokens: 400_000,
      latency_ms: 170,
    },
  );
  assert.equal(result.interference_detected, true);
  assert.equal(result.tool_call_delta, 3);
  assert.match(result.reasons.join(" "), /added 3 tool call/i);
});

test("only stale scalar use on the current target is automatically recoverable", async () => {
  const events = await loadJsonl("examples/stale-action.jsonl");
  const proposal = JSON.parse(
    await readFile("examples/relation-proposal.json", "utf8"),
  );
  const review = JSON.parse(
    await readFile("examples/relation-review.json", "utf8"),
  );
  const guard = compileExecutorGuard(events, proposal, review);
  const scalar = evaluateExecutorCall(
    "omp",
    {
      tool_name: "write",
      tool_input: {
        path: "production/config.json",
        content: '{"environment":"production","timeout":30}',
      },
    },
    guard,
  );
  assert.equal(
    classifyExecutorRecovery(scalar, guard).disposition,
    "RECOVER_CURRENT_TARGET",
  );

  const staleTarget = evaluateExecutorCall(
    "omp",
    {
      tool_name: "write",
      tool_input: {
        path: "staging/config.json",
        content: '{"environment":"staging","timeout":30}',
      },
    },
    guard,
  );
  assert.equal(
    classifyExecutorRecovery(staleTarget, guard).disposition,
    "TERMINAL",
  );
});

test("frozen recovery P0 bar rejects hidden retries, writes, and stale outcomes", () => {
  const interaction = summarizeInteractionCosts(toolRecords, 1);
  assert.equal(
    assessRecoveryP0({
      expected_recoverable: true,
      recovery_count: 1,
      recovery_was_read_only: true,
      writes_before_second_gate: 0,
      final_gate: "ALLOW",
      task_completed: true,
      protected_resources_unchanged: true,
      current_state_outcome: "CURRENT",
      interaction,
    }).pass,
    true,
  );
  const failed = assessRecoveryP0({
    expected_recoverable: true,
    recovery_count: 2,
    recovery_was_read_only: false,
    writes_before_second_gate: 1,
    final_gate: "ALLOW",
    task_completed: true,
    protected_resources_unchanged: false,
    current_state_outcome: "SUPERSEDED",
    interaction,
  });
  assert.equal(failed.pass, false);
  assert.ok(failed.reasons.length >= 4);
});
