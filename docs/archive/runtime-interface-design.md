# 统一运行时接口设计（归档）

本文件保留早期提出的统一 `RuntimeHost` / `OperationResult` 目标，供兼容分析和后续决策查阅。它不是 `@legado/source-core` 的当前 API；当前分层端口和结果以 [`source-core 宿主端口`](../../packages/source-core/docs/host-ports.md) 与 [`运行时契约`](../../packages/source-core/docs/runtime-contracts.md) 为准。

## 归档原因

当前仓库已经实现 `RequestPlan`、`RuntimeResult`、`WorkflowPorts`、`ReadingPorts`、`ContentStore` 以及 Node 的 `SourceRuleHost`/`SourceRequestHost`，但没有把所有网络、解析、脚本、Cookie、变量、资源和应用存储统一成一个 `RuntimeHost`。旧设计把尚未实现的应用状态和宿主门面混在一起，若放在现行 package 入口会让读者误以为已可调用。

## 目标结果信封

早期设计曾提出：

```ts
type OperationStatus =
  | 'success' | 'empty' | 'partial' | 'failed'
  | 'cancelled' | 'stale' | 'unknown' | 'capability-missing'

interface OperationResult<T> {
  status: OperationStatus
  value?: T
  diagnostics: RuntimeDiagnostic[]
  effects: EffectRecord[]
  changes: DomainChange[]
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
  operationId: string
  idempotencyKey?: string
  sourceRevision?: string
}
```

其中 `DomainChange` 计划表达资源身份、base revision、create/update/content-update/delete/user-override/invalidate 变化；`EffectRecord` 记录 Cookie、变量、缓存、正文或外部写入的 committed/rejected/unknown 结果。此信封尚未在 packages 导出，`stale`/`unknown` 仍属于存储或应用边界。

旧的部署草案还提出过跨网络、脚本和分页共享的 `OperationBudget`：

```ts
interface OperationBudget {
  deadlineMs: number
  maxRequests: number
  maxPages: number
  maxResponseBytes: number
  maxTotalBytes: number
  maxScriptMemoryBytes: number
  maxScriptTimeMs: number
}
```

这组字段描述的是目标级统一策略，不是当前 source-node 的单一配置对象。当前实现把请求预算交给 `RequestBudget`，把 QuickJS 预算交给 `JavaScriptBudget`，分页上限由各 core workflow 接收；统一 deadline、效果记录和跨请求清理仍需真实调用点与应用提交责任后再决定。

旧搜索设计还提出 `SearchRequest`、`SearchResultSink`/`Sink`、`SearchSourceStatus` 和 `CallContext`，用于多源调度、增量事件和统一取消。这些名称同样没有在 source-core 导出；当前使用 `SearchInput`、`WorkflowPorts`、`RuntimeResult` 和应用层的 `ReaderApplication`，不能按归档接口实现适配器。

## 目标宿主门面

早期设计还提出 `RuntimeHost` 包含以下能力：

- `scope`：session、user、source 和 operation 身份；
- `http`、`charset`、`html`、`xpath`、`jsonPath`、`js`；
- `cookies`、`variables`、`cache`、`content`、`resources`；
- 可选 `rateLimiter`、`logger` 和 `RuntimeCapabilities`。

该目标允许把应用的用户隔离、资源版本和统一日志一次性注入，但会把当前已经分层的 `WorkflowPorts`、`ContentStore` 和 Node 宿主重新耦合。今后若要实现，应先给每个能力补真实调用点、权限/生命周期、清理、版本条件写入和 conformance fixture，再决定是否提供 adapter；不能直接把本文件的接口复制到 core。

早期运行边界还比较过嵌入式 QuickJS、`isolated-vm` 和 Node `vm`。这些材料只说明隔离、内存/栈限制和句柄清理等评估方向；当前 Node 已采用 `quickjs-emscripten`，而 `node:vm` 不是不可信代码的安全边界。同步旧式 `java.ajax` 外观、Rhino 返回值对照和 Edge 执行器仍需单独验收，不能从当前 QuickJS 接入推导完整 Android JS 兼容。

## 目标变量和资源接口

目标设计中的 `VariableStoreFactory`/`VariableStore` 负责 local、chapter、book、rule-data、source 作用域；`ResourceStore` 负责图片、音频、视频和文件资源；`RateLimiter` 和 `Logger` 负责源级限流与脱敏日志。当前等价责任分布如下：

| 目标名称 | 当前承接 |
| --- | --- |
| `RuleVariableView` | `source-core/src/rules/types.ts`；session 通过 snapshot 合并 source 变量 |
| `ContentStore` / `ContentIdentity` / `ContentSaveToken` | `source-core/src/workflows/types.ts`，只覆盖最终正文 cache-first |
| `SourceScriptCache` | `source-core/src/runtime/contracts.ts` 和 `MemorySourceScriptCache` |
| `NetworkHost` / `WorkflowPorts` | `source-core/src/runtime/contracts.ts` 与 `workflows/types.ts` |
| Node 限流、Cookie、解析器、脚本和编码 | `@legado/source-node` 各 host，不是统一 `RuntimeHost` |
| 用户、Repository、SecretStore、JobStore | 应用或 archive 目标；当前没有 core 实现 |

## 采用或放弃前的门槛

任何重新启用本设计的变更都必须先更新[兼容性状态](../../docs/compatibility/status.md)和能力证据，说明：

1. 真实导出和包入口；
2. scope、权限、取消、超时和资源清理；
3. stale/unknown/revision-conflict 的可观察映射；
4. Android 事实、TypeScript 断言和 fixture/golden；
5. reader-cli、reader-web 或其他应用的提交责任。

在这些证据出现前，本文件只作为历史目标，不作为调用示例或实现承诺。
