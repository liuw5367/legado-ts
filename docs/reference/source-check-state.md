# 书源校验状态

本章定义独立库的目标契约。以下状态枚举、会话模型和版本规则作为目标契约维护；Android 的检查状态实现与目标设计不同，差异在相应章节标注。接口示意不代表已有实现。

书源校验是独立于普通搜索的诊断流程。它可以调用搜索、发现、详情、目录和正文，但结果不是一次普通业务请求的返回值。

本文的版本名称以[运行时统一契约](runtime-contracts.md)为准：`sourceRevision` 是源版本，`checkRevision` 是检测任务版本；二者都不等同于 `BookSource.lastUpdateTime`。

## 状态模型

```ts
export type SourceCheckStatus =
  | 'NEEDS_CHECK'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'CANCELLED'
  | 'STALE'

export type SourceCheckStageStatus =
  | 'PASSED'
  | 'FAILED'
  | 'SKIPPED'
  | 'UNSUPPORTED'

export type SourceCheckStage =
  | 'domain'
  | 'search'
  | 'discovery'
  | 'book-info'
  | 'category'
  | 'toc'
  | 'content'

export interface SourceCheckStageResult {
  /** 检测阶段。 */
  stage: SourceCheckStage
  /** 阶段结论。 */
  status: SourceCheckStageStatus
  /** 稳定错误码；通过时可以为空。 */
  code?: string
  /** 阶段耗时，单位毫秒。 */
  durationMs: number
  /** 可安全展示的阶段摘要。 */
  detail?: string
}

export interface SourceCheckState {
  /** 用户作用域。 */
  userId: string
  /** 原始 bookSourceUrl。 */
  sourceId: string
  /** 发起校验时使用的书源版本。 */
  sourceRevision: string
  /** 一次校验任务的版本，用于拒绝迟到结果。 */
  checkRevision: string
  /** 应用层校验会话身份。 */
  sessionId: string
  /** 当前校验状态。 */
  status: SourceCheckStatus
  /** 完成或失败时间；运行中为空。 */
  checkedAt?: number
  /** 本次检查会话观察到的响应时间；与 BookSource.respondTime 的持久化摘要分开。 */
  responseTimeMs?: number
  /** 可安全展示的摘要信息。 */
  detail: string
  /** 各阶段的完整结果；可按存储策略只保留摘要或引用。 */
  stages: SourceCheckStageResult[]
  /** 已失败的阶段和稳定错误码。 */
  failedStages: Array<{
    /** 发生失败的检测阶段。 */
    stage: SourceCheckStage
    /** 可供 API 和测试稳定断言的错误码。 */
    code: string
  }>
}
```

以上 `SourceCheckStatus`（含 RUNNING/CANCELLED/STALE）、`stages`/`failedStages`、`sessionId` 和 `responseTimeMs` 字段是目标设计；Android 的响应时间存于 `BookSource.respondTime`（`BookSource.kt` L77），它是源记录上的持久化摘要，不是检查状态的会话指标。Android 的 `BookSourceCheckState` 只有 `NEEDS_CHECK`/`PASSED`/`FAILED` 三个状态（`data/entities/BookSourceCheckState.kt`）。

校验状态不进入 `BookSource` 导出 JSON；但 `BookSource.respondTime` 是 `BookSource` 字段，会随导出 JSON 序列化，它由校验流程更新，属于校验产物。书源导入、编辑或订阅更新只要改变可执行内容，就必须使旧的 `sourceRevision` 结果失效。

```ts
export interface SourceCheckRepository {
  /** 读取当前用户某书源的最新检查状态。 */
  get(userId: string, sourceId: string): Promise<SourceCheckState | null>
  /** 创建 RUNNING 会话，并固定 sourceRevision/checkRevision。 */
  begin(input: BeginSourceCheckInput): Promise<SourceCheckState>
  /** 仅在版本和会话仍匹配时完成回写。 */
  complete(result: CompleteSourceCheckInput): Promise<boolean>
  /** 取消当前会话；已完成会话不可被旧取消覆盖。 */
  cancel(userId: string, sourceId: string, sessionId: string): Promise<boolean>
}

export interface BeginSourceCheckInput {
  /** 当前用户。 */
  userId: string
  /** 原始 sourceId。 */
  sourceId: string
  /** 已读取并固定的源版本。 */
  sourceRevision: string
  /** 应用生成的校验会话身份。 */
  sessionId: string
}

export interface CompleteSourceCheckInput {
  /** 任务所属用户。 */
  userId: string
  /** 原始 sourceId。 */
  sourceId: string
  /** 发起时固定的源版本。 */
  sourceRevision: string
  /** 当前检测任务版本。 */
  checkRevision: string
  /** 只允许 RUNNING 会话结算。 */
  sessionId: string
  /** 终态；不能由 complete 写入 RUNNING。 */
  status: Exclude<SourceCheckStatus, 'NEEDS_CHECK' | 'RUNNING'>
  checkedAt?: number
  responseTimeMs?: number
  detail: string
  stages: SourceCheckStageResult[]
  failedStages: SourceCheckState['failedStages']
}
```

Android 实际没有 RUNNING 会话：`BookSourceDao.beginCheck` 重置为 `NEEDS_CHECK` 并生成新的 `revision`（任务版本 UUID），保留 `sourceRevision`；写回不以 `status==RUNNING` 为前提，`finishCheck` 的 CAS 条件是 `status='NEEDS_CHECK' AND revision=:revision`（`BookSourceDao.kt` L298-313）。迟到结果由 `completeCheck` 返回 false 拒绝，不落 STALE 状态。`BookSourcePart` 通过 coalesce JOIN 呈现 `checkStatus`/`checkRevision`/`sourceRevision`/`checkedAt`/`checkDetail`（`BookSourcePart.kt` L21-25）。

`SourceCheckStatus` 和 `SourceCheckStageStatus` 是 package 与持久层的规范状态，统一使用大写字符串。`book-info` 是详情阶段的唯一规范值；流程文档中的 `info` 只可作为旧客户端显示别名，adapter 必须在边界转换。若某个 HTTP/WebSocket adapter 为兼容既有客户端而输出小写状态，必须在 adapter 中显式映射，并在输入边界恢复为规范状态；核心结果、数据库记录和测试 golden 不混用两套拼写。

| 规范状态 | 兼容小写 DTO（仅在 adapter 需要时） |
| --- | --- |
| `NEEDS_CHECK` | `needs_check` |
| `RUNNING` | `running` |
| `PASSED` | `passed` |
| `FAILED` | `failed` |
| `CANCELLED` | `cancelled` |
| `STALE` | `stale` |
| `SKIPPED` / `UNSUPPORTED` | `skipped` / `unsupported`（只用于阶段，不用于源最终状态） |

## 版本规则

开始校验前，在同一存储快照中读取 `BookSource` 和当前校验状态，固定 `sourceRevision`，生成新的 `checkRevision`。写回必须满足：

```text
userId       == 当前用户
sourceId     == 原始 sourceId
sourceRevision == 发起校验时的版本
checkRevision  == 当前任务版本
status         == RUNNING
```

任一条件不满足，结果只能记录为 `STALE`，或保持当前状态并记录 `NOT_COMPLETED` 诊断，不得覆盖新的书源或校验状态。（目标契约）上述写回条件是目标设计；Android 的 CAS 条件与迟到处理见上文"Android 实际没有 RUNNING 会话"标注。

## 结果含义

| 状态 | 含义 |
| --- | --- |
| `NEEDS_CHECK` | 尚未校验，或书源内容已发生变化 |
| `RUNNING` | 校验任务已启动，结果尚未完成 |
| `PASSED` | 配置的校验阶段全部通过 |
| `FAILED` | 至少一个必需校验阶段失败 |
| `CANCELLED` | 用户或应用取消，未形成完整结论 |
| `STALE` | 结果对应的书源或任务版本已经过期 |

“搜索返回空列表”和“网络请求失败”必须区分；“校验未执行目录”也不能显示为目录通过。
