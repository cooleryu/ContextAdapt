import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileRuntimeExecutorGuard,
  prepareAdaptiveContext,
  type HostContextItem,
  type TraceEvent,
} from "../packages/core/src/index.js";

function event(
  eventId: string,
  source: string,
  kind: TraceEvent["kind"],
  sequence: number,
  text: string,
  facts: Record<string, unknown>,
  options: Partial<TraceEvent> = {},
): TraceEvent {
  return {
    event_id: eventId,
    source,
    kind,
    entity: options.entity ?? null,
    sequence,
    observed_at: null,
    success: options.success ?? null,
    facts,
    links: options.links ?? {},
    text,
  };
}

const item = (
  id: string,
  role: HostContextItem["role"],
  text: string,
  tokenCount: number,
): HostContextItem => ({
  id,
  role,
  text,
  token_count: tokenCount,
  value: { role, text },
});

function runtimeFixture(): { events: TraceEvent[]; items: HostContextItem[] } {
  const events: TraceEvent[] = [
    event(
      "policy-current",
      "policy",
      "policy",
      1,
      "Host policy for production/config.json.",
      {
        resource: "production/config.json",
        protected: false,
        always_visible: true,
      },
      { entity: "resource:production/config.json" },
    ),
    event(
      "task-old",
      "user",
      "state",
      10,
      "Use staging/config.json with timeout 30.",
      {
        target_file: "staging/config.json",
        timeout: 30,
        semantic_reviewed: true,
        semantic_run_ids: ["luna:a", "luna:b"],
      },
      { entity: "ticket:deploy" },
    ),
    event(
      "read-current",
      "read_file",
      "observation",
      20,
      "Current file has timeout 45 and retries 3.",
      { target_file: "production/config.json", timeout: 45, retries: 3 },
      { entity: "file:production/config.json", success: true },
    ),
    event(
      "task-current",
      "user",
      "state",
      30,
      "Correction: use production/config.json with timeout 60; do not edit protected files.",
      {
        target_file: "production/config.json",
        timeout: 60,
        edit_protected: false,
        semantic_reviewed: true,
        semantic_run_ids: ["luna:c", "luna:d"],
      },
      { entity: "ticket:deploy", links: { replaces: "task-old" } },
    ),
  ];
  const items = [
    item("old", "user", events[1]!.text, 80_000),
    item("noise-a", "tool", "tool noise a", 310_000),
    item("read", "tool", events[2]!.text, 20_000),
    item("current", "user", events[3]!.text, 20_000),
    item("noise-b", "tool", "tool noise b", 170_000),
  ];
  return { events, items };
}

test("recorder measures token positions, recommends 400K, and renders that exact suffix", () => {
  const { events, items } = runtimeFixture();
  const prepared = prepareAdaptiveContext(events, items, {
    trace_id: "runtime",
    fixed_input_tokens: 10_000,
    available_context_tokens: 900_000,
  });

  assert.equal(prepared.recommendation.recommended_tier, "400K");
  assert.deepEqual(
    prepared.selected_items.map((entry) => entry.id),
    ["read", "current", "noise-b"],
  );
  const current = prepared.events.find(
    (entry) => entry.event_id === "task-current",
  );
  assert.deepEqual(current?.context_span, {
    start_token: 420_000,
    end_token: 440_000,
  });
  const profile = prepared.events.find(
    (entry) => entry.entity === "context:profile",
  );
  assert.deepEqual(profile?.facts.tier_window_starts, {
    "200K": 420_000,
    "400K": 400_000,
    "1M_WINDOW": 10_000,
  });
});

test("small sessions honestly choose 200K with zero fabricated savings", () => {
  const task = event(
    "task",
    "user",
    "state",
    1,
    "Set app/config.json timeout to 60.",
    {
      target_file: "app/config.json",
      timeout: 60,
      semantic_reviewed: true,
      semantic_run_ids: ["luna:a", "luna:b"],
    },
    { entity: "ticket:small" },
  );
  const policy = event(
    "policy",
    "policy",
    "policy",
    2,
    "Host policy.",
    { resource: "app/config.json", protected: false, always_visible: true },
    { entity: "resource:app/config.json" },
  );
  const observation = event(
    "read",
    "read_file",
    "observation",
    3,
    "Current timeout is 45.",
    { target_file: "app/config.json", timeout: 45 },
    { entity: "file:app/config.json", success: true },
  );
  const prepared = prepareAdaptiveContext(
    [task, policy, observation],
    [
      item("task", "user", task.text, 30),
      item("read", "tool", observation.text, 20),
    ],
    {
      trace_id: "small",
      fixed_input_tokens: 1_000,
      available_context_tokens: 900_000,
    },
  );
  assert.equal(prepared.recommendation.recommended_tier, "200K");
  assert.equal(prepared.recommendation.estimated_savings_tokens, 0);
  assert.equal(prepared.selected_items.length, 2);
});

test("a 200K model remains a supported 200K tier after reserving output tokens", () => {
  const task = event(
    "task-200k",
    "user",
    "state",
    1,
    "Set config.json timeout to 60.",
    {
      target_file: "config.json",
      timeout: 60,
      semantic_reviewed: true,
      semantic_run_ids: ["luna:a", "luna:b"],
    },
    { entity: "ticket:200k" },
  );
  const policy = event(
    "policy-200k",
    "policy",
    "policy",
    2,
    "Host policy.",
    { resource: "config.json", protected: false, always_visible: true },
    { entity: "resource:config.json" },
  );
  const observation = event(
    "read-200k",
    "read_file",
    "observation",
    3,
    "Current config.json timeout is 45.",
    { target_file: "config.json", timeout: 45 },
    { entity: "file:config.json", success: true },
  );
  const prepared = prepareAdaptiveContext(
    [task, policy, observation],
    [
      item("task-200k", "user", task.text, 100),
      item("read-200k", "tool", observation.text, 100),
    ],
    {
      trace_id: "reserved-200k",
      fixed_input_tokens: 90_000,
      active_context_window_tokens: 200_000,
      available_context_tokens: 190_000,
    },
  );
  assert.equal(prepared.recommendation.recommended_tier, "200K");
  assert.equal(
    prepared.recommendation.tier_assessments[0]!.unresolved_contradictions
      .length,
    0,
  );
});

test("unsupported larger tiers block instead of pretending a short model has 400K", () => {
  const { events, items } = runtimeFixture();
  const prepared = prepareAdaptiveContext(events, items, {
    trace_id: "short-model",
    fixed_input_tokens: 10_000,
    available_context_tokens: 260_000,
  });
  assert.equal(prepared.recommendation.recommendation, "BLOCK_AND_REFRESH");
  assert.match(
    prepared.recommendation.tier_assessments[1]!.unresolved_contradictions[0]!,
    /does not support 400K/i,
  );
  assert.deepEqual(prepared.selected_items, []);
});

test("runtime-reviewed current task compiles the last-moment write guard", () => {
  const { events } = runtimeFixture();
  const guard = compileRuntimeExecutorGuard(events);
  assert.equal(guard.current_event_id, "task-current");
  assert.equal(guard.older_event_id, "task-old");
  assert.ok(guard.changes.some((change) => change.field === "target_file"));
  assert.ok(guard.changes.some((change) => change.field === "timeout"));
});

test("carried task fields keep their old token position instead of being teleported to the latest prompt", () => {
  const { events, items } = runtimeFixture();
  const old = events.find((entry) => entry.event_id === "task-old")!;
  old.text = "Use staging/config.json with timeout 30 in production mode.";
  old.facts.environment = "production";
  items[0]!.text = old.text;
  const current = events.find((entry) => entry.event_id === "task-current")!;
  current.facts.environment = "production";
  current.facts.field_sources = {
    target_file: "task-current",
    environment: "task-old",
    timeout: "task-current",
    edit_protected: "task-current",
  };
  const prepared = prepareAdaptiveContext(events, items, {
    trace_id: "field-provenance",
    fixed_input_tokens: 10_000,
    available_context_tokens: 900_000,
  });
  assert.equal(prepared.recommendation.recommended_tier, "1M_WINDOW");
  assert.deepEqual(
    prepared.recommendation.tier_assessments[1]!.missing_evidence,
    ["task-old"],
  );
});

test("runtime guard rejects self-declared or single-run semantic authority", () => {
  const { events } = runtimeFixture();
  const current = events.find((entry) => entry.event_id === "task-current")!;
  current.facts.semantic_run_ids = ["luna:only-one"];
  assert.throws(
    () => compileRuntimeExecutorGuard(events),
    /two independent semantic run identities/i,
  );
});
