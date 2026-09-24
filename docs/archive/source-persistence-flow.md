# 书源保存与状态持久化流程

> 归档（2026-09-24）：本文描述的目标在当前仓库无对应实现，仅作历史设计保留；现行事实见 docs/README.md。

## 目的

本文规定“导入/编辑后的书源如何进入用户数据”的完整流程。它把解析得到的候选书源与真正写入用户账户的持久化动作分开，避免把客户端导入、Android API 保存、订阅刷新和数据库写入误认为同一个步骤。

核心 package 只负责解析、规范化、比较、生成变更和校验输入；应用层负责当前用户、确认、权限和事务；Repository 负责把结果写入具体存储。package 不直接依赖 Supabase、HTTP 框架或 ORM。

## 数据流

```text
原始文本/远程响应
        │
        ▼
importSources()
        │  候选 SourceCandidate[] + 诊断
        ▼
读取当前用户的 source snapshot
        │
        ▼
compare / normalize / conflict detection
        │
        ├─ invalid / conflict ──► 返回问题，不写入
        │
        ▼
用户确认（编辑页或批量导入确认页）
        │
        ▼
Repository.save/saveBatch(... expectedSourceRevision)
        │
        ├─ revision 冲突 ──► 重新读取并让用户合并
        │
        ▼
提交 source + revision + 状态失效
        │
        ▼
返回脱敏后的 SourceRecord
```

## 输入与输出契约

当前流程的最小输入和输出如下；完整字段由[书源管理与状态](source-management-and-state.md#3-repository-边界)维护，但读者不打开该文件也能判断保存边界：

```ts
interface PersistenceFlowInput {
  userId: string
  candidate: { source: NormalizedSource; rawText?: string; unknownFields: Record<string, unknown> }
  previousSourceId?: string
  expectedSourceRevision?: string
  idempotencyKey: string
  confirmed: boolean
  mode: 'web-safe' | 'android-compatible'
}

interface PersistenceFlowResult {
  status: 'new' | 'same' | 'updated' | 'conflict' | 'invalid' | 'confirmation-required' | 'cancelled' | 'stale' | 'partial' | 'unknown'
  committed: boolean
  operationId: string
  idempotencyKey: string
  sourceRevision?: string
  changes: SourceChange[]
  effects: EffectRecord[]
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
  error?: { code: string; message: string; canRetry: boolean }
}
```

`changes` 只表示待提交或已提交的领域变更，`effects` 表示检查失效、缓存清理、审计和秘密撤销等外部动作；两者不能只用一个布尔值代替。`committed=false` 不等于未提交：当状态为 `unknown` 时，Repository 必须先按 `idempotencyKey` 查询结果，再决定是否继续。

`RemoveSourceInput` 至少包含可信的 `userId`、`sourceId`、`idempotencyKey`、`confirmed` 和可选的 `expectedSourceRevision`；其余字段由[书源管理与状态](source-management-and-state.md)的 Repository 契约统一定义。Web 目标中版本使用由 Repository 生成的不透明字符串（可编码单调递增序列），`lastUpdateTime` 仍只是源内容元数据，不可替代并发版本；Android 的导入和订阅刷新仍以 `lastUpdateTime` 大小判断新增或更新，没有独立的并发版本比较。

`NormalizedSource`、`SourceRecord`、`SourceChange` 的职责见[书源状态与副作用](source-management-and-state.md)。其中 `sourceId` 默认由原始 `bookSourceUrl` 字符串稳定生成；URL 变化应作为“删除旧 ID + 新建新 ID”处理，而不是静默覆盖另一条书源。

## 保存前处理

1. 应用层先读取用户身份、目标 sourceId 和当前版本，不能接受客户端传入的 userId 作为授权依据。
2. package 解析原文，保留未知字段，规范化空值、数组、URL 和规则字段，并返回逐项诊断。
3. 对每个候选项执行结构校验和最小业务校验：书源 URL 和规则对象类型必须有效；JS 源名称必须有效，JSON 源名称缺省或为空可以保留并产生诊断；不满足条件的项进入错误列表，不应写入。
4. 与当前快照比较，区分“新建”“内容相同”“规则变化”“用户覆盖变化”“sourceId 冲突”和“版本过期”。
5. 批量导入应先完成整批预览，再按用户选择提交；预览阶段不得改变用户书源、检查状态或订阅基线。

## 按场景处理

### 新建

不存在同一 `userId + sourceId` 时创建首个不透明 revision（例如 `v1`），初始化检查状态为 `NEEDS_CHECK`。导入的原始文档和规范化结果都可以保留，但应明确哪个版本是运行时权威数据。

### 相同内容

规范化后内容和用户覆盖均相同则不创建新版本，也不重置检查状态；可更新最近一次导入来源和审计时间，但这些元数据不能导致运行时缓存失效。

### 规则或运行时内容变化

创建新 revision，并将检查状态标记为 `NEEDS_CHECK` 或 `STALE`，清理与旧规则绑定的搜索/目录/内容缓存。用户书架、阅读进度和已保存的书籍身份不应因书源编辑而被删除。

### 用户覆盖变化

用户自定义排序、启用状态、分组等元数据与书源规则分离保存。Web 目标要求只改变这些字段时，不应重置规则检查状态；但若改变了执行规则，仍按规则变化处理。Android 的 `BookSourceDao.update` 用 `checkContent()` 判断是否重置检查状态，`bookSourceGroup` 属于 `checkContent()` 的一部分，因此修改分组会重置检查状态；排序、启用和启用发现不参与 `checkContent()` 比较，修改它们不会重置。

### 并发冲突

`expectedSourceRevision` 存在且不等于数据库当前 `sourceRevision` 时拒绝写入，返回 `SOURCE_REVISION_CONFLICT`。应用重新读取快照后展示差异，由用户选择合并或覆盖；不能用最后写入者覆盖来掩盖冲突。

Android 没有等价的保存/删除版本断言：`BookSourceDao.insertSources` 使用 `REPLACE` 直接覆盖，删除无版本条件。唯一带版本条件的回写是检查完成时的 `finishCheck`，它要求 `revision` 匹配且状态仍为 `NEEDS_CHECK`，不匹配则放弃回写。

## 事务边界与副作用

一次保存至少应保证以下动作原子完成：写入 source revision、更新当前指针、写入审计来源、重置/失效检查状态。批量保存通过规范中的 `saveBatch`/`transaction` 完成；任何一步失败都不能留下“新书源 + 旧检查状态”“旧书源 + 新版本号”或部分批量写入的组合。

数据库提交成功后再触发非关键副作用，例如清理缓存、通知订阅任务或排队检查。缓存清理失败应可重试，不能回滚已经提交的书源；检查任务必须携带 sourceRevision，防止旧任务覆盖新结果。

取消发生在数据库原子提交前时，返回 `cancelled` 且保证不产生 source revision；提交已完成后收到取消时，结果仍报告已提交的 revision，并把取消限制在未开始的后续副作用。提交过程中无法确认结果时保留 `idempotencyKey` 和审计记录，重试先查询幂等结果；不能把未知结果当作失败后重复写入。

## 删除流程

```text
确认 userId + sourceId + expectedSourceRevision
        │
        ▼
事务删除当前书源/订阅关联
        │
        ├─ 清理 source variables、cookies 引用、check state、运行时缓存
        ├─ 按产品策略保留或删除书籍、章节缓存和阅读进度
        └─ 写入删除审计记录
```

默认建议保留用户书架和阅读进度，只删除书源拥有的配置、凭据引用、检查记录和可重建缓存。若产品选择级联删除内容，必须单独确认并在 API 中明确提示。

Android 的 `SourceHelp.deleteBookSource` 在删除书源行（`book_source_check_states` 经外键级联清理）和 `cacheDao.deleteSourceVariables` 之外，还会调用 `clearSharedGlobalStateBySourceKey` 清理该源在共享 JS 全局状态中的条目，并触发 `SourceConfig.removeSources(sourceKeys)` 与 `AppCacheManager.clearSourceVariables()`。

## 订阅刷新与 API 保存

订阅下载得到的每一个条目都必须复用本流程的解析、比较、冲突和提交逻辑；不能因为来源是订阅就直接覆盖用户编辑。订阅基线、`RuleSub` 元数据和用户手工覆盖应分开，以便下次刷新只计算真正变化。

Android 的 Web API 是兼容适配层：普通 `/saveBookSource` 直接保存单条有效数据，批量 `/saveBookSources` 会跳过无效数组成员；这与 package 的“先预览、再确认、按事务提交”推荐流程不同，详见[Legado Web API 适配](legado-web-api-bridge.md)。

## 错误与恢复

应用至少应把错误分为：格式错误、业务字段错误、用户无权访问、sourceId 冲突、版本冲突、事务失败、凭据保存失败和缓存失效失败。错误响应应包含可定位的 item index/sourceId，但不能回显密码、cookie 或完整授权头。

事务失败可安全重试；版本冲突必须重新读取；缓存失败进入重试队列；远程订阅失败不应删除上一次成功的订阅版本。导出功能应能导出规范化书源和必要的订阅元数据，但默认排除秘密。

## 验收标准

- 任意入口（文件、文本、URL、订阅、编辑器、兼容 API）最终都经过同一套规范化和保存边界。
- 不同用户不能读取、修改或删除彼此的 source snapshot、检查状态和秘密引用。
- 规则变更会使检查状态失效，纯用户元数据变更不会误触发检查。
- 并发编辑、批量部分无效、删除后残留状态、旧检查结果回写等情况都有明确结果。
- Repository 可以替换为内存、Postgres 或其他实现，而 package 的解析和流程测试无需改变。
