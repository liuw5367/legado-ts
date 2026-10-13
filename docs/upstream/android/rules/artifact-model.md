# Android 书源相关实体边界

本文记录 Android 源码中书源订阅涉及的实体和匹配事实。它不把项目尚未实现的 `SubscriptionRepository`、`SubscriptionItem` 或统一提交接口写成当前 API；这些目标放在[书源管理与状态归档](../../../archive/source-management-and-state.md)。

## Android 实体

Android 的书源管理同时涉及三类内容：

| 实体 | 主要身份 | 消费流程 | 与 `BookSource` 的关系 |
| --- | --- | --- | --- |
| `BookSource` | `bookSourceUrl` | 搜索、发现、详情、目录、正文 | 当前 TypeScript runtime 的首要兼容对象 |
| `RssSource` | RSS 源 URL、名称等实体字段 | RSS 分类、文章、资源和正文 | 有独立字段和流程，不能无损投影成 `BookSource` |
| `ReplaceRule` | Android 规则实体的 `id`/规则字段 | 文本替换、作用域和优先级 | 不等同于书源的 `ContentRule.replaceRegex` |

三者可以由同一个 `RuleSub` 订阅材料带入，但解析、保存、启用、冲突和运行结果分别处理。订阅类型不是把三类 JSON 合成一个宽松的 `BookSource`。

## `RuleSub` 与刷新事实

Android `RuleSub` 保存订阅地址、名称、更新时间和类型等字段。非静默刷新先由 `RuleUpdate.cacheBookSourceMap` 缓存远端内容，再由导入页展示差异并等待确认；静默刷新根据 `lastUpdateTime` 过滤后写入书源。Android 没有统一的 `userId` 订阅记录、逐条 `lastResult` 状态机、`operationId` 或 `idempotencyKey`。

`ReplaceRule` 的更新判定使用 `pattern`、`replacement` 和 `previewText` 等内容字段；它以远端 `id` 匹配本地实体，存在跨设备 id 冲突风险。不能用远端 hash 或书源 URL 自动替代这个 Android 身份。

## 适配边界

- 只实现 `BookSource` 的 runtime 必须对 `RssSource` 和 `ReplaceRule` 保留原文并返回明确的能力缺失，而不是静默按文本书源执行。
- RSS 文章结果不能无损复用 `SearchBook[]`；替换规则也不能被压成正文规则的单个正则字段。
- 用户确认、冲突、删除和秘密隔离可以在项目应用层重新设计，但应单独记录与 Android 的差异和实体版本。

订阅比较和提交计划的当前 core 入口见 [`refreshSubscription`](../../../../packages/source-core/docs/codec-and-subscriptions.md)；自动刷新、持久任务和统一 Repository 仍属于目标设计，见[归档](../../../archive/source-management-and-state.md)。
