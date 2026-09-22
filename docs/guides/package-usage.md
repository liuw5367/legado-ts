# 独立 package 的调用契约

本章是目标设计，不代表已有代码。以下名称作为公开契约维护，改名或更改输入输出须同步规格与案例。应用组织书源和提交数据，package 解释规则并编排流程。

已实现的命令行阅读器位于 `apps/reader-cli`，它在应用层使用本章公开工作流，提供搜索、详情、目录、正文、书架和阅读状态。安装、启动、键位以及 package 内的交互、架构和存储文档见 [`apps/reader-cli/README.md`](../../apps/reader-cli/README.md)。

## 最小公开能力

| 能力 | 输入 | 输出 | 归属 |
| --- | --- | --- | --- |
| `importSources` | JSON、JS、远程文本或文件输入；导入选项 | 原文、规范化候选、诊断与冲突信息 | package 解释；应用确认并保存 |
| `diagnoseSource` | 原文或编辑候选 | 字段、规则、能力诊断 | package；编辑器展示 |
| `listExploreKinds` | 书源、会话上下文 | 分类列表与诊断 | package 解释；应用选择 |
| `explore` | 书源、选定分类 URL、页码、`infoMap` 快照 | 本页 `SearchBook[]` 与诊断 | package |
| `searchOne` | 书源、关键字、页码 | 本源 `SearchBook[]` 与诊断 | package |
| `searchMany` | 已排序的书源快照、关键字、页码、精准条件 | 合并结果、进度与分源错误 | package 编排；应用选范围 |
| `getBookInfo` | 书源、已有书籍快照 | 更新后的书籍结果与变更描述 | package 计算；应用提交 |
| `getChapterList` | 书源、书籍快照、刷新选项 | 章节列表与目录元数据变更 | package 计算；应用提交 |
| `getContent` | 书源、书籍、章节、下一章 URL | 正文与可保存的元数据变更 | package 计算；宿主保存 |
| `checkSources` | 用户选择的书源快照、校验配置和关键字 | 分源校验状态、进度、诊断和可提交状态变更 | package 执行；应用保存结果 |

上述能力复用 [模型](../reference/source-schema.md)、[宿主](../reference/runtime-host-interfaces.md) 和 [状态契约](../reference/state-and-effects.md)。编辑预览调用同一入口，使用临时会话，不提交用户状态。

每个入口都接受不可变书源快照、`operationId`、预算和取消信号。成功返回可以是 `success` 或合法空结果 `empty`；存在已归一化部分结果时使用 `partial`；规则/网络/存储失败使用 `failed`；取消、版本过期、外部提交未知和能力缺失分别使用 `cancelled`、`stale`、`unknown`、`capability-missing`。入口必须返回或抛出稳定的 `code`/`stage`，不能用 `[]`、`null` 或 HTTP 状态单独表达失败。

## 公共调用协议

运行时工厂持有不可变 parser 配置；每个异步入口接收 `CallContext` 与操作输入，返回 `OperationResult<T>`，致命失败抛出带稳定 code/stage 的 SourceRuntimeError。CallContext 包含 requestId、operationId、sessionId、不可变 SourceSnapshot（sourceId/sourceRevision/source/userState）、signal、预算及当前宿主视图；sessionId 由宿主认证注入。规范名称见[运行时统一契约](../reference/runtime-contracts.md)。

OperationResult 包含 `status`、value（各入口下表结果）、diagnostics、effects（见[状态与副作用](../reference/state-and-effects.md)）、changes（尚未提交的领域变更）、operationId、sourceRevision 和 `cleanup`。成功空列表与失败不同；多源/批量返回分项状态，致命取消错误仍携带已经提交的 effects，不伪造全批回滚。`cleanup.status=complete` 只在请求、脚本、监听器和变量视图都已结算后返回；取消入口返回不等于资源已经释放。

公开结果的最小形状为：

```ts
interface PublicOperationResult<T> {
  status: 'success' | 'empty' | 'partial' | 'failed' | 'cancelled' | 'stale' | 'unknown' | 'capability-missing'
  value?: T
  diagnostics: RuntimeDiagnostic[]
  effects: EffectRecord[]
  changes: DomainChange[]
  idempotencyKey?: string
  operationId: string
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}
```

`changes` 每项包含资源身份、baseRevision、允许更新字段及目标值，结构见[运行时统一契约](../reference/runtime-contracts.md#结果与错误)的 `DomainChange`；应用按 expectedSourceRevision compare-and-set 提交。`unknown` 表示外部提交是否完成无法确认，不能自动按失败重试。DOM、Set、脚本句柄、AbortSignal、宿主对象不得进入 HTTP DTO。DTO 使用普通对象、数组和字符串；bytes 由独立二进制响应返回，不能 JSON 字符串化为正文。

| 入口补充 | 输入 | 输出与边界 |
| --- | --- | --- |
| exportSource | RawSource 与明确字段修改、json/javascript 格式 | 文本与诊断；不丢未知字段，不执行脚本 |
| evaluateRule | 规则、输出模式、脱敏输入与规则上下文 | typed value 与 trace；只在提供宿主能力时执行 JS |
| planRequest | URL 规则、page/key/baseUrl 与会话视图 | 请求计划与诊断；需要 JS/状态时有相应副作用，不宣称纯函数 |
| previewSource | 候选源、操作名、固定响应或显式网络选项 | 相同领域结果及逐步 trace；临时命名空间 |
| refreshSubscription | 订阅 revision/baseline、本地快照 | [订阅流程](../workflows/source-subscriptions.md)定义的 diff 与提交计划，不调度、不保存 |
| getContentBatch | 源、Book、带 tocRevision 的章节列表 | 每章 saved/stale/failed/unfilled、效果记录及剩余章节；不重复保存成功章 |
| getReviewSummary | Book、Chapter | ReviewParagraph[]，空摘要合法；读取分支见[段评流程](../workflows/review-flow.md) |
| getReviewDetail | Book、Chapter、paraIndex/paraData/page | ReviewPage；声明式入口保留游标校验，JS 缺失必需函数返回 capability-missing/failed，空返回仍是合法空页 |
| getReviewReplies | 上述输入加 reviewId | `status=empty` 的 ReviewPage；JS 未声明可选函数时在 diagnostics 标记 capability-missing，声明式和 JS 的分页规则不同 |
| openLegacyReview | 书籍、章节、旧式 `url/index/src`、frame origin | 旧式页面会话的 `id`/`nonce` 与页面元数据；受支持的 `getDP/getZP` 脚本走浏览器桥接，不转换为结构化 ReviewPage |
| legacyReviewPage | 会话 `id`、`nonce` | 受 CSP/sandbox 保护的旧式页面；会话无效或过期返回明确错误 |
| runLegacyReview | 会话 `id`、不超过 64 KiB 的脚本 | HTML 或带 `html` 的 JSON 结果，继续执行图片重写；书源变更、nonce 错误和脚本错误不返回空评论 |
| decodeImage | Book、src、bytes、isCover | `BinaryReference` 或解码错误；无规则原样返回，原始 bytes 只通过独立二进制响应返回 |
| resolveDownload | 文件源及 Book | 详情规则生成的下载地址列表；实际文件写入由宿主负责 |
| executeSourceAction | pay 或已知 event 名、Book/Chapter、用户确认及操作身份 | open-url/refresh-toc/intercept-default/continue-default；未知事件拒绝，写入不自动重试 |
| getLoginForm / submitLogin | 源、挑战身份、表单输入 | 登录表单/挑战/认证结果；低优先级，完整动态参数未核实前报能力缺失 |
| inspectCapabilities | 源快照及宿主报告 | required/supported/missing/dynamicUnknown；动态 JS 不能靠静态扫描保证全部依赖 |

单源搜索输入 key/page；多源额外接收有序 SourceSnapshot[]、precision 和 SearchResultSink。详情接收 canReName；目录接收旧目录、tocRevision 与刷新选项；正文接收 tocRevision、nextChapterUrl 或目录快照及 needSave（默认 false），缓存读取条件和 Android-compatible 差异见[正文流程](../workflows/content-flow.md)。分页 page 为一基正整数；不合法输入在网络前失败。searchMany 每源返回 success/empty/failed/cancelled 状态，全部失败与全部成功但无匹配分别表达。

事件通过调用方订阅器接收：`start`、`progress`、`source-success`、`source-error`、`completed`、`cancelled`、`saved`；包含 operationId、递增序号和 page/source owner。`completed` 与 `cancelled` 互斥，终态事件只能发布一次；重复或迟到事件按 operationId/version 丢弃。订阅异常不能阻断核心。只有 sink/ContentStore 确认后发布相应保存事件；completed 不表示应用已提交 changes。所有入口结束前等待本次资源关闭。

## 创建运行时与单次调用

应用启动时可准备无用户状态的解析器和宿主工厂。每次用户操作再创建独立调用上下文，其中至少包含 `requestId`、书源身份、用户或匿名会话身份、能力集合、取消信号和脱敏日志器。Cookie、书源变量、JS scope、当前 `Book` 与章节状态属于调用或会话，不属于可跨用户共享的运行时单例。

```text
应用读取书源快照与用户输入
  -> 按 enabled、enabledExplore、分组或用户选择确定范围
  -> 创建本次 RuntimeHost 视图与 AbortSignal
  -> 调用 package 的公开能力
  -> 处理进度、结果、诊断和结构化错误
  -> 核对本次请求仍是当前请求
  -> 按结果中的变更描述提交应用数据或正文缓存
  -> 等待请求、脚本、监听器和变量视图释放
```

应用持有书源配置及版本，package 接受一次调用使用的不可变书源快照。用户编辑并保存书源后，新调用使用新版本；旧调用的结果不得覆盖新版本的缓存或用户数据。应用保存源时，以 `bookSourceUrl` 识别同一书源，执行导入冲突策略和原文保留策略，详见 [导入协议](../workflows/import-protocol.md) 与 [书源编辑器规划](source-editor.md)。

## 一个应用操作如何串接书源处理

1. 用户导入书源。应用把原文交给 package 解析和诊断，展示候选与冲突；用户确认后应用写入书源存储。
2. 用户搜索或选择发现分类。应用读取已保存的书源快照并确定范围；package 返回搜索或发现结果。应用按 `searchId`、分类身份和页码接收当前结果。
3. 用户打开一本书。应用保留书源身份和 `bookUrl`，调用详情入口；需要章节时调用目录入口，并在成功后提交目录变更。
4. 用户打开章节。应用先检查与书源版本和章节身份匹配的正文缓存；未命中时调用正文入口。正文写入通过版本 token 检查，旧请求不得覆盖新内容。
5. 用户编辑书源。编辑器通过同一个导入 codec、诊断器和预览入口工作；保存后应用递增版本并失效相关分类、搜索、目录和正文缓存。
6. 用户或系统检测书源。应用读取当前用户的不可变快照，调用 `checkSources`，把阶段进度和诊断写入 `SourceCheckRepository`；检测不写入书籍/章节/正文，旧版本结果不得回写。
7. 订阅到期时，应用调度刷新任务；package 解析多个候选并生成三方差异，应用确认或按安全的静默策略提交，失败保留旧 baseline。

这条链路只描述书源相关操作。书架、阅读器展示和阅读进度属于后续应用设计，但应用需要保存足够的书源、书籍和章节身份，才能再次调用详情、目录和正文入口。

书源管理本身也是应用的一条调用链：应用先以当前用户读取源快照，再调用 package 生成导入候选、差异或校验计划；只有用户确认且版本比较成功后，Repository 才提交。package 不接收 Supabase client，也不直接写入用户数据库。保存、更新、删除和校验状态的具体副作用见 [书源持久化流程](../workflows/source-persistence-flow.md) 和 [书源校验流程](../workflows/source-check-flow.md)。

## Node、Edge 与框架接入

SPA 通过服务端 API 使用 package；Node 服务、Next.js 服务端入口或 React Router 服务端入口都应调用同一公开能力，而不是各自解释规则。`Edge` 是候选运行环境，不能仅凭 TypeScript 类型相同就认为可用：适配器要逐项验证脚本隔离、同步 JS 兼容外观、HTML/XPath/JSONPath 解析、Cookie 存储、请求时长、响应大小和持久化能力。缺少能力时返回可识别的 capability error，或把该操作交给具有所需能力的服务端运行环境。

服务端边界负责校验可访问的书源和目标地址、限制请求资源、隔离会话、转换稳定错误码，并且只向浏览器返回脱敏领域结果。部署选择改变宿主实现，不改变 package 的规则语义。部署前用同一套 fixture 验证实际宿主；详细的宿主要求见 [Node、浏览器和 Next.js](node-browser-nextjs.md)。

## package 维护约定

- 对外区分原始书源格式版本、规则语义版本和 package API 版本。规则行为修正若会改变已有书源结果，需要兼容测试和显式迁移说明。
- 未识别的书源字段由 codec 保留；支持状态由兼容矩阵和运行时能力报告决定，不因导入成功就宣称可执行。
- 每个公开入口都要有成功、空结果、规则错误、宿主失败、取消和资源清理样本；组合测试应从公开入口执行，不只测试内部解析器。
- Node、Edge 或框架适配器使用相同的公开入口和 fixture；只有实际通过的宿主能力才能标记为已验证。
