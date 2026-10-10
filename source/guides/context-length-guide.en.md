# Choosing context length for AI coding agents

Published · 10 October 2026

**Start with the material needed for the change, not the model's largest window.** Gather the relevant code, current instructions, and tests. Check whether that material fits within your active tool's limits. Then run the task and verify the result. A larger window is a candidate to test, not a guarantee of a correct fix.

This guide helps you choose the first input and decide what to do if it fails. It draws on our work on [ContextAdapt](https://github.com/cooleryu/ContextAdapt). Our [published study](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/) tests which code evidence different selection methods retain. It does not establish a universal context length for coding agents.

## How much context does an AI coding agent need

There is no single token count we can recommend for every coding task. Use the following checklist to prepare a first attempt. It is a starting procedure, not a proven minimum.

### Choose the material for the task

For every task, include the requested behavior, current constraints, permitted changes, and how you will check completion. Then add the relevant code and tests:

| Task | Material to gather first |
| --- | --- |
| A bounded bug fix | The failing input or error, relevant implementation, direct callers, and a test that reproduces the failure. |
| A change across modules | The material above, plus the affected interfaces, configuration, dependencies, and tests for the connected modules. |
| A repository-wide migration | The migration scope, affected modules, current and target versions, compatibility requirements, and migration checks. Retrieve source as each part needs it. |

For example, suppose a parser fails on empty input. Include the parsing function, the caller that supplies the input, and the failing test. This is a hypothetical teaching example, not a ContextAdapt result. Do not assume that either one function or the entire repository is always the right input.

Next, measure the assembled input with the active tool's token counter, if available. Include instructions, conversation history, and tool results in the accounting. Leave output space according to the provider's rules. **Window capacity** is the available limit. **Actual input** is what you send. **Required evidence** is what the task needs. These are different quantities. Check the current provider and tool limits; a model name alone is not enough. See [Google's context guide](https://ai.google.dev/gemini-api/docs/long-context) for the window concept.

### If the attempt fails, check the cause

- **A needed file is missing:** retrieve it and retry. Adding relevant material does not always require a larger window.
- **Indispensable material will not fit:** test a larger supported budget, or split the work where its dependencies permit. Verify the result in either case.
- **The environment or permissions block the task:** repair the test setup if authorized, or stop for permission. More tokens do not resolve these failures.

### What our experiment adds

At a 40% source budget, our 30-task held-out comparison recorded strict evidence-retention passes for 10 tasks with head-and-tail truncation, 18 with lexical retrieval, and 18 with ContextAdapt v3. The relevant source file was preselected. These were **retention passes, not completed fixes**. This result motivates comparing selection methods; it does not prove that ContextAdapt is better than lexical retrieval at this budget. Read the [study and its limitations](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/) for the full experiment. It is not a 200K-versus-1M test.

## How to choose context window size for coding tasks

**Choose a context policy against a clear completion test.** A policy includes what you retrieve, what you keep, and when you add more. The window limit alone does not specify any of these.

Start with this task card. The example is hypothetical:

| Item | Example for an API adapter change |
| --- | --- |
| Required result | Accept the new response format while preserving the existing format. |
| First input | Both format specifications, adapter code, direct callers, and relevant tests. |
| Verification | New-format tests, old-format regression tests, and a check of the changed files. |
| Limits | Do not edit stored customer data or unrelated modules. |

Count the complete request, not just the source files. Instructions, history, and tool results also occupy context, as [VS Code's documentation explains](https://code.visualstudio.com/docs/agents/concepts/context). Reserve output space under the provider's rules.

Prepare two candidates: the focused material above, and that material plus relevant dependencies that may explain a failure. Run them from separate copies of the same starting state. Keep the model, tools, and tests fixed. Record completion, constraint violations, total cost, and elapsed time.

If the focused input passes, test that policy on another representative task. If it fails because a dependency is missing, retrieve it before assuming a larger window is necessary. If you must switch models to get a larger window, label the result as a comparison of two setups, not proof of a context-length effect.

## Is 200K context enough for coding agents

**It can be enough when the necessary input fits and the agent passes the task checks.** These are separate conditions. Fitting within a limit does not prove that the input contains the right evidence or that the agent can use it.

Here is a hypothetical budget, not a measured ContextAdapt run. Assume the active setup permits 200K tokens shared between input and output, and permits a 16K output allocation:

| Component | Tokens |
| --- | ---: |
| Instructions, tool definitions, and existing history | 12K |
| Selected source code | 68K |
| Test results and error details | 4K |
| Reserved output allowance | 16K |
| Total allocated | 100K |

The current input is 84K tokens. This allocation leaves 100K before the assumed shared limit. It does not guarantee space for every later tool result. Recount as the session grows, and check separate input and output limits. Use the active model's counter when available; [Google documents request counting and response usage](https://ai.google.dev/gemini-api/docs/tokens).

For this example, start with the assembled material and run the tests. Do not add unrelated files to fill the window. If a caller is missing, retrieve that caller. If indispensable material no longer fits, compare a larger supported budget. If tests cannot start because a dependency is absent, fix the authorized environment first. If permission is missing, stop and ask. None of these failures, by itself, proves that 200K is insufficient.

## How to choose between 200K and 1M for coding

**Compare task outcomes, not window labels.** Here, 200K, 400K, and 1M are example capacity limits. Use them only if your active setup supports them. A 1M limit does not require sending 1M tokens.

For a cross-module migration, first locate the affected interfaces, callers, and tests. If the relevant material fits within the smaller budget, try that candidate. If necessary relationships cannot be retained together, test a larger candidate or split the work along verifiable boundaries.

Compare these policies on the same representative tasks:

| Policy | Rule to test |
| --- | --- |
| Fixed smaller limit | Retrieve relevant material within the smaller limit. |
| Fixed larger limit | Allow more relevant material, without filling space deliberately. |
| Conditional enlargement | Start smaller; add capacity only when a recorded missing-evidence or fit problem justifies it. |

Specify retry limits before running. Count the first attempt, retrieval, preparation, and every retry. Keep the model and tools fixed where possible. Include an intermediate 400K candidate only if it helps answer a real decision.

Check the tool's summarization behavior too. [VS Code documents](https://code.visualstudio.com/docs/agents/concepts/context) that older conversation details may be compressed or lost when it summarizes history. A larger limit and a better summary policy are different changes.

Select the policy that meets your declared completion and safety criteria at an acceptable total cost. An adaptive policy is a candidate, not an assumed winner. Our [published retention experiment](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/) does not establish which of these window sizes wins.

## Does a longer context window improve coding accuracy

**Sometimes, but a larger window is not a guarantee of a correct patch.** It can help when it restores information the task needs. It does not prove that the agent will use that information correctly.

A 2024 Google and Sourcegraph case study reported better technical question answering with a long-context Cody setup. That is evidence for that setup and task, not a universal improvement in bug fixing. Google's context guide also warns that retrieving several pieces of information can be less reliable than finding one. [Coding assistant case study](https://developers.googleblog.com/en/supercharging-ai-coding-assistants-with-massive-context/) · [Retrieval limits](https://ai.google.dev/gemini-api/docs/long-context#long-context-limitations)

Before paying for more context, compare three inputs on the same task:

1. The current input.
2. The same input plus specific missing evidence, such as a caller or failing test.
3. A larger collection that includes that evidence and more surrounding code.

Keep the model, starting code, tools, and acceptance tests fixed. Repeat each condition. Compare verified fixes, regressions, unauthorized actions, cost, and time. If only the focused addition helps, the result favors that selection policy; it does not justify filling the window. If larger inputs help repeatedly, test whether the gain is worth their total cost.

Our published study below answers a narrower question: which code evidence survives selection. It does not measure completed repairs.

### What our held out comparison actually found

In our study frozen on 2 September 2026, we tested context selection on 30 held-out SWE-bench Lite tasks from 12 repositories. At the same 40% source budget, the strict evidence-retention results were:

| Context selection policy | Tasks meeting the retention criteria |
| --- | ---: |
| Head and tail truncation | 10 of 30 |
| Lexical intent retrieval | 18 of 30 |
| ContextAdapt v3 | 18 of 30 |

A pass required staying within budget, preserving every exact issue line found in the source, and retaining at least one original line marked for removal in each reference-patch hunk. It did **not** mean the agent fixed the issue. The relevant file was preselected using the reference patch; the selector saw the issue and original source, while patch contents remained evaluator-only. Repository search and patch execution were outside this test.

This comparison gives a practical reason to test **which context you keep**, not just how much. It also challenges our own design: at this budget, the more elaborate policy did not beat lexical retrieval. Averaged over all seven compressed budgets, its advantage over lexical retrieval was 7.1 percentage points, with a 95% confidence interval of −2.3 to +17.9; that improvement remains inconclusive.

For a builder choosing a policy, the implication is to include a simple relevance-based baseline before adding complexity. Beating truncation alone is not enough. These percentages are source-allocation budgets using a character-based token estimate, not comparisons of literal 200K and 1M windows. See the [result ledger](https://cooleryu.github.io/ContextAdapt/evidence/p0-results.md) and [frozen protocol](https://cooleryu.github.io/ContextAdapt/evidence/protocol-v3.json) for the full comparison.

## How to balance context length cost latency and accuracy

**Choose an acceptable completion rate and safety requirement first. Then compare total cost and time.** The cheapest request is not necessarily the cheapest completed task.

Keep one record per task attempt:

| Record | What to include |
| --- | --- |
| Outcome | Independent test result, regressions, constraint violations, and failure reason. |
| Usage and charges | All input and output tokens, cached usage, preparation calls, retrieval, retries, and escalations. Record actual charges separately from estimates. |
| Time | Start to final outcome, including tools and retries. Keep first-token latency separate. |
| Conditions | Model, context policy, task version, and cache state. |

For Gemini, Google notes that longer requests generally increase time to first token, while caching can reduce repeated-input costs. Neither claim gives the total time or price of your coding workflow. Check the active provider's rules and measure the full run. [Latency guidance](https://ai.google.dev/gemini-api/docs/long-context#does-the-context-length-affect-the-model-latency) · [Caching documentation](https://ai.google.dev/gemini-api/docs/caching)

A useful summary is **total measured cost, including failed attempts, divided by verified completions**.

For a fictional example, policy A spends $2 across ten tasks and completes eight: $0.25 per verified completion. Policy B spends $1.50 on the same ten tasks and completes five: $0.30 per completion. A costs more overall but less per completed task. This is arithmetic, not a ContextAdapt result or a provider quote.

Report completion rate, safety failures, and typical and slow-run times beside that ratio. If no task completes, the ratio is undefined. A policy that violates a required safety condition remains unacceptable even when its average cost is low.

## How to measure the minimum context for a coding task

Measure the **smallest tested context that meets a fixed acceptance rule**, not a universal minimum. Start with one bounded fix and one harder cross-file change.

1. Freeze both tasks, starting commits, required tests, protected files, and success thresholds. Keep expected patches out of context selection.
2. Choose several supported input budgets. Apply each budget to every model request, not just the opening prompt. Fix the model, tools, output allowance, retrieval, and summarization rules. Changing the selection policy as well as the size tests two factors.
3. Run each candidate from a clean state. Set repetitions, retry limits, and escalation rules before starting. Keep every failure.
4. Save the actual context and all attempts. Count retrieval, preparation, review, retries, input/output usage, cost, and end-to-end time.
5. Compare completion, constraint violations, and cost. Repeat promising candidates on unseen tasks before making a broader recommendation.

Use one row per task, candidate, and repetition:

| Record | Save |
| --- | --- |
| Setup | Task, commit, model, selection policy, input budget |
| Outcome | Required tests, protected-file checks, failure reason |
| Full attempt | Actual input, output usage, retries, cost, elapsed time |

Do not assume that success rises steadily with context length. A binary search alone cannot establish the minimum. One successful attempt is also not evidence of reliability.

Retained evidence and completed repairs are different measurements. [ContextBench](https://arxiv.org/abs/2602.05892) likewise measures intermediate context retrieval rather than relying only on final success.

In our frozen retention study, ContextAdapt v3 required the full **preselected source** for 8 of 30 held-out tasks among tested budgets to retain every reference-patch hunk anchor. This does not mean eight live Agents required a full repository. It motivates the real-Agent test above, not an automatic stopping rule. [Frozen results](https://cooleryu.github.io/ContextAdapt/evidence/p0-results.md)

## Which open source tools help evaluate agent context length

Choose a tool by what you need to measure. These three do not automatically identify the optimal context window for your application.

| Tool | Measured unit | Does not establish | Where to start |
| --- | --- | --- | --- |
| [RULER](https://github.com/NVIDIA/RULER) | Synthetic long-context tasks with controlled length and complexity | Whether an Agent can safely repair your repository | Follow the current evaluation branches linked from its README |
| [SWE-bench](https://www.swebench.com/SWE-bench/guides/evaluation/) | Generated patches applied to real repositories and checked with tests | Which context policy caused the result or its total cost | Read the Lite evaluation and prediction-format instructions |
| [ContextAdapt](https://github.com/cooleryu/ContextAdapt) | In the published study: retained edit evidence under fixed source budgets | Live repair gains, bill savings, or a universal minimum window | Inspect the [evidence package](https://cooleryu.github.io/ContextAdapt/evidence/) and frozen comparison |

RULER helps test a model's long-context behavior. SWE-bench checks whether submitted patches resolve its tasks. ContextAdapt's published study compares how material-selection methods preserve source evidence. These are complementary jobs, not interchangeable scores.

Our study itself uses SWE-bench Lite tasks. It does not replace SWE-bench or claim to outperform its evaluation framework.

For your first coding experiment, use the two tasks and record format above. Produce a patch for each candidate, then run the same independent tests. If the Agent fails, examine its retrieved context separately from its patch. Add a synthetic benchmark when you also need to investigate long-context retrieval.

Check hardware, storage, credentials, and model-call costs before running an upstream benchmark. Reading its results is a different step from reproducing them.
