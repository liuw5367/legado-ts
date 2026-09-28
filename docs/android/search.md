🥷 本文记录 Android 搜索页面从输入到书源请求、解析、合并和显示的完整行为，作为 `apps/` 搜索实现的主要对照。

# 搜索页面

## 入口和命令状态

入口是 `ui/book/search/SearchActivity.kt`，核心状态由 `SearchViewModel` 和 `model/webBook/SearchModel.kt` 持有。

1. 提交输入时先 `trim()`，保存搜索历史，清空旧命令的 `searchKey`，再创建新的命令。
2. 输入变化会停止当前搜索并更新历史提示，但不会因为每次输入变化都请求网络。
3. 新关键字会取消旧 Job、清空结果、重置 `hasMore=true`。
4. 用空字符串调用搜索只表示继续加载下一页，保留当前关键字、书源快照和内存结果。
5. `SearchPageOwner` 防止同一命令重复注册，并保证上一页完成回调结束后才能启动下一页。

搜索页暂停时调用 `SearchModel.pause()`，恢复时调用 `resume()`。暂停只阻止下一个书源进入 Flow，已经发出的网络请求不会被这个开关中止。

## 搜索范围和书源筛选

| 范围 | 实际查询 | 结果 |
| --- | --- | --- |
| 全部 | `BookSourceDao.allEnabledPart` | `enabled = 1`，按 `customOrder` 排序 |
| 分组 | `getEnabledPartByGroup` | 每个分组只取启用书源，合并并按 URL 去重 |
| 显式单源 | `getBookSourcePart(url)` | 只按 URL 查询，没有 `enabled = 1`，显式入口可以搜索已禁用源 |

分组范围中的不存在分组会被删除。如果范围最后为空，`SearchScope` 自动回退到全部启用书源；全部启用书源仍为空时，回调 `onSearchCancel("启用书源为空")`，不会创建线程池。书源 Part 存在但对应的 `BookSource` 行不存在时，按已完成源跳过。

书源快照只在新关键字开始时生成。搜索进行中修改书源启用状态，不会改变本次快照。`enabledExplore`、`checkStatus`、`respondTime` 和 `weight` 不参与普通搜索筛选。

源码：`ui/book/search/SearchScope.kt:108-142`、`data/dao/BookSourceDao.kt:163-169, 202-203, 248-249`、`model/webBook/SearchModel.kt:56-103`。

## 并发和优先级

搜索源列表先按 `customOrder` 排序，然后进入固定线程池和 `flatMapMerge`：

- 线程池大小为 `min(AppConfig.threadCount, AppConst.MAX_THREAD)`。
- Flow 合并并发数使用配置中的 `threadCount`。
- 每个源最多等待 30 秒。
- 源的返回顺序由网络和规则解析完成顺序决定，不由 `customOrder` 决定。
- 没有“先完成高优先级源，再启动低优先级源”的分层调度。

所以 `customOrder` 只影响候选流的枚举顺序、`originOrder` 元数据和其他换源页面的排序。低顺序源可能先返回，并成为同名同作者结果的字段提供者。

## 单源请求和规则解析

`WebBook.searchBookAwait` 分为两条路径：

- JS 书源调用 `JsSourceBook.searchAwait(bookSource, key, page, filter)`。
- 声明式书源要求 `searchUrl` 非空，使用 `AnalyzeUrl` 填充关键字和页码，发送请求，执行 `loginCheckJs`，检查重定向，再交给 `BookList.analyzeBookList`。

`BookList.analyzeBookList` 的顺序是：

1. body 为空则失败，并把成功响应和原始 body 写入 `Debug`。
2. 搜索响应 URL 匹配 `bookUrlPattern` 时按详情页解析成一个结果。
3. 否则使用搜索列表规则解析书名、作者、分类、详情 URL、封面、简介、最新章节和字数。
4. 列表为空且没有 `bookUrlPattern` 时回退到详情页解析。
5. 书名为空的条目丢弃。
6. 同一源内部按 `bookUrl` 通过 `LinkedHashSet` 去重，规则前缀 `-` 会反转列表。

精准搜索过滤器在书名、作者、分类解析后执行：

```text
name == key 或 author == key 或 kind.contains(key)
```

实际代码使用大小写敏感的 Kotlin `contains`。输入框提交前会去除首尾空白，但不会做作者规范化、书名清洗或标点统一。

源码：`model/webBook/WebBook.kt:53-112`、`model/webBook/BookList.kt:35-150`。

## 跨源比较、去重和排序

`SearchModel.mergeItems` 把已有结果和新批次分成四组：

1. 完全匹配，书名或作者等于关键字。
2. 分类匹配，分类包含关键字。
3. 包含匹配，书名或作者包含关键字。
4. 其他。

同一本书的判断只有一个条件：`name ==` 且 `author ==`。命中后不比较封面、简介、章节、URL 或字数，只在原对象上调用 `addOrigin`，加入来源 URL。第一个到达的结果保留主要字段。

排序为：完全匹配按来源数量降序，分类匹配按来源数量降序，包含匹配按来源数量降序，最后是其他结果的进入顺序。精准搜索开启时，其他结果不加入最终列表。

内存合并键和数据库键不同：

- 内存合并按“书名加作者”。
- `SearchBookDao` 的 `bookUrl` 是数据库主键，重复 URL 写入时使用 `REPLACE`。
- `originOrder` 虽然写入结果，但普通搜索合并不使用它排序。

因此 Android 当前没有按书源优先级保留最完整字段的策略，也没有跨源 URL 规范化。

## 单源失败、降级和进度

`mapParallelSafe` 会捕获单源请求、登录检查、重定向检查、规则解析和 30 秒超时异常。协程没有被取消时，该源不发出结果，其他源继续执行。失败源通常仍然完成进度计数，搜索页面只看到总进度和最终列表，不显示逐源失败原因。

当前没有：

- 自动重试。
- 失败次数统计。
- 自动降权、熔断或禁用。
- 因失败而改变下一页的书源列表。
- 使用 `checkStatus` 或 `respondTime` 过滤搜索源。

`CheckSourceService` 的校验和普通搜索是两条独立路径，校验更新的状态不会自动影响搜索。

## 分页、取消和界面过滤

同一命令加载下一页时，页码递增，结果不清空，全部书源重新请求下一页。`hasMore` 只要看到任意非空批次就为 `true`，不是所有源都有下一页的严格判断。

点击停止或提交新关键字会取消旧 Job、关闭线程池并清理命令。页面销毁时也会关闭搜索模型。

菜单中的“搜索结果过滤”是显示层排除过滤：文本按行拆分、去空白和去重，只要词语在书名、作者或分类中忽略大小写出现，就从界面列表排除。它不重新请求、不改变内存合并结果，也不参与精准搜索。

## 测试证据

- `SearchPaginationContractTest`：分页所有权、重复启动保护、完成回调和取消时序。
- `SearchProgressReporterTest`：并发进度、取消后的回调隔离。
- `SearchCommandGateTest`：旧命令失效。
- `SearchResultFilterTest`：界面排除词行为。
- `SourceNavigationUiTest`：fixture 书源搜索。

尚未看到直接覆盖多个伪造书源的 `SearchModel` 集成测试，尤其是完成顺序、首个字段胜出、30 秒超时、跨源合并和下一页失败行为。`apps/` 端应将请求、过滤、合并器拆开测试。
