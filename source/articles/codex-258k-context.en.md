---
title: "Why does Codex show 258K? Getting the 500K default to take effect"
slug: codex-258k-context
description: "Separate the 258K display, the 500K default and the compaction threshold; check overrides and configure the window with documented settings."
date: 2026-10-15
updated: 2026-10-15
language: en
author: cooleryu
---

# Why does Codex show 258K? Getting the 500K default to take effect

**258K can be the usable-window calculation 272,000 × 95% = 258,400, rather than the model's maximum capacity. Tibo announced a 500K default for GPT-6.1 Sol in Codex and Work; the same calculation would display 475K. Check the selected model, configuration overrides and current session before setting a window manually.** [Calculation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L515-L538) · [Tibo's announcement](https://x.com/thsottiaux/status/2109430343346581527)

## Check these three things first

**The selected model.** The announcement concerns GPT-6.1 Sol. Check the model picker and, where supported, use `/status` to inspect the session. Record total capacity and usage separately: remaining context is not the total window. [Status command](https://learn.chatgpt.com/docs/reference/slash-commands)

**Existing overrides.** Inspect `~/.codex/config.toml` and trusted projects' `.codex/config.toml`, particularly `model_context_window` and `model_auto_compact_token_limit`. CLI flags, project configuration and a selected profile can take precedence over personal settings. In the CLI, `/debug-config` shows configuration layers and their sources. To follow the default, note and remove an old window override from the layer that sets it. [Precedence](https://learn.chatgpt.com/docs/config-file/config-basic) · [Diagnostics](https://learn.chatgpt.com/docs/developer-settings)

**Different sessions or model catalogs.** Record the client version and compare a fresh chat with the existing one using the same model. [LINUX DO users](https://linux.do/t/topic/3013574) report different capacities in new and old chats; a [GitHub issue](https://github.com/openai/codex/issues/53336) also records one chat dropping from 475K to 258.4K. Catalog or cache inconsistency is worth investigating, but these reports establish neither a universal cause nor a minimum version guaranteed to fix it.

## Set a 500K window manually

Put these entries at the **top level** of the configuration file that actually applies, before any `[table]` headers. Edit existing entries rather than adding duplicates. This example selects GPT-6.1 Sol; preserve your other settings.

```toml
model = "gpt-6.1-sol"
model_context_window = 500000
```

`model_auto_compact_token_limit` controls when automatic compaction triggers; it does not enable a larger window. If you previously set it, note its value first. To return to the model's default threshold, remove that override and check higher-priority configuration layers. [Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

After saving, restart the client and inspect a fresh chat. This is a diagnostic step, not a guaranteed catalog fix. The window override is also capped by the model catalog's `max_context_window`; editing a local number cannot expand the server's capacity. [Override implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/models-manager/src/model_info.rs#L19-L31)

## FAQ

### I set 500K but see 475K. Did it fail?

Not necessarily: 475K is exactly the result under the 95% calculation above. Existing context uses some of that capacity, so it is not a promise that you can paste another 475K tokens.

### Is the missing 5% all reserved for compaction?

No: the [source comment](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L466-L469) describes headroom for system prompts, tool overhead and model output. When neither model metadata nor configuration supplies a threshold, the cited version derives it at 90% of the window—450K for 500K; a lower catalog or configured limit can trigger compaction sooner, and this version-specific rule is not a permanent guarantee for every client. [Threshold implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L515-L538)

### Why does the API list 1,050,000 while Codex defaults to 500K?

The [API model specification](https://developers.openai.com/api/docs/models/gpt-6.1-sol), product default and catalog's maximum override describe different limits. Do not treat the API specification as the usable input budget of your current Codex session.

### What if it still shows 258K after the change?

Record the version, model, configuration sources and capacities in new and existing chats for the relevant issue report; how the backend assigns defaults to a particular account remains uncertain. This article does not test 500K inference capacity, and the configuration example is not a test result.

## Once the window is set

A larger window can retain more history; before writing, still check the current target, file state and permission. Read the [500K quick take](https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/) and [*The plan was valid. The world had changed*](https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/).
