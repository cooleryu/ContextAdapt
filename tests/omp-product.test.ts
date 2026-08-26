import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TraceEvent } from "../packages/core/src/index.js";
import {
  createOmpExtension,
  installOmpHost,
  resolveOmpReviewModel,
  type OmpAdaptiveDecision,
  type OmpContext,
} from "../packages/omp/src/index.js";

test("OMP defaults task review to Luna and permits an explicit low-cost reviewer override", () => {
  assert.equal(resolveOmpReviewModel(undefined, undefined), "gpt-5.6-luna");
  assert.equal(
    resolveOmpReviewModel(" reviewer-model ", "ignored-model"),
    "reviewer-model",
  );
  assert.equal(resolveOmpReviewModel(undefined, " env-model "), "env-model");
  assert.throws(
    () => resolveOmpReviewModel(undefined, "  "),
    /must not be empty/,
  );
});

test("OMP host installer links the package through OMP's native plugin registry and verifies discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-omp-install-"));
  const entry = join(directory, "dist/packages/omp/src/index.js");
  const calls: string[][] = [];
  try {
    await mkdir(join(directory, "dist/packages/omp/src"), { recursive: true });
    await writeFile(entry, "export default function () {}\n");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "contextadapt",
        omp: { extensions: ["./dist/packages/omp/src/index.js"] },
      }),
    );
    const result = installOmpHost({
      packageRoot: directory,
      ompCommand: "/fake/omp",
      runner: (_command, args) => {
        calls.push(args);
        if (args[0] === "--version") {
          return { status: 0, stdout: "omp/17.4.2\n", stderr: "" };
        }
        if (args[1] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify({ plugins: [{ name: "contextadapt" }] }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(result.linked, true);
    assert.equal(result.verified_by_plugin_list, true);
    assert.deepEqual(calls[1], [
      "plugin",
      "link",
      directory,
      "--scope",
      "user",
      "--json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OMP keeps a complete small history without task AI, then builds the gate before the first real mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-omp-product-"));
  const handlers = new Map<
    string,
    (event: unknown, context: OmpContext) => Promise<unknown>
  >();
  const decisions: OmpAdaptiveDecision[] = [];
  const notifications: string[] = [];
  let captureCalls = 0;
  const prompt =
    "Set config.json timeout to 60, preserve retries, and do not touch secrets.json.";
  const captured: TraceEvent = {
    event_id: "task-current",
    source: "user",
    kind: "state",
    entity: "ticket:product",
    sequence: 1,
    observed_at: null,
    success: null,
    facts: {
      target_file: "config.json",
      timeout: 60,
      edit_protected: false,
      field_sources: {
        target_file: "task-current",
        timeout: "task-current",
        edit_protected: "task-current",
      },
      semantic_reviewed: true,
      semantic_run_ids: ["luna:a", "luna:b"],
      semantic_preflight_input_tokens: 200,
    },
    links: {},
    text: prompt,
  };
  try {
    await writeFile(
      join(directory, "config.json"),
      '{"timeout":45,"retries":3}\n',
    );
    await writeFile(join(directory, "secrets.json"), '{"token":"keep"}\n');
    createOmpExtension({
      persist: false,
      fixedInputTokens: 1_000,
      captureTask: () => {
        captureCalls += 1;
        return {
          event: captured,
          preflight_input_tokens: 200,
          run_attestations: [{}, {}],
        };
      },
      onDecision: (decision) => decisions.push(decision),
    })({
      on: (event, handler) => {
        handlers.set(event, async (value, context) => handler(value, context));
      },
    });
    const context: OmpContext = {
      cwd: directory,
      model: { contextWindow: 1_000_000 },
      getContextUsage: () => ({
        tokens: 80_000,
        contextWindow: 1_000_000,
        percent: 8,
      }),
      sessionManager: { getSessionId: () => "omp-product-session" },
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    };
    await handlers.get("before_agent_start")!(
      { prompt, systemPrompt: [] },
      context,
    );
    assert.equal(captureCalls, 0);

    const messages = [{ role: "user", content: prompt }];
    const routed = (await handlers.get("context")!({ messages }, context)) as {
      messages: unknown[];
    };
    assert.deepEqual(routed.messages, messages);
    assert.equal(captureCalls, 0);
    assert.equal(decisions[0]!.decision_mode, "FULL_HISTORY_FITS_200K");
    assert.equal(decisions[0]!.gate_status, "DEFERRED_UNTIL_MUTATION");
    assert.equal(decisions[0]!.semantic_preflight_input_tokens, 0);
    assert.match(notifications[0]!, /use 200K/i);
    assert.match(notifications[0]!, /no fabricated savings/i);

    const stale = (await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "wrong-value",
        input: {
          path: "config.json",
          content: '{"timeout":30,"retries":3}\n',
        },
      },
      context,
    )) as { block: boolean; reason: string };
    assert.equal(captureCalls, 1);
    assert.equal(stale.block, true);

    const allowed = await handlers.get("tool_call")!(
      {
        toolName: "write",
        toolCallId: "current-value",
        input: {
          path: "config.json",
          content: '{"timeout":60,"retries":3}\n',
        },
      },
      context,
    );
    assert.equal(allowed, undefined);
    assert.equal(captureCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OMP defers semantic capture when first-turn usage is unavailable because context is the pre-provider authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextadapt-omp-no-usage-"));
  const handlers = new Map<
    string,
    (event: unknown, context: OmpContext) => Promise<unknown>
  >();
  let captureCalls = 0;
  const decisions: OmpAdaptiveDecision[] = [];
  try {
    createOmpExtension({
      persist: false,
      onDecision: (decision) => decisions.push(decision),
      captureTask: () => {
        captureCalls += 1;
        return {
          event: null,
          preflight_input_tokens: 0,
          run_attestations: [{}, {}],
        };
      },
    })({
      on: (event, handler) => {
        handlers.set(event, async (value, context) => handler(value, context));
      },
    });
    const context: OmpContext = {
      cwd: directory,
      getContextUsage: () => undefined,
      sessionManager: { getSessionId: () => "omp-no-usage-session" },
      hasUI: false,
    };
    const prompt = "Explain this repository without changing files.";
    await handlers.get("before_agent_start")!({ prompt }, context);
    assert.equal(captureCalls, 0);
    const messages = [{ role: "user", content: prompt }];
    const routed = (await handlers.get("context")!({ messages }, context)) as {
      messages: unknown[];
    };
    assert.deepEqual(routed.messages, messages);
    assert.equal(captureCalls, 0);
    assert.equal(decisions[0]?.recommended_tier, "200K");
    assert.equal(
      decisions[0]?.context_window_source,
      "FAIL_CLOSED_200K_FALLBACK",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
