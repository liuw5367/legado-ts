🥷 本文记录 Android 目录页怎样从数据库、EPUB 和 PDF 读取目录，怎样搜索、折叠、定位章节，并怎样处理书签和高亮。

# 目录列表

## 页面和数据来源

入口是 `ui/book/toc/TocActivity.kt`，共享状态在 `TocViewModel`，目录列表在 `ChapterListFragment`，另外两个 Tab 是 `BookmarkFragment` 和 `HighlightFragment`。

页面固定包含三个 Tab：目录、书签、高亮。搜索框只作用于当前 Tab，但切换 Tab 会用同一个搜索词重新查询对应数据。

`TocViewModel.initBook` 只从 `bookDao` 读取正式书籍。没有数据库书籍时，目录页不会直接用搜索缓存构造书籍。

## 目录加载优先级

进入 `ChapterListFragment` 后会清空旧适配器状态，再根据书籍类型选择目录来源：

1. EPUB 先调用 `EpubFile.getToc`。读取失败写日志并继续走普通章节列表。
2. PDF 先调用 `PdfOutline.read`。只有大纲中存在页码时才显示 PDF 大纲，否则回退普通章节列表。
3. 普通网络书、本地文本、音频和没有可用特殊大纲的 PDF 使用 `bookChapterDao.getChapterList`。

章节查询范围是 `0..simulatedTotalChapterNum()-1`。PDF 在数据层反序时直接反转章节列表；普通网络书和 EPUB 保留章节索引，再由显示状态决定正反序。

目录状态会记录：

- 当前完整章节列表。
- 当前搜索词。
- 正序、反序和显示反序。
- 卷的展开状态。
- 当前阅读章节索引。
- EPUB 目录树或 PDF 大纲状态。

## 卷、章节和定位

普通章节列表通过 `TocListState` 转成 `TocListItem.Volume` 和 `TocListItem.Chapter`。卷行可以折叠，折叠状态保存在书籍设置中。切换卷时记录首个可见项或卷键，刷新后尽量恢复用户的滚动位置。

页面顶部和底部按钮直接滚动到首项或末项。点击当前章节信息会展开包含当前章节的卷，再滚动到章节。搜索状态下不强行展开卷，定位使用搜索结果中的可见位置。

点击章节会通过 `TocActivityResult` 返回：章节索引、章节内位置、是否发生章节变化、卷索引、卷内索引，以及高亮定位所需的标题长度和锚文本。阅读页收到后调用 `ReadBook.openChapter`。

音频章节在列表中显示缓存状态。页面启动时读取音频缓存目录，读取期间先记录 `AUDIO_CACHE_CHANGED` 事件，状态准备好后合并这些事件。普通文本则读取章节缓存文件名，并监听 `SAVE_CONTENT` 更新可见行。

## 目录搜索

输入框每次变化都会取消上一次目录更新任务。搜索词为空时显示完整目录，搜索词非空时：

1. 等待 150 毫秒，避免快速输入重复构建列表。
2. 如果完整列表还没有建立，先加载并缓存完整章节。
3. EPUB 使用 `TocListState.searchIndexes` 在 EPUB 树中搜索。
4. 其他书籍调用 `bookChapterDao.searchIndexes` 查询章节索引。
5. 只显示命中的章节和必要的卷层级。

切换 Tab、切换书籍、关闭搜索或销毁 Fragment 都会取消旧任务，避免旧查询回写新书籍。

## 反序、展开和规则

目录菜单按书籍类型使用不同字段：

- EPUB 和 PDF 切换真正的目录顺序。
- 普通书切换目录显示顺序，阅读和缓存使用的章节索引身份保持不变。
- “展开目录”修改书籍设置，并同步活动阅读器中的书籍状态。
- 本地 TXT 可以编辑目录正则，重新解析本地书后删除旧章节并写入新章节。
- “目录使用替换规则”只改变显示标题，重新绑定列表，不改数据库原始章节标题。
- “统计字数”触发适配器更新，字数统计不是目录请求本身的一部分。

改变目录规则失败时回调阅读页显示 `LoadTocError`，不会把旧目录静默替换成空列表。

## 书签 Tab

书签为空搜索词时使用 `bookmarkDao.flowByBook(name, author)`，有搜索词时使用 `flowSearch`。数据流变化会更新列表，并按照当前阅读章节把滚动位置放在最近的书签附近。

点击书签返回章节索引和章节位置，长按打开编辑弹窗。目录菜单可以把当前书籍书签导出为 JSON 或 Markdown：Markdown 包含书名、章节名、原文和摘要。导出失败写日志，成功显示提示。

## 高亮 Tab

音频、视频以及不支持定位的漫画书不显示可定位高亮。其他书籍通过 `bookHighlightDao.flowByBook` 或 `flowSearch` 获取高亮，再从章节 URL 映射章节索引。

排序键为章节索引、正文位置和创建时间。点击高亮返回章节索引、正文位置、布局标题长度和锚文本。只有锚文本长度与高亮范围一致时才传递锚文本，阅读页据此恢复精确位置。长按打开高亮备注弹窗。

源码证据：`ui/book/toc/TocActivity.kt:56-230`、`ui/book/toc/TocViewModel.kt:29-185`、`ui/book/toc/ChapterListFragment.kt:52-430`、`BookmarkFragment.kt`、`HighlightFragment.kt`。
