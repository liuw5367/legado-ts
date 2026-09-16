# 章节目录流程

## 入口

声明式源通过 `WebBook.getChapterListAwait` 请求 `book.tocUrl`，或在详情页已经缓存 `tocHtml` 时直接解析。JS 源调用 `getChapters(book)`，再执行相同的章节对象归一化和目录信息更新。

调用方可要求先执行 `ruleToc.preUpdateJs`。该脚本用于动态更新目录链接；从详情页进入时会避免重复加载详情页。

## 单页解析

1. 创建 `AnalyzeRule(book, source)`，设置 body、baseUrl、redirectUrl；
2. 对 `chapterList` 执行 `getElements`；
3. 对每个元素执行 `chapterName`、`chapterUrl`、`updateTime`、`isVolume`、`isVip`、`isPay`；
4. 标题为空的节点丢弃；
5. URL 为空时，卷节点使用 `title + index` 作为稳定占位 URL，普通章节使用当前 baseUrl；
6. 卷名节点把 `updateTime` 放入 tag；普通章节把它放入 tag，并可从 tag 识别字数；
7. VIP/购买规则的结果使用当前 `isTrue` 语义判断；
8. `nextTocUrl` 获取一个或多个后续目录页 URL，并去掉当前 redirectUrl。

## 多页和顺序

- 后续 URL 只有一个时串行跟随，直到空 URL 或遇到已访问 URL；
- 多个后续 URL 时并发请求，单页结果按完成收集；
- 初始 `chapterList` 的 `+` 只表示去掉控制前缀；`-` 会设置目录流程的反转标志，但不会立即反转每个页面的提取结果；
- 所有目录页收集完成后，未设置 `-` 时先做一次整体反转，然后再根据 `book.readConfig.reverseToc` 做书籍级反转，最后用 `LinkedHashSet` 按章节对象去重；因此 `-` 和 `book.readConfig.reverseToc` 不能拆成互不相关的两个开关；
- `Book.readConfig.reverseToc` 是书籍刷新顺序，Android 通过 `book.getReverseToc()` 读取；`readConfig.reverseTocDisplay` 只影响展示，不能改写下一次刷新输入顺序；
- 去重和最终顺序确定后重新从 0 编号，再执行 `formatJs`。

`formatJs` 每章获得 `index`（从 1 开始）、`chapter`、`title` 和初始 `gInt=0`，返回值非空时覆盖标题。标题格式化失败记录日志但保留原标题。

## 数据流、状态和持久化边界

目录刷新接收 `BookSource + Book + tocUrl/tocHtml`，按以下阶段产生结果：

```text
目录入口
  -> 可选 preUpdateJs
  -> 选择 tocHtml 或请求 tocUrl
  -> 页面解析为 chapters + nextUrls
  -> 单后续页串行，多个后续页并发
  -> 检查取消、空目录和分页循环
  -> 目录控制前缀反转
  -> 去重
  -> readConfig.reverseToc 书籍级反转
  -> 重新编号
  -> formatJs
  -> 更新 Book 目录统计与旧章节元数据
  -> 返回章节列表和 Book 更新
```

```ts
export interface ChapterListResult {
  /** 去重、排序、编号和格式化后的完整章节列表。 */
  chapters: BookChapter[]
  /** 目录流程更新的书籍统计和当前章节标题。 */
  book: Book
  /** 参与处理的页面 URL，按请求实际访问顺序记录。 */
  visitedUrls: string[]
  /** 页面、字段和持久化前诊断。 */
  diagnostics: RuntimeDiagnostic[]
}
```

状态转换为 `created -> page-loading -> page-parsing -> collecting -> ordered -> committed -> completed`。分页请求失败进入 `failed`，已经收集的章节不能被当作完整目录提交；取消可以从加载、解析或收集状态进入 `cancelled`，并停止后续请求和编号。一个后续 URL 串行跟随时，下一 URL 只取当前页规则结果的第一个；多个 URL 并发时，结果按任务完成顺序收集，不能假设输入 URL 顺序就是最终目录顺序。

提交前必须完成空标题过滤、URL 占位、VIP/购买标记、去重、编号和标题格式化。提交会更新 `durChapterTitle`、`latestChapterTitle`、`lastCheckTime`、`lastCheckCount`、`latestChapterTime` 和 `totalChapterNum`；启用章节字数时，还要按索引与标题把已有章节的 `wordCount`、`variable`、`imgUrl` 合并回新列表。核心库返回这些更新和章节列表，宿主负责数据库事务或其他持久化。任何一步失败都不能只保存统计字段而丢失章节列表的一致性。

目录顺序的最小真值表如下，`P` 表示页面解析后收集的顺序：

| `chapterList` 前缀 | 第一轮整体反转 | `readConfig.reverseToc=false` 的最终结果 |
| --- | --- | --- |
| 无前缀 | 是 | `P` |
| `+` | 是 | `P` |
| `-` | 否 | `reverse(P)` |

当 `readConfig.reverseToc=true` 时，最终结果再反转一次。多页目录还要先按当前实现收集页面结果，再执行上面的整体顺序处理，不能在每页解析时提前反转。

## JavaScript 源目录

`getChapters` 必须返回数组。缺少 `title` 或 `url` 的项丢弃；普通 URL 相对 `book.tocUrl` 转绝对 URL；卷节点在 `isVolume=true` 且 URL 等于标题时保留占位 URL。最终注入 `bookUrl`、`baseUrl` 和 `index`。数组为空抛出目录为空错误。

## 空值和错误

- body 为空：请求/解析失败；
- 章节元素为空：最终抛出目录为空；
- 分页循环：已访问 URL 必须停止；
- 单页请求失败：按流程策略向上报告，不把未取得的页面当作空章节页；
- 取消必须在分页、每个章节和最终编号前检查。
