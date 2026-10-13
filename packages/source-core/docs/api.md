# source-core API 索引

公开入口以 [`src/index.ts`](../src/index.ts) 为准。本页只说明入口分组和调用边界，参数、结果和完整类型直接使用该文件重新导出的类型；不要在这里维护第二份字段表。

## Codec 与身份

- `importSources(input, options)` 读取 JSON、JSON 数组、静态 JavaScript、受控 URI 或文件输入，返回候选、未知字段、替换结果和诊断。
- `exportSource(candidate, options)` 导出 JSON 或 JavaScript；未修改的原文可以逐字保留，修改后的 JavaScript 只生成静态 `config` 包装。
- `createSourceUuid` 生成导入实例 UUID；`sourceDefinitionFingerprint` 和 `sameSourceDefinition` 只比较规则/请求定义，不把名称、排序和启用状态当作定义变化。
- `refreshSubscription(input)` 比较 baseline、remote 和 local 快照并返回 `SubscriptionRefreshPlan`；它不执行提交。

详见 [Codec 与订阅](codec-and-subscriptions.md) 和 [`model/types.ts`](../src/model/types.ts)。

## 规则与请求

- `compileRule` 将规则文本解析为带模式、范围、变量写入、替换和能力集合的不可变 IR；`inspectRuleCapabilities` 读取该 IR 的宿主要求。
- `evaluateRule` 在调用方提供的 `RuleContext` 和预算内求值，并返回 `RuleEvaluationResult` 与变量变化；没有对应 parser/JavaScript 能力时返回可判别的 capability 状态。
- `compileSourcePattern` 编译书源模式字符串，拒绝不安全或无效的模式并返回稳定错误。
- `createRequestPlan` 将 URL、方法、Header、正文、响应类型、执行提示和请求预算验证为 `RequestPlan`；非法 URL、方法、预算、请求体或 WebView 要求返回 `RequestPlanResult.error`。
- `resolveSourceRequestUrl`、`resolveSourceRequestReference` 和 `splitSourceRequestUrl` 处理书源 URL 规则的相对地址、引用和选项分隔。
- `SourceRuleRuntime`、`SourceRequestRuntime` 是核心运行时类；它们需要端口提供解析器、编码、脚本和网络能力。

详见 [规则与请求](rules-and-requests.md)。

## 工作流

以下入口均以 `WorkflowPorts` 或 `ReadingPorts` 为第一个参数，并返回 `RuntimeResult<T>`：

| 入口 | 作用 |
| --- | --- |
| `discoverBooks` / `searchBooks` | 发现和关键词搜索，返回带 `PageCursor` 的候选页 |
| `groupSearchCandidates`、`searchMatchRank` 等 | 纯候选归并和匹配排序，不访问网络或存储 |
| `loadBookDetails` | 对候选加载详情并返回 `BookMetadata` |
| `loadTableOfContents` | 加载目录；成功页可以通过 `TocPage.bookAfter` 返回脚本更新后的书籍快照 |
| `loadChapterContent` | 解析单章正文，不直接读写缓存 |
| `loadStoredChapterContent` | 使用 `ContentStore` 做 cache-first 读取、条件写入和提交后重读 |
| `loadChapterContentBatch` | 批量脚本与单章兜底；保存由调用方提供的 `cacheContent` 决定 |
| `decodeImage` | 对调用方已经下载的图片或封面 bytes 执行解密脚本，不下载资源 |
| `nextChapterUrlFor` / `reconcileTableOfContents` | 章节导航和目录纯函数合并 |

详见 [工作流](workflows.md)。多源调度、应用状态、书架和用户凭据属于 `apps/`，不由这些入口代办。

## 诊断与会话

`diagnostic`、`primaryError`、`safeLocation` 创建脱敏诊断；`createSourceSession` 为一个固定书源隔离脚本缓存、变量快照和 `concurrentRate` 窗口，`run` 每次创建工作流端口，`close` 释放等待并拒绝新操作。

完整导出还包括 `MemoryVariableView`、`snapshotVariables`、`variableChanges`、`KeyedConcurrencyHost`、`SourceRateLimiter` 和 `MemorySourceScriptCache`。这些是宿主组合工具，不是应用 Repository。

## 调用检查

接入新应用时按以下顺序核对：

1. 从 [`src/index.ts`](../src/index.ts) 确认入口仍公开；
2. 为每次操作提供 signal、budget 和真实端口，区分合法空结果与失败；
3. 对正文使用稳定 `ContentIdentity` 和 `ContentStore`，不把章节 URL 当成唯一缓存键；
4. 在 `finally` 中关闭 Node session 或等价宿主资源；
5. 将 Android/TypeScript 对照结果登记到[兼容性状态](../../../docs/compatibility/status.md)，不要在 API 文档中写“已兼容”。
