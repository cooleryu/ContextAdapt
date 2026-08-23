# Hybrid context-relation protocol

ContextAdapt does not ask engineering code to pretend it understands natural
language, and it does not let a model silently rewrite history. The protocol
uses three separate records:

1. immutable raw events;
2. a field-level semantic proposal from an analyzer run;
3. a separately orchestrated review bound to the proposal's canonical SHA-256 digest.

## Responsibilities

The semantic analyzer proposes a normalized entity binding, decides whether two utterances concern the same task, and
proposes `supersedes`, `partial_supersession`, `narrows`, `adds`, or `conflicts`.
Every changed field must include its old/new value and an exact quote from each
raw event. It must list unresolved fields instead of silently carrying them
forward.

The reviewer supplies its own field-level findings. Approval must name every
accepted field, retain no unresolved issue, use a distinct host-issued run ID,
and include the canonical proposal digest. Static `reconcile` files can only
demonstrate this contract. The opt-in `analyze-codex` orchestrator launches two
separate Codex/Luna runs, derives run identities from provider thread IDs, and
does not show the analyzer's answer to the reviewer.

The deterministic verifier checks:

- supported schema, relation, and field operation;
- referenced events exist and the newer event ranks later;
- the proposed entity does not contradict any existing structured event entity;
- every evidence quote exists verbatim in the referenced raw event;
- proposed values do not contradict existing structured facts;
- analyzer and reviewer declare distinct host-issued runs;
- the review covers the exact immutable proposal and every changed field;
- both confidence values meet the configured threshold;
- no field is simultaneously changed and unresolved.

If raw conversation events do not already carry an entity, both AI passes may
agree on one; engineering can verify that agreement but cannot prove the
semantic entity assignment from strings alone.

Engineering verification establishes content provenance and declared agreement. It does not
prove that a normalization such as `线上 -> production` is semantically true;
that judgment remains attributable to the two model runs and their quoted
evidence.

## Fail-closed outcomes

- `ACCEPTED`: both semantic passes agree and all mechanical checks succeed.
- `NEEDS_CLARIFICATION`: a field or review issue remains unresolved.
- `REJECTED`: evidence, chronology, scope, digest, independence, or structured
  facts fail validation.

Candidate actions are evaluated only against `ACCEPTED` relations. Any other
relation status prevents an action from silently passing.

## Current integration boundary

`codex exec --json` exposes lifecycle and tool events but not an action's
internal semantic basis. The included adapter therefore never invents
`based_on_event`. A production host should add two hooks:

1. attach the context snapshot ID when a candidate action is planned;
2. obtain analyzer and reviewer relation bundles when natural-language events
   may change an earlier task, permission, or environment state.

The shipped `reconcile` command verifies supplied bundles and fails closed on
an incomplete structured action contract. `analyze-codex` is an explicit,
consent-gated convenience path for two live Luna judgments; it writes the raw
proposal/review artifacts and then uses the same deterministic verifier.

Provider identity is evidence of separate runs, not proof of independent
internal reasoning. ContextAdapt now ships deterministic pre-tool bindings for
the supported Codex `apply_patch`/mutating `Bash` and OMP
`write`/`edit`/mutating `bash` paths. Other hosted or specialized tools remain
outside that v0.2 boundary. The host must also preserve trustworthy
`user`/`policy` source provenance; ContextAdapt does not authenticate a forged
input trace.

See [`executor-integrations.md`](executor-integrations.md) for the exact tool
coverage, retained paired result, and integration commands.

Before using the live convenience path, confirm `codex --version` works, the
Codex client is logged in, `gpt-5.6-luna` is available to that account, the
local Codex state directory is writable, and network access is permitted. A
failed run reports a bounded tail of Codex stderr plus these checks. Only the
two selected trace events are serialized into the analysis prompt; normal
Codex system/runtime context still applies.
