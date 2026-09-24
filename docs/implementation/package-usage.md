# package 使用指南

本章描述 `@legado/source-core` 与 `@legado/source-node` 当前已实现的公开入口与调用方式。API 名称以 `packages/source-core/src/index.ts` 为准；与 [书源规则标准](../standard/source-schema.md) 或历史目标设计的差异见 [已知差异](../divergence/known-divergences.md)。

应用组织书源和提交数据，package 解释规则并编排流程。已实现的命令行阅读器位于 `apps/reader-cli`，它在应用层调用本章工作流，提供搜索、详情、目录、正文、书架和阅读状态；安装与键位见 [`apps/reader-cli/README.md`](../../apps/reader-cli/README.md)。

## 当前公开入口

以下导出均来自 `@legado/source-core`：

| 入口 | 输入 | 输出 | 归属 |
| --- | --- | --- | --- |
| `importSources` | JSON、JS、远程文本或文件输入；导入选项 | 原文、规范化候选、诊断与冲突信息 | package 解释；应用确认并保存 |
| `exportSource` | RawSource 与明确字段修改、json/javascript 格式 | 文本与诊断；不丢未知字段，不执行脚本 |
| `createSourceUuid` / `sameSourceDefinition` / `sourceDefinitionFingerprint` | 书源身份字段 | 稳定 `sourceId` 与定义指纹 | package |
| `compileRule` / `inspectRuleCapabilities` | 规则文本与模式提示 | 编译结果、诊断与能力集合 | package |
| `compileSourcePattern` | 来源模式字符串 | 模式或 `SourcePatternError` | package |
| `evaluateRule` | 已编译规则、脱敏输入与 `RuleContext` | `RuleEvaluationResult`；仅在提供宿主能力时执行 JS | package |
| `createRequestPlan` | `RequestPlanInput` | `RequestPlanResult`（`plan` 或稳定错误码） | package |
| `resolveSourceRequestUrl` / `resolveSourceRequestReference` / `splitSourceRequestUrl` | URL 规则相关输入 | 展开后的 URL 或结构化错误 | package |
| `discoverBooks(ports, input)` | `WorkflowPorts`、`DiscoveryInput`（source、cursor、budget、signal） | `RuntimeResult<WorkflowPage<BookCandidate>>` | package |
| `searchBooks(ports, input)` | `WorkflowPorts`、`SearchInput`（source、keyword、cursor） | 同上 | package |
| `loadBookDetails(ports, input)` | `WorkflowPorts`、`DetailInput`（candidates、canReName） | `RuntimeResult<WorkflowPage<BookMetadata>>` | package |
| `loadTableOfContents(ports, input)` | `ReadingPorts`、`TocInput`（book、refresh、maxPages） | `RuntimeResult<WorkflowPage<Chapter>>` | package |
| `loadChapterContent(ports, input)` | `ReadingPorts`、`ContentInput`（chapter、tocHtml、nextChapterUrl、replacements） | `RuntimeResult<ChapterContent>` | package |
| `refreshSubscription` | 订阅 revision/baseline、本地快照 | [订阅流程](../flows/source-subscriptions.md)定义的 diff 与提交计划；不调度、不保存 | package |
| `snapshotVariables` / `variableChanges` / `MemoryVariableView` | 变量视图 | 快照与变更集合 | package |
| `diagnostic` / `primaryError` / `safeLocation` | 诊断或错误 | 稳定诊断与脱敏位置 | package |

多源合并、进度事件、书源检测（`checkSources`）、批量正文（`getContentBatch`）与段评结构化读取的公开入口**尚未实现**；应用侧多源循环见 `apps/reader-cli` 的 application 层，检测与批量能力见 [能力清单](../standard/capability-inventory.md) 与 [已知差异](../divergence/known-divergences.md)。

## 结果形状

工作流入口统一返回 `RuntimeResult<T>`（定义见 `packages/source-core/src/workflows/types.ts`）：

```ts
export type WorkflowStatus =
  | 'success' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'

export interface RuntimeResult<T> {
  status: WorkflowStatus
  value: T | null
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
}
```

- 合法空列表必须是 `empty`，不能用 `failed` 表达。
- `cancelled` 与 `capability-missing` 必须可判别，不能伪装成网络错误。
- 当前实现**没有** `stale` / `unknown` 终态，也没有 `effects` / `changes` / `cleanup` 字段；历史目标契约中的 `OperationResult` 见 [运行时统一契约](runtime-contracts.md) 的目标设计段与 [已知差异](../divergence/known-divergences.md)。

规则与请求工具入口返回各自的结果类型（`RuleCompileResult`、`RuleEvaluationResult`、`RequestPlanResult`），错误使用稳定 `code`，不用异常表达可预期失败。

## 宿主端口

流程入口的第一个参数是端口对象，不是可选依赖注入容器：

- `WorkflowPorts`：`network: NetworkHost`、`rules: WorkflowRulePort`、可选 `request` / `decodeResponse`。
- `ReadingPorts`：在 `WorkflowPorts` 上增加可选 `ContentCache`。

Node 实现由 `@legado/source-node` 提供组合宿主：`SourceRuleHost`、`SourceRequestHost`，以及 `NodeNetworkHost`、`HtmlParserAdapter`、`JsonPathParserAdapter`、`XPathParserAdapter`、`QuickJSJavaScriptHost`、`NodeCookieStore`、`NodeCharsetCodec` 等。端口语义见 [宿主接口](runtime-host-interfaces.md)。

## 创建运行时与单次调用

```text
应用读取书源快照与用户输入
  -> 按 enabled、分组或用户选择确定范围
  -> 构造 SourceRuleHost / SourceRequestHost（或等价 WorkflowPorts）与 AbortSignal
  -> 调用 discoverBooks / searchBooks / loadBookDetails / loadTableOfContents / loadChapterContent
  -> 处理 RuntimeResult 的 status、value、diagnostics、trace
  -> 应用自行提交书架、阅读进度等数据
  -> 等待请求、脚本与并发任务释放
```

应用持有书源配置及版本，package 接受一次调用使用的不可变书源快照（`SourceSnapshot` / `NormalizedSource`）。用户编辑并保存书源后，新调用使用新版本。导入与冲突策略见 [导入协议](../flows/import-protocol.md)；历史编辑器设计见 [归档](../archive/source-editor.md)。

## 一个应用操作如何串接书源处理

1. 用户导入书源。应用把原文交给 `importSources` 解析和诊断，展示候选与冲突；用户确认后应用写入自己的存储。
2. 用户搜索或选择发现分类。应用读取书源快照，调用 `searchBooks` 或 `discoverBooks`。
3. 用户打开一本书。应用调用 `loadBookDetails`；需要章节时调用 `loadTableOfContents`。
4. 用户打开章节。应用先查自己的正文缓存；未命中时调用 `loadChapterContent`。缓存键与版本由应用持有；标准侧 `ContentSaveToken` 契约见 [状态与副作用](../standard/state-and-effects.md)，package 内核尚未导出该令牌类型。
5. 订阅到期时，应用调度刷新；`refreshSubscription` 生成三方差异，应用确认后自行提交。

书架、阅读器展示和阅读进度属于应用层；`apps/reader-cli` 已实现本地 JSON 存储，不经过 Supabase 或 Repository 端口。

## Node 与框架接入

当前参考宿主是 Node（`@legado/source-node`）。SPA、SSR 或框架入口应调用同一组 source-core 公开入口，而不是各自解释规则。Edge 等受限环境的宿主能力判断见 [运行边界](../operations/runtime-security-and-deployment.md)；历史 Next.js 接入设计见 [归档](../archive/node-browser-nextjs.md)。

## package 维护约定

- 对外区分原始书源格式版本、规则语义版本和 package API 版本。规则行为修正若会改变已有书源结果，需要兼容测试和显式迁移说明。
- 未识别的书源字段由 codec 保留；支持状态由兼容矩阵和运行时能力报告决定，不因导入成功就宣称可执行。
- 每个公开入口都要有成功、空结果、规则错误、宿主失败、取消和资源清理样本；组合测试从公开入口执行（见 `packages/source-core/tests/` 与 `packages/source-node/tests/`）。
- Node 宿主使用相同公开入口和 fixture；只有实际通过的宿主能力才能标记为已验证。
