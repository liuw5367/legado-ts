# 章节目录流程

## 入口

声明式源通过 `WebBook.getChapterListAwait` 请求 `book.tocUrl`，或在详情页已经缓存 `tocHtml` 时直接解析。JS 源调用 `getChapters(book)`，再执行相同的章节对象归一化和目录信息更新。

调用方可要求先执行 `ruleToc.preUpdateJs`。该脚本用于动态更新目录链接；从详情页进入时会避免重复加载详情页。

## 单页解析

1. 创建 `AnalyzeRule(book, source)`，设置 body、baseUrl、redirectUrl；
2. 对 `chapterList` 执行 `getElements`；
3. 对每个元素执行 `chapterName`、`chapterUrl`、`updateTime`、`isVolume`、`isVip`、`isPay`；
4. 标题为空的节点丢弃；
5. URL为空时，卷节点使用 `title + index` 作为稳定占位 URL，普通章节使用当前 baseUrl；
6. 卷名节点把 `updateTime` 放入 tag；普通章节把它放入 tag，并可从 tag 识别字数；
7. VIP/购买规则的结果使用当前 `isTrue` 语义判断；
8. `nextTocUrl` 获取一个或多个后续目录页 URL，并去掉当前 redirectUrl。

## 多页和顺序

- 后续 URL只有一个时串行跟随，直到空 URL或遇到已访问 URL；
- 多个后续 URL时并发请求，单页结果按完成收集；
- 初始 `chapterList` 的 `+` 只表示去掉控制前缀；`-` 会设置目录流程的反转标志，但不会立即反转每个页面的提取结果；
- 所有目录页收集完成后，未设置 `-` 时先做一次整体反转，然后再根据 `book.reverseToc` 做书籍级反转，最后用 `LinkedHashSet` 按章节对象去重；因此 `-` 和 `book.reverseToc` 不能拆成互不相关的两个开关；
- `Book.readConfig.reverseToc` 是书籍刷新顺序，Android 通过 `book.getReverseToc()` 读取；`readConfig.reverseTocDisplay` 只影响展示，不能改写下一次刷新输入顺序；
- 去重和最终顺序确定后重新从 0 编号，再执行 `formatJs`。

`formatJs` 每章获得 `index`（从 1 开始）、`chapter`、`title` 和初始 `gInt=0`，返回值非空时覆盖标题。标题格式化失败记录日志但保留原标题。

目录顺序的最小真值表如下，`P` 表示页面解析后收集的顺序：

| `chapterList` 前缀 | 第一轮整体反转 | `readConfig.reverseToc=false` 的最终结果 |
| --- | --- | --- |
| 无前缀 | 是 | `P` |
| `+` | 是 | `P` |
| `-` | 否 | `reverse(P)` |

当 `readConfig.reverseToc=true` 时，最终结果再反转一次。多页目录还要先按当前实现收集页面结果，再执行上面的整体顺序处理，不能在每页解析时提前反转。

## JavaScript 源目录

`getChapters` 必须返回数组。缺少 `title` 或 `url` 的项丢弃；普通 URL 相对 `book.tocUrl` 转绝对 URL；卷节点在 `isVolume=true` 且 URL等于标题时保留占位 URL。最终注入 `bookUrl`、`baseUrl` 和 `index`。数组为空抛出目录为空错误。

## 空值和错误

- body为空：请求/解析失败；
- 章节元素为空：最终抛出目录为空；
- 分页循环：已访问 URL必须停止；
- 单页请求失败：按流程策略向上报告，不把未取得的页面当作空章节页；
- 取消必须在分页、每个章节和最终编号前检查。
