---
name: contextadapt-north-star
description: Keep ContextAdapt development centered on selecting the smallest context that lets an AI agent act safely. Use for every ContextAdapt product, architecture, experiment, benchmark, feature, issue, documentation, README, release, or prioritization task.
---

# ContextAdapt north star

## Preserve the purpose

Help every Agent use the smallest context that can still act safely.

Treat this as the product objective, not a slogan. ContextAdapt must help a user decide whether a task needs roughly 200K, 400K, or the 1M-window tier, while preventing a shorter context from causing stale, unauthorized, or under-evidenced action.

The execution gate, relation engine, trace format, model adapters, experiments, and context renderers are supporting mechanisms. They are not the product outcome by themselves.

## Produce a useful decision

Design the product to return one of these outcomes before execution:

- `USE_200K`
- `USE_400K`
- `USE_1M_WINDOW`
- `BLOCK_AND_REFRESH`

Include:

- the smallest recommended tier;
- the evidence that must remain visible;
- any missing, stale, contradictory, or unauthorized evidence;
- expected total context cost, including retries and escalations;
- the action-gate result before the real tool call.

Do not claim savings from the final successful prompt alone. If 200K fails and 400K succeeds, count both attempts. If a conservative preflight can jump directly to 400K, compare that total with always using the largest tier.

## Define minimum safe context

Call a context tier safe only when all of these are true:

1. It contains the latest authoritative target, values, corrections, permissions, and task-critical observations.
2. Superseded facts and failed or uncommitted tool previews cannot silently become current state.
3. The planned action names evidence that actually supports its file, values, operation, and permission.
4. The host-bound executor guard validates the real tool arguments immediately before mutation.
5. A deterministic verifier can judge task completion and protected-resource safety.

If evidence is missing or unresolved, prefer `BLOCK_AND_REFRESH` over guessing.

## Follow the P0 product loop

For product work, follow this sequence:

1. Build an evidence map for the current task: required target, scalar details, permissions, corrections, successful observations, and dependencies.
2. Estimate which tier preserves that evidence before calling the task Agent.
3. Run the chosen tier first. Permit at most one evidence-driven escalation in the initial product version.
4. Record total input tokens, latency, model turns, retries, action, evidence basis, gate result, and verifier result.
5. Gate the actual mutation. On a block, refresh only the missing or stale evidence and retry safely.
6. Compare against `always-small` and `always-largest` baselines on the same task and initial state.
7. Report whether ContextAdapt reduced total cost without increasing unsafe actions or incomplete tasks.

Treat semantic review as part of that total cost. Keep the task Agent and
reviewer model independently configurable so a stronger task model does not
silently multiply recorder cost. The default reviewer must be a tested profile;
any cheaper override still has to satisfy independent identity, schema,
agreement, provenance, and executor-gate checks or fail closed.

Prioritize implementation in this order:

1. A stable recommendation contract and user-facing explanation.
2. Evidence-coverage and contradiction signals that work before execution.
3. An adaptive runner that selects a tier and counts the full cost of escalation.
4. Recovery after a blocked action.
5. A public product-value demo with real model behavior and real tool verification.

## Completed P0: one-step targeted recovery

The live recorder, pre-Agent tier selection, real pre-tool gate, and one-step
recovery are now the completed runtime foundation. Public tests must cover the
frozen safety bar; local run outputs are not public evidence.

Implement this as a bounded state machine:

1. Classify the block. Only missing evidence, stale observations, or a stale
   action basis are automatically recoverable. An authoritative conflict,
   revoked permission, unsupported tool contract, or unreviewed target must
   stop without mutation.
2. Re-read or retrieve only the evidence IDs and resources named by the block.
   Recovery tools must be read-only.
3. Update the evidence map, preserve provenance and original token positions,
   and recompute the smallest safe tier.
4. Permit exactly one new task-Agent attempt and pass its real tool arguments
   through the executor guard again.
5. If evidence is still incomplete or the second action is blocked, stop safely.

Do not score this P0 only by final task completion. Record separately:

- recovery-trigger reason;
- recovery retrieval calls and tokens;
- repeated reads or repeated tool calls;
- execution calls;
- total input tokens and latency across both attempts;
- whether the final answer used current rather than superseded state;
- final task/verifier result and protected-resource outcome.

The P0 passes only when recovery never expands authority, never writes before a
second successful gate, performs at most one retry, and exposes its full
reacquisition cost to the user and evaluator.

## Completed P0: public paired product value

Run the first product-value slice of the frozen paper-grounded plan in
`docs/paper-reproduction-plan.md`. The public result must compare the same Luna
model and initial state under:

1. `always-small` at 200K;
2. `always-largest` at the measured 1M-window limit;
3. `contextadapt`, which chooses 200K/400K/1M-window or blocks and permits at
   most one recovery.

Include tasks whose empirical minimum is 200K, 400K, 1M-window, and safe block.
Freeze task manifests, renderers, verifier, scoring, and claim thresholds before
the scored run. Report every attempt's tokens and latency, current/superseded
outcome, unsafe action, recovery cost, false block, and selection regret.

The runtime and protocol are implemented. Do not promote local matrix results
to public product evidence until the sanitized dataset, analysis, limitations,
and reproduction command pass publication review together.

## Completed P0: controlled native-session validation

Move from generated conflicting histories to replayable, naturally occurring
Codex and OMP tasks. The user must not write an evidence manifest or manually
choose a tier. The host recorder must derive current task changes, authority,
successful tool state, and token positions from native lifecycle events, then
make the recommendation before the task-Agent call and gate actual executor
arguments before mutation.

For every accepted real-session result:

1. replay `always-largest` and ContextAdapt from the same isolated state;
2. retain the fixed task verifier and protected-resource policy;
3. count semantic preflight, every task turn, retrieval/reacquisition, retries,
   repeated actions, and latency;
4. classify current, superseded, other failure, unsafe proposal, and false
   block separately;
5. expose conservative blocks and null findings instead of silently removing
   hard tasks.

This P0 fails if the runtime requires manual labels, if the executor cannot
bind the proposed write to the actual tool arguments, or if token savings come
from more incomplete or unsafe outcomes.

The controlled replay path is implemented for Codex and OMP. Keep local host
acceptances separate from natural-session effect-size claims and from the
public source release.

## Current P0 evidence phase: passive natural-session cohort

The Codex engineering slice is accepted: passive Hooks add no primary model
call or gate, native thread reading happens after completion, copy-on-write
snapshots restore the actual pre-write state, and supported tasks replay in
isolated copies. If the complete history already fits 200K, return `NULL` with
zero Luna calls. Do not spend semantic preflight merely to announce the
smallest tier.

The provider-native App Server path records requested capacity, effective
capacity, and actual input separately. The current P0 work is evidence
collection: natural 200K, 400K, large-tier, safe-block, and null rows plus an
OMP passive row. Keep actual provider usage, host estimates, transport
capacity, and product value separate.

## Completed P0: installed OMP user path

The OMP product entry is now `contextadapt install-host omp`, followed by
ordinary `omp` use. The package must be discovered from OMP's installed plugin
registry; tests that inject the extension factory directly do not satisfy this
acceptance.

For a complete history that fits 200K, make the first provider decision with
zero semantic task-capture calls. If the Agent later proposes a mutation,
perform the two-reviewer task capture and target preflight lazily before the
real tool executes. Report that review as safety overhead; do not subtract it
away or call a short task cheaper when the all-in total is higher.

If OMP does not expose active-model metadata, use a fail-closed 200K capacity.
Never infer 400K or 1M support from an installed model catalog or from a model
name. Preserve an append-only decision history so later tool turns cannot erase
the original pre-Agent decision.

Public integration tests cover installed discovery, the zero-preflight short
path, lazy review, wrong-value blocking, correct-value allowance, and protected
file preservation. Live OMP-model quality and natural long-context savings
remain open evidence items.

## After product-value acceptance: paper-specific reproduction and improvement

Extend the accepted common matrix into the still-open source-specific tracks in
`docs/paper-reproduction-plan.md`. Keep three labels strictly separate:

- **Referenced:** a paper motivates a metric or intervention.
- **Reproduced:** ContextAdapt ran a frozen protocol and observed the stated
  phenomenon in its own coding-Agent environment.
- **Improved:** a paired ContextAdapt policy beat the reproduced baseline under
  the predeclared safety, completion, and total-cost criteria.

Never use a citation as a substitute for a local result. Never call a
phenomenon-level adaptation an exact reproduction of a paper's published
numbers. Preserve model/version, prompts, state hashes, context renderings,
tool traces, token accounting, verifier output, and sanitized raw results.

The suite should connect each source to one product question:

1. compression cost -> does the shorter tier cause hidden state reacquisition?
2. evolving state -> does the Agent use current rather than superseded state?
3. memory traps -> does extra relevant history interfere with verified action?
4. compiled active context -> can archived evidence be recovered without
   replaying the full history?

Every paper track must still compare `always-small`, `always-largest`, and
`contextadapt`; otherwise it is literature reproduction, not ContextAdapt
product validation.

## Hold experiments to the product question

Every product experiment must compare at least:

- always use the smallest tier;
- always use the largest available tier;
- use the ContextAdapt recommendation and execution gate.

Include tasks where 200K is enough, where 400K is the minimum safe tier, where the 1M-window tier is necessary, and where no tier resolves the evidence conflict.

Measure:

- task completion;
- unsafe or wrong-target actions;
- total input tokens across every attempt;
- end-to-end latency;
- false blocks and unnecessary escalations;
- selection regret: excess context above the empirical minimum safe tier;
- recovery success after a block.

Freeze the oracle before the scored run. Keep the task Agent blind to tier names, causal labels, and expected outcomes. Use the same model settings and initial environment for paired comparisons. Store raw, sanitized traces and distinguish model failures, host limits, evaluator defects, and product interventions.

One successful thread is a pilot, not statistical evidence. A model's ability to answer at 883K is not ContextAdapt product value. Product value requires a comparative improvement caused by ContextAdapt.

## Reject misleading progress

Do not promote any of these as the main product result:

- a model handling a large prompt;
- a synthetic fixture whose outcome is hard-coded;
- a safety gate passing its own fixtures;
- a high pass rate without a baseline or intervention;
- token savings that omit failed attempts;
- an experiment that never lets ContextAdapt make or enforce a decision.

Keep infrastructure results as supporting evidence and label them accordingly.

## Use the pre-development check

Before accepting a feature, experiment, or documentation change, answer:

1. What user decision becomes easier?
2. Does this help select the smallest safe context, prevent a real mistake, or reduce total cost?
3. What are the always-small and always-largest baselines?
4. Is the claimed improvement caused by ContextAdapt rather than the model or fixture?
5. Are retries, latency, false blocks, and recovery included?
6. Can a new user see the benefit without reading the research history?

If the answers are weak, deprioritize the work or label it infrastructure rather than product validation.
