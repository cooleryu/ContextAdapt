# Paper-grounded reproduction and improvement plan

Status: protocol and scorers implemented; OMP runtime recovery, a real
Luna/Codex fault-injection recovery, and the first frozen 36-cell long-context
product-value matrix are accepted. The source-paper-specific reproduction
tracks and real-session external-validity run remain open.

## Goal and claim boundary

This suite adapts four published experimental questions to a coding-Agent
environment, then asks whether ContextAdapt improves the resulting trade-off.
It does not promise an exact reproduction of each paper's numerical tables.
Exact replication would additionally require the original code, data, prompts,
model snapshots, and environment.

Use these public labels:

- `REFERENCED`: source and protocol mapping are documented;
- `REPRODUCED`: the frozen local protocol observed the target phenomenon;
- `NOT_REPRODUCED`: it did not, including null or opposite results;
- `IMPROVED`: ContextAdapt met the predeclared paired acceptance bar;
- `NOT_IMPROVED`: ContextAdapt did not meet that bar.

Never replace `NOT_REPRODUCED` or `NOT_IMPROVED` with a qualitative success
story.

## Common frozen protocol

Use the same task Agent, initial workspace hash, tool schemas, system prompt,
temperature, turn budget, and verifier across paired conditions. The initial
public run uses one pinned Luna model/version and three context tiers:

- `200K`;
- `400K`;
- `1M_WINDOW` using the host's measured usable limit.

Every task includes at least these policies:

1. `always-small`: run the 200K rendering;
2. `always-largest`: run the measured 1M-window rendering;
3. `contextadapt`: preflight tier choice, real action gate, and at most one
   targeted recovery.

The task Agent must not see policy names, tier labels, causal family labels,
expected actions, or oracle outcomes. Freeze tasks, renderers, scoring, and the
analysis script before the scored run. Use at least three independent model
runs per cell for the first public matrix; label that sample as a pilot rather
than statistical generalization.

## Track A: hidden state-reacquisition cost

Source: [What Does Context Compression Cost an Agent?](https://arxiv.org/abs/2608.16370)

Target phenomenon: a shorter or dropping context can preserve final completion
while increasing the interaction spent rediscovering execution state.

Conditions:

- full trajectory;
- recent-tail/drop rendering;
- equal-budget fact-preserving rendering;
- ContextAdapt evidence map plus targeted recovery;
- controlled restoration of the missing state for causal diagnosis on a frozen
  subset.

Report task completion, retrieval calls, execution calls, repeated calls,
direct ContextAdapt recovery reads, input/output tokens, latency, and turn
budget consumed. Treat `retrieval - paired fact-preserving retrieval` as excess
reacquisition; do not assume every read was caused by context loss.

ContextAdapt improvement bar: no more unsafe/incomplete tasks than
`always-largest`, with lower total input cost and no greater excess
reacquisition on the paired task.

## Track B: evolving and derived state

Source: [Can Agent Memory Systems Track Evolving State?](https://arxiv.org/abs/2608.19652)

Target phenomenon: an Agent can retrieve relevant history yet act on a
superseded value or fail to recompute derived state.

Scenario families:

- no conflict;
- one authoritative supersession;
- multiple supersessions;
- derived-state invalidation after a dependency changes;
- anti-update control where a later non-authoritative mention must not replace
  the current value.

Score `CURRENT`, `SUPERSEDED`, and `OTHER_FAILURE` separately, then verify the
real file target/value and protected-resource outcome.

ContextAdapt improvement bar: higher current-state action accuracy than both
fixed policies without increasing false updates on the anti-update controls.

## Track C: context interference

Source: [MemTrapBench](https://arxiv.org/abs/2608.20202)

Target phenomenon: truthful and semantically related history can reduce current
task performance even when the current evidence remains visible.

Paired conditions hold the task and current evidence fixed:

- current evidence only;
- current evidence plus relevant non-trap history;
- current evidence plus trap-inducing history;
- full history;
- ContextAdapt-selected active context.

Measure verified completion, wrong/stale actions, first-to-final action change,
retrieval/execution calls, repeated actions, tokens, and latency. Define context
interference as paired behavioral degradation caused by adding a history block;
do not ask an AI judge to infer hidden attention or subjective utility.

ContextAdapt improvement bar: reduce interference failures versus full history
without losing the evidence needed for safe completion.

## Track D: active versus recoverable context

Source: [Eureka](https://arxiv.org/abs/2608.19047)

Target phenomenon: a minimal active working set plus archived state can preserve
task performance while reducing repeated context and recomputation.

Conditions:

- full historical context resident;
- active evidence only, with no recovery;
- active evidence plus stable read-only recovery handles;
- ContextAdapt active tier plus one targeted recovery.

Measure resident input tokens, recovery tokens and calls, recomputation,
completion, gate outcome, and latency. The ContextAdapt result must count
archival lookup and recovery in total cost.

ContextAdapt improvement bar: lower total input cost than full history while
matching safe completion, with at most one recovery and no unverified write.

## Required public artifacts

Publish or generate reproducibly:

- task manifest and pre-scored failure families;
- model ID/version and decoding settings;
- initial workspace and state hashes;
- exact context renderer and measured token spans;
- prompt hashes and sanitized model outputs;
- complete tool traces classified as retrieval or execution;
- per-attempt and total token/latency accounting;
- action-gate and deterministic verifier results;
- raw per-cell results plus the analysis script;
- a limitations file covering host limits, evaluator defects, and deviations
  from the source papers.

Generated multi-megabyte prompts may remain uncommitted if the committed
generator, seed, hash, and byte/token counts reproduce them exactly.

## Final comparison and publication rule

For every track, compare paired task-level differences against both fixed
baselines. Publish safety and task completion before efficiency. A ContextAdapt
policy is `IMPROVED` only if it:

1. does not increase unsafe actions versus `always-largest`;
2. matches completion on tasks that `always-largest` completes;
3. reduces total input cost, including semantic preflight, recovery, retries,
   and failed attempts;
4. performs at most one recovery;
5. exposes every conservative block and null result.

The final README result table must link each claim to its raw artifact and
reproduction command. Local pilots are not public evidence. A run becomes a
public checkpoint only after its sanitized dataset, protocol, analysis, and
limitations have passed publication review and are included together.
