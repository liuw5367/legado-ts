# source-core 工作流

工作流实现位于 [`workflows/`](../src/workflows/)，入口从 [`src/index.ts`](../src/index.ts) 导出。它们只处理单源规则和结果编排；多源调度、用户状态、书架、鉴权、删除和应用提交属于 `apps/`。

## 发现、搜索和详情

`discoverBooks(ports, input)` 使用 `DiscoveryInput` 的 source、cursor、signal 和 budget 执行发现规则；`searchBooks(ports, input)` 还接收 keyword、可选纯候选过滤和提前停止回调。二者返回 `RuntimeResult<WorkflowPage<BookCandidate>>`：

- 每个候选保留 `sourceId`、`bookUrl`、`rawFields` 和 `traceRef`；名称、作者、分类等来源缺失时保持缺失；
- `PageCursor.index` 是书源页码，`nextCursor` 只在后续地址会变化时出现；
- `groupSearchCandidates`、`searchMatchRank`、`isBookTitleMatch` 和 `isAuthorMatch` 是不访问网络的纯归并函数；
- 取消、空页、重复候选、规则失败和宿主能力缺失都进入 `diagnostics`，不把失败伪装为空列表。

`loadBookDetails(ports, input)` 接受候选列表和 `canReName`，返回 `BookMetadata` 页面。详情临时的 `infoPage`/`tocHtml` 只供当前工作流使用，应用保存时必须丢弃临时响应正文。

## 目录

`loadTableOfContents(ports, input)` 使用 `TocInput` 的 book、refresh、cursor、maxPages、maxBytes、`runPerJs`、`isFromBookInfo` 和 `tocCountWords`：

1. 按书源规则请求目录页，执行分页和目录规则；
2. 归一化 `ChapterIdentity`，保留原始 URL、baseUrl、index、volume、VIP/pay、resourceUrl 和 rawFields；
3. 按顺序、去重、卷节点和章节范围生成 `TocPage.items`；
4. 目录脚本修改书籍时，通过 `TocPage.bookAfter` 返回快照，应用决定是否按 source revision 保存。

`reconcileTableOfContents` 是纯函数，负责应用层已有目录与新目录的变更计算；source-core 不写书籍 Repository。卷节点不请求正文，章节身份不能只由标题生成。

## 正文与 cache-first

`loadChapterContent` 接受 `ContentInput`，执行详情复用、正文分页、`sourceRegex`/WebView 提示、替换、HTML 清洗、图片资源和 `subContent`。返回 `ChapterContent`，包括 `raw`、`cleaned`、`pages`、`resources`、最终响应 URL、可选标题、图片和歌词/弹幕 auxiliary。该入口纯粹解析，不读写 ContentStore。

`loadStoredChapterContent` 是 cache-first 编排：

1. 用 `ContentIdentity` 读取 `ContentStore`；有效命中时不请求网络；
2. 未命中或 `refresh=true` 时运行 `loadChapterContent`；
3. 用 `ContentSaveToken` 条件提交正文、最终 URL、章节元数据和附加资源；
4. 提交后重新读取，若宿主返回 `stale`、`rejected` 或 `unknown`，不覆盖较新内容，结果仍可带 `partial`/`cache-failed` 诊断。

应用提供 `ContentStore` 和正文身份，core 不负责文件/数据库、书架、阅读进度或凭据。

## 批量正文

`loadChapterContentBatch` 只接收调用方已经筛出的章节，忽略卷节点，按配置分组运行普通 `contentBatch` 或 JS `getContentBatch(chapters, book)`。每次脚本最多接收 50 章；批量成功后通过 `cacheContent(chapter, content)` 交给应用保存。缺少批量函数、脚本失败或未回存的章节单章兜底；宿主回调返回 `false` 时 core 不再覆盖该章。

返回 `ChapterContentBatchResult` 的 items 保留输入顺序，`via` 为 `batch`、`single` 或 `none`，`saved` 只有宿主确认写入时才为 true。没有 `cacheContent` 时跳过批量脚本并返回单章解析结果，不写缓存。

## 图片解密与章节导航

`decodeImage` 接受调用方已下载的 bytes、src、source、book、`isCover` 和可选 JavaScript budget；它只执行 `coverDecodeJs` 或 `imageDecode`，不下载图片，失败时不返回原密文。`nextChapterUrlFor` 只计算下一章地址，不触发网络。

## 应用边界和结果

所有入口都返回 `RuntimeResult<T>`，状态为 `success`、`partial`、`empty`、`failed`、`cancelled` 或 `capability-missing`。应用必须按状态处理合法空结果、取消、未支持能力、缓存提交状态和版本冲突。`ReaderApplication.search`、`checkSources`、多源 fan-out、进度事件和页面提交不是 source-core 工作流。

共享业务顺序和 Android 页面事实分别见 [`docs/flows`](../../../docs/flows/README.md) 与 [`docs/upstream/android/README.md`](../../../docs/upstream/android/README.md)；跨端证据和缺口见[兼容性与验证](../../../docs/compatibility/README.md)。

## 相关测试

| 主题 | 现有测试 |
| --- | --- |
| 搜索归并、详情、目录、正文 | `tests/workflows.test.ts`、`reading.test.ts`、`reading-batch.test.ts` |
| 目录身份和下一章 | `tests/toc-reconcile.test.ts`、`chapter-navigation.test.ts` |
| 请求/规则/图片 | `tests/source-request.test.ts`、`request-url.test.ts`、`rules.test.ts`、`font.test.ts` |
| 真实源和跨端 fixture | `tests/source-fixtures.test.ts`、`source-conformance.test.ts`；执行状态见兼容性目录 |
