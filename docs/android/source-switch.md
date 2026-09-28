🥷 本文记录 Android 整本书换源和章节换源的候选构建、排序、附加请求、提交和取消行为。

# 书源切换

## 整本书换源入口

`ChangeBookSourceDialog` 可以从书籍信息页或阅读页打开。`ChangeBookSourceViewModel` 接收书名、作者、当前书和是否从阅读页进入等参数。默认范围来自启用书源或 `AppConfig.searchGroup`，也可以指定单个书源。

启动搜索时：

1. 取消上一项换源任务，清空搜索缓存、目录映射和书籍映射。
2. 读取全部启用书源或指定分组。分组为空时回退全部启用书源。
3. 按 `AppConfig.threadCount` 并行调用 `WebBook.searchBookAwait`，单源超时 60 秒。
4. 精确匹配书名，作者是否必须包含原作者由 `changeSourceCheckAuthor` 决定。
5. 按配置决定是否继续请求详情、目录和字数。

搜索结果先写入 `searchBooks`，同一来源的新结果会替换同一对象。每批结果通过 Flow 更新 UI，页面可以在搜索仍在进行时筛选和排序。

## 换源候选的附加加载

当开启详情、目录或字数选项时，每个候选按以下顺序处理：

1. 没有 `tocUrl` 时请求详情。
2. 需要目录或字数时请求目录。
3. 需要字数时选取当前阅读章节，或候选目录最后一章，获取正文并经过旧书内容处理器后统计字符数。
4. 统计结果和响应时间写回 `SearchBook`，再推送到列表。

目录会被缓存到 `tocMap`，书籍对象缓存到 `bookMap`。目录总章节达到 30000 后不再继续存入换源内存缓存，但当前候选仍可显示。

字数统计失败不会让候选整体失败，结果中会记录 `-1` 和失败说明。详情或目录失败则该候选通常不能成为可提交换源结果。

## 结果筛选和排序

换源结果与普通搜索不同，使用 `ChangeSourceResultOptions`：

- 基础评分由书名、作者、来源评分组成。
- 同分时按 `SourceConfig.getSourceScore(origin)` 和 `originOrder` 排序。
- 开启响应时间排序时，响应时间参与比较。
- 开启字数加载时，可以优先已测量结果，并按章节字数、字数文本和章节数排序。
- 相对字数过滤可以按最小值、最大值或参考书相对比例排除候选。
- 从阅读页换源时可以固定当前源，避免它在候选列表中消失。

搜索框的 `screenKey` 是界面过滤，只检查书名包含关系，不重新发起网络搜索。来源分组筛选也在候选列表层完成。

## 提交整本书换源

用户选择候选后，页面可以按设置加载书籍信息和目录。成功结果包含 `Book`、目录、目标 `BookSource`，以及是否关闭对话框和是否删除搜索缓存的标志。

`BookInfoViewModel.changeTo` 或 `ReadBookViewModel.changeTo` 提交时：

1. 设置新书源和自定义按钮。
2. 把当前书的阅读进度、分组和必要字段迁移到新书。
3. 书架书替换数据库记录和章节，更新缓存目录。
4. 网页文件重新构造下载文件列表。
5. 发布 `SOURCE_CHANGED`，阅读页重新加载正文。

提交失败会保留原书，记录日志并发布失败状态。搜索结果的临时缓存只在成功提交后由 `SourceChangeCompletion` 删除。

## 自动换源

阅读页当前书没有书源且 `autoChangeSource` 开启时，启用文本书源并发精确搜索。每个候选还必须成功加载详情、目录和当前章节正文，第一条完整结果通过 `take(1)` 提交。没有合适源时显示错误，失败源不会被自动禁用。

## 章节换源

`ChangeChapterSourceViewModel` 继承整本书换源模型，但固定当前源并维护原目录进度。章节换源包含三种状态：

- 原书目录 `Loading`、`Success`、`Error`。
- 目标书目录 `Idle`、`Loading`、`Success`、`Error`。
- 目标正文 `Loading`、`Success`、`Error`。

单章换源流程是：读取原目录，搜索或选择目标书，加载目标目录，用 `matchChapterSource` 匹配同名章节，加载正文，预览后缓存到原书章节。匹配不唯一时必须让用户选择，不直接覆盖正文。

批量换源会逐章执行。正文列表先全部读取，合并后确认非空，再以 `NonCancellable` 保存原章节缓存。保存成功后移动到下一章；正文缺失、匹配不唯一或请求错误会暂停自动化任务，用户可以继续、跳过或停止。

所有搜索、目录、正文和缓存任务都有独立 Job。关闭弹窗、切换书籍或提交新的换源操作时，先取消旧任务，防止旧结果回写新书。

源码证据：`ui/book/changesource/ChangeBookSourceViewModel.kt:102-450, 730-820`、`ChangeChapterSourceViewModel.kt:23-445`、`ChangeBookSourceDialog.kt`、`ChangeChapterSourceDialog.kt`。
