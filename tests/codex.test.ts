import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyPairedSavings,
  convertCodexExec,
  CodexAppServerClient,
  CodexTaskCaptureError,
  codexRuntimeStem,
  handleCodexRuntimeHook,
  emptyCodexAdaptiveSession,
  installCodexRuntimeHooks,
  loadLatestCodexPrivateSessionReference,
  observeCodexPassiveSession,
  parseCodexAdaptiveAgentStream,
  parseCodexSemanticStream,
  runCodexNativeBoundary,
  runTwoPassCodexAnalysis,
  runTwoPassCodexTaskCapture,
  runCodexAdaptiveTurn,
  runCodexShadowPair,
  TASK_CAPTURE_SYSTEM_PROMPT,
  type CodexRunner,
  type CodexAppServerThread,
} from "../packages/codex/src/index.js";
import {
  compileExecutorGuard,
  loadJsonl,
  type TraceEvent,
} from "../packages/core/src/index.js";

test("paired replay requires the frozen 25% product savings bar", () => {
  assert.deepEqual(classifyPairedSavings(76_164, 76_130, true), {
    total_input_tokens: 34,
    percent: 0.0446,
    product_bar_percent: 25,
    meets_product_bar: false,
  });
  assert.equal(classifyPairedSavings(100, 74, true).meets_product_bar, true);
  assert.equal(classifyPairedSavings(100, 50, false).meets_product_bar, false);
});

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

test("adaptive Codex stream retains public tool output for the next real turn", () => {
  const parsed = parseCodexAdaptiveAgentStream(
    [
      JSON.stringify({ type: "thread.started", thread_id: "native-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "a", type: "agent_message", text: "I will inspect it." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "b",
          type: "command_execution",
          command: "cat config.json",
          aggregated_output: '{"timeout":45}',
          exit_code: 0,
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "c", type: "agent_message", text: "Done." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 123 },
      }),
    ].join("\n"),
  );
  assert.equal(parsed.text, "Done.");
  assert.equal(parsed.history_messages.length, 3);
  assert.deepEqual(
    parsed.history_messages.map((item) => item.role),
    ["assistant", "tool", "assistant"],
  );
  assert.match(parsed.history_messages[1]!.text, /cat config\.json/);
  assert.match(parsed.history_messages[1]!.text, /timeout/);
  assert.doesNotMatch(parsed.history_messages[1]!.text, /"id":"b"/);
  assert.equal(parsed.usage.input_tokens, 123);
  assert.equal(parsed.provider_thread_hash.length, 20);
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

test("two Luna-style task captures create one reviewed current task without a user manifest", () => {
  const answer = JSON.stringify({
    actionable: true,
    continues_previous: true,
    fields: {
      target_file: {
        value: "production/config.json",
        origin: "new",
        quote: "production/config.json",
      },
      timeout: { value: 60, origin: "new", quote: "timeout 60" },
      edit_protected: {
        value: false,
        origin: "new",
        quote: "do not edit protected files",
      },
    },
  });
  let run = 0;
  const runner: CodexRunner = () => {
    run += 1;
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: `task-${run}` }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: answer },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 120 },
        }),
      ].join("\n"),
    };
  };
  const previous: TraceEvent = {
    event_id: "old",
    source: "user",
    kind: "state",
    entity: "ticket:deploy",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: { target_file: "staging/config.json", timeout: 30 },
    links: {},
    text: "Use staging/config.json with timeout 30.",
  };
  const captured = runTwoPassCodexTaskCapture(
    "Correction: use production/config.json with timeout 60; do not edit protected files.",
    previous,
    { sequence: 2, session_id: "session", runner },
  );
  assert.equal(captured.preflight_input_tokens, 240);
  assert.equal(captured.event?.facts.target_file, "production/config.json");
  assert.equal(captured.event?.links.replaces, "old");
  assert.equal(captured.event?.facts.semantic_reviewed, true);
  assert.equal(captured.event?.facts.semantic_review_model, "gpt-5.6-luna");
  assert.equal(
    new Set(captured.event?.facts.semantic_run_ids as string[]).size,
    2,
  );
});

test("task review model is independent from the task Agent model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-model-split-"));
  const prompt = "Set config.json timeout to 60.";
  const reviewModels: string[] = [];
  const taskModels: string[] = [];
  let reviewRun = 0;
  const runner: CodexRunner = (_command, args) => {
    const model = args[args.indexOf("--model") + 1]!;
    if (args.includes("--ephemeral")) {
      reviewModels.push(model);
      reviewRun += 1;
      return {
        status: 0,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "thread.started",
            thread_id: `review-${reviewRun}`,
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify({
                actionable: true,
                continues_previous: false,
                fields: {
                  target_file: {
                    value: "config.json",
                    origin: "new",
                    quote: "config.json",
                  },
                  timeout: {
                    value: 60,
                    origin: "new",
                    quote: "timeout to 60",
                  },
                },
              }),
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 100 },
          }),
        ].join("\n"),
      };
    }
    taskModels.push(model);
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "task-agent" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done." },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10_000 },
        }),
      ].join("\n"),
    };
  };
  try {
    await writeFile(join(directory, "config.json"), '{"timeout":45}\n');
    const result = await runCodexAdaptiveTurn(
      emptyCodexAdaptiveSession("model-split"),
      prompt,
      {
        cwd: directory,
        model: "gpt-5.6-sol",
        review_model: "gpt-5.6-luna",
        review_runner: runner,
        runner,
        requireInstalledHook: false,
        fixed_input_tokens: 1_000,
      },
    );
    assert.deepEqual(reviewModels, ["gpt-5.6-luna", "gpt-5.6-luna"]);
    assert.deepEqual(taskModels, ["gpt-5.6-sol"]);
    assert.equal(result.task_model, "gpt-5.6-sol");
    assert.equal(result.review_model, "gpt-5.6-luna");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task capture prompt makes repeated current fields win provenance deterministically", () => {
  assert.match(
    TASK_CAPTURE_SYSTEM_PROMPT,
    /explicitly states, repeats, allows, or denies a field, origin MUST be new/i,
  );
  assert.match(
    TASK_CAPTURE_SYSTEM_PROMPT,
    /origin=previous only when user_prompt is entirely silent/i,
  );
  assert.match(
    TASK_CAPTURE_SYSTEM_PROMPT,
    /does NOT mean that the ordinary target file may be edited/i,
  );
  assert.match(
    TASK_CAPTURE_SYSTEM_PROMPT,
    /only limits edits to one file or says not to edit other files/i,
  );
});

test("task capture reconciles identical repeated denials to validated current evidence", () => {
  const common = {
    actionable: true,
    continues_previous: true,
    fields: {
      target_file: {
        value: "production/config.json",
        origin: "new",
        quote: "production/config.json",
      },
      timeout: { value: 60, origin: "new", quote: "timeout 60" },
    },
  };
  const answers = [
    {
      ...common,
      fields: {
        ...common.fields,
        edit_protected: {
          value: false,
          origin: "new",
          quote: "do not edit protected files",
        },
      },
    },
    {
      ...common,
      fields: {
        ...common.fields,
        edit_protected: { value: false, origin: "previous", quote: null },
      },
    },
  ];
  let run = 0;
  const runner: CodexRunner = () => {
    const answer = answers[run++]!;
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: `reconcile-${run}`,
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify(answer) },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100 },
        }),
      ].join("\n"),
    };
  };
  const previous: TraceEvent = {
    event_id: "old-denial",
    source: "user",
    kind: "state",
    entity: "release:one",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "staging/config.json",
      timeout: 30,
      edit_protected: false,
      field_sources: { edit_protected: "old-denial" },
    },
    links: {},
    text: "Use staging/config.json; do not edit protected files.",
  };
  const captured = runTwoPassCodexTaskCapture(
    "Correction: use production/config.json with timeout 60; do not edit protected files.",
    previous,
    { sequence: 2, session_id: "reconcile", runner },
  );
  const fieldSources = captured.event?.facts.field_sources as Record<
    string,
    string
  >;
  assert.equal(fieldSources.edit_protected, captured.event?.event_id);
  assert.equal(captured.preflight_input_tokens, 200);
});

test("task capture drops a protected denial extracted by only one reviewer without relaxing the target boundary", () => {
  const answers = [
    {
      actionable: true,
      continues_previous: false,
      fields: {
        target_file: {
          value: "config.json",
          origin: "new",
          quote: "update config.json",
        },
        timeout: { value: 60, origin: "new", quote: "timeout is 60" },
      },
    },
    {
      actionable: true,
      continues_previous: false,
      fields: {
        target_file: {
          value: "config.json",
          origin: "new",
          quote: "update config.json",
        },
        timeout: { value: 60, origin: "new", quote: "timeout is 60" },
        edit_protected: {
          value: false,
          origin: "new",
          quote: "do not touch secrets.json",
        },
      },
    },
  ];
  let index = 0;
  const runner: CodexRunner = () => ({
    status: 0,
    stderr: "",
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: `denial-${index}` }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(answers[index++]) },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10 } }),
    ].join("\n"),
  });
  const captured = runTwoPassCodexTaskCapture(
    "Please update config.json so timeout is 60 and do not touch secrets.json",
    null,
    { sequence: 1, session_id: "optional-denial", runner },
  );
  assert.equal(captured.event!.facts.target_file, "config.json");
  assert.equal(captured.event!.facts.timeout, 60);
  assert.equal(Object.hasOwn(captured.event!.facts, "edit_protected"), false);
});

test("task capture drops an environment inferred only from a superseded mention", () => {
  const base = {
    actionable: true,
    continues_previous: true,
    fields: {
      target_file: {
        value: "services/api/config.json",
        origin: "new",
        quote: "services/api/config.json",
      },
      timeout: { value: 61, origin: "new", quote: "timeout to 61" },
      edit_protected: {
        value: false,
        origin: "new",
        quote: "do not edit protected files",
      },
    },
  };
  const answers = [
    {
      ...base,
      fields: {
        ...base.fields,
        environment: { value: "staging", origin: "new", quote: "staging" },
      },
    },
    base,
  ];
  let run = 0;
  const runner: CodexRunner = () => ({
    status: 0,
    stderr: "",
    stdout: [
      JSON.stringify({
        type: "thread.started",
        thread_id: `environment-${run}`,
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(answers[run++]!),
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100 } }),
    ].join("\n"),
  });
  const previous: TraceEvent = {
    event_id: "old-staging",
    source: "user",
    kind: "state",
    entity: "release:one",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: { target_file: "staging/config.json", timeout: 30 },
    links: {},
    text: "Use staging/config.json.",
  };
  const captured = runTwoPassCodexTaskCapture(
    "Replace the earlier staging instruction. Set services/api/config.json timeout to 61 and do not edit protected files.",
    previous,
    { sequence: 2, session_id: "environment", runner },
  );
  assert.equal(Object.hasOwn(captured.event!.facts, "environment"), false);
});

test("task capture drops a false protected-edit field inferred from general file scope", () => {
  const answer = JSON.stringify({
    actionable: true,
    continues_previous: false,
    fields: {
      target_file: {
        value: "config.json",
        origin: "new",
        quote: "config.json",
      },
      timeout: { value: 49, origin: "new", quote: "timeout to 49" },
      edit_protected: {
        value: false,
        origin: "new",
        quote: "do not edit any other file",
      },
    },
  });
  let run = 0;
  const runner: CodexRunner = () => ({
    status: 0,
    stderr: "",
    stdout: [
      JSON.stringify({
        type: "thread.started",
        thread_id: `general-scope-${++run}`,
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: answer },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100 },
      }),
    ].join("\n"),
  });
  const captured = runTwoPassCodexTaskCapture(
    "Set config.json timeout to 49; do not edit any other file.",
    null,
    { sequence: 1, session_id: "general-scope", runner },
  );
  assert.equal(captured.event?.facts.timeout, 49);
  assert.equal(captured.event?.facts.edit_protected, undefined);
  assert.deepEqual(captured.event?.facts.field_sources, {
    target_file: captured.event?.event_id,
    timeout: captured.event?.event_id,
  });
});

test("task capture fails closed on reviewer disagreement and carried permission", () => {
  const answers = [
    {
      actionable: true,
      continues_previous: false,
      fields: {
        target_file: { value: "a.json", origin: "new", quote: "a.json" },
      },
    },
    {
      actionable: true,
      continues_previous: false,
      fields: {
        target_file: { value: "b.json", origin: "new", quote: "b.json" },
      },
    },
  ];
  let run = 0;
  const runner: CodexRunner = () => {
    const answer = JSON.stringify(answers[run]!);
    run += 1;
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: `different-${run}`,
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: answer },
        }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n"),
    };
  };
  assert.throws(
    () =>
      runTwoPassCodexTaskCapture("Use a.json and b.json", null, {
        sequence: 1,
        session_id: "s",
        runner,
      }),
    /disagreed/i,
  );
});

test("task capture errors preserve completed provider usage for cost accounting", () => {
  let run = 0;
  const runner: CodexRunner = () => {
    run += 1;
    if (run === 2)
      return { status: 1, stdout: "", stderr: "connection failed" };
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "partial-first" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              actionable: true,
              continues_previous: false,
              fields: {
                target_file: {
                  value: "a.json",
                  origin: "new",
                  quote: "a.json",
                },
              },
            }),
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 123 },
        }),
      ].join("\n"),
    };
  };
  assert.throws(
    () =>
      runTwoPassCodexTaskCapture("Use a.json", null, {
        sequence: 1,
        session_id: "partial",
        runner,
      }),
    (error) => {
      assert.ok(error instanceof CodexTaskCaptureError);
      assert.equal(error.completed_input_tokens, 123);
      assert.equal(error.run_attestations.length, 1);
      return true;
    },
  );
});

test("Codex native hooks record prompts and tool status, then deny a stale real tool call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-codex-hook-"));
  const session = "codex-hook-session";
  try {
    await handleCodexRuntimeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        turn_id: "turn-1",
        cwd: directory,
        model: "gpt-5.6-luna",
        prompt: "Change production timeout to 60.",
      },
      { runtimeDirectory: directory },
    );
    await handleCodexRuntimeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: session,
        turn_id: "turn-1",
        cwd: directory,
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "git status" },
        tool_response: { exit_code: 0 },
      },
      { runtimeDirectory: directory },
    );
    const recording = await readFile(
      join(directory, `${codexRuntimeStem(session)}.recording.jsonl`),
      "utf8",
    );
    const lines = recording
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.event, line.success ?? null]),
      [
        ["user_prompt", null],
        ["tool_result", true],
      ],
    );

    const events = await loadJsonl("examples/stale-action.jsonl");
    const proposal = JSON.parse(
      await readFile("examples/relation-proposal.json", "utf8"),
    );
    const review = JSON.parse(
      await readFile("examples/relation-review.json", "utf8"),
    );
    await writeFile(
      join(directory, `${codexRuntimeStem(session)}.guard.json`),
      JSON.stringify(compileExecutorGuard(events, proposal, review)),
    );
    const denied = await handleCodexRuntimeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: session,
        cwd: directory,
        tool_name: "apply_patch",
        tool_input: {
          command:
            '*** Begin Patch\n*** Update File: staging/config.json\n@@\n-{"timeout":60}\n+{"timeout":30}\n*** End Patch',
        },
      },
      { runtimeDirectory: directory },
    );
    assert.equal(
      (denied?.hookSpecificOutput as Record<string, unknown>)
        .permissionDecision,
      "deny",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex PreToolUse performs one read-only scalar recovery and then fails closed", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "contextadapt-codex-recovery-"),
  );
  const session = "codex-recovery-session";
  try {
    await mkdir(join(directory, "production"));
    await writeFile(
      join(directory, "production/config.json"),
      '{"environment":"production","timeout":45,"retries":3}\n',
    );
    const events = await loadJsonl("examples/stale-action.jsonl");
    const proposal = JSON.parse(
      await readFile("examples/relation-proposal.json", "utf8"),
    );
    const review = JSON.parse(
      await readFile("examples/relation-review.json", "utf8"),
    );
    await writeFile(
      join(directory, `${codexRuntimeStem(session)}.guard.json`),
      JSON.stringify(compileExecutorGuard(events, proposal, review)),
    );
    await handleCodexRuntimeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        turn_id: "turn-recovery",
        cwd: directory,
        prompt: "Use the current production timeout.",
      },
      { runtimeDirectory: directory },
    );
    const stalePatch =
      '*** Begin Patch\n*** Update File: production/config.json\n@@\n-{"timeout":45}\n+{"environment":"production","timeout":30}\n*** End Patch';
    const first = await handleCodexRuntimeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: session,
        turn_id: "turn-recovery",
        cwd: directory,
        tool_name: "apply_patch",
        tool_use_id: "stale-first",
        tool_input: { command: stalePatch },
      },
      { runtimeDirectory: directory },
    );
    const firstReason = String(
      (first?.hookSpecificOutput as Record<string, unknown>)
        .permissionDecisionReason,
    );
    assert.match(firstReason, /one read-only recovery/i);
    assert.match(firstReason, /"timeout":45/);

    const exhausted = await handleCodexRuntimeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: session,
        turn_id: "turn-recovery",
        cwd: directory,
        tool_name: "apply_patch",
        tool_use_id: "stale-second",
        tool_input: { command: stalePatch },
      },
      { runtimeDirectory: directory },
    );
    assert.match(
      String(
        (exhausted?.hookSpecificOutput as Record<string, unknown>)
          .permissionDecisionReason,
      ),
      /budget is exhausted/i,
    );

    const current = await handleCodexRuntimeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: session,
        turn_id: "turn-recovery",
        cwd: directory,
        tool_name: "apply_patch",
        tool_use_id: "current",
        tool_input: {
          command:
            '*** Begin Patch\n*** Update File: production/config.json\n@@\n-{"timeout":45}\n+{"environment":"production","timeout":60}\n*** End Patch',
        },
      },
      { runtimeDirectory: directory },
    );
    assert.equal(current, null);
    const recording = (
      await readFile(
        join(directory, `${codexRuntimeStem(session)}.recording.jsonl`),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      recording.filter((line) => line.event === "recovery_read").length,
      1,
    );
    assert.equal(
      recording.filter((line) => line.event === "recovery_exhausted").length,
      1,
    );
    assert.deepEqual(
      recording
        .filter((line) => line.event === "pre_tool_gate")
        .map((line) => line.decision),
      ["BLOCK", "BLOCK", "ALLOW"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("controlled Codex runner selects 400K before one Agent call and writes its guard first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-codex-runner-"));
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ timeout: 45, retries: 3 }),
  );
  const session = emptyCodexAdaptiveSession("adaptive-codex-test");
  session.events.push({
    event_id: "old-task",
    source: "user",
    kind: "state",
    entity: "ticket:config",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "config.json",
      environment: "production",
      timeout: 30,
      semantic_reviewed: true,
      semantic_run_ids: ["codex:old-a", "codex:old-b"],
    },
    links: {},
    text: "OLD config.json is production with timeout 30.",
  });
  session.messages.push(
    { role: "user", text: "OLD config.json is production with timeout 30." },
    { role: "tool", text: "NOISE from a long completed tool loop." },
  );
  const prompt = "Keep config.json in production, but change timeout to 60.";
  const captured: TraceEvent = {
    event_id: "current-task",
    source: "user",
    kind: "state",
    entity: "ticket:config",
    sequence: 2,
    observed_at: null,
    success: null,
    facts: {
      target_file: "config.json",
      environment: "production",
      timeout: 60,
      field_sources: {
        target_file: "current-task",
        environment: "old-task",
        timeout: "current-task",
      },
      semantic_reviewed: true,
      semantic_run_ids: ["codex:new-a", "codex:new-b"],
      semantic_preflight_input_tokens: 200,
    },
    links: { replaces: "old-task" },
    text: prompt,
  };
  let receivedInput = "";
  const runner: CodexRunner = (_command, _args, options) => {
    receivedInput = options.input;
    const observedAt = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(
      join(directory, ".contextadapt/runtime/test.recording.jsonl"),
      [
        { event: "user_prompt", observed_at: observedAt },
        {
          event: "pre_tool_gate",
          observed_at: observedAt,
          in_scope: true,
          decision: "ALLOW",
        },
        {
          event: "tool_result",
          observed_at: observedAt,
          phase: "execution",
          tool_name: "apply_patch",
        },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    );
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "task-agent" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Updated config safely." },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 310_000 },
        }),
      ].join("\n"),
    };
  };
  try {
    const result = await runCodexAdaptiveTurn(session, prompt, {
      cwd: directory,
      runner,
      model_context_window: 950_000,
      captureTask: () => ({
        event: captured,
        preflight_input_tokens: 200,
        run_attestations: [{}, {}],
      }),
      requireInstalledHook: false,
      countTokens: (text) =>
        text.includes("OLD")
          ? 80_000
          : text.includes("NOISE")
            ? 160_000
            : 30_000,
    });
    assert.equal(result.recommendation.recommended_tier, "400K");
    assert.equal(result.agent_called, true);
    assert.deepEqual(result.hook_attestation, {
      hooks_observed: true,
      user_prompt_events: 1,
      pre_tool_gate_events: 1,
      post_tool_result_events: 1,
      allowed_mutation_gates: 1,
      execution_result_events: 1,
    });
    assert.equal(result.actual_agent_input_tokens, 310_000);
    assert.equal(result.actual_total_input_tokens, 310_200);
    assert.equal(result.session.observed_fixed_input_tokens, 10_000);
    assert.match(receivedInput, /OLD config\.json/);
    assert.match(receivedInput, /NOISE from a long/);
    const guard = JSON.parse(
      await readFile(
        join(directory, ".contextadapt/executor-guard.json"),
        "utf8",
      ),
    );
    assert.equal(guard.current_event_id, "current-task");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow runner freezes one capture and replays largest versus adaptive from identical files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-codex-shadow-"));
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ environment: "production", timeout: 45, retries: 3 }),
  );
  const session = emptyCodexAdaptiveSession("shadow-native-session");
  session.events.push({
    event_id: "old-shadow-task",
    source: "user",
    kind: "state",
    entity: "ticket:shadow",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "config.json",
      environment: "production",
      timeout: 45,
      semantic_reviewed: true,
      semantic_run_ids: ["old:a", "old:b"],
    },
    links: {},
    text: "Use config.json in the production environment with timeout 45.",
  });
  session.messages.push(
    {
      role: "user",
      text: "Use config.json in the production environment with timeout 45.",
    },
    { role: "tool", text: "NOISE from a completed native tool audit." },
  );
  const prompt = "Correction: set config.json timeout to 60.";
  const captured: TraceEvent = {
    event_id: "current-shadow-task",
    source: "user",
    kind: "state",
    entity: "ticket:shadow",
    sequence: 2,
    observed_at: null,
    success: null,
    facts: {
      target_file: "config.json",
      environment: "production",
      timeout: 60,
      field_sources: {
        target_file: "current-shadow-task",
        environment: "old-shadow-task",
        timeout: "current-shadow-task",
      },
      semantic_reviewed: true,
      semantic_run_ids: ["new:a", "new:b"],
    },
    links: { replaces: "old-shadow-task" },
    text: prompt,
  };
  let captureCount = 0;
  let taskRun = 0;
  const runner: CodexRunner = (_command, _args, options) => {
    taskRun += 1;
    writeFileSync(
      join(options.cwd, "config.json"),
      JSON.stringify({ environment: "production", timeout: 60, retries: 3 }),
    );
    return {
      status: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: `shadow-task-${taskRun}`,
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "apply config change",
            aggregated_output: "updated",
            exit_code: 0,
            status: "completed",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Updated and verified." },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: taskRun === 1 ? 850_000 : 350_000 },
        }),
      ].join("\n"),
    };
  };
  try {
    const result = await runCodexShadowPair(session, prompt, {
      cwd: directory,
      runner,
      requireInstalledHook: false,
      captureTask: () => {
        captureCount += 1;
        return {
          event: captured,
          preflight_input_tokens: 200,
          run_attestations: [
            { thread_id_sha256: "capture-a" },
            { thread_id_sha256: "capture-b" },
          ],
        };
      },
      fixed_input_tokens: 0,
      countTokens: (text) =>
        text.includes("production environment")
          ? 80_000
          : text.includes("NOISE")
            ? 250_000
            : 30_000,
    });
    assert.equal(captureCount, 1);
    assert.equal(taskRun, 2);
    assert.equal(result.paired_initial_state_match, true);
    assert.equal(result.policies["always-largest"].selected_tier, "1M_WINDOW");
    assert.equal(result.policies.contextadapt.selected_tier, "400K");
    assert.equal(
      result.policies["always-largest"].verification.task_success,
      true,
    );
    assert.equal(result.policies.contextadapt.verification.task_success, true);
    assert.equal(
      result.policies.contextadapt.verification.execution_safety,
      true,
    );
    assert.equal(result.verdict, "IMPROVED");
    assert.equal(result.paired_savings.meets_product_bar, true);
    assert.ok(result.paired_savings.percent >= 25);
    assert.deepEqual(
      result.policies.contextadapt.verification.changed_file_sha256,
      [createHash("sha256").update("config.json").digest("hex")],
    );
    assert.doesNotMatch(JSON.stringify(result), /config\.json/);
    assert.equal(
      JSON.parse(await readFile(join(directory, "config.json"), "utf8"))
        .timeout,
      45,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow replay rejects a symlink that could escape the isolated workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-shadow-link-"));
  const external = await mkdtemp(
    join(tmpdir(), "contextadapt-shadow-outside-"),
  );
  const outsideFile = join(external, "outside.json");
  await writeFile(
    outsideFile,
    JSON.stringify({ environment: "production", timeout: 45, retries: 3 }),
  );
  await symlink(outsideFile, join(directory, "config.json"));
  const session = emptyCodexAdaptiveSession("shadow-symlink-session");
  const prompt = "Set config.json timeout to 60.";
  const captured: TraceEvent = {
    event_id: "current-shadow-symlink",
    source: "user",
    kind: "state",
    entity: "task:shadow-symlink",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "config.json",
      timeout: 60,
      field_sources: {
        target_file: "current-shadow-symlink",
        timeout: "current-shadow-symlink",
      },
      semantic_reviewed: true,
      semantic_run_ids: ["capture:a", "capture:b"],
    },
    links: {},
    text: prompt,
  };
  try {
    await assert.rejects(
      runCodexShadowPair(session, prompt, {
        cwd: directory,
        requireInstalledHook: false,
        captureTask: () => ({
          event: captured,
          preflight_input_tokens: 0,
          run_attestations: [
            { thread_id_sha256: "capture-a" },
            { thread_id_sha256: "capture-b" },
          ],
        }),
      }),
      /unsafe workspace symlink escapes replay root/,
    );
    assert.equal(JSON.parse(await readFile(outsideFile, "utf8")).timeout, 45);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("Codex hook installer preserves existing hooks and is idempotent", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "contextadapt-codex-install-"),
  );
  await mkdir(join(directory, ".codex"));
  await writeFile(
    join(directory, ".codex/hooks.json"),
    JSON.stringify({
      description: "user hooks",
      hooks: {
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: "mine" }] }],
      },
    }),
  );
  try {
    const first = await installCodexRuntimeHooks(
      directory,
      "contextadapt host-hook codex",
    );
    const second = await installCodexRuntimeHooks(
      directory,
      "contextadapt host-hook codex",
    );
    assert.deepEqual(first.added, [
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
    ]);
    assert.deepEqual(second.added, []);
    const installed = JSON.parse(
      await readFile(join(directory, ".codex/hooks.json"), "utf8"),
    );
    assert.equal(installed.description, "user hooks");
    assert.equal(installed.hooks.Stop[0].hooks[0].command, "mine");
    assert.equal(installed.hooks.PreToolUse.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex App Server adapter performs native read, inject, and completed Luna turn over JSONL", async () => {
  const server = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const thread = (id, turns = []) => ({ id, turns, ephemeral: true, sessionId: id + "-session", cwd: process.cwd(), modelProvider: "openai" });
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    if (message.method === "initialized") continue;
    if (message.method === "initialize") reply({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
    if (message.method === "thread/read") reply({ id: message.id, result: { thread: thread(message.params.threadId, [{ id: "old", items: [], status: "completed" }]) } });
    if (message.method === "thread/start") reply({ id: message.id, result: { thread: thread("started") } });
    if (message.method === "thread/fork") reply({ id: message.id, result: { thread: thread("forked") } });
    if (message.method === "thread/inject_items") reply({ id: message.id, result: {} });
    if (message.method === "turn/start") {
      const turn = { id: "turn-live", items: [], status: "inProgress", error: null };
      reply({ id: message.id, result: { turn } });
      reply({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: turn.id, tokenUsage: { total: { inputTokens: 123 }, last: { inputTokens: 123 }, modelContextWindow: 950000 } } });
      reply({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", items: [{ type: "agentMessage", id: "answer", text: "ok" }] } } });
    }
  }
});`;
  const client = await CodexAppServerClient.connect({
    command: process.execPath,
    args: ["-e", server],
    requestTimeoutMs: 5_000,
  });
  try {
    const read = await client.threadRead("native-thread");
    assert.equal(read.id, "native-thread");
    assert.equal(read.turns.length, 1);
    const started = await client.threadStart({ cwd: process.cwd() });
    assert.equal(started.id, "started");
    const forked = await client.threadFork({
      threadId: read.id,
      cwd: process.cwd(),
    });
    assert.equal(forked.id, "forked");
    await client.threadInjectItems(forked.id, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "history" }],
      },
    ]);
    const turn = await client.startTurn({
      threadId: forked.id,
      prompt: "Answer safely.",
    });
    assert.deepEqual(turn.agent_messages, ["ok"]);
    assert.equal(
      (turn.token_usage!.last as Record<string, unknown>).inputTokens as number,
      123,
    );
    assert.doesNotMatch(JSON.stringify(turn), /native-thread/);
  } finally {
    client.close();
  }
});

test("passive Codex opt-in stores the raw thread reference only in a mode-0600 private file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-passive-ref-"));
  try {
    const installed = await installCodexRuntimeHooks(
      directory,
      "contextadapt host-hook codex",
      { passiveCohort: true },
    );
    assert.equal(installed.passive_cohort, true);
    const hooks = JSON.parse(
      await readFile(join(directory, ".codex/hooks.json"), "utf8"),
    );
    assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /--shadow-only/);
    await handleCodexRuntimeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "raw-private-thread-id",
      turn_id: "turn-private",
      cwd: directory,
      prompt: "ordinary private prompt",
    });
    const observed = await handleCodexRuntimeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "raw-private-thread-id",
        turn_id: "turn-private",
        cwd: directory,
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\\n*** Update File: config.json\\n*** End Patch",
        },
      },
      { shadowOnly: true },
    );
    assert.equal(observed, null);
    const reference = await loadLatestCodexPrivateSessionReference(directory);
    assert.equal(reference.thread_id, "raw-private-thread-id");
    const referencePath = join(
      directory,
      ".contextadapt/private",
      `${codexRuntimeStem(reference.thread_id)}.codex-session.json`,
    );
    assert.equal((await stat(referencePath)).mode & 0o777, 0o600);
    const publicRecording = await readFile(
      join(
        directory,
        ".contextadapt/runtime",
        `${codexRuntimeStem(reference.thread_id)}.recording.jsonl`,
      ),
      "utf8",
    );
    assert.doesNotMatch(publicRecording, /raw-private-thread-id/);
    assert.match(publicRecording, /pre_tool_shadow/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passive Codex observation derives a 200K decision and writes a real session guard without leaking raw content", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "contextadapt-passive-observe-"),
  );
  const threadId = "private-native-thread";
  const prompt = "Set config.json timeout to 60.";
  try {
    await writeFile(
      join(directory, "config.json"),
      '{"timeout":45,"retries":3}\n',
    );
    await handleCodexRuntimeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "turn-one",
        cwd: directory,
        prompt,
      },
      { retainSessionReference: true },
    );
    await handleCodexRuntimeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: threadId,
        turn_id: "turn-one",
        cwd: directory,
        tool_name: "apply_patch",
        tool_input: {
          command:
            '*** Begin Patch\n*** Update File: config.json\n@@\n-  \\"timeout\\": 45\n+  \\"timeout\\": 60\n*** End Patch',
        },
      },
      { shadowOnly: true },
    );
    const nativeThread: CodexAppServerThread = {
      id: threadId,
      sessionId: "private-session-tree",
      modelProvider: "openai",
      cwd: directory,
      ephemeral: false,
      turns: [
        {
          id: "turn-one",
          status: "completed",
          items: [
            {
              type: "userMessage",
              id: "user-one",
              clientId: null,
              content: [{ type: "text", text: prompt, text_elements: [] }],
            },
            {
              type: "agentMessage",
              id: "agent-one",
              text: "Done.",
            },
          ],
        },
      ],
    };
    const result = await observeCodexPassiveSession({
      cwd: directory,
      fixed_input_tokens: 10,
      forceAnalysis: true,
      appServer: { threadRead: async () => nativeThread },
      captureTask: async (_text, _previous, options) => {
        const eventId = `task:${options.sequence}`;
        return {
          event: {
            event_id: eventId,
            source: "user",
            kind: "state",
            entity: "task:config",
            sequence: options.sequence,
            observed_at: new Date().toISOString(),
            success: null,
            facts: {
              target_file: "config.json",
              timeout: 60,
              field_sources: {
                target_file: eventId,
                timeout: eventId,
              },
              semantic_reviewed: true,
              semantic_run_ids: ["codex:review-a", "codex:review-b"],
              semantic_preflight_input_tokens: 24,
            },
            links: {},
            text: prompt,
          },
          preflight_input_tokens: 24,
          run_attestations: [
            { provider: "codex-cli", thread_id_sha256: "review-a" },
            { provider: "codex-cli", thread_id_sha256: "review-b" },
          ],
        };
      },
    });
    assert.equal(result.report.cohort_bucket, "200K");
    assert.equal(result.report.decision.recommendation, "USE_200K");
    assert.equal(result.report.execution_gate.status, "READY");
    assert.equal(result.report.execution_gate.session_guard_written, true);
    assert.equal(result.report.hook_attestation.pre_tool_gate_events, 0);
    assert.equal(
      result.report.hook_attestation.primary_hook_mode,
      "observe_only",
    );
    assert.equal(result.report.hook_attestation.snapshot_target_count, 1);
    assert.equal(result.report.hook_attestation.replayable_snapshot, true);
    assert.equal(result.replay!.prompt, prompt);
    assert.deepEqual(result.replay!.session.messages, []);
    assert.equal(result.replay!.initial_files[0]!.target, "config.json");
    assert.match(result.replay!.initial_files[0]!.content!, /"timeout":45/);
    const serialized = JSON.stringify(result.report);
    assert.doesNotMatch(serialized, /private-native-thread/);
    assert.doesNotMatch(serialized, /private-session-tree/);
    assert.doesNotMatch(serialized, /config\.json|Set config|ordinary private/);
    const guard = JSON.parse(
      await readFile(
        join(
          directory,
          ".contextadapt/runtime",
          `${codexRuntimeStem(threadId)}.guard.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(guard.current_event_id, "task:1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passive Codex observation stays out and makes zero semantic calls when full history fits 200K", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-passive-null-"));
  const threadId = "small-native-thread";
  try {
    await handleCodexRuntimeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "small-turn",
        cwd: directory,
        prompt: "Explain this small project.",
      },
      { retainSessionReference: true },
    );
    const result = await observeCodexPassiveSession({
      cwd: directory,
      appServer: {
        threadRead: async () => ({
          id: threadId,
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  id: "small-user",
                  content: [
                    {
                      type: "text",
                      text: "Explain this small project.",
                      text_elements: [],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
      captureTask: async () => {
        throw new Error("semantic capture must not run on the NULL fast path");
      },
    });
    assert.equal(result.report.cohort_bucket, "NULL");
    assert.equal(result.report.decision.recommendation, "NULL");
    assert.equal(
      result.report.decision.null_reason,
      "full_history_fits_200k_without_selection",
    );
    assert.equal(result.report.task_capture.semantic_calls, 0);
    assert.equal(result.report.task_capture.semantic_preflight_input_tokens, 0);
    assert.equal(result.replay, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider-native boundary batches more than the legacy CLI character ceiling and keeps only sanitized evidence", async () => {
  let injectedBatches = 0;
  let injectedItems = 0;
  const report = await runCodexNativeBoundary({
    cwd: process.cwd(),
    contentChars: 1_060_000,
    appServer: {
      threadStart: async () => ({
        id: "raw-boundary-thread",
        turns: [],
      }),
      threadInjectItems: async (_threadId, items) => {
        injectedBatches += 1;
        injectedItems += items.length;
      },
      startTurn: async () => ({
        thread_id_sha256: "thread-hash",
        turn_id_sha256: "turn-hash",
        turn: { id: "turn", status: "completed", items: [] },
        token_usage: {
          last: { inputTokens: 310_000, cachedInputTokens: 0 },
          modelContextWindow: 950_000,
        },
        agent_messages: [
          JSON.stringify({
            first: "CA-FIRST-7F31",
            middle: "CA-MIDDLE-4B92",
            last: "CA-LAST-9D06",
          }),
        ],
      }),
    },
  });
  assert.equal(report.injected.exceeded_legacy_single_request_chars, true);
  assert.ok(injectedBatches > 1);
  assert.equal(report.injected.batch_count, injectedBatches);
  assert.equal(report.injected.item_count, injectedItems);
  assert.equal(report.provider_usage.actual_input_tokens, 310_000);
  assert.equal(report.provider_usage.requested_context_window, null);
  assert.equal(report.verification.marker_match, true);
  assert.doesNotMatch(JSON.stringify(report), /raw-boundary-thread|CA-FIRST/);
  assert.match(report.claim_scope, /not natural-session product value/);
});
