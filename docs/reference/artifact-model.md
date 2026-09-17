# 书源相关实体边界

书源订阅并不只产生 `BookSource`。为了完整迁移，必须区分三种 artifact，避免用一个 JSON 模型掩盖它们不同的身份、规则和消费流程。

## 实体分类

| 类型 | 身份 | 核心处理 | 当前策略 |
| --- | --- | --- | --- |
| `BookSource` | `bookSourceUrl` | 搜索、发现、详情、目录、正文 | `source-core` 首要范围 |
| `RssSource` | RSS 源 URL/名称等实体键 | RSS 分类、文章、资源和正文 | 独立 adapter/package，不能伪装为 BookSource |
| `ReplaceRule` | 规则名称或稳定规则键 | 文本替换、作用域和优先级 | 独立 adapter/package，不能并入书源规则 |

三者可以由同一 `RuleSub` 订阅下载，但解析、保存、启用、冲突和运行时结果分别建模。`RuleSub.type` 的兼容映射见[书源订阅与刷新](../workflows/source-subscriptions.md)。

## 订阅模型

```ts
export interface SubscriptionRecord {
  /** 当前用户的订阅 ID。 */
  id: string
  /** 当前用户。 */
  userId: string
  /** 订阅地址原文。 */
  url: string
  /** Android RuleSub 的稳定兼容字段。 */
  name: string
  /** 是否自动刷新。 */
  autoUpdate: boolean
  /** 两次自动刷新之间的间隔，单位毫秒。 */
  updateIntervalMs: number
  /** 最近一次刷新尝试时间，而非最近一次成功时间。 */
  lastAttemptAt?: number
  /** 订阅项和 baseline 的当前修订。 */
  subscriptionRevision: string
}

export interface SubscriptionItem {
  /** 订阅记录身份。 */
  subscriptionId: string
  /** 远端条目在订阅中的稳定键。 */
  itemKey: string
  /** `BookSource`、`RssSource` 或 `ReplaceRule`。 */
  artifactType: 'book-source' | 'rss-source' | 'replace-rule'
  /** 当前远端内容指纹。 */
  remoteHash?: string
  /** 上一次用户确认或采用的基线版本。 */
  baselineRevision?: string
  /** 本地绑定的实体身份。 */
  artifactId?: string
  /** 最近一次刷新结果。 */
  lastResult?: 'unchanged' | 'updated' | 'conflict' | 'invalid' | 'missing' | 'failed'
}

export interface SubscriptionRefreshAttempt {
  /** 一次刷新任务身份，跨重试不变。 */
  operationId: string
  /** 幂等提交身份。 */
  idempotencyKey: string
  subscriptionId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown'
  diagnostics: RuntimeDiagnostic[]
}

export interface SubscriptionRepository {
  /** 读取当前用户的订阅及其条目快照。 */
  get(userId: string, subscriptionId: string): Promise<SubscriptionRecord | null>
  /** 按用户列出订阅；不得跨用户返回 URL 或条目。 */
  list(userId: string): Promise<SubscriptionRecord[]>
  /** 原子提交订阅快照和条目结果，按 subscriptionRevision 做 CAS。 */
  commitRefresh(input: {
    userId: string
    subscriptionId: string
    expectedSubscriptionRevision: string
    attempt: SubscriptionRefreshAttempt
    items: SubscriptionItem[]
  }): Promise<boolean>
}
```

## 扩展边界

- `source-core` 必须能识别并报告非 `BookSource` 条目，但不能把 RSS 或替换规则静默转换为文本书源。
- 若当前版本只实现 `BookSource`，必须返回 `UNSUPPORTED_ARTIFACT_TYPE`，保留原文和远端指纹，等待独立 adapter 处理。
- `RssSource` 的文章结果不能复用 `SearchBook[]` 作为无损模型；`ReplaceRule` 也不能复用 `ContentRule.replaceRegex` 代替。
- 用户确认、冲突、删除和秘密隔离规则与 `BookSource` 相同，但实体表、版本和运行缓存分别隔离。

## 取舍决策

推荐采用三个实体 adapter 加一个订阅编排层，而不是把三种类型强行放入一个核心接口。这样不会降低订阅导入能力，也不会让 `BookSource` 的字段表承担 RSS 或替换规则的错误语义。是否在第一版同时发布 RSS/ReplaceRule package，仍需在实施阶段按能力清单逐项确认；在确认前不得标记为已支持。
