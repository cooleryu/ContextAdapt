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

Prioritize implementation in this order:

1. A stable recommendation contract and user-facing explanation.
2. Evidence-coverage and contradiction signals that work before execution.
3. An adaptive runner that selects a tier and counts the full cost of escalation.
4. Recovery after a blocked action.
5. A public product-value demo with real model behavior and real tool verification.

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
