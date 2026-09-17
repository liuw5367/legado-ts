# 运行时统一契约

本文收敛 package 对外使用的版本、请求计划、结果、资源和错误命名。它优先于旧流程中的局部命名；兼容 Android 或旧 Web API 的别名只能在 adapter 边界转换。

## 规范命名

| 名称 | 含义 |
| --- | --- |
| `sourceId` | 原始 `bookSourceUrl` 字符串身份 |
| `sourceRevision` | 用户保存的源配置并发版本 |
| `baseRevision` | 计算修改时读取的旧版本 |
| `checkRevision` | 一次检测任务的版本 |
| `writeVersion` | 一次正文/资源写入的代次 |
| `semanticVersion` | 规则语义和结果缓存版本 |
| `operationId` | 一次领域调用身份；重试不改变 |
| `idempotencyKey` | 跨请求重试仍保持的提交意图身份 |

`revision`、`sourceVersion`、`baseVersion` 不是新的内部名称。适配器可把旧字段映射到上表，但核心、Repository、测试 golden 和持久化契约只使用规范命名。

## 请求计划

URL 规则先产生不可变 `RequestPlan`，宿主再把它物化为 HTTP 或 WebView 请求。这样核心不会丢失 Android `UrlOption` 中的执行意图。

```ts
export interface RequestPlan {
  /** 规则展开后的绝对 URL。 */
  url: string
  /** 请求方法；未知方法已按兼容规则回退。 */
  method: 'GET' | 'POST' | 'HEAD'
  /** 已解析的请求头。 */
  headers: Record<string, string>
  /** 已按 charset 和 Content-Type 准备好的请求体。 */
  body?: string | Uint8Array
  /** 请求体和响应使用的字符集提示。 */
  charset?: string
  /** 最大尝试次数；不代表一定重试。 */
  maxAttempts: number
  /** 是否允许跟随重定向。 */
  followRedirects: boolean
  /** 期望的响应处理路径。 */
  responseType: 'text' | 'bytes'
  /** bodyJs 等响应后处理脚本。 */
  bodyJs?: string
  /** 普通 HTTP 以外的宿主执行提示。 */
  execution: RequestExecutionHints
  /** 本次请求的资源预算和取消信号。 */
  budget: RequestBudget
}

export interface RequestExecutionHints {
  /** 是否要求 WebView；缺少能力时必须返回 capability error。 */
  useWebView: boolean
  /** WebView 页面脚本。 */
  webJs?: string
  /** DNS 覆盖地址；安全策略仍由宿主校验。 */
  dnsIp?: string
  /** 代理提示；不能绕过宿主出口策略。 */
  proxy?: string
  /** Android 兼容的服务端节点提示。 */
  serverId?: number
  /** WebView 加载后等待时间。 */
  webViewDelayTimeMs?: number
}

export interface RequestBudget {
  /** 单次请求截止时间。 */
  timeoutMs: number
  /** 当前操作共享的截止时间。 */
  deadlineMs?: number
  /** 页面、重试和分页共享的上限。 */
  maxRequests: number
  signal?: AbortSignal
}
```

`origin`、页码占位符、URL 中的 `<js>` 和 `{{}}` 在生成计划前处理；`bodyJs`、XML 补声明和字符集解码在响应阶段处理。宿主不得自行修改核心已经决定的 URL、方法、正文或响应类型。

## 结果与错误

所有公开流程返回 `OperationResult<T>`，其中 `value` 可以是成功空列表，但不能用空列表表示失败：

```ts
export type OperationStatus =
  | 'success'
  | 'empty'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'capability-missing'

export interface OperationResult<T> {
  /** 可判别终态；空列表成功必须使用 empty，而非 failed。 */
  status: OperationStatus
  /** 领域结果；partial/cancelled 时允许保留已产生但未提交的部分结果。 */
  value?: T
  /** 可继续处理的警告和阶段诊断。 */
  diagnostics: RuntimeDiagnostic[]
  /** 已发生或已提交的副作用。 */
  effects: EffectRecord[]
  /** 尚未由应用提交的领域变更。 */
  changes: unknown[]
  /** 请求资源的最终收尾结果；cancelled 也必须等待资源所有者结算。 */
  cleanup: {
    status: 'complete' | 'partial' | 'failed'
    pending: string[]
  }
  operationId: string
  sourceRevision?: string
}

export interface EffectRecord {
  /** 副作用种类，例如 cookie、变量、缓存、正文或上游写入。 */
  kind: string
  /** 稳定资源身份；不得包含秘密。 */
  resourceKey: string
  /** 已提交、被拒绝或结果未知。 */
  status: 'committed' | 'rejected' | 'unknown'
  operationId: string
}
```

错误必须使用既有 `RuntimeStage` 和稳定 `code`。`cancelled`、`stale`、`budget-exceeded`、`capability-missing`、`policy-denied`、`storage-error`、`revision-conflict` 和上游网络失败不能互相伪装。

映射示例：宿主启用 `blockSourceNavigation` 且在 `SuppressSourceNavigation` 上下文阻止 `openUrl`/`openVideoPlayer` 时，适配器应把该拒绝报告为 `policy-denied`，不能伪装成网络错误或能力缺失。

## 契约边界

```text
source-core
  -> RequestPlan / OperationResult / RuntimeDiagnostic
  -> RuntimeHost 端口
  -> application service 提交 changes/effects
  -> Repository、Store 或 JobStore
```

核心不直接导入 `fetch`、Supabase、Node 文件 API 或 Web 框架。适配器负责旧字段映射、认证、策略拒绝、持久化和传输协议。
