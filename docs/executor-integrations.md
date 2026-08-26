# Real executor integrations

ContextAdapt can now enforce an accepted context update at the last responsible
moment: after an Agent proposes a concrete tool call, but before that tool
changes the workspace.

The two layers have different jobs:

1. two semantic passes decide how a newer user/policy event changes an older
   event;
2. a deterministic executor guard checks the actual file path, patch, or shell
   command submitted by the Agent.

This closes the gap between “the plan was diagnosed as stale” and “the stale
write was actually prevented.”

## Compile an accepted relation

First create or obtain an accepted proposal/review bundle. The bundled fixture
is useful for seeing the integration shape:

```bash
npm run contextadapt -- compile-guard \
  examples/stale-action.jsonl \
  examples/relation-proposal.json \
  examples/relation-review.json \
  --output .contextadapt/executor-guard.json
```

`compile-guard` refuses anything except an `ACCEPTED` relation between
host-recorded `user` or `policy` events. In a live integration, use the
artifacts emitted by `analyze-codex` or another trusted two-pass host rather
than the bundled fixture.

## Codex

Install the three native lifecycle hooks without replacing existing hooks:

```bash
contextadapt install-host codex --cwd /path/to/repo
```

`UserPromptSubmit` records the raw task update locally, `PostToolUse` records
tool success and a response fingerprint, and `PreToolUse` receives the actual
JSON arguments and can deny them before execution. If ContextAdapt is not on
`PATH`, pass an absolute command during installation:

```text
contextadapt install-host codex --cwd /path/to/repo --command "/absolute/path/to/ContextAdapt/scripts/contextadapt-hook host-hook codex"
```

The controlled `run-codex` command performs two Luna task-capture passes,
records a fresh target observation, selects the model-visible history, writes a
session-bound guard, and only then invokes the task Agent. The task model and
review model are independent (`--model` and `--review-model`), so a stronger
task Agent does not automatically multiply the semantic-review bill. Luna is
the tested review default. It refuses to invoke Codex if the reviewed
`PreToolUse` hook is absent or the independent reviews do not produce one
validated current task.

The first controlled turn reserves 90K tokens for model/system/tool overhead.
After the provider reports actual input usage, the session stores the observed
fixed portion and applies a 10% margin on the next recommendation. Semantic
preflight calls remain a separate cost line so a cheap-looking tier cannot hide
the recorder cost.

Project hooks must be trusted in Codex. Keep the normal sandbox and approval
policy enabled. The test-only `--dangerously-bypass-hook-trust` flag says only
that an already-reviewed hook may run; it should not be copied into ordinary
interactive use.

Hooks alone cannot choose the internal Codex history length: the public hook
payload does not expose a stable complete assembled transcript, and there is no
per-turn 200K/400K/1M switch. `run-codex` is therefore the controlled assembly
boundary. For deeper application integrations, Codex App Server can own thread
creation and injected history, while the native hook remains the final write
gate. See the official [Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks)
and [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

For a same-state product check, `shadow-codex` copies the source workspace into
isolated fixed-largest and adaptive roots, reuses one reviewed task capture,
and requires both deterministic file verification and native Hook attestation.
The source workspace remains unchanged. Local run outputs are not included in
the public source release.

## Oh My Pi / OMP

OMP 17.x exposes the full set of native events needed by the P0 loop. Install
the package through OMP's own plugin registry once, then run OMP normally:

```bash
npm run contextadapt -- install-host omp
omp
```

OMP keeps its active task model and uses Luna only for the lazy two-pass task
review. Advanced hosts may set `CONTEXTADAPT_REVIEW_MODEL`; this changes the
reviewer, not OMP's task model, and remains fail-closed on disagreement.

The command invokes `omp plugin link` and verifies the installed package with
`omp plugin list`. The extension queues task updates in `before_agent_start`,
uses `context` as the authoritative pre-provider boundary, updates
successful/failed observations from `tool_result`, and performs the final
deterministic guard at `tool_call`. Short complete histories incur zero task-AI
calls before the primary request; task capture and target preflight are delayed
until the first mutation. Because
the separate `python` and `notebook` tools can mutate files without exposing a
stable target contract, v0.2 blocks them while a guard is active. The extension
also fails closed if the policy is missing or invalid.

OMP's headless SDK may omit the active model from the context callback. In that
case ContextAdapt uses a fail-closed 200K capacity: work that fits proceeds,
and anything requiring 400K or the 1M-window tier stops rather than relying on
an unknown host limit. Tier selection changes the model-visible history; it
does not change provider credentials or manufacture a larger model window.

The public OMP integration tests cover native discovery, lazy capture,
wrong-value blocking, correct-value allowance, and protected-file preservation.

## What v0.2 checks

For the supported tool paths, the guard can:

- block a write to the old target after the target moved;
- block a write to any target that was not the current reviewed task target;
- block an edit to a host-declared protected resource when current permission
  forbids it;
- recognize stale field/value pairs such as `environment=staging` or
  `timeout=30` in the actual patch or command;
- allow the corresponding current target and values.

The host still owns source authentication, sandboxing, OS permissions, and the
complete tool inventory. A shell command that delegates mutation to an opaque
script without spelling the guarded path or changed values may exceed the
current parser's evidence. Hosted tools and specialized paths that do not emit
a supported pre-tool event also remain outside this version's boundary. Treat
this as a focused guardrail, not a universal authorization system.

## Reproduce the executor labs

The OMP lab uses OMP's real agent loop, native `tool_call` lifecycle, and real
`write` tool. Its decision source is OMP's deterministic mock provider so the
test isolates executor behavior and needs no model endpoint:

```bash
OMP_RUNTIME_DIR=/path/to/omp/runtime \
CONTEXTADAPT_LAB_DIR=/tmp/contextadapt-omp-lab \
CONTEXTADAPT_GUARD=/tmp/contextadapt-omp-lab/executor-guard.json \
bun run scripts/omp_executor_lab.ts
```

The Codex lab uses two real `gpt-5.6-luna` runs in isolated temporary Git
repositories. It requires an existing Codex login:

```bash
python3 research/python/scripts/codex_executor_lab.py \
  --lab-dir /tmp/contextadapt-codex-lab \
  --guard /tmp/contextadapt-codex-lab/executor-guard.json \
  --codex-bin /path/to/codex \
  --hook-bin $PWD/scripts/contextadapt-hook \
  --model gpt-5.6-luna
```

The retained local result is summarized in
[`artifacts/executor/real-executor-report.json`](../artifacts/executor/real-executor-report.json).
