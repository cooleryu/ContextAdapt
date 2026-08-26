# Research inputs: state, reacquisition, and context interference

Date reviewed: 2026-08-24

This note records four new arXiv v1 papers and the concrete product decisions
they informed. They are research inputs, not independent validation of
ContextAdapt.

## 1. Context compression and hidden reacquisition cost

[What Does Context Compression Cost an Agent?](https://arxiv.org/abs/2608.16370)
shows that task completion can stay statistically unchanged while retrieval
calls rise sharply after execution-relevant state is dropped. It separates
retrieval from execution calls and uses controlled state restoration to test
causal attribution. The paper also finds no retrieval surge in ALFWorld, so the
effect is explicitly environment dependent.

Decision for ContextAdapt:

- the recovery P0 must report retrieval, execution, repeated calls, tokens, and
  latency instead of reporting only eventual success;
- directly triggered recovery reads are counted exactly;
- Agent-initiated reacquisition is called causal only when a paired baseline or
  controlled restoration supports that attribution;
- use excess retrieval over the paired baseline, not a raw count of every read,
  as the stronger reacquisition signal.

## 2. Evolving state and supersession

[Can Agent Memory Systems Track Evolving State?](https://arxiv.org/abs/2608.19652)
separates answers based on current state, superseded state, and other failures.
Its StateMem method keeps supersession and dependency structure explicit.

Decision for ContextAdapt:

- add current/superseded/other as an evaluation decomposition;
- retain the current `replaces` and field-level provenance design;
- add derived-state invalidation after the recovery P0, so a changed dependency
  marks dependent facts as needing recheck rather than silently current.

Boundary: StateMemBench is synthetic, reports single runs, uses roughly 3K to
15K-token scenarios, and does not test frontier answerers. It is a useful state
model and metric template, not evidence for ContextAdapt's 200K/400K/1M tiers.

## 3. Relevant memory can still interfere

[MemTrapBench](https://arxiv.org/abs/2608.20202) reports cases where faithfully
recorded, semantically related memory hurts current-task reasoning relative to
a no-memory baseline. The paper is explicitly marked work in progress.

Decision for ContextAdapt:

- add context interference to the paired experiment;
- operationalize it with blinded `relevant-only` versus `relevant-plus-history`
  interventions while holding the current evidence and task fixed;
- do not add a subjective runtime “utility judge” yet. Marginal context utility
  should come from changes in verified success, unsafe actions, tool calls,
  tokens, and latency under the paired intervention.

## 4. Active context versus recoverable history

[Eureka](https://arxiv.org/abs/2608.19047) separates active local state from
archived and incrementally recoverable state. Its compiled-context experiment
reduces median input from 9,490 to 4,005 tokens without changing its reported
success rate.

Decision for ContextAdapt:

- keep `historical`, `recoverable`, and `active` context as the longer-term
  architecture vocabulary;
- use stable evidence handles so targeted recovery can restore an archived fact
  without replaying the entire history;
- do not treat this experiment as support for long-context tier selection: its
  scale, domain, and architecture are materially different.

## Updated evaluation outcome

The public paired experiment should report:

```text
task completion
current / superseded / other outcome
unsafe or wrong-target action
retrieval and execution calls
direct recovery cost
excess reacquisition versus paired baseline
repeated calls
total input tokens and latency
context interference
tier-selection regret
recovery success
```

## Implemented and checked on 2026-08-24

The paper inputs now change executable behavior rather than only documentation:

- `paper-eval.ts` separates retrieval, execution, direct recovery, repeats,
  paired excess reacquisition, and current/superseded/other outcomes;
- Codex and OMP allow at most one target-bound read-only scalar refresh, then
  require a second action-gate decision;
- `working-set.ts` keeps the operative desired change separate from the latest
  verified pre-action value and exposes only fingerprinted read-only recovery
  handles.

These are runtime and evaluation capabilities, not claims that the cited paper
phenomena have been reproduced.

The next scope is a reviewed, publishable natural-session dataset plus the
still-open paper-specific tracks, not a general memory platform. Internal run
outputs are not part of the public source release.
