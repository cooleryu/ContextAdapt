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

| Field         | Type    | Meaning                                                             |
| ------------- | ------- | ------------------------------------------------------------------- |
| `entity`      | string  | The stateful object, for example `ticket:123` or `file:config.json` |
| `sequence`    | integer | Authoritative ordering within the same entity                       |
| `observed_at` | string  | Ingestion timestamp used only as a deterministic tie-breaker        |
| `success`     | boolean | Whether an `observation` succeeded                                  |
| `facts`       | object  | Structured facts extracted from the event                           |
| `links`       | object  | Provenance relationships between event IDs                          |
| `text`        | string  | Human-readable raw evidence or a redacted excerpt                   |

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

`source` is part of the trusted ingestion boundary. The Agent being checked
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

Version 1 expects structured event fields. It does not claim to infer reliable
provenance from arbitrary unstructured logs yet. Adapters should redact API
keys, credentials, personal data, and proprietary source content before
writing a shareable trace.

The first supported adapter is documented in
[`codex-adapter.md`](codex-adapter.md). Its default output stores fingerprints
and lengths instead of raw Agent content.
