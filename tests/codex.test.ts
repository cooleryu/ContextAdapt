import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
  convertCodexExec,
  parseCodexSemanticStream,
  runTwoPassCodexAnalysis,
  type CodexRunner,
} from "../packages/codex/src/index.js";
import type { TraceEvent } from "../packages/core/src/index.js";

test("Codex adapter redacts raw content by default", () => {
  const events = convertCodexExec(
    [
      JSON.stringify({ type: "thread.started", thread_id: "private-thread" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "i1",
          type: "command_execution",
          command: "cat secret",
          aggregated_output: "secret-value",
          exit_code: 0,
          status: "completed",
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12 } }),
    ],
    { instruction: "private prompt" },
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(
    serialized,
    /private-thread|secret-value|private prompt|cat secret/,
  );
  assert.ok(events.some((event) => event.facts.command_sha256));
});

test("Codex adapter includes content only by explicit opt-in", () => {
  const events = convertCodexExec(
    [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
    ],
    { includeContent: true },
  );
  assert.match(events[0]!.text, /hello/);
});

test("semantic stream requires provider identity and completed turn", () => {
  const answer = JSON.stringify({
    entity: "x",
    relation: "adds",
    confidence: 0.9,
    changes: [],
    unresolved_fields: [],
  });
  assert.throws(
    () =>
      parseCodexSemanticStream(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}`,
      ),
    /provider thread identity/,
  );
  assert.throws(
    () =>
      parseCodexSemanticStream(
        `${JSON.stringify({ type: "thread.started", thread_id: "t" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } })}`,
      ),
    /completed turn/,
  );
});

test("two semantic runs must have independent provider identities", () => {
  const rawAnswer = JSON.stringify({
    entity: "ticket:x",
    relation: "supersedes",
    confidence: 0.95,
    changes: [
      {
        field: "timeout",
        operation: "replace",
        old_value: 30,
        new_value: 60,
        old_quote: "30",
        new_quote: "60",
      },
    ],
    unresolved_fields: [],
  });
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "same" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: rawAnswer },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  const runner: CodexRunner = () => ({ status: 0, stdout, stderr: "" });
  const events: TraceEvent[] = [
    {
      event_id: "old",
      source: "user",
      kind: "state",
      entity: "ticket:x",
      sequence: 1,
      observed_at: null,
      success: null,
      facts: { timeout: 30 },
      links: {},
      text: "timeout 30",
    },
    {
      event_id: "new",
      source: "user",
      kind: "state",
      entity: "ticket:x",
      sequence: 2,
      observed_at: null,
      success: null,
      facts: { timeout: 60 },
      links: {},
      text: "timeout 60",
    },
  ];
  assert.throws(
    () => runTwoPassCodexAnalysis(events, "old", "new", { runner }),
    /same run identity/,
  );
});

test("failed semantic run returns a bounded, home-redacted diagnostic", () => {
  const events: TraceEvent[] = [
    {
      event_id: "old",
      source: "user",
      kind: "state",
      entity: "ticket:x",
      sequence: 1,
      observed_at: null,
      success: null,
      facts: {},
      links: {},
      text: "old",
    },
    {
      event_id: "new",
      source: "user",
      kind: "state",
      entity: "ticket:x",
      sequence: 2,
      observed_at: null,
      success: null,
      facts: {},
      links: {},
      text: "new",
    },
  ];
  const runner: CodexRunner = () => ({
    status: 1,
    stdout: "",
    stderr: `${"x".repeat(1500)} ${homedir()}/private`,
  });
  assert.throws(
    () => runTwoPassCodexAnalysis(events, "old", "new", { runner }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(homedir()));
      assert.match(error.message, /~\/private/);
      assert.ok(error.message.length < 1450);
      return true;
    },
  );
});
