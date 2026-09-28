🥷 本文记录 Android 书架页的分组、列表数据、排序、刷新、导入导出、添加书籍和阅读状态行为。书架有两套布局实现，但两套实现共享菜单、头部统计和 ViewModel。

# 书架

## 页面入口和布局分支

主界面的书架位置由 `MainActivity` 创建 `BookshelfFragment1` 或 `BookshelfFragment2`。两者都继承 `BaseBookshelfFragment`，因此菜单和头部行为一致，书籍展示方式不同。

| 实现 | 分组方式 | 列表行为 |
| --- | --- | --- |
| `BookshelfFragment1` | 每个 `BookGroup` 是一个 `ViewPager` 页面和顶部 Tab | 每组由 `BooksFragment` 单独查询、排序和滚动 |
| `BookshelfFragment2` | 一个 RecyclerView，根页先显示分组卡片，再显示书籍 | 左右滑动切换分组，根页可展开分组，分组页直接显示书籍 |

`BookshelfFragment1` 首次读取分组后恢复 `AppConfig.saveTabPosition`。长按分组 Tab 打开分组编辑；再次点击当前 Tab 只提示该分组的书籍数量。`BookshelfFragment2` 在根分组以外显示返回箭头，左滑或右滑只在现有分组范围内切换，系统返回优先从子分组回到根页。

## 书籍集合和分组定义

`BookDao.flowByGroup` 先按特殊分组或用户分组选择 SQL，再过滤 `isNotShelf` 书籍。因此已经移出书架的书不会出现在书架列表，即使它仍存在数据库中。

特殊分组的筛选条件如下：

- 根分组只显示文本类型、非本地、没有用户分组且没有被隐藏的网络书。
- 全部显示所有正式书架书。
- 本地、音频、视频按类型位筛选。
- 网络未分组和本地未分组分别排除用户分组。
- 更新失败按 `BookType.updateError` 筛选。
- 正整数分组 ID 按 `book.group` 位掩码匹配。

根页的第二套布局额外查询 `flowBookshelfBooks`，将所有正式书架书投影为轻量 `BookshelfBook`，再按照分组封面和预览规则构造分组卡片。没有自定义分组封面时，预览最多取四本；有封面时不生成预览书籍。

## 排序规则

书籍列表每次收到数据库变化都会重新排序。用户分组可以保存自己的 `bookSort`，小于零时回退到全局 `AppConfig.bookshelfSort`。排序编号和实现如下：

| 编号 | 排序 |
| --- | --- |
| 0 或其他 | 阅读章节时间 `durChapterTime` 降序 |
| 1 | 最新章节时间 `latestChapterTime` 降序 |
| 2 | 书名中文比较 |
| 3 | 自定义 `order` 升序 |
| 4 | `max(latestChapterTime, durChapterTime)` 降序 |
| 5，仅旧布局 | 作者中文比较 |

旧布局的 `BooksFragment` 支持编号 5。新布局的 `BookshelfFragment2` 和根页预览使用 0 至 4，不能假定跨布局完全相同。排序更新只重新提交列表，不改变当前分组。

## 书架头部和阅读状态

`BaseBookshelfFragment.bindShelfHeader` 根据两个配置决定是否显示头部：

- `showBookshelfStats` 打开时，监听书架数量 Flow，并从 DAO 读取正在阅读数量，显示“书架数量、正在阅读数量”。
- `showBookshelfRecentReading` 打开时，读取 `lastReadBookOnShelf`。DAO 优先选有章节索引或章节位置的书，再按 `durChapterTime` 降序。
- 最近阅读区域点击打开阅读，长按打开书籍信息。
- 书籍没有有效章节标题时显示“未开始阅读”；百分比由阅读进度计算后限制在 0 至 100。

Flow 在页面 `RESUMED` 时收集，以数据库变化事件刷新，并使用 `conflate` 丢弃过时中间值。头部查询失败只写 `AppLog`，不会让列表页面崩溃。关闭两个配置时头部根视图隐藏且不启动查询。

## 下拉刷新和更新范围

列表下拉刷新调用主界面的 `MainViewModel.upToc(books, onlyUpdateRead)`。用户分组的 `enableRefresh` 决定是否允许下拉，`onlyUpdateRead` 决定只更新已读书。根分组默认允许刷新；没有书籍时刷新控件被禁用。

刷新不是书架本地排序操作，而是对当前列表触发目录更新。失败书籍仍保留在列表，并通过书籍的更新错误状态进入“更新失败”特殊分组。

## 菜单和配置弹窗

`BaseBookshelfFragment` 的菜单按以下入口执行：

- 远程导入书籍、搜索、更新目录。
- 书架布局配置、分组管理、添加本地书、按 URL 添加、书架管理、缓存下载。
- 导出书架、导入书架和查看应用日志。

布局配置弹窗读取并校正非法配置，然后让用户同时修改：分组样式、布局、书名显示方式、排序、阅读进度显示、书架边距、未读标记、最后更新时间、待更新数量、快速滚动条、最近阅读和统计。

保存时的副作用按配置类别区分：

- 未读、最后更新时间、阅读进度和快速滚动条只发出书架刷新事件。
- 待更新数量通知主界面重算更新数。
- 分组样式通知主界面，书名显示、边距、最近阅读、统计和布局变化触发重建。
- 排序直接调用 `upSort`，不强制重建。
- 网格和列表布局切换前清理对应的共享 RecyclerView 回收池。

## 通过 URL 添加书籍

`BookshelfViewModel.addBookByUrl` 接收一个多行文本，逐行 trim 并跳过空行。每行处理顺序固定：

1. 先按完整 `bookUrl` 查数据库。已存在时只合并目标分组，不重新请求详情，并计入成功数。
2. 解析 URL 基域。若 URL 带 `AnalyzeUrl` 参数，先读取参数中的 origin，只有该书源存在且 URL 命中其 `bookUrlPattern` 才采用。
3. 未命中特定 origin 时按基域调用 `getBookSourceAddBook`。
4. 仍未找到时遍历启用且有 `bookUrlPattern` 的书源，首个正则命中的书源获选。这里不会搜索所有禁用书源。
5. 创建带 URL、书源 URL 和书源名称的临时 `Book`，调用 `WebBook.getBookInfoAwait`。
6. 若数据库已有相同书名和作者，继续获取目录，并通过源切换迁移函数替换旧书，保留活动阅读器，不清除活动阅读状态。
7. 否则把目标分组合并到新书，使用数据库最小 `order` 排到前面，保存并保留自定义封面。

每成功处理一本书更新等待框计数。整批结束时至少成功一本显示成功，否则显示“添加网址失败”；单本失败会被 `runCatching` 吞掉并继续下一行，异常写入日志。等待框取消会取消 `addBookJob`。

## 导出书架

导出先在应用内部 `filesDir/books.json` 生成临时 JSON 数组，再交给系统文件选择器或直链上传。每本书只写 `name`、`author`、`intro` 三个字段，简介使用展示简介，不包含章节、源 URL 或阅读进度。导出完成后显示文件 URI；如果是直链上传，还显示上传摘要并提供复制 URI 的操作。空书架直接报“书籍不能为空”。

## 导入书架和精确搜索

导入输入可来自文本框或文件选择器，接受三种形式：

- 绝对 URL：下载并解压响应 body，再递归按同一规则解析。
- JSON 数组：每项必须有非空字符串 `name`，`author` 可以缺省、为 null 或字符串。
- 其他文本：报格式错误。

JSON 项按 `name + author` 去重。导入时读取全部启用书源，使用 `Semaphore(AppConfig.threadCount)` 限制并发。每一本先检查数据库是否已有同名同作者，已有则跳过；否则按书源顺序调用 `WebBook.preciseSearchAwait`，首个成功结果加入目标分组并保存。所有书并发执行，失败项在等待全部任务后聚合成一条错误；只要有失败，整批最终回调错误并记录失败信息。

这条导入路径的源选择与普通搜索不同：它不使用搜索页的分组选择、排序或结果合并，也没有逐源 30 秒搜索超时逻辑，而是按启用书源列表顺序逐本寻找首个精确结果。

## 书籍点击、长按和滚动

- 点击书籍进入对应阅读页面。
- 长按书籍进入书籍信息页。
- 根布局点击分组卡片进入该分组；长按打开分组编辑。
- 快速滚动条由 `showBookshelfFastScroller` 控制，关闭时恢复系统滚动条宽度。
- 主界面再次点击书架 Tab 会调用 `gotoTop`，墨水屏模式直接滚动，普通模式平滑滚动。

## 对 apps 和 CLI 的对照要求

实现书架时需要保留“书架书”和数据库中非书架书的区别，不能用全量书籍数量代替书架数量。还要保留每个分组独立的刷新开关、只更新已读开关和排序覆盖；导入导出要明确 JSON 只包含三字段；通过 URL 添加和 JSON 导入都只在启用书源范围内自动匹配，但显式 URL origin 仍要先走其规则验证。

源码证据：`ui/main/bookshelf/BaseBookshelfFragment.kt:62-415`、`ui/main/bookshelf/BookshelfViewModel.kt:45-235`、`ui/main/bookshelf/style1/BookshelfFragment1.kt:35-171`、`ui/main/bookshelf/style1/books/BooksFragment.kt:65-317`、`ui/main/bookshelf/style2/BookshelfFragment2.kt:56-377`、`ui/main/bookshelf/style2/BookshelfGroupItem.kt:24-64`、`data/dao/BookDao.kt:30-105, 173-200`、`data/entities/BookGroup.kt:14-61`。
