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
- 多个后续 URL 时并发请求，mapAsync 按输入顺序收集单页结果，不按网络完成顺序收集；
- 初始 `chapterList` 的 `+` 只表示去掉控制前缀；`-` 会设置目录流程的反转标志，但不会立即反转每个页面的提取结果；
- 所有页收集后，未设置 `-` 时先整体反转，再用 LinkedHashSet 按章节对象去重，最后在 book.getReverseToc() 为 false 时再次反转。第一次反转决定重复项保留方向，不能把去重移到最后；
- `Book.readConfig.reverseToc` 是书籍刷新顺序，Android 通过 `book.getReverseToc()` 读取；`readConfig.reverseTocDisplay` 只影响展示，不能改写下一次刷新输入顺序；
- 去重和最终顺序确定后重新从 0 编号，再执行 `formatJs`。

`formatJs` 在整个循环开始时设置 gInt=0，每章更新一基 index、chapter、title；gInt 可跨章累计。返回值不为 null 时覆盖标题，空字符串也覆盖；异常保留该章原标题。依据为 BookChapterList.analyzeChapterList 的 bindings 循环。

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
  /** `success`、`empty`、`partial`、`failed`、`cancelled`、`stale` 或 `unknown`。 */
  status: OperationStatus
  /** 本次目录操作基于的书源版本。 */
  sourceRevision: string
  /** 去重、排序、编号和格式化后的完整章节列表。 */
  chapters: BookChapter[]
  /** 目录流程更新的书籍统计和当前章节标题。 */
  book: Book
  /** 参与处理的页面 URL，按输入调度和逻辑归并顺序记录；不承诺并发请求的物理完成顺序。 */
  visitedUrls: string[]
  /** 读取旧目录时使用的修订；提交时用于拒绝并发旧写。 */
  tocRevision: string
  /** 本次目录操作身份。 */
  operationId: string
  /** 页面、字段和持久化前诊断。 */
  diagnostics: RuntimeDiagnostic[]
  /** 尚未由应用提交的目录和 Book 领域变更。 */
  changes: DomainChange[]
  /** 已发生的缓存、Cookie 或变量副作用。 */
  effects: EffectRecord[]
  /** 并发请求、脚本和监听器的最终清理状态。 */
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}
```

核心状态为 `created -> page-loading -> page-parsing -> collecting -> ordered -> completed`，应用提交在返回后单独进行。分页失败或取消不提交不完整目录。单 URL 分支以后只跟随首个下一页；多 URL 分支只收集这一批返回的章节，不递归展开每页新 URL。FlowExtensions.mapAsync 按发送 deferred 的输入顺序 await，后页先完成也不提前合并。

提交前必须完成空标题过滤、URL 占位、VIP/购买标记、去重、编号和标题格式化。提交会更新 `durChapterTitle`、`latestChapterTitle`、`lastCheckTime` 和 `totalChapterNum`；仅在 `totalChapterNum < list.size`（发现新章节）时更新 `lastCheckCount` 和 `latestChapterTime`；启用章节字数时，还要按索引与标题把已有章节的 `wordCount`、`variable`、`imgUrl` 合并回新列表。核心库返回这些更新和章节列表，宿主负责数据库事务或其他持久化。任何一步失败都不能只保存统计字段而丢失章节列表的一致性。

目录顺序的最小真值表如下，`P` 表示页面解析后收集的顺序：

| `chapterList` 前缀 | 第一轮整体反转 | `readConfig.reverseToc=false` 的最终结果 |
| --- | --- | --- |
| 无前缀 | 是 | `P` |
| `+` | 是 | `P` |
| `-` | 否 | `reverse(P)` |

当 `readConfig.reverseToc=true` 时，最终结果再反转一次。多页目录还要先按当前实现收集页面结果，再执行上面的整体顺序处理，不能在每页解析时提前反转。

真值表中的 P 假定没有重复章节；存在重复时必须按“前缀反转 → 去重 → reverseToc=false 再反转”的实际顺序计算，不能先去重后套表。输入需要旧目录及 `tocRevision`，才能合并元数据和拒绝并发旧写；输出更新书籍统计与完整目录，由应用在同一提交边界保存，见 [状态契约](../reference/state-and-effects.md)。`visitedUrls` 是逻辑归并结果：串行分支按完成顺序，多页并发分支按输入 URL 顺序；不能把网络响应的物理完成先后写入兼容结果。

BookChapter.equals/hashCode 只按 url 判断，因此 LinkedHashSet 不是按全部章节字段判断相等。相同 URL 不同标题也会去重；先反转的分支保留原收集顺序中最后出现的同 URL 章节。不能误用 JSON 深比较。isTrue 对空白及精确字符串 `null` 返回默认 false，trim 后忽略大小写的 false/no/not/0/0.0 为 false，其他文本为 true。

## JavaScript 源目录

`getChapters` 必须返回数组。缺少 `title` 或 `url` 的项丢弃；普通 URL 相对 `book.tocUrl` 转绝对 URL；卷节点在 `isVolume=true` 且 URL 等于标题时保留占位 URL。最终注入 `bookUrl`、`baseUrl` 和 `index`。数组为空抛出目录为空错误。

## 空值和错误

- body 为空：请求/解析失败；
- 章节元素为空：最终抛出目录为空；
- 分页循环：已访问 URL 必须停止；
- 单页请求失败：按流程策略向上报告，不把未取得的页面当作空章节页；
- 取消必须在分页、每个章节和最终编号前检查。
- 取消后必须停止新的分页和章节解析，等待已经启动的请求、并发任务、脚本和监听器释放；清理尚未完成时返回 `cancelled` 并携带待清理资源，不能只依赖同步的 cancel 调用。
