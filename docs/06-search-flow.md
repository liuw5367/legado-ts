# 搜索流程

## 入口和分流

单书源搜索由 `WebBook.searchBookAwait` 进入：

- `mainJs` 非空：调用 JS 源顶层 `search(key, page)`；
- 声明式源：要求 `searchUrl` 非空，使用 `AnalyzeUrl(searchUrl, key, page)` 请求，再使用 `BookList.analyzeBookList` 解析。

多书源搜索由 `SearchModel` 管理书源范围、并发和进度。当前每个书源有 30 秒超时，工作数受全局线程数和最大线程数限制；单个书源失败记录日志，不应阻塞其他书源结果。

## 声明式搜索解析

1. 以响应最终 URL设置 `AnalyzeRule.baseUrl` 和 `redirectUrl`；
2. 若 `bookUrlPattern` 与响应 URL匹配，把整个响应当作详情页，直接执行详情规则；
3. 否则使用 `ruleSearch` 的 `bookList` 获取元素列表；
4. `bookList` 以 `-` 开头表示解析后反转，以 `+` 开头表示去掉控制前缀但不反转；
5. 对每个元素执行 `name`、`author`、`kind`、`intro`、`wordCount`、`lastChapter`、`coverUrl`、`bookUrl`；
6. 书名为空丢弃；作者、简介等字段按各自字段错误策略处理；
7. 相对封面和详情 URL按响应 URL转绝对 URL；详情 URL为空时回退响应 URL；
8. 同书源内按 `SearchBook.bookUrl` 去重；
9. 列表为空且没有 `bookUrlPattern` 时，回退为详情页解析。

发现流程相同，但优先使用 `ruleExplore`；`ruleExplore.bookList` 为空时回退搜索规则。发现 URL可以携带 `infoMap`。

## 多书源合并

`SearchModel` 收到每个书源结果后分为四组：

1. 书名或作者精确等于搜索词；
2. 分类包含搜索词；
3. 书名或作者包含搜索词；
4. 非精准搜索时保留的其他结果。

同组中书名和作者都相同时合并来源，保留首次条目并向其 `origins` 加入其他书源。组内按来源数量降序，最终按精确、分类、包含、其他顺序输出。精准搜索只允许名称、作者或分类包含关键字的结果进入流程；分类命中会进入第二组，而不是被精准搜索丢弃。

## 失败和空值

- 搜索 URL为空：该书源直接失败；
- 响应 body为空：该书源失败；
- 规则列表为空但可识别详情页：按详情页解析；
- 单个字段规则失败：保留书名后继续，字段为空；
- 所有书源未返回结果：流程正常结束并标记空结果；
- 取消搜索：终止当前 page owner 和工作池，迟到的回调不能重新发布结果。

## 迁移验收

必须分别测试详情页搜索、列表搜索、`+/-` 列表前缀、相对 URL、空书名、列表回退、同源去重、跨源合并、精准搜索、30 秒超时和取消后迟到结果。原项目的 `SearchPaginationContractTest` 已固定 page owner 的注册、完成、取消和回调顺序。
