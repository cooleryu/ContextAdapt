import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assessRecoveryP0,
  classifyCurrentStateOutcome,
  summarizeInteractionCosts,
  type ToolTraceRecord,
  type TraceEvent,
} from "../packages/core/src/index.js";
import {
  createOmpExtension,
  type OmpContext,
  type OmpRecoveryEvent,
} from "../packages/omp/src/index.js";

test("OMP performs one read-only stale-scalar recovery and re-gates the retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-omp-recovery-"));
  await mkdir(join(directory, "production"));
  await writeFile(
    join(directory, "production/config.json"),
    '{"timeout":45,"retries":3}\n',
  );
  const old: TraceEvent = {
    event_id: "task-old",
    source: "user",
    kind: "state",
    entity: "ticket:recovery",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "production/config.json",
      timeout: 30,
      semantic_reviewed: true,
      semantic_run_ids: ["old:a", "old:b"],
    },
    links: {},
    text: "Use production/config.json timeout 30.",
  };
  const current: TraceEvent = {
    event_id: "task-current",
    source: "user",
    kind: "state",
    entity: "ticket:recovery",
    sequence: 2,
    observed_at: null,
    success: null,
    facts: {
      target_file: "production/config.json",
      timeout: 60,
      semantic_reviewed: true,
      semantic_run_ids: ["current:a", "current:b"],
    },
    links: { replaces: "task-old" },
    text: "Correction: production/config.json timeout is 60.",
  };
  const handlers = new Map<
    string,
    (event: unknown, context: OmpContext) => Promise<unknown>
  >();
  const traces: ToolTraceRecord[] = [];
  const recoveries: OmpRecoveryEvent[] = [];
  createOmpExtension({
    initialEvents: [old],
    persist: false,
    modelContextWindow: 1_000_000,
    fixedInputTokens: 0,
    captureTask: () => ({
      event: current,
      preflight_input_tokens: 0,
      run_attestations: [{}, {}],
    }),
    onToolTrace: (record) => traces.push(record),
    onRecovery: (event) => recoveries.push(event),
  })({
    on: (event, handler) => {
      handlers.set(event, async (value, context) => handler(value, context));
    },
  });
  const context: OmpContext = {
    cwd: directory,
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "omp-recovery-test" },
  };
  try {
    await handlers.get("before_agent_start")!(
      { prompt: current.text, systemPrompt: [] },
      context,
    );
    const first = (await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "stale-first",
        input: {
          path: "production/config.json",
          content: '{"timeout":30,"retries":3}\n',
        },
      },
      context,
    )) as { block: boolean; reason: string };
    assert.equal(first.block, true);
    assert.match(first.reason, /one read-only recovery/i);
    assert.match(first.reason, /"timeout":45/);
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0]!.recovery_count, 1);

    const exhausted = (await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "stale-second",
        input: {
          path: "production/config.json",
          content: '{"timeout":30,"retries":3}\n',
        },
      },
      context,
    )) as { block: boolean; reason: string };
    assert.match(exhausted.reason, /budget exhausted/i);
    assert.equal(recoveries.length, 1);

    const allowed = await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "current",
        input: {
          path: "production/config.json",
          content: '{"timeout":60,"retries":3}\n',
        },
      },
      context,
    );
    assert.equal(allowed, undefined);
    await writeFile(
      join(directory, "production/config.json"),
      '{"timeout":60,"retries":3}\n',
    );
    await handlers.get("tool_result")!(
      {
        toolName: "write",
        toolCallId: "current",
        input: {
          path: "production/config.json",
          content: '{"timeout":60,"retries":3}\n',
        },
        content: "written",
        isError: false,
      },
      context,
    );
    const final = JSON.parse(
      await readFile(join(directory, "production/config.json"), "utf8"),
    );
    const interaction = summarizeInteractionCosts(traces, 1);
    assert.equal(interaction.recovery_retrieval_calls, 1);
    assert.equal(interaction.execution_calls, 1);
    assert.equal(interaction.blocked_action_proposals, 2);
    const acceptance = assessRecoveryP0({
      expected_recoverable: true,
      recovery_count: recoveries.length,
      recovery_was_read_only: true,
      writes_before_second_gate: 0,
      final_gate: "ALLOW",
      task_completed: final.timeout === 60 && final.retries === 3,
      protected_resources_unchanged: true,
      current_state_outcome: classifyCurrentStateOutcome(
        { target_file: "production/config.json", timeout: final.timeout },
        { target_file: "production/config.json", timeout: 60 },
        [{ target_file: "production/config.json", timeout: 30 }],
        ["target_file", "timeout"],
      ),
      interaction,
    });
    assert.equal(acceptance.pass, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
