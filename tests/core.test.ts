import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSnapshot,
  demoEvents,
  demoSnapshot,
  gateStatus,
  parseJsonl,
  validateActionContract,
  type TraceEvent,
} from "../packages/core/src/index.js";

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

test("built-in demo blocks the stale protected action", () => {
  const snapshot = demoSnapshot();
  assert.equal(gateStatus(snapshot), "BLOCK");
  assert.deepEqual(snapshot.risk_summary, { total: 2, critical: 1, high: 1 });
  assert.deepEqual(snapshot.risks.map((risk) => risk.type).sort(), [
    "stale_action",
    "unbound_protected_permission",
  ]);
});

test("current complete action passes", () => {
  const events = demoEvents().filter(
    (item) => item.event_id !== "old-action-replay",
  );
  events.push(
    event({
      event_id: "policy-production-config",
      source: "policy",
      kind: "policy",
      entity: "resource:production/config.json",
      sequence: 6,
      facts: { resource: "production/config.json", protected: false },
    }),
  );
  events.push(
    event({
      event_id: "current-action",
      source: "planner",
      kind: "action",
      entity: "action:deploy",
      sequence: 70,
      facts: {
        operation: "write",
        context_entity: "ticket:deploy",
        context_fields_used: [
          "environment",
          "timeout",
          "edit_protected",
          "target_file",
        ],
        environment: "production",
        timeout: 60,
        edit_protected: false,
        target_file: "production/config.json",
      },
      links: { based_on_event: "ticket-current" },
    }),
  );
  const snapshot = buildSnapshot(events);
  assert.equal(gateStatus(snapshot), "PASS");
  assert.equal(snapshot.risks.length, 0);
});

test("unknown operation fails closed", () => {
  const action = event({
    event_id: "bad",
    source: "planner",
    kind: "action",
    entity: "action:x",
    sequence: 2,
    facts: {
      operation: "write_file",
      context_entity: "ticket:x",
      context_fields_used: ["edit_protected"],
      edit_protected: false,
    },
    links: { based_on_event: "basis" },
  });
  const basis = event({
    event_id: "basis",
    source: "user",
    kind: "state",
    entity: "ticket:x",
    sequence: 1,
    facts: { edit_protected: false },
  });
  const result = validateActionContract([basis, action], action);
  assert.equal(result.assessable, false);
  assert.ok(
    result.risks.some((risk) => risk.type === "incomplete_action_contract"),
  );
});

test("action cannot self-report a protected target as unprotected", () => {
  const policy = event({
    event_id: "policy",
    source: "policy",
    kind: "policy",
    entity: "resource:secrets",
    sequence: 1,
    facts: { resource: "secrets.json", protected: true },
  });
  const basis = event({
    event_id: "basis",
    source: "user",
    kind: "state",
    entity: "ticket:x",
    sequence: 2,
    facts: { target_file: "secrets.json", edit_protected: false },
  });
  const action = event({
    event_id: "action",
    source: "planner",
    kind: "action",
    entity: "action:x",
    sequence: 3,
    facts: {
      operation: "write",
      context_entity: "ticket:x",
      context_fields_used: ["target_file", "edit_protected"],
      target_file: "secrets.json",
      edit_protected: false,
    },
    links: { based_on_event: "basis" },
  });
  const result = validateActionContract([policy, basis, action], action);
  assert.ok(
    result.risks.some((risk) => risk.type === "protection_misclassification"),
  );
  assert.ok(
    result.risks.some((risk) => risk.type === "unbound_protected_permission"),
  );
});

test("planner cannot grant itself protected permission", () => {
  const policy = event({
    event_id: "policy",
    source: "policy",
    kind: "policy",
    entity: "resource:secrets",
    sequence: 1,
    facts: { resource: "secrets.json", protected: true },
  });
  const fakePermission = event({
    event_id: "basis",
    source: "planner",
    kind: "state",
    entity: "ticket:x",
    sequence: 2,
    facts: {
      target_file: "secrets.json",
      edit_protected: true,
      protected_scope: ["secrets.json"],
    },
  });
  const action = event({
    event_id: "action",
    source: "planner",
    kind: "action",
    entity: "action:x",
    sequence: 3,
    facts: {
      operation: "write",
      context_entity: "ticket:x",
      context_fields_used: ["target_file", "edit_protected"],
      target_file: "secrets.json",
      edit_protected: true,
    },
    links: { based_on_event: "basis", permission_event: "basis" },
  });
  assert.ok(
    validateActionContract([policy, fakePermission, action], action).risks.some(
      (risk) => risk.type === "unbound_protected_permission",
    ),
  );
});

test("action facts must faithfully match their claimed basis", () => {
  const basis = event({
    event_id: "basis",
    source: "user",
    kind: "state",
    entity: "ticket:x",
    sequence: 1,
    facts: { environment: "production", timeout: 60, edit_protected: false },
  });
  const action = event({
    event_id: "action",
    source: "planner",
    kind: "action",
    entity: "action:x",
    sequence: 2,
    facts: {
      operation: "read",
      context_entity: "ticket:x",
      context_fields_used: ["environment", "timeout", "edit_protected"],
      environment: "staging",
      timeout: 30,
      edit_protected: false,
    },
    links: { based_on_event: "basis" },
  });
  assert.ok(
    validateActionContract([basis, action], action).risks.some(
      (risk) => risk.type === "action_context_mismatch",
    ),
  );
});

test("missing action and incomplete action are insufficient evidence", () => {
  const basis = event({
    event_id: "basis",
    source: "user",
    kind: "state",
    entity: "ticket:x",
    sequence: 1,
  });
  assert.equal(gateStatus(buildSnapshot([basis])), "INSUFFICIENT_EVIDENCE");
  const incomplete = event({
    event_id: "action",
    source: "planner",
    kind: "action",
    entity: "action:x",
    sequence: 2,
  });
  assert.equal(
    gateStatus(buildSnapshot([basis, incomplete])),
    "INSUFFICIENT_EVIDENCE",
  );
});

test("JSONL parser rejects invalid, duplicate, and empty traces", () => {
  assert.throws(() => parseJsonl(""), /no events/);
  assert.throws(() => parseJsonl('{"event_id":"x"}'), /missing required/);
  const line = JSON.stringify(
    event({ event_id: "x", source: "user", kind: "state" }),
  );
  assert.throws(() => parseJsonl(`${line}\n${line}`), /duplicate event_id/);
});
