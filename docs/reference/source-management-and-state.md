# 书源管理与状态

本章定义独立库的目标契约。以下状态分层、Repository 接口和生命周期作为目标契约维护；Android 的实际管理行为与目标设计存在差异，差异在相应章节标注。接口示意不代表已有实现。

本章定义书源从导入到删除的管理边界。它是独立 package 与应用存储之间的契约，不把 Android Room、Supabase 或其他数据库实现放入核心规则引擎。

## 1. 状态分层

同一个书源相关的数据必须按生命周期拆开：

| 数据 | 作用域 | 是否属于书源导出 | 所有者 |
| --- | --- | --- | --- |
| `RawSource` | 用户、源 | 是，未修改时可原样导出 | codec/应用 |
| `NormalizedSource` | 用户、源版本 | 否，供运行时使用 | package |
| 用户覆盖字段 | 用户、源 | 否，按保存策略合并 | 应用 |
| `sourceRevision` | 用户、源 | 否 | Repository |
| Cookie/登录凭据 | 用户、源、会话 | 否 | SecretStore/SessionStore |
| 源变量和脚本缓存 | 用户、源 | 否 | Host |
| 校验状态 | 用户、源版本 | 否 | CheckRepository |
| 书籍、目录、正文缓存 | 用户、书籍、源版本 | 否 | 应用/ContentStore |

`bookSourceUrl` 是兼容层的 `sourceId`。它按原字符串比较，不自动做尾斜杠、大小写、查询参数或域名规范化。（目标设计）不同用户可以拥有相同 `sourceId`，不能使用全局 URL 作为数据库唯一键；Android `BookSource` 的主键即 `bookSourceUrl`，单用户、无 `userId` 维度。

版本名称以[运行时统一契约](runtime-contracts.md)为准：`sourceRevision` 是持久化源版本，`baseRevision` 是修改时读取的旧版本，`checkRevision` 是检测任务版本，`writeVersion` 是正文/资源写入代次。`lastUpdateTime` 是源文件元数据，不能替代任何一种版本。该句是目标契约：Android 静默更新实际以 `lastUpdateTime` 比较后整行 REPLACE（`RuleUpdate.kt` L56-61），与"不能替代任何版本"存在张力。

## 2. 书源生命周期

```text
未存在
  -> 导入候选
  -> 解析成功
  -> 待用户确认
  -> 已保存 sourceRevision=v1
  -> 已校验
  -> 用户编辑/订阅更新
  -> sourceRevision=v2，旧运行状态失效
  -> 删除并清理关联状态
```

导入成功不等于保存成功，保存成功也不等于书源可运行。每个状态都要通过候选、版本、能力报告或持久化结果表达，不能只使用一个 `enabled` 布尔值。

## 3. Repository 边界

```ts
export interface SourceRepository {
  /** 读取当前用户可见的一个源快照。 */
  get(userId: string, sourceId: string): Promise<SourceRecord | null>
  /** 按用户配置和分组读取源；不得返回其他用户的源。 */
  list(userId: string, filter?: SourceFilter): Promise<SourceRecord[]>
  /** 按 expectedSourceRevision 原子保存，失败返回版本冲突。 */
  save(input: SaveSourceInput): Promise<SaveSourceResult>
  /** 在一个事务中提交已经通过计划校验的整批变更。 */
  saveBatch(input: SaveBatchInput): Promise<SaveBatchResult>
  /** 删除源及应用明确允许清理的关联状态；版本不匹配返回冲突。 */
  remove(input: RemoveSourceInput): Promise<RemoveSourceResult>
  /** 在同一数据库事务中执行版本断言、保存和状态失效。 */
  transaction<T>(work: (tx: SourceTransaction) => Promise<T>): Promise<T>
}

export interface SourceTransaction {
  /** 原子确认每个源仍处于计划读取的版本；任一不匹配都使事务失败。 */
  assertRevisions(expected: SourceRevisionExpectation[]): Promise<void>
  /** 原子保存整批源变更；输入必须已完成候选校验和用户确认。 */
  saveSources(changes: SourceChange[]): Promise<SourceRecord[]>
  /** 原子失效受规则版本影响的检查状态。 */
  invalidateChecks(changes: SourceChange[]): Promise<void>
  /** 原子记录不含秘密的来源和操作者审计信息。 */
  appendAudit(entries: SourceAuditEntry[]): Promise<void>
}

export interface SaveSourceInput {
  /** 当前登录用户；Repository 不得从请求 body 推断该值。 */
  userId: string
  /** 要保存的规范化书源，不包含 Cookie、密码或 token 明文。 */
  source: NormalizedSource
  /** 编辑已有源或改名时的旧身份；新建时为空。 */
  previousSourceId?: string
  /** 导入时保留的原文；从结构化 API 保存时可以为空。 */
  rawText?: string
  /** 导入未识别的字段；保存时不得静默丢弃。 */
  unknownFields?: Record<string, unknown>
  /** 用户独立状态；缺失时由 Repository 使用现有值或默认值。 */
  userState?: UserSourceState
  /** 编辑开始时读取的源版本；新建时为空。 */
  expectedSourceRevision?: string
  /** 跨 HTTP 重试保持不变的保存意图身份。 */
  idempotencyKey: string
  /** 是否已经完成应用层确认；false 必须返回 confirmation-required，不得写入。 */
  confirmed: boolean
  /** 导入、编辑、订阅或兼容 API 等来源。 */
  origin: SourceOrigin
  /** web-safe 或 android-compatible；应用和 Repository 必须使用同一模式。 */
  mode: 'web-safe' | 'android-compatible'
}

export interface SaveSourceResult {
  /** 保存结论；same 表示没有领域变化但仍可返回当前记录。 */
  status: 'new' | 'same' | 'updated' | 'conflict' | 'invalid' | 'confirmation-required' | 'cancelled' | 'stale' | 'partial' | 'unknown'
  /** 保存后的完整用户源记录；非提交状态为空。 */
  record?: SourceRecord
  /** 本次提交的字段变化。 */
  changes: SourceChange[]
  /** 保存后生成的不透明源版本；未提交时为空。 */
  sourceRevision?: string
  /** 稳定错误；conflict/invalid/cancelled/stale 必须可直接处理。 */
  error?: { code: string; message: string; canRetry: boolean }
  /** 是否已经产生持久化提交。 */
  committed: boolean
  /** 本次领域调用身份；重试不改变。 */
  operationId: string
  /** 结果未知时用于查询已提交结果。 */
  idempotencyKey: string
  /** 检查失效、缓存清理和审计等副作用。 */
  effects: EffectRecord[]
  /** 所有资源的最终清理状态。 */
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}

export interface SaveBatchInput {
  /** 当前登录用户。 */
  userId: string
  /** 已解析并完成用户选择的整批源变更。 */
  changes: SourceChange[]
  /** 批量操作读取快照时的源版本断言。 */
  expectedSourceRevisions: SourceRevisionExpectation[]
  /** 跨 HTTP 重试保持不变的批量保存意图身份。 */
  idempotencyKey: string
  /** 是否已经完成批量确认。 */
  confirmed: boolean
  /** 整批来源。 */
  origin: SourceOrigin
}

export interface SaveBatchResult {
  /** 整批保存的最终状态；unknown 必须先查询幂等结果，不能直接重试写入。 */
  status: 'success' | 'partial' | 'conflict' | 'invalid' | 'confirmation-required' | 'cancelled' | 'unknown'
  /** 整批保存后的源记录；事务失败时不返回部分成功结果。 */
  records: SourceRecord[]
  /** 整批实际提交的字段变化。 */
  changes: SourceChange[]
  committed: boolean
  operationId: string
  idempotencyKey: string
  effects: EffectRecord[]
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}

export interface SourceRevision {
  /** 版本记录所属用户。 */
  userId: string
  /** 版本记录对应的源身份。 */
  sourceId: string
  /** 不透明的并发版本值。 */
  sourceRevision: string
  /** 规范化源内容指纹；不作为身份或权限凭证。 */
  contentHash: string
  /** 版本提交时间；不能替代 sourceRevision 比较。 */
  createdAt: number
  /** 触发版本产生的来源和操作者摘要。 */
  origin: SourceOrigin
}

export interface SourceRevisionExpectation {
  /** 版本断言所属用户。 */
  userId: string
  /** 版本断言对应的源身份。 */
  sourceId: string
  /** 当前快照版本；新建源为空。 */
  sourceRevision?: string
}

export interface SourceAuditEntry {
  /** 审计记录所属用户。 */
  userId: string
  /** 被操作的源身份。 */
  sourceId: string
  /** 导入、编辑、订阅、删除或兼容 API 等动作。 */
  action: "import" | "edit" | "subscription" | "delete" | "api"
  /** 触发动作的来源信息；不得包含秘密。 */
  origin: SourceOrigin
  /** 可供排障的脱敏摘要。 */
  summary?: string
  /** 跨请求重试的幂等操作身份。 */
  idempotencyKey?: string
}

export interface SourceFilter {
  /** 只返回指定分组；未提供时返回全部可见书源。 */
  groups?: string[]
  /** 是否包含 disabled source；默认由应用列表策略决定。 */
  includeDisabled?: boolean
}

export interface SourceOrigin {
  /** 导入、编辑、订阅或兼容 API 等来源类型。 */
  kind: "file" | "text" | "url" | "subscription" | "editor" | "api" | "json" | "remote-url" | "uri" | "javascript"
  /** 可展示的来源位置；必须脱敏。 */
  location?: string
}

export interface RemoveSourceInput {
  /** 当前登录用户；不能信任客户端 body 中同名字段。 */
  userId: string
  /** 要删除的原始 bookSourceUrl/sourceId。 */
  sourceId: string
  /** 删除开始时的源版本；不匹配时拒绝删除。 */
  expectedSourceRevision?: string
  /** safe 要求版本断言；android-compatible 才能显式使用旧式无版本删除。 */
  mode: 'web-safe' | 'android-compatible'
  /** 跨请求重试保持不变的删除意图身份。 */
  idempotencyKey: string
  /** false 时只返回确认要求，不执行删除。 */
  confirmed: boolean
}

export interface RemoveSourceResult {
  status: 'deleted' | 'not-found' | 'conflict' | 'cancelled' | 'partial' | 'unknown'
  sourceId: string
  cleaned: string[]
  pending: string[]
  committed: boolean
  operationId: string
  idempotencyKey: string
  effects: EffectRecord[]
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
  error?: { code: string; message: string; canRetry: boolean }
}

export interface SourceChange extends DomainChange {
  /** 变化对应的源身份。 */
  sourceId: string
  /** 与通用 DomainChange.resourceKey 相同；固定为 source:userId:sourceId 形式。 */
  resourceKey: string
  /** 计算差异时读取的版本；新建时为空。 */
  baseRevision?: string
  /** 变化类别，供应用决定是否失效检查和缓存。 */
  kind: "create" | "content-update" | "user-override" | "delete"
  /** 允许写入的字段路径和目标值；不允许隐式整对象覆盖。 */
  fields: Record<string, unknown>
}

export interface SourceRecord {
  /** 数据库内部不透明 ID，不作为兼容 sourceId。 */
  id: string
  /** 当前用户身份。 */
  userId: string
  /** 原始 bookSourceUrl，大小写和尾斜杠保持不变。 */
  sourceId: string
  /** 未修改时用于原样导出的原文。 */
  rawText: string
  /** 解析后的可执行配置，不包含用户独立状态。 */
  normalizedSource: NormalizedSource
  /** 当前用户独立状态；是启用、分组、排序和权重的权威值。 */
  userState: UserSourceState
  /** 未知字段和原始结构保留区。 */
  unknownFields: Record<string, unknown>
  /** 当前源版本，保存成功后生成新的不透明值；是用户源的并发控制版本，不是 lastUpdateTime。 */
  sourceRevision: string
  /** 来源信息和订阅关联由应用保存。 */
  origin?: SourceOrigin
}
```

Repository 不是规则执行器。package 返回 `ImportCandidate`、领域结果、`changes` 和 `effects`；应用根据当前用户、用户确认和版本条件调用 Repository。`SourceRecord` 的 `normalizedSource` 是源配置，`userState` 是用户状态；运行时使用二者合成[SourceSnapshot](source-field-ownership.md)。本文是 Repository、事务和保存输入的唯一事实源；流程文档只引用这里的接口，不再重新定义 `SourceRepository`。

## 4. 保存流程

```text
候选 rawText
  -> parse/normalize/diagnose
  -> 查询 userId + sourceId
  -> 比较 baseRevision 和内容指纹
  -> 合并用户覆盖字段
  -> 用户确认
  -> 原子保存原文、规范化值和版本
  -> 重置该版本的校验状态
  -> 失效分类、搜索、目录和正文引用
  -> 返回新 SourceRecord
```

保存时至少需要区分 `new`、`same`、`update`、`conflict` 和 `invalid`。同一用户在两个标签页同时编辑时，后提交者不能静默覆盖前一个版本；应用可以让用户选择重新载入、强制覆盖或导出副本。

`confirmed=false` 只产生 `confirmation-required` 诊断，不产生数据库写入；兼容 API 若需要保留旧式直接保存，必须由 adapter 显式选择 `android-compatible` 模式并记录来源。取消发生在原子提交前时返回 `cancelled` 且不写入；提交已经成功后才收到取消时返回 `success`/`partial` 并说明已提交的 effects，不能报告为“未保存”。提交结果未知时保留幂等键和审计记录，重试必须先查询幂等结果，不能盲目重复写入。

## 5. 更新和删除副作用

### 源内容发生变化

- `sourceRevision` 增加；
- 旧校验状态变为 `NEEDS_CHECK` 或 `STALE`；
- 旧规则版本的搜索、目录、正文缓存不能被新版本误用；
- Cookie 是否继承由应用策略决定，不能因保存书源而自动跨用户或跨源复制；
- 源变量、脚本缓存和分类缓存按源版本检查；
- 在途操作返回 `stale`，不能回写旧结果。

### 仅修改用户状态

修改 `enabled`、`enabledExplore`、`customOrder`、`weight` 或分组时，不应改变规则版本，也不应强制清除正文缓存；但列表查询和源选择结果需要立即使用新用户状态。

### 删除书源

删除至少要处理源记录、校验状态、订阅绑定、分类缓存、源变量、Cookie/SecretStore 引用、并发记录和书源专属运行缓存。SecretStore 中的秘密必须撤销或删除，不能只删除指针后继续允许旧会话读取。书籍和正文是否删除是独立的应用策略，不能因为删除书源就自动删除用户书架数据。清理失败返回 `partial` 和待清理资源，不把已删除源伪装成完全清理成功。

## 6. 插入策略与兼容实现事实

Android 的 `SourceHelp.insertBookSource` 不是普通 DAO 保存的同义词。它会拦截内置 18+ 名单域名（assets/18PlusList.txt，base64 解码后匹配二级域名），并在 `customOrder` 越界或排序值重复时调整排序；删除还会清理源变量和相关运行缓存。独立 package 不调用 `SourceHelp`，但应用必须显式选择并记录插入策略：

| 模式 | 适用入口 | 必须保留的行为 |
| --- | --- | --- |
| `web-safe` | 新 Web 应用、编辑器、标准导入 | 先执行域名、字段和排序策略，再调用 Repository；拒绝项不产生写入 |
| `android-compatible` | 复刻旧 `/saveBookSource(s)` 的 adapter | 保留 Android Controller 的最小名称/URL 校验和直接 DAO 写入；不伪称它等同 `SourceHelp` |

兼容 API 的直接写入与新 Web 应用的安全策略可能产生不同结果，这是适配层的明确兼容选择。无论选择哪种模式，解析、规范化、版本检查、用户隔离和秘密处理仍遵循本文与[导入协议](../workflows/import-protocol.md)。

Android 的 DAO 保存会在书源内容变化时重置 `BookSourceCheckState`；`SourceHelp` 删除书源时会清除源变量和相关运行缓存；JS 源改名会检查目标冲突、清理旧源并保留启用、分组、排序和权重等用户状态。`SourceHelp.insertBookSource` 通过 `Coroutine.async` 异步触发 `adjustSortNumber()`，仅在 `maxOrder>99999`、`minOrder<-99999` 或 `hasDuplicateOrder` 时把全部 `customOrder` 重排为索引（`SourceHelp.kt` L174-186）。JS 源保存路径 `JsSourceUpsert.preserveUserState` 除保留启用、分组、排序和权重外还保留 `respondTime`，分组仅在目标源分组空白时继承（`JsSourceUpsert.kt` L152-161）；`bookSourceUrl` 或 `exploreUrl` 变化会清 `exploreKindsCache`，`jsLib` 变化会移除 `SharedJsScope`（`JsSourceUpsert.kt` L65-73）。独立 package 需要保留这些可观察约束，但由 Repository 和 Host 分别承担，而不是复制 Android 全局单例。用户状态字段和远程更新优先级以[字段所有权与合并规则](source-field-ownership.md)为准。
