---
title: "Codex 默认 500K 之后：少压缩，不等于少犯错"
slug: codex-500k-context
description: "先用默认窗口，找准缺失的材料，并在写入前确认目标、文件状态和权限是否仍然有效。"
date: 2026-10-14
updated: 2026-10-14
language: zh-CN
author: cooleryu
---

# Codex 默认 500K 之后：少压缩，不等于少犯错

**500K 的价值，是让长任务少一些中途压缩；要让下一步做对，还得在写入前确认目标、文件状态和权限有没有变。先用默认窗口，把缺失的材料补准，再决定要不要加大。装得下多少，与行动依据是否仍然有效，是两件事。**

[Tibo 宣布](https://x.com/thsottiaux/status/2109430343346581527)，GPT-6.1 Sol 在 Codex 与 Work 中的默认上下文由 272K 提至 500K，以减少压缩、保留细节；用户仍可手动覆盖，最大为 1M。他随后说明，[订阅使用不收长上下文附加费](https://x.com/thsottiaux/status/2109430894604026039)。

## 先用默认，再看任务缺什么

如果任务没有反复丢失约束、依赖或早期决定，先保持默认。遇到遗漏，先补回那份文件、那条要求，再试更大窗口；局部修改、状态明确的任务，则可以试更精简的输入。不要为了用满容量，把无关材料一起塞进去。

比较时，固定任务、初始提交、模型、工具和权限，提前写好验收测试。除了结果是否通过，也记录压缩、重读、全部重试的 token 和耗时。更大窗口是否值得，要看完成整个任务的代价；缩小输入和降低窗口上限也要分开记录。具体步骤见[上下文长度选择指南](https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/zh-CN/)。

## 写入之前，再看一眼现在

设想 Agent 已读完 staging 配置、准备修改，暂停期间用户却换了目标、撤销了权限。计划依然完整，但已经不适用。

恢复工作时，别只问“还记不记得计划”，还要核对“现在改哪里、文件有没有变、授权还在不在”。发现冲突就停下刷新。窗口变大，可以留下更多历史，也可能把过期依据一起留下。我在另一篇文章[《计划没有错，世界已经变了》](https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/)里详细讨论过这个问题。

## 旧数据给了什么提醒

ContextAdapt 的长输入探针曾让 `gpt-5.6-luna` 判断合成轨迹里的目标、权限和事实来源。这里的通过，是决策 JSON 符合预定答案；[逐次结果](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/experiments/long-context/results/luna-v1.jsonl)和[汇总](https://github.com/cooleryu/ContextAdapt/blob/960309fddf7115d730043501122c50f2d35955eb/experiments/long-context/results/luna-v1-summary.json)可在公开仓库中查看。

| 目标档位 | 实测最后一轮输入 token | 决策通过 |
| --- | ---: | ---: |
| 200K | 197,802–197,835 | 3/3 |
| 400K | 393,709–393,747 | 3/3 |
| 1M（目标负载） | 883,258–883,470 | 3/3 |

更贴近“该留什么”的，是[已发表研究](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/)中的离线代码保留基准：30 个留出任务、12 个仓库，40% 源代码预算下，头尾截断通过 10/30，关键词检索和 ContextAdapt v3 都是 18/30。

严格保留要求预算内留下源码中与问题精确匹配的所有行，以及参考补丁每个修改块的原文锚点。全部压缩预算平均曲线上，ContextAdapt 对关键词检索为 +7.1 个百分点，95% 区间 −2.3 至 +17.9，优势仍不确定。[结果账本](https://github.com/cooleryu/ContextAdapt/blob/258861ec7e732ff38c587558626b4db432c6b120/evidence/p0-results.md)和[实验协议](https://github.com/cooleryu/ContextAdapt/blob/258861ec7e732ff38c587558626b4db432c6b120/evidence/protocol-v3.json)已公开；逐项原始数据来自项目内部实验记录，尚未公开。

对使用者最实在的提醒是：先试着找准材料，并保留简单检索作为对照，再判断是否需要更复杂的上下文方案。

## FAQ

**默认升到 500K，需要马上改配置吗？**
先确认会话实际模型和容量，没有缺证据迹象就先用默认值。

**500K 和 1M 怎么选？**
让同任务验收结果决定；更大输入持续补回必要材料、改善结果，才值得调大。

**为什么还显示 258K？**
[LINUX DO 上也有人问到这个现象](https://linux.do/t/topic/3013574)。记录客户端版本、会话模型和配置覆盖，分开核对公布默认值、会话生效容量与可用输入预算；单凭显示值不能确定原因。

**少 compaction 就少犯错吗？**
还要看关键证据是否留下、旧状态是否被误用，以及任务最终是否通过。

**怎样测实际需要多少上下文？**
用可重复任务和独立验收器，逐步补回缺失证据，再比较支持的容量档位，并记录所有尝试。

## 这篇文章没证明什么

- 我们没有测试 Codex 500K，也没有测出它与其他档位的优劣。订阅费用说明不适用于 [API 的计费规则](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。
- 长输入实验每场景每档只跑一次，大档更多轮次、模型窗口配置相同，未真正改代码；1M 是目标档名，不是实际输入百万 token。
- 代码基准预选了目标文件，按字符估算预算；保留通过不等于找到文件、修好问题或省下费用。
- OMP 集成实验主要使用确定性 mock，检验的是写入前能否拦截动作，不是在线模型的长上下文质量；该记录尚未公开。staging 情形是示例，不能当作真实事故。

继续阅读：[ContextAdapt 项目](https://github.com/cooleryu/ContextAdapt) · [代码证据保留研究](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/) · [上下文长度选择指南](https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/zh-CN/)。
