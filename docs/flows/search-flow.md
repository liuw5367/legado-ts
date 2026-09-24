# 搜索流程

## 入口和分流

单书源搜索由 `WebBook.searchBookAwait` 进入：

- `mainJs` 非空：调用 JS 源顶层 `search(key, page)`；
- 声明式源：要求 `searchUrl` 非空，使用 `AnalyzeUrl(searchUrl, key, page)` 请求，再使用 `BookList.analyzeBookList` 解析。

多书源搜索由 `SearchModel` 管理书源范围、并发和进度。当前每个书源有 30 秒超时，工作数受全局线程数和最大线程数限制；每个书源在 `mapParallelSafe` 中执行，单书源异常被其内部 catch 吞掉，结果不写入 `searchBookDao`，也不阻塞其他书源。

## 声明式搜索解析

1. 以响应最终 URL 设置 `AnalyzeRule.baseUrl` 和 `redirectUrl`；
2. 若 `bookUrlPattern` 与响应 URL 匹配，把整个响应当作详情页，直接执行详情规则；
3. 否则使用 `ruleSearch` 的 `bookList` 获取元素列表；
4. `bookList` 以 `-` 开头表示解析后反转，以 `+` 开头表示去掉控制前缀但不反转；
5. 对每个元素执行 `name`、`author`、`kind`、`wordCount`、`lastChapter`、`intro`、`coverUrl`、`bookUrl`；书名和作者分别先经过 `formatBookName`/`formatBookAuthor` 清洗（规则见[书源数据模型](../standard/source-schema.md#书名和作者清洗)）；
6. 清洗后的书名为空丢弃；作者、简介等字段按各自字段错误策略处理；
7. 相对封面和详情 URL 按响应 URL 转绝对 URL；详情 URL 为空时回退响应 URL；
8. 同书源内按 `SearchBook.bookUrl` 去重；
9. 列表为空且没有 `bookUrlPattern` 时，回退为详情页解析。

工作流展开 `searchUrl` 时按 Android `AnalyzeUrl.replaceKeyPageJs` 的语义处理 `{{...}}`：已知替换项（`{{key}}`、运行时别名 `{{keyword}}`、`{{page}}`、`{{pageIndex}}`、`{{source.bookSourceUrl}}`）注入原值，非 ASCII 字符由请求层按 URL 规范编码；纯页码算术（如 `{{(page-1)*10}}`）直接求值；其余片段按内联 JavaScript 交给规则宿主求值，结果为 null/undefined 时展开为空串（例如清 Cookie 惯用法 `{{cookie.removeCookie(source.getKey())}}`）。宿主没有 JavaScript 能力或求值失败时，本次请求以 `capability-missing`/`rule-failed` 诊断失败，不把 `{{...}}` 字面量拼进地址。首页页码与 Android `SearchModel` 一致从 1 开始，`searchPageStart`/`explorePageStart` 只是可选覆盖项。列表字段读取兼容 Android 的 `name`、`author`、`coverUrl`、`intro`、`kind`、`wordCount` 与内部历史别名 `bookName`、`bookAuthor`、`bookCoverUrl`、`bookIntro`、`bookKind`、`bookWordCount`。

发现列表复用 `BookList` 的字段解析，但它还有独立的分类入口、选定 URL、`infoMap` 和取消边界。详见 [发现流程与分类规则](explore-flow.md)。

## Android 多书源合并

`SearchModel` 收到每个书源结果后分为四组：

1. 书名或作者精确等于搜索词；
2. 分类包含搜索词；
3. 书名或作者包含搜索词；
4. 非精准搜索时保留的其他结果。

同组中书名和作者都相同时合并来源，保留首次条目并向其 `origins` 加入其他书源。精确、分类、包含三组各自按来源数量降序，其他组不排序直接追加；最终按精确、分类、包含、其他顺序输出。精准搜索只允许名称、作者或分类包含关键字的结果进入流程；分类命中会进入第二组，精准搜索不应丢弃该结果。

## TypeScript 当前聚合行为

`reader-cli` 负责多书源 fan-out、并发、进度和到达顺序；`source-core` 的 `groupSearchCandidates` 执行候选归并和匹配排序，CLI 再把核心分组映射成包含 `SourceEntry` 的页面数据。当前核心行为保持 CLI 原有结果不变：

- 书名和作者都非空时，按规范化后的“书名+作者”跨来源归并；若书名或作者缺失，则按 `sourceId+bookUrl` 区分版本。首次到达的候选作为分组代表。
- 书名先做 NFKC、转小写并移除空白/标点/符号；作者做 NFKC、转小写并移除空白。作者标点会保留。
- 匹配等级只看书名：`exact`、`contains`、`other`。先按等级排序，同等级按分组中最早候选的 `arrivalIndex` 稳定排序，不按来源数量排序。
- 普通 CLI 搜索保留 `other` 结果，不应用 Android 的精准搜索过滤；`searchMoreSources` 才会要求规范化后的书名和作者都完整匹配。

Android 的分类命中、作者参与相关性、精准搜索过滤和来源数量排序尚未成为 TypeScript 搜索的当前行为。后续采用这些规则时，应单独调整核心聚合与页面交互；本次职责整理只把现有 CLI 规则迁入 `source-core`。

## 数据流和生命周期

搜索输入由带所有权的请求上下文构成，不能只传入一条 URL。下述 `SearchRequest` / `SearchResultSink` / `SearchSourceStatus`（含 `stale`、`storage-error`）是**目标设计**；当前实现入口为 `searchBooks`（接受 `SearchInput`，返回 `RuntimeResult`），状态词汇见 [包使用与当前导出](../implementation/package-usage.md)，差异见 [已知差异](../divergence/known-divergences.md)：

```ts
export interface SearchRequest {
  /** 当前 HTTP 或预览请求的身份，用于日志、变量和资源隔离。 */
  requestId: string
  /** 用于区分同一页面的重试、换页和新搜索。 */
  searchId: string
  /** 用户输入的关键字，传给书源 URL 或 JS 函数。 */
  key: string
  /** 从 1 开始的页码。 */
  page: number
  /** 已按搜索范围确定顺序的不可变书源快照。 */
  sources: ReadonlyArray<{
    source: BookSource
    sourceRevision: string
  }>
  /** 是否启用名称、作者和分类的精准过滤。 */
  precision: boolean
  /** 取消本次搜索、请求和回调的信号。 */
  signal?: AbortSignal
}

export interface SearchResultSink {
  /** 在发布 source-success 前保存本次书源结果；不需要持久化时由上层提供内存实现。 */
  save(items: SearchBook[], request: SearchRequest): Promise<void>
}

export type SearchSourceStatus =
  | 'source-success'
  | 'empty-result'
  | 'source-error'
  | 'cancelled'
  | 'stale'
  | 'capability-missing'
  | 'storage-error'

export interface SearchSourceResult {
  sourceId: string
  status: SearchSourceStatus
  items: SearchBook[]
  error?: { code: string; message: string; canRetry: boolean }
  operationId: string
}

export interface SearchResult {
  /** 最终合并结果的可判别状态；逐源状态保留在 sourceResults。 */
  status: OperationStatus
  searchId: string
  operationId: string
  /** 结果基于的书源快照版本；多源搜索可按 sourceResults 分别记录。 */
  sourceRevision?: string
  page: number
  items: SearchBook[]
  sourceResults: SearchSourceResult[]
  isEmpty: boolean
  hasMore: boolean
  diagnostics: RuntimeDiagnostic[]
  /** 尚未由应用提交的搜索结果变更。 */
  changes: DomainChange[]
  /** 已发生的搜索 sink、Cookie 或变量副作用。 */
  effects: EffectRecord[]
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}

export interface SearchEvent {
  /** 与 package-usage 约定一致；source-error 和 saved 都是正式事件。 */
  type: 'start' | 'progress' | 'source-success' | 'source-error' | 'completed' | 'cancelled' | 'saved'
  operationId: string
  sequence: number
  searchId: string
  page: number
  pageOwner: string
  source?: SearchSourceResult
  items?: SearchBook[]
  isEmpty?: boolean
  hasMore?: boolean
  diagnostics?: RuntimeDiagnostic[]
}
```

处理阶段固定为：

1. 创建请求上下文，清理同一调用方旧的 `searchId`，清空上一轮合并列表；空关键字直接以合法空结果结束，不自动发布取消事件；启用书源为空时进入空范围分支并发布带 `pageOwner` 的完成事件。
2. 为每个书源创建子任务。子任务先等待暂停状态，再执行 URL 展开、网络请求、登录检测和声明式/JS 解析；单个书源的失败记录阶段错误，不阻断其他书源。
3. 书源结果先释放临时 HTML，再写入搜索结果存储，随后执行同源去重和跨源合并。Android 是先写入 `searchBookDao` 再发布成功回调，独立库通过 `SearchResultSink` 暴露同样的先后关系。
4. 每次合并后的快照都带 `searchId` 和 `page` 发布，调用方只能接收当前 `pageOwner` 的事件；旧请求的迟到结果不能覆盖新请求。
5. 所有子任务结束后发布完成事件，携带 `isEmpty` 和 `hasMore`；取消时只发布取消事件，不能把取消伪装成正常空结果。某源保存完成后再发布 `saved`，保存失败发布带 `storage-error` 的 `source-error`。

状态转换为 `created -> running -> paused -> running -> completed`，异常取消为 `running/paused -> cancelled`。换页沿用同一个 `searchId` 并递增 `page`；新关键字创建新的 `searchId`，先取消旧请求。多书源任务的并发完成顺序影响中间回调时机，但最终合并规则和同一快照内的排序必须稳定。

事件顺序必须满足：正常请求为 `start -> progress/source-success/source-error/saved* -> completed`，取消请求为 `start -> cancelled`；`source-success` 发生前必须完成结果归一化，`saved` 只在 sink 确认后发布。所有事件携带同一 `operationId` 和递增 `sequence`，旧 `pageOwner` 的事件必须丢弃。资源清理包括子任务、并发池、暂停等待、AbortSignal 监听和进度报告器，必须在成功、失败、取消和超时路径执行。

## 失败和空值

- 搜索 URL 为空：该书源直接失败；
- 响应 body 为空：该书源失败；
- 规则列表为空但可识别详情页：按详情页解析；
- 分类、字数、最新章节、简介、封面字段规则失败：保留书名后继续，字段为空；书名、作者、详情链接失败会向上传播，导致该书源失败；
- 所有书源未返回结果：流程正常结束并标记空结果；
- Web 结果另外携带每源状态：全部请求失败与全部成功但无匹配不能只用同一个 isEmpty 表达；
- 取消搜索：终止当前 page owner 和工作池，迟到的回调不能重新发布结果。

书源级失败不能写入成功结果；但已经成功的其他书源结果仍然可以发布。全局错误只用于请求上下文失效、结果存储失败或资源清理失败等流程级问题。实现时必须区分 `source-error`、`empty-result`、`cancelled` 和 `storage-error`，上层据此决定提示、重试或继续展示已有结果。`isEmpty=true` 只能表示最终没有可展示项目，不能抹掉逐源状态。

## 迁移验收

必须分别测试详情页搜索、列表搜索、`+/-` 列表前缀、相对 URL、空书名、列表回退、同源去重、跨源合并、精准搜索、30 秒超时和取消后迟到结果。原项目的 `SearchPaginationContractTest` 已固定 page owner 的注册、完成、取消和回调顺序。

Web 调用中 searchId 是一次查询会话身份，operationId 是一次页调用身份；核心只管理本次子任务，应用显式取消上一操作，不通过模块级“当前搜索”取消其他用户。输入 `sources` 使用不可变快照数组，保留 `source` 和 `sourceRevision`；兼容 Android 的 `BookSource[]` 只能作为进入核心前的运行时投影。完成清理只释放请求视图，不清除会话状态。多源最终同分排序保持原合并规则，不新增字母排序；跨源到达次序影响“首次条目”，测试应固定调度。
