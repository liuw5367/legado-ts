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
| `loadReviewSummary` / `loadReviewDetail` / `loadReviewReplies` | 读取结构化段评摘要、详情和回复，支持声明式规则、JS 函数、内容协议和分页 |
| `executePayAction` / `executeSourceCallback` | 执行用户触发的付费动作和书源回调；返回 URL/真值/能力状态，宿主负责浏览器、刷新和 UI |
| `nextChapterUrlFor` / `reconcileTableOfContents` | 章节导航和目录纯函数合并 |

详见 [工作流](workflows.md)。多源调度、应用状态、书架和用户凭据属于 `apps/`，不由这些入口代办。

## 阅读正文结构

`normalizeReadingContent(input, parseHtml)` 将已提取的 `ChapterContent.cleaned`、`contentType` 和图片资源转换为 `ReadingDocument`；可提供最终响应地址作为 `baseUrl` 解析相对图片。它不执行网络请求、书源替换或抓取格式化，也不改变原始缓存契约。

纯文本与 HTML 都输出有序的段落、图片及显式分页块。段落只保留加粗、斜体、下划线和代码格式，来源链接保留为普通文字，脚本及危险容器整棵移除。`text` 中保留的 `img`、`usehtml` 和独立行 `[newpage]` 同样参与规范化，其他文本标签和实体不重新解释。纯文本边界缩进由阅读器控制，HTML 的 `pre` 保留行内空白。图片仅接受 HTTP(S) 或限定的位图 base64 data URL，附加图片按规范化地址去重。

`ReadingHtmlParser` 由宿主提供包含全部文本节点的有序节点视图，core 统一决定过滤、断段和格式；需要解释 HTML 却未提供解析器时抛出带 `capability-missing` 的错误。`readingParagraphTexts(document)` 生成按块索引对齐的文字数组，图片与分页标记对应空字符串，字符偏移为 UTF-16。渲染、笔记校验和摘录必须使用同一模型及索引，不能另外从 HTML 的整章 `textContent` 推导锚点。

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
