# 章节目录流程

## 入口

声明式源通过 `WebBook.getChapterListAwait` 请求 `book.tocUrl`，或在详情页已经缓存 `tocHtml` 时直接解析。JS 源调用 `getChapters(book)`，再执行相同的章节对象归一化和目录信息更新。

调用方可要求先执行 `ruleToc.preUpdateJs`。该脚本用于动态更新目录链接；从详情页进入时会避免重复加载详情页。

声明式源以 `runPerJs=true` 执行该脚本时，Android 的同步助手 `refreshTocUrl()` 会重新获取书籍详情；`isFromBookInfo=true` 时跳过这次请求。`reGetBook()` 按当前书名和作者精确搜索，更新书籍 URL 与搜索变量，再以 `canReName=false` 重新获取详情。助手返回后，脚本可立即读取更新后的 `book` 字段。助手失败会让目录预处理失败，取消会取消整个目录操作，不能悄悄沿用旧目录。

搜索期间由规则写入的 `RuleData` 变量会随候选带回；精准重搜得到的新变量会覆盖同名旧变量并保留其他旧变量。TS 还将预更新脚本及其等待中的助手限制在 30 秒内；Android 助手的超时上限是 30 分钟，因此较慢的详情请求可能在 TS 提前取消。

详情规则可以不配置书名、作者或简介。Android 仍会处理目录地址；目录地址规则缺失、为空或未返回有效值时，使用详情响应 URL，并把该响应正文作为 `tocHtml`。

## 单页解析

1. 创建 `AnalyzeRule(book, source)`，设置 body、baseUrl、redirectUrl；
2. 对 `chapterList` 执行 `getElements`；
3. 对每个元素执行 `chapterName`、`chapterUrl`、`updateTime` 和 `isVolume`；
4. 标题为空的节点直接丢弃，不执行该节点的 `isVip`/`isPay` 规则；标题非空时才继续解析 VIP 和购买标记；
5. URL 为空时，卷节点使用 `title + index` 作为稳定占位 URL，普通章节使用当前 baseUrl；
6. 卷名节点把 `updateTime` 放入 tag；普通章节把它放入 tag，并可从 tag 识别字数；
7. VIP/购买规则的结果使用当前 `isTrue` 语义判断；
8. `nextTocUrl` 获取一个或多个后续目录页 URL，稳定去重并去掉当前 redirectUrl。

## 多页和顺序

- `TocInput.refresh=true` 跳过详情阶段的临时 `tocHtml` 复用；目录/正文流程不再读取或写入原始页面缓存。详情阶段只有同一次操作内且 `book.bookUrl === book.tocUrl` 的 `tocHtml` 可以复用。
- 第一页的后续 URL 数量决定分页模式：一个时串行跟随且后续页面只取首个 URL，多个时只并发这一批页面；
- 并发请求由 mapAsync 按输入顺序收集单页结果，不按网络完成顺序收集；
- `loginCheckJs` 只在首个实际目录网络请求上执行；复用 `tocHtml` 不消耗这次检查，后续分页请求不重复执行；
- 初始 `chapterList` 的 `+` 只表示去掉控制前缀；`-` 会设置目录流程的反转标志，但不会立即反转每个页面的提取结果；
- 所有页收集后，未设置 `-` 时先整体反转，再用 LinkedHashSet 按章节对象去重，最后在 book.getReverseToc() 为 false 时再次反转。第一次反转决定重复项保留方向，不能把去重移到最后；
- `Book.readConfig.reverseToc` 是书籍刷新顺序，Android 通过 `book.getReverseToc()` 读取；`readConfig.reverseTocDisplay` 只影响展示，不能改写下一次刷新输入顺序；
- 去重和最终顺序确定后重新从 0 编号，再执行 `formatJs`。

`formatJs` 在整个循环开始时设置 gInt=0，每章更新一基 index、chapter、title；gInt 可跨章累计。脚本对 `chapter` 的 URL、baseUrl、卷、VIP、购买、tag、字数和变量等字段修改会回写到最终章节，并按新的原始 URL/基准地址重新计算 `chapterUrl`。返回值不为 null 时覆盖标题，空字符串也覆盖；异常保留该章原标题。依据为 BookChapterList.analyzeChapterList 的 bindings 循环。

章节字段规则也共享同一个可变 `chapter` 绑定：标题、原始 URL、更新时间投影和卷标状态完成后，后续 VIP/购买规则可以读取这些最新字段；JavaScript 规则对绑定的直接修改会在下一字段前合并。

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
  -> 返回章节列表
  -> 应用层 reconcile 旧章节元数据并在同一写锁内保存目录快照与书籍 patch
```

当前 TypeScript 入口返回 `RuntimeResult<WorkflowPage<Chapter>>`；下面的 `ChapterListResult` 是 Android/统一门面目标形状，用来说明应用提交时需要补齐的领域信息，不是 `source-core` 的实际返回类型。

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

提交前必须完成空标题过滤、URL 占位、VIP/购买标记、去重、编号和标题格式化。`reconcileTableOfContents` 会更新 `durChapterTitle`、`latestChapterTitle`、`lastCheckTime` 和 `totalChapterNum`；仅在 `totalChapterNum < list.size`（发现新章节）时更新 `lastCheckCount` 和 `latestChapterTime`；启用章节字数时，还要按索引与标题把已有章节的 `wordCount`、`variable`、`imgUrl` 合并回新列表。核心 reconcile 是纯函数，宿主负责把章节快照与书籍 patch 放入同一写锁。任何一步失败都不能只保存统计字段而丢失章节列表的一致性。

目录顺序的最小真值表如下，`P` 表示页面解析后收集的顺序：

| `chapterList` 前缀 | 第一轮整体反转 | `readConfig.reverseToc=false` 的最终结果 |
| --- | --- | --- |
| 无前缀 | 是 | `P` |
| `+` | 是 | `P` |
| `-` | 否 | `reverse(P)` |

当 `readConfig.reverseToc=true` 时，最终结果再反转一次。多页目录还要先按当前实现收集页面结果，再执行上面的整体顺序处理，不能在每页解析时提前反转。

真值表中的 P 假定没有重复章节；存在重复时必须按“前缀反转 → 去重 → reverseToc=false 再反转”的实际顺序计算，不能先去重后套表。`loadTableOfContents` 不读取旧目录；CLI 成功后把旧快照和当前阅读投影传给 `reconcileTableOfContents`，再由应用在同一提交边界保存，见 [状态契约](../standard/state-and-effects.md)。`visitedUrls` 是逻辑归并结果：串行分支按完成顺序，多页并发分支按输入 URL 顺序；不能把网络响应的物理完成先后写入兼容结果。

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
