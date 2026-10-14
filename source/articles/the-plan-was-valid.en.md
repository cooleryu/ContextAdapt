---
title: "The Plan Was Valid. The World Had Changed: Why Context Problems in Long-Horizon Agents Become Execution Problems"
slug: the-plan-was-valid
canonical_url: https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/
description: "A short review of recent research, controlled experiments, and executor integration: long-context failures are not only about forgetting. Agents may act on facts and permissions that have already expired."
date: 2026-10-14
updated: 2026-10-14
language: en
keywords:
  - long-horizon AI agents
  - context management
  - stale context
  - action provenance
  - AI agent reliability
  - ContextAdapt
---

# The Plan Was Valid. The World Had Changed.

> Why context problems in long-horizon agents become execution problems

**Author: cooleryu**

An AI agent can remember every fact and still execute an apparently correct action at the wrong time.

Consider this sequence:

- At 10:02, the agent reads that the current environment is `staging` and that protected configuration may be modified.
- At 10:16, it plans a change to `staging/config.json`, but the task is interrupted.
- At 10:40, the environment has switched to `production`, the timeout has changed, and modifying protected configuration is no longer permitted.
- At 11:05, the old plan resumes.

The plan may be syntactically valid. The path may still exist. Every old fact may once have been correct. The problem is that **the world that justified the action no longer exists.**

This is the view I gradually arrived at while building [ContextAdapt](https://github.com/cooleryu/ContextAdapt). Context problems in long-horizon agents are not just about what a model forgets, or how much more text we can fit into its window. There is another question, closer to execution:

> When an agent is about to call a tool, can we establish that the action is still supported by the current state, instructions, and permissions?

This article brings together related research and experiments from an early Python prototype of ContextAdapt, with their evidence and limitations. Citing these papers does not mean that we have reproduced or improved on their results.

## 01 / From fitting more context to managing it

Early discussions often reduced long context to window size: if a model could read more tokens, long-running tasks would become more reliable. Recent research presents a more complicated picture.

[LOCA-bench](https://arxiv.org/abs/2602.07962) treats growth in the environment itself as a controlled variable, studying agents under dynamic long-context conditions. Across the models and configurations it tested, longer environment descriptions generally accompanied worse performance; some context-management strategies improved the results.

[ContextBench](https://arxiv.org/abs/2602.05892) spans 66 repositories, 8 programming languages, and 1,136 tasks. It draws a useful distinction: an agent's having explored a piece of context does not mean it includes that material in the context it ultimately declares for generating a patch. There is still a gap between visiting information and declaring its use.

Other work gives agents a more active role in editing, externalizing, or compressing context. [ACM](https://arxiv.org/abs/2607.23809) studies agent-controlled context editing and external memory. [CoMem](https://arxiv.org/abs/2605.30842) separates memory processing from the main agent. [Active Context Compression](https://arxiv.org/abs/2601.07190) lets agents initiate compression through a tool. These approaches address a shared question: **how should limited attention be allocated?**

[TRACE](https://arxiv.org/abs/2608.06503) goes a step further. Repeated compression can weaken recent interactions, leading to blocked actions, repeated exploration, or instability later in the run. TRACE uses paired closed-loop continuations from the same state, with verifiers measuring additional blocked actions and repeated exploration after compression.

Taken together, these studies suggest a shift in emphasis:

| Direction | Main question it addresses | Question still open before execution |
| --- | --- | --- |
| Dynamic long-context evaluation | How does context growth affect task performance? | Which version of the state does this action depend on? |
| Retrieval and utilization analysis | What did the agent find, and what did it actually use? | Is the evidence it used still valid? |
| Editing, externalization, and compression | How can attention and latency costs be reduced? | Did compression preserve permissions and temporal relationships? |
| Paired closed-loop validation | Does rewriting context change subsequent behavior? | How can the finding be enforced before a real tool call? |

These approaches and ContextAdapt are not substitutes for one another. They address problems at different points in the context lifecycle.

## 02 / Managing context is not the same as authorizing an action

Carefully organized context can still contain an invalid plan. A summary can accurately repeat an old instruction without saying that it was later revoked. A retriever can find the right file but bind another entity's latest value to the current task.

That leads me to a narrower distinction:

> **Context management determines what an agent sees. Execution authorization determines whether it may still act now.**

The two need to connect, but they should not be conflated.

The early Python prototype of ContextAdapt operates at the last responsible moment: after a plan has formed, before a tool executes. Instead of asking whether the context is good overall, it asks the action for a minimal account of its provenance:

- `based_on_event`: which state or instruction does this action rely on?
- `permission_event`: for a protected operation, where does the current permission come from?
- Do those sources refer to the same entity?
- Have later events superseded them?
- Does the current state still permit this operation?

Within the supported action contracts, insufficient evidence blocks execution. Unknown is not treated as safe.

## 03 / Our first experiment challenged the easiest story to tell

“The context was too long, so the model forgot.” It is an appealing explanation and an easy story to promote. Our first experiments did not support such a simple conclusion.

In a test with explicitly marked, precisely retrievable facts in very long inputs, we made 9 real calls to `gpt-5.6-luna`, at roughly 198K, 398K, and 898K input tokens. Across those three sizes, all 27 authoritative facts were extracted correctly, with no stale-source errors. These results come from the project's internal experiment records; the complete records have not been published with this article.

The test was narrow. It was not a real agent workflow and did not include complex tool feedback. It nevertheless challenges an overgeneralization: **length alone does not necessarily cause clearly marked facts to be lost.**

The more useful question becomes: if the correct facts are still in the window, why does the agent act incorrectly?

## 04 / The danger is not just missing a fact—it is binding it incorrectly

We next constructed event-store traces with events presented out of order. The correct facts remained visible, alongside multiple entities, successive updates, failed reads, and old state. The agent had to determine which information belonged to the current object, which reads were trustworthy, and which values had been superseded.

The results diverged:

| Input condition | Exactly correct | No protected modification requested | Wrong source |
| --- | ---: | ---: | ---: |
| Raw 200K | 5/6 | 6/6 | 1/6 |
| Raw 400K | 2/6 | 2/6 | 4/6 |
| Raw 900K | 2/6 | 2/6 | 4/6 |
| Current state extracted from the 900K trace | 6/6 | 6/6 | 0/6 |

Here, K denotes the nominal size of the original trace. The normalized input was shorter. We scored action JSON only; no writes were executed. With the same state hash, four failed cases became successes, with no regressions in the other direction. These data also come from internal experiment records; the full traces and methodology records have not been published with this article.

This is not simply memory loss. A closer description is that **the correct facts remained in the input, but the output used a value associated with the wrong time, entity, or source.**

Changing the order alone was not enough either. In an experiment in the same report that held content constant and varied only its order, ordering changed the error counts and error types in the tested sample. Yet across 71 valid experimental units, none of the six plausible arrangements was entirely correct; every arrangement produced at least one error. Ordering can affect risk, but it is not a safety mechanism.

## 05 / From failure attribution to paired replay from the same state

If context really caused a failure, repairing it and continuing from the same environment state should produce a repeatable change in the result. Otherwise, we may be misclassifying a tool failure, an environmental difference, or random variation as a context problem.

We therefore ran a controlled experiment closer to a diagnostic workflow:

1. Locate a high-friction interval in a failed trace.
2. Freeze the environment state and task objective.
3. Give the agent either the raw trace tail, structured recent state, or a summary plus recent state.
4. Run paired executions and use an independent outcome check to determine whether the context intervention changed behavior.
5. Add tool-failure controls so that unavailable tools are not mistaken for a context cause.

The initial experiment contained 24 opaque tasks across 8 hidden task families. On its 8-task holdout set, structured recent state achieved an 87.5% success rate, compared with 25% for the raw trace tail. In a subsequent, newly constructed holdout set, anchor precision was 4/4, with 1/4 for the remaining non-anchor controls. The injected tool-failure controls failed task validation under every tested strategy and were not attributed to context. These results come from internal experiment records; the complete records have not been published with this article.

The numbers are informative, but their scope matters. They come from controlled configuration-editing tasks. They do not estimate how often context failures occur in the real world, or establish that different models would see the same gains.

## 06 / The final step: making validation stop a tool call

A diagnostic report becomes an engineering safeguard only when it reaches the execution boundary.

The prototype's minimal path is:

```text
Immutable event log
    ↓
Reconstruct current state; distinguish trusted reads from failed observations
    ↓
Check action provenance, entity scope, temporal order, and current permissions
    ↓
ALLOW or BLOCK
    ↓
Supported tool calls proceed only on ALLOW
```

The Python prototype demonstrates that path with:

```bash
python3 -m contextadapt demo
```

The stale action in the demonstration receives `BLOCK` for two reasons: current permissions do not allow the protected modification, and later events have superseded the state it relies on. `contextadapt check TRACE.jsonl` succeeds only when the evidence is sufficient and validation passes. A `BLOCK` result or insufficient evidence fails closed with exit code 2.

The executor validation connected prepared, already accepted relation examples to the tool boundary. In the Codex setup tested at the time, `PreToolUse` checked for stale context before `apply_patch`. OMP's `tool_call` covered writes, edits, and recognizable mutating shell commands. In the paired cases, the stale path was blocked and the file remained unchanged; the current path was allowed and wrote to the file. Opaque scripts and tools outside that coverage are excluded from the conclusion. Machine-readable results are in the [executor validation report](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/artifacts/executor/real-executor-report.json). The project's [executor integration documentation](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/docs/executor-integrations.md) provides further reading, but its description of the current implementation is not a substitute for that historical validation.

That OMP executor validation used a deterministic mock provider. The report records that the remote Qwen backend was offline at the time. It demonstrates the execution-blocking path, not the decision quality of an online Qwen model.

## 07 / Why a semantic layer is still needed—and is not a safety proof

Some relationships cannot be established by comparing fields alone: whether two passages refer to the same entity, for example, or whether a new event truly overrides an earlier instruction. The prototype's hybrid path lets the host supply semantic analyses from two separate runs: one proposes relationships; the other reviews them.

The deterministic core does not make hidden model calls or treat a missing semantic analysis as evidence of safety. It checks:

- whether quotations match the original events verbatim;
- whether temporal order and entity scope are consistent;
- whether structured values have evidential support;
- whether the review comes from a separate run;
- whether a SHA-256 digest binds the reviewed content to the original proposal;
- whether every changed field is covered;
- whether any unresolved issues remain.

A semantic model can propose a judgment. The deterministic core performs the mechanical checks and fails closed. Separate runs and hash binding do not, by themselves, establish that the semantic judgment is correct. The project's [hybrid semantic-relations documentation](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/docs/hybrid-relations.md) describes the relevant contracts. It has evolved with the implementation and should not be read as an exact description of this early prototype.

## 08 / What ContextAdapt has not established

I do not want to present an alpha project as a universal safety layer. The evidence supports a specific set of capabilities:

- Detecting when an action depends on superseded instructions or state.
- Detecting when a protected modification lacks current permission.
- Enforcing deterministic `ALLOW` / `BLOCK` rules before a tool call.
- Using paired replay from the same state to test whether an intervention changes the outcome.

It has not established that:

- all failures in long-horizon agents come from stale context;
- the verifier can understand every semantic relationship in arbitrary natural language;
- a trace fabricated by a malicious host can be detected automatically;
- gains in these controlled experiments generalize directly to all models, frameworks, and production tasks;
- installing ContextAdapt makes an agent “safe.”

In particular, the event trace remains a trusted record supplied by the host. The verifier can check internal consistency, but it cannot authenticate a fabricated history from nothing.

## 09 / A more precise question

We have often asked: how much does the agent still remember?

Perhaps we should also ask:

> Before it acts, can we see what the action is based on and confirm that those grounds still hold now?

Long context, retrieval, summaries, external memory, and compression all matter. They help agents form better plans. But when a plan survives across time, it needs a check at execution: has the world changed, have permissions changed, or has newer evidence superseded the old?

**The plan was valid. The world had changed.**

ContextAdapt aims to give the system one last opportunity to say no before an old plan meets the real world.

---

## References and experiment records

### Recent research

1. [LOCA-bench: Benchmarking Language Agents Under Controllable and Extreme Context Growth](https://arxiv.org/abs/2602.07962)
2. [ContextBench: A Benchmark for Context Retrieval in Coding Agents](https://arxiv.org/abs/2602.05892)
3. [CoMem: Context Management with A Decoupled Long-Context Model](https://arxiv.org/abs/2605.30842)
4. [ACM: Agentic Context Management for Long Horizon Tasks](https://arxiv.org/abs/2607.23809)
5. [Active Context Compression: Autonomous Memory Management in LLM Agents](https://arxiv.org/abs/2601.07190)
6. [Toward Reliable Context Compression for Long-Horizon Agents: An Empirical Study of Execution Instability](https://arxiv.org/abs/2608.06503)

### Project experiment records and implementation documentation

The three groups of results—explicit fact retrieval in very long inputs, hidden temporal and entity conflicts, and failure anchors with paired replay from the same state—come from ContextAdapt's internal experiment records. This article reports the results and limitations, but does not provide a public version of the complete records. Readers cannot currently audit these experiments independently from the article alone.

The links below are pinned to the same repository commit so that later updates do not change the cited material. The executor report records historical validation. The other documents describe the implementation at that commit; they do not imply that it is identical to the early Python prototype.

- [Executor validation report](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/artifacts/executor/real-executor-report.json)
- [Action guard contract](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/docs/action-guard.md)
- [Executor integrations and limitations](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/docs/executor-integrations.md)
- [Hybrid semantic-relations protocol](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/docs/hybrid-relations.md)
