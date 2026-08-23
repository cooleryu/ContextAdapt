# ContextAdapt

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python: 3.9+](https://img.shields.io/badge/python-3.9%2B-3776AB.svg)](setup.cfg)

**Stop AI Agents from executing valid-looking plans built from stale context.**

![ContextAdapt catches a stale Agent action before execution](docs/assets/contextadapt-stale-action.svg)

Long Agent sessions do not only forget information. They can retain an old,
complete plan after the user has replaced it—and execute that plan against the
current environment. ContextAdapt reconstructs the current state, keeps failed
observations separate from trusted reads, and checks whether a planned action
is still supported by current context and permission.

The verifier runs locally and deterministically with no runtime dependencies.
The optional hybrid path needs two semantic analyses supplied by an Agent host;
the core never hides a model call or treats missing analyses as safety evidence.

## See the failure in 10 seconds

```bash
python3 -m contextadapt demo
```

That command runs directly from the checkout. No install, API key, or model
call is required for the first demo. Install the package later when you want
the `contextadapt` command available outside the repository.

You will see one host resource policy, one old task, one replacement task, and
a delayed Agent action:

```text
CONTEXT TIMELINE
  10  OLD      staging / timeout=30 / protected edit allowed
  30  CURRENT  production / timeout=60 / protected edit forbidden
  50  ACTION   staging/config.json / timeout=30 / protected edit

VERDICT  BLOCK
  ! CRITICAL x1  Protected edit has no current permission.
  ! HIGH     x1  Action was built from superseded context.
```

The built-in case is synthetic and deterministic. Its job is to make the
supported safety check observable—not to pretend a fixture is a model result.

## See AI and engineering check each other

Natural-language updates are not safely comparable with string matching.
ContextAdapt therefore accepts a field-level relation proposed by one AI run,
requires a separately declared review run, and then applies deterministic checks:

```bash
python3 -m contextadapt reconcile \
  examples/stale-action.jsonl \
  examples/relation-proposal.json \
  examples/relation-review.json \
  --action-event old-action-replay
```

The included proposal says that the newer request changes `environment`,
`timeout`, and `edit_protected`. Every change cites an exact quote from both
raw events. A SHA-256 content digest binds the review to that exact proposal;
it does not prove the reviewer's identity or independence.
ContextAdapt then verifies chronology, entity scope, verbatim evidence,
structured values, declared-distinct run IDs, field agreement, confidence, and
unresolved fields before it evaluates the action.

The bundled proposal and review are transparent fixtures demonstrating the
contract; the core command does not secretly call a model. For an explicit
live test, ContextAdapt can launch two separate Luna runs through an existing
Codex login:

```bash
python3 -m contextadapt analyze-codex \
  examples/stale-action.jsonl ticket-old ticket-current \
  --action-event old-action-replay \
  --allow-remote-content \
  --output-dir relation-run
```

This opt-in command serializes only the selected two trace events into each
analysis prompt, records provider-issued run identities and output digests, and
never treats a disagreement as acceptance. Codex still supplies its own system
and runtime context. ContextAdapt starts both runs in an empty temporary
workspace, ignores project rules, and requests a read-only sandbox, but this is
not a promise that the provider request contains only those event tokens.
Different caller-supplied ID strings alone do not prove real independence.
Missing, ambiguous, contradictory, or incomplete evidence never silently
becomes `PASS`.

See the [`hybrid relation protocol`](docs/hybrid-relations.md) for the division
of responsibility between AI judgment and deterministic verification.

## Use it as an execution gate

`check` is the first production-shaped use case. Feed it a structured Agent
trace before executing candidate actions:

```bash
python3 -m contextadapt check examples/stale-action.jsonl
```

It prints `PASS`, `BLOCK`, or `INSUFFICIENT_EVIDENCE`. The process exits with
`0` only on pass and `2` for either a supported risk or insufficient evidence,
so the same command can gate CI, a shell workflow, or an Agent executor.

If the trace has no candidate action or lacks the required provenance/action
contract, it prints `INSUFFICIENT_EVIDENCE` and also exits `2`; absence of
evidence is never presented as a safe real-Agent run.

See the [`stale-action guard` integration guide](docs/action-guard.md) for
placement, minimum provenance, exit codes, and a Python example.

## Block the real tool call

`check` answers whether a recorded action is safe enough to continue. The
executor integrations go one step further: they inspect the actual patch,
file path, or shell command immediately before Codex or OMP executes it.

```bash
python3 -m contextadapt compile-guard \
  examples/stale-action.jsonl \
  examples/relation-proposal.json \
  examples/relation-review.json \
  --output .contextadapt/executor-guard.json
```

The same accepted relation can then protect either Agent host:

- Codex: a native `PreToolUse` hook blocks a stale `apply_patch` before the
  file changes;
- OMP: a native `tool_call` extension blocks stale `write`, `edit`, or
  mutating `bash` calls before execution.

The retained paired test used two real `gpt-5.6-luna` Codex runs: the stale
staging patch was denied and left the file unchanged, while the current
production patch was allowed and written. The OMP test exercised its real
agent loop and real write tool with a deterministic local decision source:
the old write was blocked and the current write succeeded. See the
[`real executor integration guide`](docs/executor-integrations.md) and
[`machine-readable result`](artifacts/executor/real-executor-report.json).

To see why an ordinary Codex event stream is not enough for a causal verdict:

```bash
python3 -m contextadapt check examples/codex-exec.trace.jsonl
```

It returns `INSUFFICIENT_EVIDENCE` and exit `2`, rather than inventing a safe
action basis.

ContextAdapt v0.1 catches two high-value failures:

- an action built from an instruction or state that has been superseded;
- a protected edit whose permission does not come from the current request.

The trace is a trusted host record, not Agent-authored testimony. In
particular, the host—not the planner—must assign event `source`, preserve raw
user/policy events, and issue resource-protection policy events. The verifier
can catch inconsistencies inside that record; it cannot authenticate a forged
trace by itself.

For deeper inspection, build the complete provenance-aware snapshot:


```bash
python3 -m contextadapt diagnose examples/stale-action.jsonl --format json
python3 -m contextadapt diagnose examples/stale-action.jsonl --fail-on-risk
```

## Import a real Codex run

The first real adapter converts the documented stdout stream from
`codex exec --json`:

```bash
codex exec --json "Your task" > run.codex.jsonl
python3 -m contextadapt import-codex run.codex.jsonl --output run.contextadapt.jsonl
python3 -m contextadapt diagnose run.contextadapt.jsonl
```

The adapter redacts raw prompts, IDs, commands, outputs, errors, and Agent
messages by default. It keeps event structure, status, usage, character counts,
and fingerprints. See [`docs/codex-adapter.md`](docs/codex-adapter.md) for the
privacy boundary and the explicit local-only `--include-content` option.

The public Codex stream does not currently expose which state a command was
planned from. The adapter therefore preserves the evidence it has and does not
invent causal links. Full stale-action checks require an instrumented Agent
host or a validated relation bundle; importing a normal Codex stream alone is
not an automatic stale-context detector.

## What ContextAdapt builds

A `contextadapt.trace.v1` stream becomes a `ContextSnapshot` containing:

- current instructions and state, selected by declared sequence;
- last successful observations, kept separate from failed previews;
- superseded events and candidate actions;
- action-to-context and permission links;
- deterministic risks with machine-readable evidence.

Public input contract: [`docs/trace-format.md`](docs/trace-format.md).
Contribution and evidence rules: [`CONTRIBUTING.md`](CONTRIBUTING.md).
Release blockers and milestones: [`docs/release-checklist.md`](docs/release-checklist.md).
Sensitive-data guidance: [`SECURITY.md`](SECURITY.md).
[Codex and OMP executor hooks](docs/executor-integrations.md).
[Apache-2.0 license](LICENSE).

> Alpha scope: v1 imports the public `codex exec --json` stream and expects
> structured provenance fields for causal diagnostics. It does not parse
> arbitrary private Codex, Claude Code, or other Agent logs. `PASS` means no
> currently supported risk was found; it is not a universal safety guarantee.
