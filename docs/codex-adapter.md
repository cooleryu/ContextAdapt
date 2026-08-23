# Codex exec adapter

ContextAdapt's first real Agent adapter consumes the documented newline-delimited
JSON emitted on **stdout** by `codex exec --json`. It does not read Codex's
private desktop databases or internal session files.

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
