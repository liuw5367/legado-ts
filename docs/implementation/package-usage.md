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
| `SourceRuleRuntime` | `SourceRuleRuntimeOptions` 中的解析器、JS、编码、加密、字体和 bridge 能力 | 实现 `WorkflowRulePort` 的书源规则运行时 | package |
| `createRequestPlan` | `RequestPlanInput` | `RequestPlanResult`（`plan` 或稳定错误码） | package |
| `SourceRequestRuntime` | `WorkflowRequest`、`NetworkHost`、字符集与可选规则能力 | 解析书源请求选项并返回 `NetworkResponse`；请求失败时 reject | package |
| `resolveSourceRequestUrl` / `resolveSourceRequestReference` / `splitSourceRequestUrl` | URL 规则相关输入 | 展开后的 URL 或结构化错误 | package |
| `replaceFont` | 文本与错误/正确字体映射 | 按 glyph 轮廓替换文字 | package |
| `discoverBooks(ports, input)` | `WorkflowPorts`、`DiscoveryInput`（source、cursor、budget、signal） | `RuntimeResult<WorkflowPage<BookCandidate>>` | package |
| `searchBooks(ports, input)` | `WorkflowPorts`、`SearchInput`（source、keyword、cursor） | 同上 | package |
| `groupSearchCandidates` | 关键词与带 `BookCandidate`、`arrivalIndex` 的候选 | 按书名/作者身份归并并稳定排序的分组 | package |
| `searchMatchRank` / `isBookTitleMatch` / `isAuthorMatch` | 搜索词或候选字段 | 核心匹配等级与规范化比较结果 | package |
| `loadBookDetails(ports, input)` | `WorkflowPorts`、`DetailInput`（candidates、canReName） | `RuntimeResult<WorkflowPage<BookMetadata>>` | package |
| `loadTableOfContents(ports, input)` | `ReadingPorts`、`TocInput`（book、refresh、maxPages） | `RuntimeResult<WorkflowPage<Chapter>>` | package |
| `loadChapterContent(ports, input)` | `ReadingPorts`、`ContentInput`（chapter、tocHtml、nextChapterUrl、replacements） | `RuntimeResult<ChapterContent>` | package |
| `loadStoredChapterContent(ports, input)` | `ReadingPorts`、`StoredContentInput`（正文输入、`ContentIdentity`、`ContentStore`、可选 refresh） | `RuntimeResult<ChapterContent>`；命中不请求网络，提交后重读 | package + host store |
| `loadChapterContentBatch(ports, input)` | `ReadingPorts`、`ContentBatchInput`（book、chapters、可选 `cacheContent` 宿主回调） | `RuntimeResult<ChapterContentBatchResult>`；已回存项与单章兜底结果按输入顺序返回 | package |
| `decodeImage(ports, input)` | `WorkflowPorts`、`ImageDecodeInput`（source、src、bytes、isCover、book、resultInputKind、javascriptBudget、signal） | `RuntimeResult<Uint8Array>`；失败时不返回原密文 | package |
| `refreshSubscription` | 订阅 revision/baseline、本地快照 | [订阅流程](../flows/source-subscriptions.md)定义的 diff 与提交计划；不调度、不保存 | package |
| `snapshotVariables` / `variableChanges` / `MemoryVariableView` | 变量视图 | 快照与变更集合 | package |
| `diagnostic` / `primaryError` / `safeLocation` | 诊断或错误 | 稳定诊断与脱敏位置 | package |

声明式 `ruleContent.subContent` 会把在线文本副文并入 `ChapterContent.pages/raw/cleaned`；音频歌词或视频弹幕通过 `ChapterContent.auxiliary` 返回，并在返回的 `ChapterContent.chapter.variable` 中更新 `lyric` 或 `danmaku`。辅助字段是章节变量的便捷投影，持久化以返回章节变量为准。声明式正文工作流不修改调用方传入的章节对象；source-core 不直接持久化章节，应用适配器负责保存这些字段。JS 源 `getContent` 沿用其函数返回，不额外运行声明式副文规则。

`decodeImage` 只解释图片解密规则，不下载或缓存图片。`isCover` 选择 `coverDecodeJs`，否则选择 `ruleContent.imageDecode`；规则缺省时原样返回输入 bytes。正文图片脚本把 `result` 作为 `Uint8Array` 接收；封面默认按 Android 图片加载路径把 `result` 暴露为常用 `InputStream` 兼容对象，也可用 `resultInputKind: 'bytes'` 显式选择字节数组形式。规则必须返回 `Uint8Array`，执行失败、宿主能力缺失和取消都可从 `RuntimeResult.status` 区分。`javascriptBudget` 可按调用方策略覆盖宿主默认输入、输出、内存和时限；实际网络下载、文件/图片缓存和失败后的缓存策略由调用方负责。

`loadStoredChapterContent` 是最终正文的 cache-first 编排入口：它按 `ContentIdentity` 读取宿主 `ContentStore`，命中有效记录时不请求网络；未命中或 `refresh=true` 时执行 `loadChapterContent`，再用 `ContentSaveToken` 条件提交正文、最终响应 URL、章节元数据和副内容，并在提交后重读。宿主返回 `stale`、`rejected` 或 `unknown` 时不覆盖较新正文，当前结果仍可交付并带 `partial`/`cache-failed` 诊断。`loadChapterContent` 仍是纯解析入口，不直接读写存储。

`loadChapterContentBatch` 接收调用方筛出的缓存未命中章节，忽略卷节点，按配置的 `maxBatchSize` 分组，运行普通源 `ruleContent.contentBatch` 或 JS 源 `getContentBatch(chapters, book)`，并将 `java.cacheContent(chapter, content)` 接到调用方提供的 `cacheContent(chapter, content, signal)` 回调。核心按章节 `index` 识别对象、只接受唯一命中的 URL，先应用书源 `replaceRegex`，再让宿主逐章提交。缺少批量函数、脚本失败或未回存的章节会走 `loadChapterContent` 单章兜底；已成功回存的项目保留。回调返回 `false` 表示宿主拒绝当前写入，核心跳过该章兜底以免覆盖更新后的正文。未提供缓存回调时会跳过批量脚本、返回单章解析结果且不写入缓存。每次脚本最多接收 50 章。

多源 fan-out、并发调度、进度事件和书源检测（`ReaderApplication.search` / `ReaderApplication.checkSources`）由 `apps/reader-cli` 应用层提供；核心 package 仍只负责单源工作流。CLI 还提供书源状态与优先级持久化、批量启用/禁用，以及检测取消后对已确认失败书源的再次选择。段评结构化读取仍未实现。纯候选归并与匹配排序已由 `groupSearchCandidates` 等核心函数提供；CLI 当前分组规则说明见[搜索流程](../flows/search-flow.md#typescript-当前聚合行为)。检测细节见[书源校验流程](../flows/source-check-flow.md)，其余能力见[能力清单](../standard/capability-inventory.md)与[已知差异](../divergence/known-divergences.md)。

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

- `WorkflowPorts`：`network: NetworkHost`、`rules: WorkflowRulePort`、可选请求适配器 `request` / 响应解码器 `decodeResponse`。默认请求与 Node 请求适配都使用 `SourceRequestRuntime` 的请求语义。
- `ReadingPorts`：在 `WorkflowPorts` 上保留批量流程的兼容 `ContentCache` 字段；最终正文必须使用 `ContentStore`，原始页面缓存不再由目录/正文流程读取或写入。

Node 实现由 `@legado/source-node` 提供组合门面：`SourceRuleHost` 委托给 `SourceRuleRuntime`，`SourceRequestHost` 委托给 `SourceRequestRuntime`；Node 包提供 `NodeNetworkHost`、HTML/JSONPath/XPath 解析器、`QuickJSJavaScriptHost`、`NodeCookieStore`、`NodeCharsetCodec` 等平台能力。端口语义见[宿主接口](runtime-host-interfaces.md)。

宿主可通过 `NetworkHost.defaultUserAgent` 提供平台默认 User-Agent；Node `createNodeSourceSession` 的 `networkOptions.defaultUserAgent` 会将其带入请求计划。核心只在 source header 没有 User-Agent 时采用该值，URL options 中的显式 Header 仍可覆盖它。Node 未显式配置时使用当前 Android 基线 User-Agent（`Chrome/153.0.0.0`），平台升级时需同步版本常量。

`createNodeSourceSession` 返回的 session 还提供 `diagnostics()` 和 `close()`：前者报告首次非法 `concurrentRate` 的兼容 fallback，后者释放窗口等待并阻止该 session 接受新工作流。源定义编辑、覆盖或删除时应先关闭旧 session，再用新快照创建 session。

独立登录凭据不放入 `source.header`。宿主通过 `NetworkHost.getLoginHeaders(sourceId)` 或 Node 的 `networkOptions.loginHeaderProvider` 提供；core 默认只允许精确主机名，具备 Public Suffix List 的宿主应实现 `NetworkHost.isLoginHeaderSite`，Node 已提供该判断。凭据只按初始请求 URL 注入，URL options Header 可以覆盖；凭据存储、登录流程和删除清理由应用/SecretStore 负责。

宿主适配迁移注意：`XPathParser` 要求同时实现 `parse(input)` 与 `evaluate(document, expression)`。只实现 `evaluate` 的旧适配器需补上文档解析，否则不满足 `source-core` 导出的类型；`parse` 返回的文档可直接交给 `evaluate`。

## 创建运行时与单次调用

```text
应用读取书源快照与用户输入
  -> 按 enabled、分组或用户选择确定范围
  -> 组合 Node 平台能力并构造 SourceRuleHost / SourceRequestHost（或等价 WorkflowPorts）与 AbortSignal
  -> 调用 discoverBooks / searchBooks / loadBookDetails / loadTableOfContents / loadStoredChapterContent
  -> 处理 RuntimeResult 的 status、value、diagnostics、trace
  -> 应用自行提交书架、阅读进度等数据
  -> 等待请求、脚本与并发任务释放
```

应用持有书源配置及版本，package 接受一次调用使用的不可变书源快照（`SourceSnapshot` / `NormalizedSource`）。用户编辑并保存书源后，新调用使用新版本。导入与冲突策略见 [导入协议](../flows/import-protocol.md)；历史编辑器设计见 [归档](../archive/source-editor.md)。

### CLI 书源管理

`ReaderApplication` 将书源用户状态保存在 `source-state.json`，以原始 `bookSourceUrl` 为键、以定义指纹区分旧结果。状态包括 `enabled`、`enabledExplore`、`customOrder`、搜索连续失败次数和最近一次 `SourceCheckRecord`。加载目录时先应用用户状态，再计算可用、禁用、冲突和不支持状态；定义指纹变化会丢弃旧检测结果和搜索失败计数。

书源管理页从首页 `m` 进入。用户可以固定一批书源 ID 后调用 `checkSources`；检测任务只使用这份选择快照。执行顺序与 Android `CheckSourceService` 对齐：域名（可选）→ 搜索及其首个候选的详情、目录、正文 → 第一个有效发现分类及其首个候选的详情、目录、正文。默认单源总超时为 180 秒，检测关键字优先读取 `ruleSearch.checkKeyWord`，包含 `http`、`::`、`++` 或 `--` 时回退为“我的”。取消任务不会把未完成源标成失败；已完成的失败结果立即写入状态文件，页面可用 `f` 重新选择后批量禁用。

## 一个应用操作如何串接书源处理

1. 用户导入书源。应用把原文交给 `importSources` 解析和诊断，展示候选与冲突；用户确认后应用写入自己的存储。
2. 用户搜索或选择发现分类。应用读取书源快照，调用 `searchBooks` 或 `discoverBooks`。
3. 用户打开一本书。应用调用 `loadBookDetails`；需要章节时调用 `loadTableOfContents`。
4. 用户打开章节。应用构造包含书源指纹、目录 revision 和章节身份的 `ContentIdentity`，调用 `loadStoredChapterContent`；CLI 的 `ReaderStorage.contentStore(bookId)` 负责 token、条件写和原子文件替换。需要预览或强制刷新时传入 `refresh=true`。
5. 订阅到期时，应用调度刷新；`refreshSubscription` 生成三方差异，应用确认后自行提交。

书架、阅读器展示和阅读进度属于应用层；`apps/reader-cli` 已实现本地 JSON 存储，不经过 Supabase 或 Repository 端口。

## Node 与框架接入

当前参考宿主是 Node（`@legado/source-node`）。SPA、SSR 或框架入口应调用同一组 source-core 公开入口，而不是各自解释规则。Edge 等受限环境的宿主能力判断见 [运行边界](../operations/runtime-security-and-deployment.md)；历史 Next.js 接入设计见 [归档](../archive/node-browser-nextjs.md)。

## package 维护约定

- 对外区分原始书源格式版本、规则语义版本和 package API 版本。规则行为修正若会改变已有书源结果，需要兼容测试和显式迁移说明。
- 未识别的书源字段由 codec 保留；支持状态由兼容矩阵和运行时能力报告决定，不因导入成功就宣称可执行。
- 每个公开入口都要有成功、空结果、规则错误、宿主失败、取消和资源清理样本；组合测试从公开入口执行（见 `packages/source-core/tests/` 与 `packages/source-node/tests/`）。
- Node 宿主使用相同公开入口和 fixture；只有实际通过的宿主能力才能标记为已验证。
