🥷 本文记录 Android 书籍信息页如何恢复书籍、并行加载详情和目录、处理书架状态及执行菜单操作。

# 书籍信息页面

## 进入时的书籍恢复优先级

入口是 `ui/book/info/BookInfoActivity.kt`，数据处理在 `BookInfoViewModel`。

`initData` 按下面的顺序恢复书籍：

1. 以 `name + author` 查询正式书架书。
2. 有 `bookUrl` 时，以 URL 查询正式书架书。
3. 以 URL 查询 `searchBooks` 搜索缓存并转换成 `Book`。
4. 以 `name + author` 从搜索缓存中取 `originOrder` 最优的一条。
5. 全部失败时记录日志并提示“未找到书籍”。

恢复正式书架书时，`inBookshelf = !book.isNotShelf`。搜索结果打开的书可以先作为临时书，保留书源和详情 URL，但不立即算作书架书。

## 初始加载分支

`upBook` 先根据 `book.origin` 查找书源，发布 `bookData`，然后异步尝试补封面。

| 条件 | 后续动作 |
| --- | --- |
| 本地书 | 读取本地书籍信息和目录 |
| 网络书，`tocUrl` 为空 | 请求详情，成功后继续请求目录 |
| 网络书，已有目录缓存 | 读取数据库目录；缓存为空时再请求目录 |
| 网页文件 | 不显示普通目录，解析下载 URL 列表 |

网络详情和目录请求使用 `BookInfoNetworkLoadingCounter`。只有所有并发任务结束后才关闭加载状态，所以封面、详情、目录等任务不会互相错误地关闭进度条。

## 详情请求的提交边界

`loadBookInfo` 对网络书调用 `WebBook.getBookInfo`。请求成功后：

1. 如果临时搜索书的详情加载后与同源的正式书架书对应，会把数据库书更新为详情结果并转为书架状态。
2. 详情结果是网页文件时，保存书籍并进入 `loadWebFile`，不请求章节目录。
3. 普通网络书进入 `loadChapter`。只有 `inBookshelf` 时才把书籍和章节写入正式数据库。
4. `runPreUpdateJs`、`canReName` 和 `isFromBookInfo` 会影响书源 JavaScript、书名重命名和目录更新行为。

详情失败时发布旧书籍和旧目录，写入 `AppLog`，提示获取书籍信息失败，不会用空对象覆盖页面。

## 目录请求和本地书处理

本地书调用 `LocalBook.getChapterList`，先删除旧章节，再插入新章节，通知 `ReadBook.onChapterListUpdated`。

网络书调用 `WebBook.getChapterList`。成功后：

- 书架书清除 `updateError`，替换书籍记录。
- 如果 `preUpdateJs` 修改了 `bookUrl`，同步更新缓存目录。
- 删除旧 URL 的章节并插入新目录。
- 通知阅读模型刷新目录。
- 页面显示新书籍和新目录，即使当前书只是临时书。

目录失败时保留旧书和旧目录，写日志并提示“获取目录失败”。没有书源时保留当前目录并提示无书源。

## 封面、简介和书源自定义内容

没有可显示封面时，页面调用 `BookCover.searchCover`。找到封面后更新 `customCoverUrl`，书架书立即保存，临时书只更新内存状态。

简介按前缀选择渲染方式：

- 普通文本支持缩进和折叠。
- `<usehtml>` 使用 WebView，并注入缓存、书源和 JavaScript 扩展。
- `<useweb>` 直接加载 HTML，支持非 HTTP 协议跳转到在线导入或外部应用。
- `<md>` 转成 Markdown，再渲染图片、表格和 HTML。

简介渲染有 generation 检查，旧的异步 Markdown 结果不能覆盖新书籍。HTML 中的图片点击和自定义按钮会回调书源 JavaScript。

## 书架、目录和菜单副作用

- 开始阅读会根据书籍类型打开文本、漫画、音频或视频页面。临时书进入阅读页时仍可保存阅读进度。
- 加入书架会清除 `notShelf`，分配排序位置，恢复已有阅读进度，保存书和当前目录，并触发书源 `ADD_BOOK_SHELF` 回调。
- 移出书架删除数据库书；本地书还可以按参数删除原文件。
- 目录按钮在没有目录时提示错误。临时书进入目录时，目录返回会把书保存或删除临时书。
- 分组选择对临时书有特殊行为，选中有效分组时会先加入书架。
- 刷新网络书会重新加载详情。刷新本地书时还会检查 WebDAV 远程文件的更新时间并尝试下载。
- 清理缓存会清除正文、漫画等本地缓存；正在阅读同一本书时同步清理阅读模型。
- 编辑书籍、编辑书源、切换变量、登录书源、创建更新任务、复制书籍 URL 和目录 URL、分享书籍数据都会通过菜单或回调执行。

分享内容不是只有 URL，而是 `bookUrl#bookJson`，发送前还会经过书源 `CLICK_SHARE_BOOK` 回调。

## 网页文件和本地化

详情返回 `isWebFile` 时，页面从 `downloadUrls` 生成展示文件名。文件名优先使用响应 URL 的文件名，否则使用“书名 作者”，并根据 URL 类型补后缀。

- 支持的后缀调用 `LocalBook.importFileOnLine`，导入后转成本地书并重新加载目录。
- 不支持的后缀只下载到书籍目录，仍保留在线文件项。
- 未配置书籍目录时通过 `actionLive = selectBooksDir` 要求用户选择目录。
- 压缩包导入先读取符合书籍文件正则的条目，用户选择条目后调用 `LocalBook.importArchiveFile`。

下载、解压或导入失败会关闭等待框、记录日志、提示错误，并在适用时从网页文件列表删除失败项。

源码证据：`ui/book/info/BookInfoViewModel.kt:115-342, 355-455, 458-637`、`ui/book/info/BookInfoActivity.kt:139-227, 285-510, 610-895`。
