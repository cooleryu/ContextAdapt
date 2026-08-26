# Codex exec adapter

## Live adaptive path

The privacy-safe importer below remains useful for offline diagnosis. The live
P0 path uses documented Codex boundaries instead:

1. `UserPromptSubmit` records the new prompt locally;
2. two independent `gpt-5.6-luna` calls capture the narrow task-state schema;
3. deterministic checks preserve field-level provenance and reject disagreement;
4. `run-codex` chooses and renders the smallest supported history tier;
5. native `PreToolUse` evaluates the actual patch or command before mutation;
6. `PostToolUse` records success status after execution.

Install and run:

```bash
contextadapt install-host codex --cwd /path/to/repo
contextadapt run-codex --cwd /path/to/repo \
  --model gpt-5.6-sol \
  --review-model gpt-5.6-luna \
  --allow-remote-content \
  "Edit config.json: set timeout to 60 and preserve retries"
```

`--model` controls the task Agent. `--review-model` controls the two independent
task-state reviews and defaults separately to `gpt-5.6-luna`. This reserves a
stronger model for the task without automatically paying for it twice during
review. The reviewer model is stored in task provenance; invalid output or
review disagreement blocks instead of falling back to an unreviewed task.

Codex Hooks are the recorder and last-moment gate, not the history selector.
They cannot set a per-turn context length. The controlled runner owns the
selected history; the passive path uses the official Codex App Server to read a
completed native thread and build isolated candidate replays.

## Opt-in passive path

```bash
contextadapt install-host codex --passive-cohort --cwd /path/to/repo
# Complete an ordinary Codex task.
contextadapt observe-codex --cwd /path/to/repo
```

In passive mode the primary Hook records lifecycle evidence and a copy-on-write
snapshot before the first target mutation. It never executes a model call,
never returns a block decision, and never changes the primary Agent's request.
Raw thread IDs and snapshot contents remain under `.contextadapt/private/` with
mode `0600` and are not copied into the public observation.

After the task completes, ContextAdapt uses the documented App Server
`initialize`/`initialized` and `thread/read` sequence. Agent output and tool
results after the actionable user prompt are excluded from the candidate
decision so the answer cannot leak into its own evaluation. Supported tasks can
be replayed from the pre-write snapshot in two isolated workspace copies.

When the complete history plus fixed overhead already fits 200K, the default
path returns `NULL` without task capture. Histories that require semantic
analysis need explicit `--allow-remote-content`; forcing capture/replay is a
research option, not the default product behavior.

The provider-native boundary probe uses App Server `thread/start`, repeated
experimental `thread/inject_items`, and `turn/start`. It separately records the
requested context window, the effective window in the token-usage event, and
actual provider input. Generated inert payloads prove transport only. See the
[official App Server contract](https://learn.chatgpt.com/docs/app-server).

ContextAdapt's first real Agent adapter consumes the documented newline-delimited
JSON emitted on **stdout** by `codex exec --json`. It does not read Codex's
private desktop databases or internal session files.

## Same-state shadow replay

After at least one controlled `run-codex` turn has created a session file, a
later task can be compared from two isolated copies of the same workspace:

```bash
contextadapt shadow-codex \
  --cwd /path/to/repo \
  --session /path/to/repo/.contextadapt/session.json \
  --allow-remote-content \
  "Correction: set config.json timeout to 60 and verify it"
```

The command freezes one two-Luna task capture for both policies, runs
fixed-largest and ContextAdapt separately, derives a JSON verifier from the
captured task, and writes a sanitized audit artifact. It does not modify the
source workspace. A pair is accepted only when initial state hashes match,
the adaptive task is no less complete or safe, and actual provider usage is
fully counted. Native Hook activity is reported separately from the file
verifier so a correct file alone cannot conceal a missing write gate.

## Capture and convert

```bash
codex exec --json "Your task" > run.codex.jsonl
npm run contextadapt -- import-codex run.codex.jsonl --output run.contextadapt.jsonl
npm run contextadapt -- diagnose run.contextadapt.jsonl
```

Codex diagnostics and warnings belong on stderr. Do not merge stderr into the
JSONL file: malformed or mixed streams fail closed instead of silently dropping
lines.

The official event stream does not currently repeat the original prompt. If a
local prompt file is available, add its fingerprint to the trace with:

```bash
npm run contextadapt -- import-codex run.codex.jsonl \
  --instruction-file prompt.txt \
  --output run.contextadapt.jsonl
```

## Privacy defaults

By default, the adapter does not copy any of these values into the converted
trace:

- thread or item identifiers;
- prompt and Agent message text;
- shell commands and command output;
- errors, file-change payloads, or tool-call payloads.

It records character counts and SHA-256 fingerprints so a local investigation
can correlate identical evidence without publishing the evidence itself. A
fingerprint is not anonymity: short or guessable values can still be tested by
an attacker. Review every trace before sharing it.

Raw content can be retained only by explicitly passing `--include-content`.
This is intended for controlled local debugging, not for public issue reports.

## Evidence boundary

The adapter preserves event order, lifecycle, command exit status, usage
counters, and start/completion relationships that the public stream actually
contains. It does **not** invent a `based_on_event` link between a command and a
state. Therefore an imported stream is useful structural evidence, but
stale-action diagnosis requires provenance supplied by the Agent or a future
instrumented adapter.

The supported upstream contract is the public `codex exec --json` output. Any
parser for private Codex session files would be experimental and is outside the
v1 compatibility promise.
