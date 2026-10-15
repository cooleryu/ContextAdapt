---
title: "Codex 为什么显示 258K？默认 500K 怎么生效"
slug: codex-258k-context
description: "分清 258K 显示值、500K 默认窗口和自动压缩阈值，检查模型与配置覆盖，并用官方配置项手动设置。"
date: 2026-10-15
updated: 2026-10-15
language: zh-CN
author: cooleryu
---

# Codex 为什么显示 258K？默认 500K 怎么生效

**258K 可以来自 272,000 × 95% = 258,400 的有效窗口折算，不代表模型最大只能处理 258K。Tibo 宣布的 500K 是 GPT-6.1 Sol 在 Codex 和 Work 中的默认窗口；按同一口径折算会显示 475K。先检查当前模型、配置覆盖和会话状态，再决定是否手动设置。** [计算依据](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L515-L538) · [Tibo 原帖](https://x.com/thsottiaux/status/2109430343346581527)

## 先查这三处

**模型是否一致。** 公告针对 GPT-6.1 Sol。先看模型选择器；支持的客户端可用 `/status` 查看当前会话，记录容量的总数和已用量，不要把剩余额度当总窗口。[状态命令](https://learn.chatgpt.com/docs/reference/slash-commands)

**旧配置是否覆盖默认值。** 检查 `~/.codex/config.toml` 和可信项目的 `.codex/config.toml`，重点找 `model_context_window`、`model_auto_compact_token_limit`。CLI 参数、项目配置和选中的 profile 都可能优先于个人配置；CLI 可用 `/debug-config` 查看配置层来源。若要跟随默认值，先记下旧窗口覆盖，再从设置它的配置层移除。[配置优先级](https://learn.chatgpt.com/docs/config-file/config-basic) · [诊断命令](https://learn.chatgpt.com/docs/developer-settings)

**会话或模型目录是否不同。** 记下客户端版本，用同一模型比较新旧会话。[LINUX DO](https://linux.do/t/topic/3013574) 有新旧会话不同的报告；[GitHub issue](https://github.com/openai/codex/issues/53336) 还记录了同一会话从 475K 回到 258.4K。目录或缓存不一致是排查方向，但这些报告不能证明所有账号都是同一原因，也没有给出保证修好的最低版本。

## 怎样手动设为 500K

在实际生效的 `config.toml` **顶层**设置下列两项，放在 `[表名]` 之前；已有同名项就修改，不要重复追加。此例选择 GPT-6.1 Sol，其他设置保留。

```toml
model = "gpt-6.1-sol"
model_context_window = 500000
```

`model_auto_compact_token_limit` 控制何时自动压缩，不是开启大窗口的开关。若以前手写过它，先记下原值；要恢复模型默认阈值，应移除这一覆盖，并检查更高优先级配置。[官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)

保存后重新启动客户端，用新会话核对容量；这只是排查步骤，不保证修复目录问题。窗口覆盖还会受模型目录的 `max_context_window` 限制，改本地数字不能扩大服务端能力。[覆盖实现](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/models-manager/src/model_info.rs#L19-L31)

## FAQ

### 设了 500K，却显示 475K，是失败了吗？

不一定；按上述 95% 口径正好是 475K。它是有效容量，已有上下文还会占用它，不等于还能粘贴这么多 token。

### 少掉的 5% 都是给 compaction 吗？

不是；[代码注释](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L466-L469) 说明它为系统提示、工具开销和模型输出留空间。所引版本在模型目录和配置都未指定阈值时，按窗口的 90% 计算：500K 对应 450K；目录或配置中的更低阈值会提前触发，这是该版本的规则，不是所有客户端的永久保证。[阈值实现](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L515-L538)

### API 写着 1,050,000，为什么 Codex 默认只有 500K？

[API 模型规格](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、产品默认窗口和客户端目录允许的覆盖上限是不同口径。不要把 API 的标称上限直接当作当前 Codex 会话的可用输入预算。

### 改完仍是 258K，该怎么办？

记录版本、模型、配置来源和新旧会话的容量，附到对应问题报告；后台对特定账号如何下发默认值，目前仍不确定。本文没有测试实际 500K 推理容量，也不把配置示例当作测试结果。

## 窗口调好以后

更大的窗口能留住更多历史，写入前仍要确认目标、文件状态和权限是否有效。继续读 [500K 快评](https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/zh-CN/) 与 [《计划没有错，世界已经变了》](https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/)。
