# Stale-action guard

The first supported production-shaped use case is narrow: an Agent host has
already planned an action, but the user or environment may have changed before
execution. ContextAdapt checks the action's declared provenance immediately
before the host executes it.

This is especially useful for queued tool calls, delayed approvals, retry
queues, resumed sessions, and plans generated before a user correction.

## Placement

```text
Agent plans action
        |
        v
Agent records based_on_event + permission_event
        |
        v
npm run contextadapt -- check trace.jsonl
        |
        +-- PASS (exit 0)  --> host may continue with its own safety checks
        |
        +-- BLOCK (exit 2) --> discard action and rebuild from current state
        |
        +-- INSUFFICIENT_EVIDENCE (exit 2) --> do not execute; repair provenance
```

The guard belongs after planning and before execution. Running it only after a
write or deployment is too late.

## Minimum useful provenance

The trace needs three concepts:

1. an old state event;
2. a newer event for the same `entity`;
3. a candidate action whose `links.based_on_event` names its source event.

Every candidate action must also declare a structured `operation`, a non-empty
`context_fields_used` list whose fields are present in `facts`, and an explicit
boolean `edit_protected`. It must declare `context_entity`; mutating operations
must also declare `target_file`. Every used value must equal the corresponding
value in the claimed basis event. Missing action provenance or scope produces
`INSUFFICIENT_EVIDENCE`, never `PASS`.

For every mutating target, a separate host-issued `policy` event declares
whether the resource is protected. The Agent's `edit_protected` claim must
match that policy. Protected actions must name the authorizing state in
`links.permission_event`; it must be current, originate from the host-recorded
`user` or `policy` source, explicitly allow protected editing, cover the exact
target in `protected_scope`, and bind to the same context entity as the basis.

The host must own the trace recorder. If the planner can forge `source=user`,
rewrite policy events, or omit candidate actions before the gate sees them, no
JSONL verifier can recover that lost trust boundary.

Export the complete built-in example for inspection:

```bash
npm run contextadapt -- demo --trace-out demo.jsonl
npm run contextadapt -- check demo.jsonl
```

## Exit contract

| Exit | Meaning                                                              |
| ---: | -------------------------------------------------------------------- |
|  `0` | The trace was valid and no supported action risk was found           |
|  `1` | The trace could not be read or validated                             |
|  `2` | A supported risk or insufficient evidence was found; block execution |

`PASS` is deliberately limited. It does not prove that a command is correct,
secure, reversible, or authorized by the operating system. The host must keep
its normal sandbox, approval, verifier, and access-control checks.

## TypeScript integration

```ts
import { buildSnapshot, gateStatus, loadJsonl } from "contextadapt";

const snapshot = buildSnapshot(await loadJsonl("agent-trace.jsonl"), "run-123");
if (gateStatus(snapshot) !== "PASS") {
  throw new Error("Discard candidate action and rebuild from current state");
}
```

The core check is deterministic and performs no model or network call.
