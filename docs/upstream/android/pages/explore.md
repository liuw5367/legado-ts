🥷 本文记录 Android 发现页从书源列表到发现结果、分类、分页、错误、书架状态和批量加入书架的完整行为。

# 发现

## 发现源列表

主界面发现入口是 `ui/main/explore/ExploreFragment`。它通过 `BookSourceDao.flowExplore` 监听启用且配置了发现入口的书源，数据库变化时更新列表。页面按数据库 Flow 的顺序展示，不在 UI 层重新按评分排序。

每个发现源项目可以执行以下动作：

- 点击发现入口打开 `ExploreShowActivity`，传入书源 URL、入口标题和发现 URL。
- 点击搜索该书源，打开带指定书源的搜索页。
- 编辑书源。
- 置顶，把 `customOrder` 设置为当前最小顺序减一。
- 删除。删除前弹窗确认，确认后调用 `SourceHelp.deleteBookSource`。
- 使用快速滚动条定位列表。

发现列表的搜索框是本地过滤，不发起网络搜索。输入普通文本调用 `flowExplore(searchKey)`，通常匹配源名称、URL 或发现入口字段，实际匹配规则由 DAO 查询定义。输入 `group:<组名>` 改走 `flowGroupExplore(group)`，只看指定发现分组。

搜索框变化会同时更新分组菜单勾选。输入空白恢复全部发现源。选择“全部”把查询设为空，选择分组把查询设为 `group:<组名>`。如果数据库更新后当前组已不存在，页面清空搜索条件。

## 列表状态、空结果和滚动

列表 Flow 只在页面 `RESUMED` 时收集，使用数据库变化事件和 `conflate`。异常写入 `AppLog`，列表保留上一份数据。空状态只有在结果为空且搜索框也为空时显示，因此搜索无结果时不会同时误显示“没有发现源”。首批项目插入位置为 0 时自动滚到顶部。

页面暂停时清除搜索框焦点，并通知适配器暂停；恢复时重新启用快速滚动条和适配器的 resumed 状态。销毁视图时解绑快速滚动条。

## 发现详情页初始化

`ExploreShowActivity` 将 `exploreName` 设置为标题，`ExploreShowViewModel.initData` 按以下顺序初始化：

1. 从 Intent 或保存状态恢复标题和发现 URL。
2. 从保存状态恢复页码，最小值为 1。
3. 按 `sourceUrl` 查询完整 `BookSource`。找不到时产生“无此书源”错误。
4. 书源加载成功后先请求第一页发现数据。
5. 如果 `showExploreCategories` 开启，再请求发现分类。

保存状态只写标题、发现 URL 和当前页。进程重建后会重新查书源并重新请求数据，已加载的发现书籍列表不写入 Bundle。

## 分类加载和切换

分类调用 `bookSource.exploreKinds()`。只保留 URL 类型、URL 非空且标题不以 `ERROR:` 开头的分类。网络或解析失败只在页面上 Toast，不会阻止第一页结果显示。

分类菜单是一个可切换的设置项。打开后把分类分成最多三行，每行最多约十项的可滚动 Tab。切换 Tab 时：

- 只有目标 URL 与当前分类不同时才触发。
- 清空上下翻页错误。
- `skipPage(1)` 清空已加载书籍，页码回到 1，并发布 loading 状态。
- 重置 RecyclerView 到顶部，然后请求新分类的第一页。

关闭分类只隐藏 Tab，不清除当前分类 URL 或已经加载的结果。重新打开时复用已加载的分类数据。

## 发现请求和分页

请求通过 `WebBook.exploreBook(viewModelScope, source, url, page)`，生产构建超时 60 秒，Debug 构建不设置超时。每次请求先通过 `ExplorePaginationState` 生成递增 request ID：同一时间只允许一个请求，旧请求完成后如果 request ID 已失效会丢弃结果。

有两种请求入口：

- 到达列表底部时调用 `explore()` 请求 `nextPage`，成功后把新结果追加到 `LinkedHashSet`，再把 `nextPage` 加一。
- 从顶部向上翻页或跳转页码时调用 `explore(page)`，成功后把新结果放在旧结果之前，并根据 `prependCount` 修正滚动锚点。

每页成功后先把 `SearchBook` 写入 `searchBookDao`，再在主线程更新 `booksData` 和当前页。追加请求的 `hasMore` 是新列表大小是否增长；向上插入请求沿用之前的 `hasMore`。因此返回空页或只有重复书籍时，底部会进入无更多状态。

错误处理保留当前书籍列表：底部请求错误写入 `errorLiveData`，显示底部加载控件错误；顶部请求错误写入 `errorTopLiveData`，显示顶部加载控件错误。错误会打印调试堆栈，下一次用户点击加载控件仍可再次发起请求。

## 页码菜单、首尾加载和滚动锚点

标题栏页码菜单打开数字选择器，范围是 1 至 999。选择新页码时：

1. 更新顶部加载控件。
2. 记录 `oldPage`。
3. `skipPage(page)` 清空内存书籍和状态。
4. 清空适配器，标记 `isClearAll`。
5. 请求指定页，完成后滚回列表第一项。

RecyclerView 到达底部时自动请求下一页，到达顶部且当前页大于 1 时请求上一页。顶部插入成功后优先按原先可见的 `SearchBook` 找锚点，找不到时使用插入数量估算位置，避免画面跳动。第 1 页没有顶部加载控件。

## 发现结果展示和书架标记

适配器每项显示书名、作者、最新章节、简介、分类标签和封面。封面加载是否只走 Wi-Fi 遵循 `AppConfig.loadCoverOnlyWifi`。点击结果打开书籍信息页，并传入书名、作者和 `bookUrl`，因此详情页可优先按 URL 恢复这个临时搜索结果。

ViewModel 初始化时监听全部书架书，建立三类标记：`name-author`、书名和 `bookUrl`。结果作者为空时只按书名匹配。数据库变化后通过 `upAdapterLiveData` 通知适配器只刷新书架图标，不重新加载网络结果。

## 批量加入书架

“将已加载书籍加入书架”菜单读取当前内存中的全部结果。没有结果时直接 Toast；有结果时弹窗显示数量并要求确认。

确认后只允许一个批量任务同时运行。任务调用 `SearchBookShelfHelp.addLoadedBooksToShelf`，返回已添加和跳过数量。完成后在不可取消的主线程区间同步正在阅读、音频、漫画和视频模型中同 URL 的活动书籍，再将这些活动状态写回数据库，并触发 `SourceCallBack.ADD_BOOK_SHELF`。成功 Toast 同时显示新增和跳过数；失败写入 `AppLog` 并显示异常文本。任务结束时解除 busy 状态，恢复菜单可用。

批量加入使用当前已加载结果快照。后续翻页产生的新结果不会加入正在运行的任务；第二次点击在任务未结束时只提示进行中。书架是否已存在的图标判断和真正加入书架的去重都由不同层负责，CLI 实现时不能只用 UI 图标代替保存层结果。

## 发现页与书源策略的边界

发现列表只显示 `flowExplore` 返回的启用发现源，不能把普通搜索可用源直接当成发现源。详情页只使用用户点击的单一书源和单一发现 URL，不会像全局搜索那样并发多个书源，也没有源优先级或失败降级。分类、翻页和批量加入都在这个源的上下文中执行。

## 对 apps 和 CLI 的对照要求

至少需要分别建模发现源筛选、发现 URL 分类、追加分页、向上插入、页码跳转、底部和顶部错误、书架标记以及批量加入任务。分页结果应保持去重后的插入顺序，并在向上插入时恢复可见锚点。发现请求 60 秒超时、Debug 构建无超时、分类错误只 Toast、列表请求错误保留旧结果等行为不能合并成统一的“失败后清空”。

源码证据：`ui/main/explore/ExploreFragment.kt:48-338`、`ui/main/explore/ExploreViewModel.kt:10-27`、`ui/book/explore/ExploreShowViewModel.kt:43-414`、`ui/book/explore/ExploreShowActivity.kt:35-327`、`ui/book/explore/ExploreShowAdapter.kt:17-93`。
