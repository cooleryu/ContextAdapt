# ContextAdapt product roadmap

## North star

Help every Agent use the smallest context that can still act safely.

The product must answer a user-facing question: does this task need roughly 200K, 400K, or the 1M-window tier—or is the available evidence too conflicted to act safely?

The execution gate is the safety backstop. The recommendation is the primary product decision.

## P0 user experience

The first product flow should look like:

```text
$ contextadapt recommend TRACE.jsonl --task TASK.json

RECOMMEND  USE_400K

WHY
✓ latest target and scalar correction covered
✓ current permission revocation covered
✓ verified file observation covered
! 200K rendering loses user-482

EXPECTED TOTAL INPUT  394K
VERSUS 1M WINDOW       -55%
ESCALATION             none
EXECUTION GATE         required
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

## Metrics

Report:

- deterministic task completion;
- unsafe, protected, wrong-target, or stale-value actions;
- total input tokens across all attempts;
- end-to-end latency;
- number and cost of escalations;
- false blocks;
- recovery success after a block;
- tier-selection accuracy;
- selection regret: context used above the empirical minimum safe tier.

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

1. Define TypeScript schemas for evidence requirements and context recommendations.
2. Add `contextadapt recommend` with deterministic explanation output.
3. Implement tier renderers and full-cost accounting.
4. Connect recommendation, task execution, action gate, and one-step recovery.
5. Build the frozen four-family paired experiment.
6. Run the live model matrix and publish comparative results.
7. Only then promote adaptive context selection as a shipped capability.
