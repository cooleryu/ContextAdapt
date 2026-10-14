---
title: "Codex at 500K: more room, but check the state before writing"
slug: codex-500k-context
description: "Start with the default, restore missing evidence, and check the current target, file state, and permission before writing."
date: 2026-10-14
updated: 2026-10-14
language: en
author: cooleryu
---

# Codex at 500K: more room, but check the state before writing

**A larger default window gives Codex more room before capacity-triggered compaction. Whether it makes the right edit still depends on current evidence and permission. Start with the default, restore missing evidence deliberately, and check what is still true before writing.**

[Tibo says](https://x.com/thsottiaux/status/2109430343346581527) GPT-6.1 Sol's default in Codex and Work has increased from 272K to 500K to reduce compaction and preserve nuance, with overrides up to 1M. He also says [subscription usage has no long-context surcharge](https://x.com/thsottiaux/status/2109430894604026039).

## Keep the default until the task gives you a reason

If the agent loses a dependency, constraint, or earlier decision that still matters, restore that evidence first. Then compare a larger input containing the same evidence and more surrounding material. Look for a better result, not simply a fuller window.

For a local change with clear current state, try more focused input. Reducing active material and lowering the host's window limit are different changes; record which you made. Count reacquisition and retries when judging the result.

## More remembered history can include an expired plan

Imagine an agent reading a staging configuration and preparing an edit. Before it resumes, the user changes the target and revokes permission. The old plan still makes sense, and a large window may preserve every word. Its authority has expired.

Before writing, check the current target, relevant file state, and authorization; refresh conflicting evidence. I discuss this problem in more detail in [*The plan was valid. The world had changed*](https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/).

## What our existing results show

In an earlier ContextAdapt experiment, `gpt-5.6-luna` resolved synthetic histories involving a changed target, revoked permission, or failed observation. Passing meant that its decision JSON matched the expected answer. The [individual results](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/experiments/long-context/results/luna-v1.jsonl) and [summary](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/experiments/long-context/results/luna-v1-summary.json) are public.

| Target tier | Measured final-turn input tokens | Decision checks passed |
| --- | ---: | ---: |
| 200K | 197,802–197,835 | 3/3 |
| 400K | 393,709–393,747 | 3/3 |
| 1M target load | 883,258–883,470 | 3/3 |

The lesson is modest: explicitly marked state changes remained solvable in these runs.

The separate retention benchmark in our [published study](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/) used 30 held-out tasks from 12 repositories. At a 40% source budget, head-and-tail truncation passed strict retention on 10/30 tasks; lexical retrieval and ContextAdapt v3 both passed on 18/30.

Across the compressed-budget curve, ContextAdapt's advantage over lexical retrieval was 7.1 percentage points, with a 95% interval from −2.3 to +17.9. Include a simple relevance-based baseline before adding a complicated selector: that interval leaves the advantage uncertain. The [result ledger](https://github.com/cooleryu/ContextAdapt/blob/258861ec7e732ff38c587558626b4db432c6b120/evidence/p0-results.md) and [protocol](https://github.com/cooleryu/ContextAdapt/blob/258861ec7e732ff38c587558626b4db432c6b120/evidence/protocol-v3.json) are public; the underlying per-case data remain in internal project experiment records and are not yet public.

## Run a comparison you can learn from

Keep the task, starting commit, model, tools, permissions, and independent acceptance tests fixed. Compare the default input, a targeted evidence addition, and a larger input; repeat each condition. Our [context-length guide](https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/) walks through this process.

Record completed fixes, regressions, unauthorized actions, compactions, repeated reads, all attempts' tokens, and elapsed time. Missing telemetry stays unknown. Count the whole attempt history, not just the successful final request.

## FAQ

### Should I change settings immediately because the default is 500K?

Inspect the current session's model and effective capacity. Keep the default while establishing a baseline unless necessary evidence is missing.

### Is 500K or 1M better for a coding agent?

Compare matched tasks. Expand when the larger condition repeatedly improves independently verified outcomes.

### Why does my client still show 258K?

[A LINUX DO user raised the same question](https://linux.do/t/topic/3013574), but the display alone cannot identify the cause. Record client version, session model, capacity field, and overrides; distinguish the announced default, effective capacity, and available input budget.

### Does less compaction mean fewer mistakes?

Check what survives, whether obsolete state is being used, and whether the task passes. Compaction count measures a process, not correctness.

### How do I measure the context my task actually needs?

Use a repeatable task and independent verifier, add missing evidence deliberately, then compare supported capacities. A single success does not establish the smallest safe context.

## What this article has not established

- We have not tested Codex 500K or ranked it against other capacities. The subscription announcement does not describe [API billing](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and the 258K report does not establish a cause.
- The input-load experiment checked decision JSON, executed no code changes, and ran each scenario once per tier. Context load and turn count changed while the configured window stayed constant; 1M was a target, not measured input.
- Retention required exact issue lines, original-source anchors for every reference-patch hunk, and budget compliance. Files were preselected and budgets were character estimates; this does not demonstrate bug fixes or savings.
- OMP integration used a deterministic provider to test enforcement before writes, not live-model context quality; that record is not yet public. The staging scenario is illustrative.

Further reading: [ContextAdapt on GitHub](https://github.com/cooleryu/ContextAdapt) · [Code-retention study](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/) · [Context-length guide](https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/).
