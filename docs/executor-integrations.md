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

Codex supports `PreToolUse` hooks that receive the actual JSON tool arguments.
Copy [`integrations/codex/hooks.json.example`](../integrations/codex/hooks.json.example)
to `<repo>/.codex/hooks.json`. If ContextAdapt is not installed as a command,
replace the hook command with an absolute checkout path:

```text
/absolute/path/to/ContextAdapt/scripts/contextadapt-hook executor-hook codex --policy /absolute/path/to/repo/.contextadapt/executor-guard.json --format native
```

The example matches every local tool because Codex can expose file edits under
several matcher aliases. ContextAdapt then scopes enforcement to `apply_patch`
and mutating `Bash` calls and leaves other tools alone.

Project hooks must be trusted in Codex. Keep the normal sandbox and approval
policy enabled. The test-only `--dangerously-bypass-hook-trust` flag says only
that an already-reviewed hook may run; it should not be copied into ordinary
interactive use.

See the official [Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks)
for trust, matcher, input, and denial semantics.

## Oh My Pi / OMP

OMP 17.x exposes a native `tool_call` extension event before tool execution.
Run OMP with the included extension and point it at the guard:

```bash
CONTEXTADAPT_GUARD=/absolute/path/to/repo/.contextadapt/executor-guard.json \
omp --extension /absolute/path/to/ContextAdapt/dist/packages/omp/src/index.js
```

The extension runs the TypeScript guard in process and covers OMP `write`, `edit`, and relevant `bash` calls. Because
the separate `python` and `notebook` tools can mutate files without exposing a
stable target contract, v0.2 blocks them while a guard is active. The extension
also fails closed if the policy is missing or invalid.

## What v0.2 checks

For the supported tool paths, the guard can:

- block a write to the old target after the target moved;
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
