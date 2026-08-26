# ContextAdapt product roadmap

## North star

Help every Agent use the smallest context that can still act safely.

The product must answer a user-facing question: does this task need roughly 200K, 400K, or the 1M-window tier—or is the available evidence too conflicted to act safely?

The execution gate is the safety backstop. The recommendation is the primary product decision.

Current status: the recommendation schema, fail-closed selector, automatic evidence map, two-Luna natural-language task capture, token-position recorder, Codex controlled runner, OMP in-process context selector, both pre-tool gates, and bounded one-step recovery are implemented. OMP has a one-install path through its native plugin registry. Semantic preflight and actual provider input are counted separately. The Codex passive reference path observes an ordinary primary run without gating it, snapshots pre-write state, stays out with zero Luna calls when 200K already fits, and supports causal isolated replay. The **current evidence phase** is a reviewed natural 200K/400K/large/block/null cohort; local research outputs remain outside the source release until publication review.

## Completed P0: one-step targeted recovery

When the selector or real action gate finds missing/stale evidence, ContextAdapt
must not immediately jump to the largest context or let the Agent rediscover the
whole workspace. It should:

1. classify the block as recoverable or terminal;
2. fetch only the named missing/stale evidence with read-only tools;
3. rebuild the evidence map and choose the smallest safe tier again;
4. make at most one additional task-Agent call;
5. gate the second action and either complete or stop without mutation.

Permission revocation, authoritative conflict, unreviewed targets, and opaque
tool contracts are terminal in v0.3: recovery must never manufacture authority.
The recovery report must show the reason, retrieval calls, duplicate reads,
input tokens, latency, second-tier decision, gate result, and verifier result.

## P0 user experience

The first product flow should look like:

```text
$ contextadapt recommend TRACE.jsonl

ContextAdapt: use 400K.
Why: 200K loses the latest target, permission, and verified state; 400K retains them.
Cost: about 394K input tokens, 55% below the 1M-window baseline.
Safety: plan at 400K; the real tool call is still gated.
```

The recommendation contract should expose:

```json
{
  "recommendation": "USE_400K",
  "candidate_tiers": ["200K", "400K", "1M_WINDOW"],
  "required_evidence": ["user-482", "tool-460", "policy-461"],
  "missing_by_tier": { "200K": ["user-482"], "400K": [] },
  "contradictions": [],
  "expected_total_input_tokens": 394000,
  "maximum_escalations": 1,
  "gate_required": true
}
```

For OMP, the accepted product entry is even smaller:

```bash
npm run contextadapt -- install-host omp
omp
```

The extension must be discovered by OMP rather than injected by a lab. A short
complete history pays zero semantic task-capture cost before the first model
request. If the Agent proposes a mutation, ContextAdapt performs the two-review
task capture and target preflight lazily, then gates the actual tool arguments.
Short tasks can have negative all-in token savings after lazy review; that is a
safety cost and must never be presented as a cost-reduction result.

## How selection should work

### Offline: learn the empirical minimum safe tier

For evaluation, run every frozen task at each candidate tier with the same model settings and initial environment. Use the deterministic task verifier and real tool outcome—not model confidence—to identify the smallest tier that completes the task without an unsafe action.

This post-hoc value is the evaluation label. It must never be shown to the selector or task Agent.

### Online: choose before paying for every tier

Running 200K, then 400K, then the 1M-window tier can cost more than starting large. The online product therefore needs a preflight selector:

1. Build an evidence map from host-authored user, policy, successful-tool, correction, and dependency events.
2. Render the evidence coverage expected at each candidate tier.
3. Choose the smallest tier with complete current evidence and no unresolved contradiction.
4. Run the task Agent once at that tier.
5. Allow at most one evidence-driven escalation when the action gate finds missing or stale basis.
6. Count every attempted token and every retry in the final cost.

The initial selector may combine AI relation extraction with deterministic chronology, source authority, coverage, and executor checks. Do not let the planner self-authorize or self-classify protected resources.

## First product-value experiment

Use one fixed model and four task families:

| Family                                      | Expected product behavior |
| ------------------------------------------- | ------------------------- |
| Local recent work                           | recommend 200K            |
| Mid-history correction or permission change | recommend 400K            |
| Deep contract, invariant, or dependency     | recommend 1M-window       |
| Unresolved authoritative conflict           | `BLOCK_AND_REFRESH`       |

For every task, compare three policies on the same initial state:

1. `always-small`: cheapest fixed tier;
2. `always-largest`: maximum available context;
3. `contextadapt`: preflight recommendation, action gate, and at most one recovery.

Keep the task Agent blind to policy names, tier labels, failure families, and expected results. Freeze the tasks, renderers, action schema, verifier, and scoring code before the scored run.

Use at least three independent live runs per cell for the first public product experiment. Publish every sanitized decision, including failures and conservative blocks.

Status: the runtime and scoring machinery are implemented. The reviewed public
dataset is still pending; internal run outputs are intentionally excluded from
this source release and do not establish real-world prevalence or effect size.

## Completed P0: native-session shadow validation

Run ContextAdapt invisibly alongside real Codex and OMP work so a user does not
write an evidence manifest or choose a tier manually. For each replayable task:

1. install the recorder at context assembly and tool boundaries;
2. derive the task, authority, successful observations, and token spans from
   native host events;
3. make a pre-Agent recommendation in shadow mode;
4. replay the same initial state with always-largest and the recommended policy;
5. pass any real mutation through both gates in an isolated worktree;
6. report task completion, current/superseded/other outcome, unsafe proposals,
   reacquisition, repeated calls, total tokens, latency, and false blocks.

The P0 fails if manual evidence labels are required at runtime, if a proposed
write cannot be bound to actual executor arguments, or if ContextAdapt saves
tokens by increasing incomplete or unsafe outcomes. Results must remain paired
and must include conservative blocks and null findings.

Status: the controlled same-state replay path is implemented for Codex and OMP.
Natural prevalence, externally reviewed effect sizes, and provider-native 1M
continuation remain open evidence questions.

## Current P0 evidence phase: passive natural-session cohort

The Codex engineering slice is implemented. Opt-in shadow mode can
observe a normal task without a special stress prompt, save sanitized hashes and
Hook counts, snapshot the target before mutation, and replay supported tasks in
isolated copies without delaying or mutating the primary run. Complete histories
that already fit 200K return `NULL` with zero semantic calls.

The first cohort must include naturally occurring 200K, 400K, large-tier, and
safe-block decisions, plus null findings where all policies behave the same.
The provider-native App Server assembly path records requested window,
effective window, and actual provider input separately. This is transport
instrumentation only. Publish paired task rows and every failure; do not claim
an effect size until the frozen natural cohort exists.

## Metrics

Report:

- deterministic task completion;
- current-state accuracy, separating current, superseded, and other failures;
- unsafe, protected, wrong-target, or stale-value actions;
- retrieval/reacquisition calls, execution calls, and repeated tool calls;
- product-triggered recovery cost as a separate line item;
- excess reacquisition relative to the paired full/fact-preserving baseline;
- total input tokens across all attempts;
- end-to-end latency;
- number and cost of escalations;
- false blocks;
- recovery success after a block;
- tier-selection accuracy;
- selection regret: context used above the empirical minimum safe tier.
- context interference: paired behavioral degradation when extra history is
  added while required current evidence is held fixed.

Do not label every read as context reacquisition. Some reads are normal task
discovery. Report directly attributable product-recovery reads separately, and
estimate Agent-initiated excess reacquisition only through a paired baseline or
controlled state-restoration intervention.

Compare paired task-level differences. Do not claim statistical generalization from one run per cell.

## Initial P0 acceptance bar

Freeze the acceptance bar before the scored run:

- no increase in unsafe actions compared with `always-largest`;
- equal deterministic task completion on tasks that `always-largest` can complete;
- at least 25% median reduction in total input tokens versus `always-largest`;
- no more than one escalation per task;
- every blocked mutation either recovers successfully or stops without changing protected state;
- every recommendation includes the evidence and cost explanation a new user can understand.

If the adaptive policy cannot meet this bar, publish the failure and improve the selector. Do not substitute a model-capability benchmark for product evidence.

## Implementation order

1. ✅ Define TypeScript schemas for evidence requirements and context recommendations.
2. ✅ Add `contextadapt recommend` with deterministic explanation output and prior-attempt cost accounting.
3. ✅ Implement automatic structured trace-to-evidence mapping and tier coverage checks.
4. ✅ Instrument live Codex and OMP hosts so profiles and spans are captured without user work.
5. ✅ Connect recommendation, task execution, and the real action gate.
6. ✅ One-step targeted recovery and reacquisition-cost accounting. OMP's real
   Agent loop and the live Luna/Codex fault-injection acceptance both pass.
7. ✅ Build the paired product-value protocol and scoring path.
8. ✅ Implement the invisible recorder, selector, same-state replay, and real
   execution gate for Codex/OMP.
9. ✅ Add opt-in Codex passive capture, pre-write snapshots, causal replay, and
   a provider-native large-context continuation boundary.
10. **CURRENT P0 EVIDENCE:** Fill the frozen natural 200K, 400K, large, block,
    and null cohort, and add an OMP passive row.
11. Only after a larger independent suite should adaptive context selection be
    promoted as a statistically validated policy.

The suite design and claim rules are frozen in
[`paper-reproduction-plan.md`](paper-reproduction-plan.md). It starts only after
step 6 passes: recovery behavior is part of the evaluated ContextAdapt policy,
not an optional follow-up added after seeing results.
