# 搜索流程

## 入口和分流

单书源搜索由 `WebBook.searchBookAwait` 进入：

- `mainJs` 非空：调用 JS 源顶层 `search(key, page)`；
- 声明式源：要求 `searchUrl` 非空，使用 `AnalyzeUrl(searchUrl, key, page)` 请求，再使用 `BookList.analyzeBookList` 解析。

多书源搜索由 `SearchModel` 管理书源范围、并发和进度。当前每个书源有 30 秒超时，工作数受全局线程数和最大线程数限制；单个书源失败记录日志，不应阻塞其他书源结果。

## 声明式搜索解析

1. 以响应最终 URL 设置 `AnalyzeRule.baseUrl` 和 `redirectUrl`；
2. 若 `bookUrlPattern` 与响应 URL 匹配，把整个响应当作详情页，直接执行详情规则；
3. 否则使用 `ruleSearch` 的 `bookList` 获取元素列表；
4. `bookList` 以 `-` 开头表示解析后反转，以 `+` 开头表示去掉控制前缀但不反转；
5. 对每个元素执行 `name`、`author`、`kind`、`intro`、`wordCount`、`lastChapter`、`coverUrl`、`bookUrl`；
6. 书名为空丢弃；作者、简介等字段按各自字段错误策略处理；
7. 相对封面和详情 URL 按响应 URL 转绝对 URL；详情 URL 为空时回退响应 URL；
8. 同书源内按 `SearchBook.bookUrl` 去重；
9. 列表为空且没有 `bookUrlPattern` 时，回退为详情页解析。

发现流程相同，但优先使用 `ruleExplore`；`ruleExplore.bookList` 为空时回退搜索规则。发现 URL 可以携带 `infoMap`。

## 多书源合并

`SearchModel` 收到每个书源结果后分为四组：

1. 书名或作者精确等于搜索词；
2. 分类包含搜索词；
3. 书名或作者包含搜索词；
4. 非精准搜索时保留的其他结果。

同组中书名和作者都相同时合并来源，保留首次条目并向其 `origins` 加入其他书源。组内按来源数量降序，最终按精确、分类、包含、其他顺序输出。精准搜索只允许名称、作者或分类包含关键字的结果进入流程；分类命中会进入第二组，精准搜索不应丢弃该结果。

## 数据流和生命周期

搜索输入由带所有权的请求上下文构成，不能只传入一条 URL：

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
  /** 已按搜索范围确定顺序的书源快照。 */
  sources: BookSource[]
  /** 是否启用名称、作者和分类的精准过滤。 */
  precision: boolean
  /** 取消本次搜索、请求和回调的信号。 */
  signal?: AbortSignal
}

export interface SearchResultSink {
  /** 在发布 source-success 前保存本次书源结果；不需要持久化时由上层提供内存实现。 */
  save(items: SearchBook[], request: SearchRequest): Promise<void>
}
```

处理阶段固定为：

1. 创建请求上下文，清理同一调用方旧的 `searchId`，清空上一轮合并列表；没有关键字或启用书源为空时直接结束并报告取消或空范围。
2. 为每个书源创建子任务。子任务先等待暂停状态，再执行 URL 展开、网络请求、登录检测和声明式/JS 解析；单个书源的失败记录阶段错误，不阻断其他书源。
3. 书源结果先释放临时 HTML，再写入搜索结果存储，随后执行同源去重和跨源合并。Android 是先写入 `searchBookDao` 再发布成功回调，独立库通过 `SearchResultSink` 暴露同样的先后关系。
4. 每次合并后的快照都带 `searchId` 和 `page` 发布，调用方只能接收当前 `pageOwner` 的事件；旧请求的迟到结果不能覆盖新请求。
5. 所有子任务结束后发布完成事件，携带 `isEmpty` 和 `hasMore`；取消时只发布取消事件，不能把取消伪装成正常空结果。

状态转换为 `created -> running -> paused -> running -> completed`，异常取消为 `running/paused -> cancelled`。换页沿用同一个 `searchId` 并递增 `page`；新关键字创建新的 `searchId`，先取消旧请求。多书源任务的并发完成顺序影响中间回调时机，但最终合并规则和同一快照内的排序必须稳定。

事件顺序必须满足：正常请求为 `start -> progress/source-success* -> finish`，取消请求为 `start -> cancel`；`source-success` 发生前必须完成结果归一化和存储。资源清理包括子任务、并发池、暂停等待、AbortSignal 监听和进度报告器，必须在成功、失败、取消和超时路径执行。

## 失败和空值

- 搜索 URL 为空：该书源直接失败；
- 响应 body 为空：该书源失败；
- 规则列表为空但可识别详情页：按详情页解析；
- 单个字段规则失败：保留书名后继续，字段为空；
- 所有书源未返回结果：流程正常结束并标记空结果；
- 取消搜索：终止当前 page owner 和工作池，迟到的回调不能重新发布结果。

书源级失败不能写入成功结果；但已经成功的其他书源结果仍然可以发布。全局错误只用于请求上下文失效、结果存储失败或资源清理失败等流程级问题。实现时必须区分 `source-error`、`empty-result`、`cancelled` 和 `storage-error`，上层据此决定提示、重试或继续展示已有结果。

## 迁移验收

必须分别测试详情页搜索、列表搜索、`+/-` 列表前缀、相对 URL、空书名、列表回退、同源去重、跨源合并、精准搜索、30 秒超时和取消后迟到结果。原项目的 `SearchPaginationContractTest` 已固定 page owner 的注册、完成、取消和回调顺序。
