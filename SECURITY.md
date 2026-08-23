# Security policy

ContextAdapt processes Agent trajectories, which may contain source code,
credentials, personal data, or internal operational details.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** button on this repository's
Security page. Private vulnerability reporting keeps the report and follow-up
discussion visible only to the reporter and repository maintainers.

Do not open a public issue containing an exploit, secret, private trace, or
personal information. Provide the smallest synthetic reproducer possible and
remove unrelated content before submitting the private report.

## Data handling expectations

- ContextAdapt's core diagnostic command runs locally and does not send trace
  contents to a model or external service.
- Contributors must not commit raw credentials, private repositories, personal
  conversations, or proprietary traces.
- Adapters should redact sensitive fields before serializing
  `contextadapt.trace.v1`.
- The Codex adapter redacts raw identifiers, prompts, messages, commands,
  outputs, errors, and tool payloads by default. Its SHA-256 fingerprints can
  still reveal short or guessable values through offline guessing; they are for
  correlation, not anonymization.
- `--include-content` creates a sensitive local artifact. Do not attach that
  output to a public issue without line-by-line review.
- `analyze-codex --allow-remote-content` sends the selected events' raw `text`
  and `facts` to the configured Codex model. Codex also adds provider system
  and runtime context. ContextAdapt uses an empty temporary workspace, ignores
  project rules, and requests a read-only sandbox, but users must still review
  the selected events before consenting.
- `analyze-codex --output-dir` stores proposal and review artifacts containing
  verbatim evidence quotes. Treat that directory as sensitive trace data.
- Executor hooks receive the Agent's actual tool arguments. Keep guard files
  and hook commands under host control, use absolute paths where practical,
  and do not log raw patches or commands unless the destination is approved for
  the same sensitivity as the source repository.
- A ContextAdapt hook supplements the Agent sandbox and operating-system access
  controls; it does not replace them. Unsupported or opaque tool paths must be
  disabled, separately guarded, or treated as outside the v0.1 guarantee.
- Risk output is diagnostic evidence, not an authorization decision. Protected
  actions should also be guarded by the host Agent environment.
