# 任务执行与 Serverless 边界

检测、订阅刷新、批量正文和复杂媒体处理可能超过一次 Web 请求的生命周期。它们必须通过可恢复任务执行，不能依赖函数响应后继续运行。

## 执行分层

```text
浏览器/SPA
   -> 应用 API：创建任务、读取状态、取消任务
   -> JobStore：任务状态和租约
   -> Node Worker：执行 source-core + RuntimeHost
   -> Repository/Store：原子保存结果
```

Edge 只适合短时、无长脚本、资源受限且可以在请求内完成的操作。Node Worker 是完整 JS 书源、检测、订阅刷新和长正文流程的参考执行环境。框架可以是 Next.js、React Router 或普通 Node，但不能改变任务语义。

任务输入在入队时固定快照、参数、预算和幂等键；worker 生成的租约、完成时间和最终状态不能由客户端提交。任务是可恢复操作，取消请求、租约释放、外部副作用结算和最终状态是不同事件，必须分别记录。

## JobStore 契约

```ts
export type JobKind = 'source-check' | 'subscription-refresh' | 'content-batch' | 'media'

export interface JobRecord {
  /** 任务唯一身份。 */
  id: string
  /** 用户作用域。 */
  userId: string
  /** 任务类型。 */
  kind: JobKind
  /** 创建任务时固定的源版本；批量任务可以包含多个版本。 */
  sourceRevisions: Record<string, string>
  /** 跨 HTTP 重试保持不变的幂等身份。 */
  idempotencyKey: string
  /** 当前状态。 */
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'stale' | 'unknown'
  /** 创建时冻结的领域输入和运行参数；不放秘密明文。 */
  inputSnapshot: Record<string, unknown>
  params: Record<string, unknown>
  /** 已完成阶段和总进度。 */
  progress: { completed: number; total?: number; stage?: string }
  /** 租约到期时间；无租约时为空。 */
  leaseUntil?: number
  /** 本次租约的不透明凭证；旧 worker 不能凭 workerId 单独结算。 */
  leaseToken?: string
  /** 尝试次数。 */
  attempt: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
  /** 最终领域结果摘要；大内容存外部并只保留引用。 */
  output?: Record<string, unknown>
  /** 稳定失败或未知原因；message 必须脱敏。 */
  error?: { code: string; stage?: string; message: string; canRetry: boolean }
  /** 任务资源和子任务清理结果。 */
  cleanup?: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}

export interface JobStore {
  /** 按幂等键创建或返回已有任务。 */
  enqueue(input: Pick<JobRecord, 'userId' | 'kind' | 'sourceRevisions' | 'idempotencyKey' | 'inputSnapshot' | 'params'>): Promise<JobRecord>
  /** 原子领取一个可执行任务并建立租约。 */
  claim(workerId: string, leaseMs: number): Promise<JobRecord | null>
  /** 只有当前 worker 和当前租约能续租。 */
  renew(jobId: string, workerId: string, leaseToken: string, leaseMs: number): Promise<boolean>
  /** 提交结果；源版本不匹配时只能结算为 stale/unknown。 */
  complete(jobId: string, workerId: string, leaseToken: string, result: JobCompletion): Promise<boolean>
  /** 取消排队或当前租约任务。 */
  cancel(jobId: string, userId: string): Promise<boolean>
  /** 查询用户可见的任务状态。 */
  get(jobId: string, userId: string): Promise<JobRecord | null>
}

export interface JobCompletion {
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'stale' | 'unknown'
  progress: JobRecord['progress']
  diagnostics: RuntimeDiagnostic[]
  effects: EffectRecord[]
  output?: Record<string, unknown>
  error?: JobRecord['error']
  cleanup: NonNullable<JobRecord['cleanup']>
}
```

## 状态和恢复

```text
queued -> running -> succeeded/partial/failed/cancelled/unknown
             │
             └─ lease expired -> queued 或 unknown
```

- worker 领取任务后必须按固定间隔续租；进程崩溃不能留下永久 `running`。
- 任务恢复前重新读取源快照，并验证所有 `sourceRevision`；版本变化时不继续写旧结果。
- 普通网络失败可以按任务策略重试；上游购买、发帖等不可证明幂等的写入不得自动重试。
- 取消只阻止未开始的分页、重试和保存；已经发生的网络、Cookie、变量或外部写入必须记录在 `effects`。
- worker 无法确认外部请求是否完成时使用 `unknown`，不能直接标记失败后允许自动重发；源版本已经变化时使用 `stale`，不继续写入旧结果。
- 进度是可重复读取的快照，不要求客户端保持 WebSocket；SPA 默认使用轮询或 SSE。

`unknown`、`stale`、`cancelled` 和 `partial` 互不覆盖：`partial` 表示已确认的部分领域结果，`unknown` 表示外部效果是否完成无法确认，`stale` 表示结果不再具备当前版本提交资格，`cancelled` 表示调用方请求停止。所有终态都必须带 cleanup 结果。

## Vercel 组织方式

应用服务只负责鉴权、创建任务和返回状态。执行器应运行在可承载 Node 依赖和 JS 隔离的 Worker/函数中；若平台无法保证租约期间完成，应使用外部队列或独立 Worker。不要依赖“响应返回后函数继续执行”完成检测或订阅刷新。

Supabase/Postgres 保存任务元数据和租约，不能替代执行器。对象存储保存大正文或二进制资源，不能把大内容塞进任务行。具体供应商可以替换，但必须保留幂等、租约、版本保护和恢复语义。

## 验收要求

必须测试重复 enqueue、两个 worker 竞争 claim、租约过期恢复、续租失败、取消竞争、worker 崩溃、旧 sourceRevision 结果、部分成功、unknown 结果、用户越权读取和任务完成后的资源清理。
