# ContextAdapt trace format v1

ContextAdapt accepts newline-delimited JSON. Each non-empty line is one event.
Comment lines beginning with `#` are ignored.

## Required fields

| Field      | Type   | Meaning                                                              |
| ---------- | ------ | -------------------------------------------------------------------- |
| `event_id` | string | Unique, stable identifier within the trace                           |
| `source`   | string | Host-recorded producer such as `user`, `policy`, or `read_file`      |
| `kind`     | string | `state`, `observation`, `action`, `instruction`, `policy`, or `note` |

## Optional fields

| Field          | Type    | Meaning                                                             |
| -------------- | ------- | ------------------------------------------------------------------- |
| `entity`       | string  | The stateful object, for example `ticket:123` or `file:config.json` |
| `sequence`     | integer | Authoritative ordering within the same entity                       |
| `observed_at`  | string  | Ingestion timestamp used only as a deterministic tie-breaker        |
| `success`      | boolean | Whether an `observation` succeeded                                  |
| `facts`        | object  | Structured facts extracted from the event                           |
| `links`        | object  | Provenance relationships between event IDs                          |
| `text`         | string  | Human-readable raw evidence or a redacted excerpt                   |
| `context_span` | object  | Host-measured `[start_token, end_token]` span in the rendered input |

## Automatic recommendation metadata

`contextadapt recommend TRACE.jsonl` builds the evidence map itself. A supported
host adapter records a trusted profile event:

```json
{
  "event_id": "context-profile",
  "source": "host",
  "kind": "note",
  "entity": "context:profile",
  "facts": {
    "total_input_tokens": 883300,
    "window_policy": "suffix_window_v1",
    "trusted_observation_sources": ["read_file"],
    "tier_input_tokens": {
      "200K": 197800,
      "400K": 393700,
      "1M_WINDOW": 883300
    },
    "tier_window_starts": {
      "200K": 685500,
      "400K": 489600,
      "1M_WINDOW": 0
    },
    "tier_supported": {
      "200K": true,
      "400K": true,
      "1M_WINDOW": true
    },
    "token_measurement": "host_item_estimate"
  }
}
```

Task, resource-policy, and successful-observation events include a full-event
token span such as:

```json
"context_span": { "start_token": 530000, "end_token": 530260 }
```

The first implementation accepts only `suffix_window_v1`; it will not silently
apply suffix arithmetic to a summary or reordered context. The host also names
the tool sources allowed to supply successful observations. A planner, user, or
policy event can never be placed on that allowlist.

ContextAdapt computes each suffix window from these measurements and requires
the whole event to fit. Live adapters also record the actual atomic message
boundary in `tier_window_starts`; this prevents a tool result from being counted
as visible when the host must remove its whole turn. `tier_supported=false`
blocks a marketed tier that the active model cannot actually accept. A
partially clipped event is missing evidence, not a partial success. The profile
and spans belong to the trusted host-ingestion boundary; the planner must not
supply or rewrite them.

When a short correction carries a field from an older user turn, the live task
event records `facts.field_sources`, for example:

```json
"field_sources": {
  "target_file": "user-10",
  "timeout": "user-30"
}
```

This preserves the old field's old token position. The latest prompt cannot
“teleport” an inherited target into the recent window merely because the
semantic recorder understands the combined task.

The first mapper supports one active reviewed user task with `target_file`,
one matching current host resource policy, and one matching latest successful
observation. Missing measurements, missing policy, missing observation, or
multiple active tasks produce `BLOCK_AND_REFRESH`. This is deliberately narrower
than arbitrary natural-language inference.

## Ordering rules

- For `state`, `instruction`, and `policy`, the greatest explicit `sequence`
  is current for an entity.
- Successful and failed `observation` events are kept in separate lanes. A
  failed preview never overwrites the last successful observation.
- Input position is an ingestion detail, not authoritative event time.
- Missing sequence values rank below explicit sequence values.

## Action provenance

Every candidate `action` must declare a fail-closed structured contract:

```json
"entity": "action:deploy",
"facts": {
  "operation": "write",
  "context_entity": "ticket:deploy",
  "context_fields_used": ["environment", "timeout", "edit_protected"],
  "environment": "staging",
  "timeout": 30,
  "edit_protected": true,
  "target_file": "staging/config.json"
},
"links": {
  "based_on_event": "ticket-old",
  "permission_event": "ticket-old"
}
```

The action values must exactly match its claimed basis for every member of
`context_fields_used`. Mutating targets also need a host-issued resource policy;
the Agent cannot make a protected file safe by setting `edit_protected=false`.
If the resource is protected, permission must come from a current trusted
user/policy event for the exact target and context entity.

`source` and `context_span` are part of the trusted ingestion boundary. The Agent being checked
must not be allowed to author or rewrite user/policy source labels or resource
policy events. ContextAdapt validates the resulting record but does not
cryptographically authenticate an arbitrary JSONL file.

## Example

```json
{
  "event_id": "ticket-current",
  "source": "user",
  "kind": "state",
  "entity": "ticket:deploy",
  "sequence": 30,
  "facts": {
    "environment": "production",
    "timeout": 60,
    "edit_protected": false
  }
}
```

See [`examples/stale-action.jsonl`](../examples/stale-action.jsonl) for a
complete seven-event trace, including the host resource policy.

## Scope and privacy

Version 1 expects structured event fields. Live Codex/OMP adapters use two
independent semantic captures for the narrow task-field vocabulary; unsupported
or disagreeing natural language fails closed. Adapters should redact API
keys, credentials, personal data, and proprietary source content before
writing a shareable trace.

The first supported adapter is documented in
[`codex-adapter.md`](codex-adapter.md). Its default output stores fingerprints
and lengths instead of raw Agent content.
