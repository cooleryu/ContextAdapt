# P0 verification and rendering evidence ledger

Frozen on 2026-09-02. These results intentionally separate three different
questions: whether the engineering pipeline is internally coherent, whether an
external paper's phenomenon can be reproduced from its locked data, whether a
frozen ContextAdapt renderer retains real edit evidence, and whether that
retention becomes real Agent success. The first three now have evidence. The
fourth remains unearned.

## 1. ContextAdapt engineering matrix

Command: `npm run experiment:p0-engineering`

Evidence label: `PIPELINE_VALIDATED`  
Model calls: `0`  
Cells: `320`

At the first sufficient synthetic verification budget, ContextAdapt's
risk-allocated policy covered all 18 critical paths and failed closed whenever
the smaller budget was insufficient. Same-budget recency and uniform baselines
were deliberately not given those oracle labels.

| Policy at budget 2            | Critical-path recall | Projected unsafe proceeds | Mean estimated verification input |
| ----------------------------- | -------------------: | ------------------------: | --------------------------------: |
| risk allocated                |                18/18 |                         0 |                            355.75 |
| recency                       |                 0/18 |                        12 |                            418.25 |
| seeded uniform                |                12/18 |                         6 |                            390.25 |
| verify all (cost upper bound) |                18/18 |                         0 |                          1,055.38 |

The exact-span coverage gate passed all 48 rendering cells. The numbers below
use a character-divided-by-four estimate, not a tokenizer or provider bill.

| Renderer                      | Required-span coverage | Mean rendered/original estimate | Mean rendered estimate |
| ----------------------------- | ---------------------: | ------------------------------: | ---------------------: |
| raw                           |                  16/16 |                          1.0000 |              1,124.375 |
| extractive                    |                  16/16 |                          0.2270 |                291.500 |
| intent-conditioned extractive |                  16/16 |                          0.2485 |                316.875 |

Interpretation: this validates generation, allocation, target binding,
fail-closed behavior, exact-span preservation, recovery handles, scoring, and
artifact determinism. Because the scenarios and oracle are synthetic, these
differences are not model behavior and are not a product-savings claim.

## 2. Stale Constraints v3 reproduction

Command: `npm run experiment:p0-stale-reproduction`

Evidence label: `PAPER_DATA_REPRODUCED`  
New model calls: `0`  
Source: _When Stale Constraints Go Unchecked_, v3, DOI
`10.5281/zenodo.22147784`, CC BY 4.0.

The command verifies the official archive SHA-256, rehashes all 14,370 package
manifest entries, recomputes Study A from raw answers, reruns the frozen A/B/X/C
analysis scripts, and requires every output to match the archived bytes.

Selected reproduced findings:

| Experiment           |          Locked episodes | Reproduced result                                                                           |
| -------------------- | -----------------------: | ------------------------------------------------------------------------------------------- |
| A                    |                      900 | forced-critical minus native authoritative consistency: +80.7 pp, 95% CI [74.0, 86.7]       |
| B                    |                      600 | merely showing freshness: target-selection delta -4.0 pp, 95% CI [-11.3, 3.3], inconclusive |
| X                    | 1,498 plus 2 error files | forced-critical minus native: +62.0 pp, 95% CI [57.2, 66.8]                                 |
| C                    |                    5,400 | native critical-record selection rose from 5.3% at budget 1 to 88.7% at budget 4            |
| C, target-blind rule |                    5,400 | at budget 2, selection +89.7 pp and outcome +89.3 pp versus P0                              |

Interpretation: the external data establishes that scarce verification
allocation can cause large stale-constraint failures, and that a deterministic
target-blind selection rule can redirect attention. Experiment B is especially
important: passive freshness presentation alone did not solve the problem.
This is the reason ContextAdapt now combines risk allocation with an execution
gate. The paper did not run ContextAdapt, so none of these numbers are a
ContextAdapt improvement result.

## 3. Independent frozen-Luna reanalysis

Command: `npm run experiment:p0-stale-luna`

Evidence label: `EXTERNAL_MODEL_BEHAVIOR_REANALYZED`  
New model calls: `0`  
Frozen model in the source episodes: `gpt-5.6-luna`  
Raw episodes: `900`; independent completed provider calls: `1,750`

This analysis ignores the stored score block and recomputes selection and
current-consistent outcome from raw `resolved_ids` and `answer_t2`. It verifies
unique provider identities and same-world prompt equality, then bootstraps the
25 run superblocks 10,000 times.

| Luna intervention                          | Budget | Selection delta | Current-consistent outcome delta | Added estimated input |
| ------------------------------------------ | -----: | --------------: | -------------------------------: | --------------------: |
| target-blind constraint rule versus native |      1 | +46 pp [30, 62] |                  +44 pp [24, 64] |         +104.4 tokens |
| target-blind constraint rule versus native |      2 | +96 pp [90,100] |                  +92 pp [80,100] |         +128.2 tokens |
| forced critical versus native              |      3 |               — |                  +72 pp [52, 88] |                     — |
| forced critical versus native              |      4 |               — |                  +28 pp [12, 48] |                     — |

Dates-only and oldest-first negative controls did not reproduce the gain. The
important result is not “Luna is good” or “Luna is bad”: for this frozen model,
the main failure was allocation of attention to the right evidence, not simple
access to more memory. This is still an external-paper intervention, not a
ContextAdapt product trial.

## 4. Real-code renderer development and held-out evaluation

Commands:

```bash
npm run experiment:p0-real-code:dev
npm run experiment:p0-real-code:holdout
```

Evidence label: `REAL_CODE_RETENTION_HOLDOUT`  
New model calls: `0`  
Development: `23 tasks × 9 policies × 8 budgets = 1,656 cells`  
Held out: `30 tasks × 9 policies × 8 budgets = 2,160 cells`

The 30 held-out tasks span 12 repositories. The renderer sees only the issue
and base-commit source; the gold patch is evaluator-only. The renderer,
evaluator, split, source manifest, metrics, thresholds, and 10,000-draw
repository-cluster bootstrap were fingerprinted in `protocol-v3.json` before
the single held-out run.

The strict metric requires all three conditions: stay inside the source budget,
preserve every exact issue line found in source, and retain at least one
pre-edit line from every gold patch hunk.

| Held-out source budget | ContextAdapt v3 strict | Lexical strict | Head/tail strict | ContextAdapt hunk coverage | All-in estimated ratio |
| ---------------------: | ---------------------: | -------------: | ---------------: | -------------------------: | ---------------------: |
|                    10% |            10/30 (33%) |     6/30 (20%) |       4/30 (13%) |                      41.7% |                  14.9% |
|                    20% |            12/30 (40%) |    10/30 (33%) |       8/30 (27%) |                      50.0% |                  24.4% |
|                    40% |            18/30 (60%) |    18/30 (60%) |      10/30 (33%) |                      67.8% |                  43.2% |
|                    60% |            22/30 (73%) |    20/30 (67%) |      12/30 (40%) |                      85.0% |                  62.2% |
|                   100% |           30/30 (100%) |   30/30 (100%) |     30/30 (100%) |                     100.0% |                 100.0% |

Across the seven compressed budgets, ContextAdapt v3 improved strict retention
over head/tail by **+22.4 percentage points**, repository-cluster bootstrap 95%
CI **[+2.4, +40.6]**. Against lexical intent, the gain was only **+7.1 points**,
95% CI **[-2.3, +17.9]**: directionally positive but inconclusive. At the 40%
checkpoint, ContextAdapt and lexical intent tied at 18/30, while v2 was 19/30.
The development-set advantage therefore did not generalize cleanly.

The ablations sharpen the conclusion:

- exact issue-evidence gating improved the compressed-curve strict metric over
  ungated structural retrieval by +6.2 points, 95% CI [+1.1, +11.9], while edit
  hunk coverage was unchanged;
- structural ranking versus ContextAdapt v2 was +4.3 points, 95% CI
  [-4.6, +15.3], so its incremental held-out value is not established;
- the evaluator-only anchor oracle exceeded ContextAdapt v3 by +42.9 points,
  95% CI [+29.8, +55.8], exposing large remaining location headroom.

All 840 held-out monotonicity checks passed: a larger ContextAdapt budget never
lost a previously retained anchor, hunk, issue line, or strict success. All 480
oracle-isolation checks passed, and there were zero delivered over-budget or
missing-exact-evidence cells. An adversarial same-file traceback caused one
held-out regression at 40% (and one offsetting improvement), confirming that
untrusted location hints still need provenance-aware weighting.

The source ratio is not the whole bill. The fixed issue text was excluded from
source allocation but included in the reported all-in estimate. All token
numbers are characters divided by four, not provider tokenizer usage.

## 5. The deep conclusion

This experiment falsified the tempting strong story that “preserving the user
request plus a clever structural slice is enough to know the shortest safe
context.” It is not. ContextAdapt can now guarantee exact-evidence preservation,
budget compliance, deterministic recovery, and monotonic escalation. It can
also beat naive truncation on real code. But on the held-out set, 8 of 30 tasks
still needed the full source before every gold hunk was retained, and the
renderer itself could not know which eight without evaluator-only information.

That creates a clean separation:

1. **Proven now:** ContextAdapt can build a safer, auditable context candidate
   and substantially outperform position-only truncation.
2. **Not proven:** the candidate is the shortest context that lets an Agent
   finish the task.
3. **Required next:** send the candidate to a real task Agent, run the real
   verifier, escalate on failure, and count the failed attempt, recovery,
   reviewer, and larger-context retry. Only that closed loop can turn retention
   into a user-facing 200K/400K/1M recommendation.

## 6. Product claim still pending

The external coding-task layer has now been executed, but only as a within-file
retention benchmark. The gold-touched file is preselected, so repository search
is not tested. No Paritok model or task-Agent call was made.

`IMPROVED` remains unearned. It requires blinded, paired runs of the same Agent,
task, Host state, and verifier across:

1. always-largest + raw + verify-all;
2. always-small + raw + native verification;
3. ContextAdapt tier selection only;
4. ContextAdapt tier + exact renderer + risk allocation + execution gate.

The primary acceptance target is not maximum compression. It is equal safety
and completion versus the largest-context baseline at lower all-in cost,
including review, verification, recovery, retries, and failed attempts.
