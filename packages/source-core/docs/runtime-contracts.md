# source-core 运行时契约

当前实现的契约由 [`runtime/contracts.ts`](../src/runtime/contracts.ts) 与 [`workflows/types.ts`](../src/workflows/types.ts) 定义。本页只解释结果、请求、游标和存储状态之间的边界；统一 `OperationResult`、effects 和 cleanup 的设计已移到[历史接口设计](../../../docs/archive/runtime-interface-design.md)，不能当作当前导出。

## 规范身份

| 名称 | 当前用途 |
| --- | --- |
| `sourceId` | 原始 `bookSourceUrl` 字符串身份；不做 URL 规范化 |
| `sourceRevision` | 应用保存书源快照的版本；由应用传入或保存，core 不生成 Repository 版本 |
| `semanticVersion` | 规则语义和正文缓存的版本字段；变化时不能命中旧缓存 |
| `operationId` | 一次正文/订阅或宿主写入意图的身份；重试由调用方保持不变 |
| `writeVersion` | `ContentSaveToken` 的条件写入代次 |
| `chapterKey` / `tocRevision` | 正文缓存使用的章节和目录身份 |

## 请求计划

`createRequestPlan` 先把 URL 规则产生的输入验证成不可变 `RequestPlan`，再交给 `NetworkHost.request` 物化。当前 `RequestPlan` 包含：

- 绝对 `url`、`GET`/`POST`/`HEAD` 方法和已合并 Header；
- 可选字符串或 `Uint8Array` body、请求/响应字符集、是否跟随重定向和 `text`/`bytes` 响应类型；
- `useWebView`、`webJs`、`sourceRegex`、DNS、代理、Cookie、serverId、限流旁路等 `RequestExecutionHints`；
- `RequestBudget` 的 `timeoutMs`、`deadlineMs`、请求数、页数、单响应/总响应/请求体字节数和重定向上限。

默认预算在 [`request-plan.ts`](../src/runtime/request-plan.ts) 中定义。非法 URL、方法、预算、超大请求体和要求 WebView 的请求返回 `RequestPlanResult.error`；普通 Node HTTP 不得静默执行 `useWebView`。

宿主返回 [`NetworkResponse`](../src/runtime/contracts.ts) 时必须保留最终 URL、状态码、响应头、解压后的 bytes 和 `redirected`。网络失败不能伪造 200，也不能把超过预算的部分响应当作成功。

## 工作流结果

当前所有已实现工作流使用：

```ts
type WorkflowStatus =
  | 'success' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'

interface RuntimeResult<T> {
  status: WorkflowStatus
  value: T | null
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
}
```

- `success` 表示有有效值；合法无结果使用 `empty`，不能用 `failed` 代替。
- `partial` 可以带已获得但未完成的候选或章节；应用必须按诊断决定是否展示或保存。
- `cancelled` 保留取消原因；`capability-missing` 表示宿主缺少明确能力；二者不能包装成普通网络失败。
- `WorkflowDiagnostic` 至少带稳定 `code`、`stage`、消息和 `retryable`；`trace` 记录请求、规则、候选和字段事件，不得写入凭据。

`WorkflowStage` 当前为 `discover`、`search`、`detail`；阅读和请求诊断仍通过入口和 `WorkflowDiagnostic` 的字段说明阶段。完整类型见 [`workflows/types.ts`](../src/workflows/types.ts)。

## 页面与目录游标

`WorkflowPage<T>` 包含 `items`、当前 `cursor` 和可选 `nextCursor`。只有规则确实产生下一地址（例如 `{{page}}`/`{{pageIndex}}` 或命中 nextPage）时才返回下一游标；没有页码变化的地址不能反复宣称可翻页。目录使用 `TocPage`，成功时可以通过 `bookAfter` 返回目录脚本回写的书籍状态。

`PageCursor.index` 是书源页码，不是全局 offset；`token` 是可选的书源续页 token。应用保存游标时必须绑定 source/book 版本，不能跨书源复用。

## 规则与请求诊断

规则求值使用 `RuleEvaluationResult` 的 `success`、`empty`、`failed`、`cancelled`、`capability-missing` 和 `budget-exceeded`。请求计划错误使用 `invalid-url`、`invalid-method`、`invalid-budget`、`request-body-too-large` 或 `webview-required`。预期的规则、解析器、编码和宿主能力问题应返回稳定诊断，不用异常消息作为兼容断言。

`SourceRequestRuntime` 可以抛出 `SourceRequestError`，错误码为 `invalid-config`、`capability-missing`、`cancelled` 或 `rule-failed`；工作流适配器负责将它们映射为诊断。请求脚本的 `book`、内部 chapter scope、Header 和最终响应 URL 的语义见[规则与请求](rules-and-requests.md)。

## 存储状态和结果映射

source-core 本身没有 `stale` / `unknown` 工作流终态，也没有 `effects`、`changes`、`cleanup` 字段。正文 `ContentStore.write` 返回 `committed`、`rejected`、`stale`、`cancelled` 或 `unknown`：

- `committed` 才表示条件写入已确认；
- `stale`/`rejected` 表示不能覆盖更新版本，当前正文可以仍然交付并附带 `partial` 或 `cache-failed` 诊断；
- `unknown` 表示底层可能已写入但暂时无法确认，应用不能自动重试非幂等提交；
- `cancelled` 表示写入被取消，不等于工作流已经没有可展示的值。

应用或 Repository 可以另有 `stale`、`unknown`、`storage-error` 状态，但必须记录它们与 `RuntimeResult` 的映射。兼容状态的单一入口是[兼容性状态总览](../../../docs/compatibility/status.md)。

## 资源和关闭

每次工作流使用 `AbortSignal` 和预算；Node session 还包住 source 级限流、脚本缓存和 source 变量快照。操作结束后由 session/宿主等待在途请求、脚本和并发任务，应用在 `finally` 调用 `close()`。core 不因工作流返回就自动删除应用 Cookie、正文、书架或凭据。
