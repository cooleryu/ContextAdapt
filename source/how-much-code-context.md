---
title: How Much Code Context Does an AI Agent Need?
subtitle: Evidence from 2,160 held-out evaluations
description: A controlled study of whether smaller, structured code contexts retain action-critical evidence better than naive truncation—and what that still does not prove.
slug: how-much-code-context-does-an-ai-agent-need
date: 2026-09-02
updated: 2026-09-03
author: cooleryu
evidence: REAL_CODE_RETENTION_HOLDOUT
---

# How Much Code Context Does an AI Agent Need?

> Evidence from 2,160 held-out evaluations

When people discuss long context, the first question is usually whether a model can accept 200K, 400K, or even one million tokens.

For an agent that edits code and calls tools, that may not be the question that matters most.

The practical question is this:

> **Does this task actually need 200K, 400K, or something close to one million tokens? Can an agent work from a smaller context without losing the evidence that could change—or veto—its next action?**

That is the product question behind [ContextAdapt](https://github.com/cooleryu/ContextAdapt). It is not another attempt to create a larger context window. It is an attempt to identify the smallest defensible context candidate for a task, preserve the evidence that matters, and check that evidence again before execution.

This article reports our first strict held-out evaluation of the context-construction part of that idea.

The result is promising but deliberately narrow: across seven compressed source budgets, ContextAdapt improved strict evidence retention by **22.4 percentage points** over head-and-tail truncation. It did **not** establish that an agent completed more tasks, found the universally shortest safe context, or reduced a real provider bill.

That distinction is the point of the work.

## The question we originally made too simple

Our first intuition was attractive: preserve the user request, file paths, exact values, and a few critical code spans; compress everything else; then declare the smallest passing candidate the “shortest safe context.”

Only half of that intuition survived contact with the evidence.

Short contexts can clearly fail through omission. A recent goal can be truncated. `timeout=60` can become a vague summary. A revoked write permission can disappear. But a large context is not automatically safe either. An agent may have access to the new evidence and still spend its limited verification effort elsewhere. It may continue organizing an apparently coherent action around an old goal, an old file state, or an old permission.

So “is the context sufficient?” is actually three different questions:

1. Did the critical evidence enter the context?
2. Did the agent inspect and use that evidence correctly?
3. Did the eventual tool call remain consistent with the current evidence?

This experiment measures the first question. It creates the foundation for testing the second and third, but it does not silently claim them.

## Four papers changed four parts of the design

We did not add recent paper titles to a README after the experiment. Each of these papers changed a concrete constraint in the protocol.

- [When Stale Constraints Go Unchecked](https://arxiv.org/abs/2608.25553v3) pushed us to separate evidence being accessible from evidence actually being verified under a limited budget. That led to explicit risk ranking and an execution gate, rather than merely displaying the freshest record.
- [Paritok-4B](https://arxiv.org/abs/2608.24188v1) made a simple comparison between 200K, 400K, and one million tokens look insufficient. Within the same budget, we also need to compare how policies preserve verbatim code, edit anchors, and exact values.
- [JIT-Agent](https://arxiv.org/abs/2608.25593v1) reinforced the need to freeze everything outside the context policy. If memory, planning, tools, and the action protocol all change together, any improvement becomes impossible to attribute.
- [PILOT in the Loop](https://arxiv.org/abs/2608.26530v1) made the cost boundary explicit. Observation, recovery, retries, and verification must be counted separately. A supervisor that consumes all the savings cannot be hidden inside “system overhead.”

The resulting principle was simple: change the context policy, freeze the rest, and label the evidence at the level the experiment actually supports.

## How we avoided designing the test after seeing the answers

The evaluation had two layers.

First, we reanalyzed 900 frozen Luna trajectories. We ignored the labels already stored in the dataset and recomputed outcomes from the records the model selected and the answers it produced. This showed an external failure pattern: for the same model, the problem was sometimes not missing memory but scarce verification attention being allocated away from the evidence most capable of vetoing an action.

That reanalysis was not counted as a ContextAdapt product win.

The second layer moved to real code. We used **23 development tasks** to repair the method. We then froze the renderer, evaluator, data split, source-file inventory, metrics, thresholds, and statistical procedure before running the **30-task holdout once**.

Those 30 tasks came from 12 repositories. We compared nine context policies at eight source budgets, producing **2,160 held-out evaluation cells**.

The critical isolation rule was this:

> The renderer could see the issue and the baseline source tree. Only the evaluator could see the gold patch.

ContextAdapt therefore could not inspect the answer and then pretend it had discovered the relevant code independently.

## What counted as a strict pass

We used a stricter criterion than “the keyword still appears.” A candidate context had to satisfy all three conditions:

- stay within its allocated source budget;
- preserve every issue line that could be matched exactly in the source;
- preserve at least one pre-change source line from every hunk that was actually modified.

This is still an **evidence-retention metric**. A passing candidate has retained the material needed to reason about the change; it has not yet generated a patch, run tests, or completed the task.

## Results: better than positional truncation, not magic

The clearest budget points are below.

| Source budget | ContextAdapt strict pass | Lexical intent retrieval | Head + tail | ContextAdapt hunk coverage | Estimated total input ratio, including issue |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10% | 10/30 (33%) | 6/30 (20%) | 4/30 (13%) | 41.7% | 14.9% |
| 20% | 12/30 (40%) | 10/30 (33%) | 8/30 (27%) | 50.0% | 24.4% |
| 40% | 18/30 (60%) | 18/30 (60%) | 10/30 (33%) | 67.8% | 43.2% |
| 60% | 22/30 (73%) | 20/30 (67%) | 12/30 (40%) | 85.0% | 62.2% |
| 100% | 30/30 (100%) | 30/30 (100%) | 30/30 (100%) | 100.0% | 100.0% |

Across the seven compressed budgets, ContextAdapt exceeded head-and-tail truncation by **22.4 percentage points** in strict evidence retention. A repository-clustered bootstrap gave a 95% confidence interval of **[+2.4, +40.6]**.

That is real progress. When full source was unavailable, organizing context around exact evidence and code structure was materially better than keeping only the beginning and end.

Three less flattering results matter even more.

### 1. The lexical baseline remained competitive

ContextAdapt exceeded the simpler lexical-intent retriever by only **7.1 percentage points**, with a 95% confidence interval of **[-2.3, +17.9]**. Because the interval crosses zero, we cannot claim that the structured policy reliably beats that baseline. At the 40% budget, both passed 18 of 30 tasks.

### 2. Eight tasks still required the full source

Eight of the 30 holdout tasks needed 100% of the selected source files to retain every modified hunk. A better renderer can improve the hit rate, but it cannot yet know in advance which tasks are unsafe to compress.

### 3. The oracle exposed a large remaining gap

An evaluator-only anchor oracle—allowed to use the answer—outperformed ContextAdapt by **42.9 percentage points**, with a 95% confidence interval of **[+29.8, +55.8]**. The oracle is not deployable. Its value is diagnostic: the difficult problem remains identifying which code will truly matter without seeing the future patch.

## Checks designed to make a flattering result harder

The holdout also included tests aimed at breaking the method.

- All **840 budget-monotonicity checks** passed: increasing the budget never removed evidence that had already been retained.
- All **480 oracle-isolation checks** passed.
- No delivered context exceeded its assigned budget.
- No candidate dropped exact issue evidence that the protocol required it to preserve.
- A misleading traceback placed in the correct file still caused one regression at the 40% budget, showing that unverified location hints cannot be trusted blindly.

The complete frozen ledger and protocol are available in the [evidence package](../../evidence/).

## What this experiment falsified

It falsified a conclusion we wanted to believe:

> Preserve the request, create a clever structured slice, and you can immediately know the shortest safe context.

We cannot make that claim.

ContextAdapt can now construct a shorter, auditable context candidate that retains strict code evidence more effectively than positional truncation. It can enforce a source budget, preserve specified evidence verbatim, and prevent evidence from disappearing as the budget grows.

But evidence being present does not mean an agent will use it correctly. A pre-change source line being present does not mean the generated patch will pass its tests.

The honest label is therefore:

```text
REAL_CODE_RETENTION_HOLDOUT
```

Not:

```text
IMPROVED
```

This is not a defensive footnote. It is the input to the next product decision.

## What the user-facing product should eventually say

A useful ContextAdapt experience should not show users a complicated evidence table. It should do the work in the background and say something like:

```text
Start with 200K.
The current goal, permission, exact values, and latest successful state are present.
If verification fails, upgrade once to 400K and count the cost of both attempts.
Before writing, check the target, permission, and evidence source again.
```

To make those four lines a real promise, the next experiment must close the loop:

1. Generate concrete 200K, 400K, and one-million-token candidates.
2. Run the same real agent, host, and tool protocol from the smallest candidate first.
3. Let a deterministic verifier decide whether the task completed.
4. Upgrade at most once after failure.
5. Recheck goal, permission, and provenance immediately before mutating tools run.
6. Count failed first attempts, review, recovery, retries, larger windows, latency, and provider input cost.
7. Compare blindly against “always use the largest window” and “always use the smallest window.”

Only if ContextAdapt reduces end-to-end cost without lowering completion rate or safety should the evidence label move from retention to improvement.

## Four explicit limits

- This stage made no new Luna or task-model calls. The 900 Luna trajectories came from frozen external experimental data.
- The real-code study used source-budget ratios from 10% to 100%; it did not rerun a provider at literal 200K, 400K, and one-million-token windows.
- Token cost in the table is estimated as characters divided by four. It is neither a provider tokenizer result nor a real bill.
- Gold-patch files were preselected, so this stage did not test repository-wide file search. Evidence retention is not patch generation, passing tests, or task completion.

These constraints mean we have a more credible context-candidate generator and a clearer map of where it fails. We do not yet have the final user savings number.

## The most useful result was not the largest number

If the goal were a clean demo, we could select a few tasks that pass at a 20% budget and announce an 80% saving.

But a system that intends to stand between an agent and a real tool cannot depend on selecting friendly tasks.

The most useful result was not the 22.4-point lift. It was narrowing the product claim to something testable:

> **ContextAdapt is getting better at constructing context candidates. The next step is to make a real agent, a real verifier, and the full cost ledger determine which candidate is actually the shortest defensible one.**

Research should not manufacture a cleaner story for the product. It should tell us which sentence we have earned the right to say next.

---

## Reproduce, challenge, or extend the work

- [Browse the evidence package](../../evidence/)
- [Read the frozen result ledger](../../evidence/p0-results.md)
- [Inspect the frozen protocol](../../evidence/protocol-v3.json)
- [View ContextAdapt on GitHub](https://github.com/cooleryu/ContextAdapt)
- [Open a methodological question or counterexample](https://github.com/cooleryu/ContextAdapt/issues)

If you maintain a coding agent, I am especially interested in failure traces where the correct evidence was technically available but the agent verified the wrong thing, used an obsolete state, or acted from a permission that had already changed.

*Editorial note: this English edition was prepared with AI-assisted translation and editing from the original Chinese research note. The author is responsible for the argument, and every experimental claim was checked against the frozen result ledger.*
