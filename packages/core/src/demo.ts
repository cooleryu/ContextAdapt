import { buildSnapshot } from "./diagnose.js";
import type { ContextSnapshot, TraceEvent } from "./types.js";

export const DEMO_TRACE_ID = "stale-deploy-action";

function event(
  value: Partial<TraceEvent> & Pick<TraceEvent, "event_id" | "source" | "kind">,
): TraceEvent {
  return {
    entity: null,
    sequence: null,
    observed_at: null,
    success: null,
    facts: {},
    links: {},
    text: "",
    ...value,
  };
}

export function demoEvents(): TraceEvent[] {
  return [
    event({
      event_id: "policy-staging-config",
      source: "policy",
      kind: "policy",
      entity: "resource:staging/config.json",
      sequence: 5,
      facts: { resource: "staging/config.json", protected: true },
      text: "Host policy classifies staging/config.json as protected.",
    }),
    event({
      event_id: "ticket-old",
      source: "user",
      kind: "state",
      entity: "ticket:deploy",
      sequence: 10,
      facts: {
        environment: "staging",
        timeout: 30,
        edit_protected: true,
        target_file: "staging/config.json",
        authority: "user",
        protected_scope: ["staging/config.json"],
      },
      text: "Deploy staging/config.json in staging with timeout 30; protected edits are allowed for staging/config.json.",
    }),
    event({
      event_id: "read-prod-ok",
      source: "read_file",
      kind: "observation",
      entity: "file:production/config.json",
      sequence: 20,
      success: true,
      facts: { timeout: 45, retries: 3 },
      text: "Successful production read.",
    }),
    event({
      event_id: "ticket-current",
      source: "user",
      kind: "state",
      entity: "ticket:deploy",
      sequence: 30,
      facts: {
        environment: "production",
        timeout: 60,
        edit_protected: false,
        target_file: "production/config.json",
        authority: "user",
        protected_scope: [],
      },
      links: { replaces: "ticket-old" },
      text: "Replace that plan: deploy production/config.json in production with timeout 60; protected edits are forbidden.",
    }),
    event({
      event_id: "read-prod-failed",
      source: "read_file",
      kind: "observation",
      entity: "file:production/config.json",
      sequence: 40,
      success: false,
      facts: { preview_retries: 1 },
      text: "Refresh failed; preview is unverified.",
    }),
    event({
      event_id: "old-action-replay",
      source: "planner-replay",
      kind: "action",
      entity: "action:deploy",
      sequence: 50,
      facts: {
        target_file: "staging/config.json",
        operation: "write",
        context_entity: "ticket:deploy",
        environment: "staging",
        timeout: 30,
        retries: 8,
        edit_protected: true,
        context_fields_used: [
          "environment",
          "timeout",
          "edit_protected",
          "target_file",
        ],
      },
      links: { based_on_event: "ticket-old", permission_event: "ticket-old" },
      text: "Delayed replay of a complete but stale action.",
    }),
    event({
      event_id: "user-current",
      source: "user",
      kind: "instruction",
      entity: "request:active",
      sequence: 60,
      facts: { request: "execute current production change and verify" },
      text: "Continue with the current request.",
    }),
  ];
}

export function demoSnapshot(): ContextSnapshot {
  return buildSnapshot(demoEvents(), DEMO_TRACE_ID);
}

export function renderDemo(snapshot: ContextSnapshot): string {
  return [
    "ContextAdapt · stale Agent action caught before execution",
    "========================================================",
    "",
    "SCENARIO",
    "  An old staging task allowed a protected edit and timeout=30.",
    "  The user replaced it with production, timeout=60, no protected edits.",
    "  A delayed planner is now trying to replay the complete old action.",
    "",
    "CONTEXT TIMELINE",
    "  10  OLD      staging / timeout=30 / protected edit allowed",
    "  30  CURRENT  production / timeout=60 / protected edit forbidden",
    "  50  ACTION   staging/config.json / timeout=30 / protected edit",
    "",
    "VERDICT  BLOCK",
    `  ! CRITICAL x${snapshot.risk_summary.critical}  Protected edit has no current permission.`,
    `  ! HIGH     x${snapshot.risk_summary.high}  Action was built from superseded context.`,
    "",
    "RESULT",
    "  ContextAdapt recommends rebuilding the action from the current request",
    "  instead of executing a valid-looking but stale plan.",
    "",
    "This seven-event scenario is synthetic and deterministic.",
    "Use `npx contextadapt demo --trace-out demo.jsonl` to inspect the evidence.",
    "Use `npx contextadapt check TRACE.jsonl` to gate a structured Agent trace.",
    "",
  ].join("\n");
}
