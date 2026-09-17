# 书籍详情流程

## 输入和缓存

详情流程接收 `BookSource` 和已有 `Book`。`mainJs` 非空时走 `JsSourceBook.getBookInfo`；声明式源优先使用 `book.infoHtml`，没有缓存时请求 `book.bookUrl`。书源类型会先覆盖到当前 Book 的类型标记。

## 声明式字段顺序

`BookInfo.analyzeBookInfo` 使用 `ruleBookInfo`：

1. `init` 非空时执行 `getElement(init)`，将返回节点作为后续所有字段的新内容；
2. 读取 `name`、`author`；
3. 读取 `kind`、`wordCount`、`lastChapter`、`intro`、`coverUrl`；
4. 普通文本源读取 `tocUrl`，文件源读取 `downloadUrls`。

书名和作者只有在允许重命名或 Book 原字段为空时覆盖。详情字段的 `canReName` 不是一条会被执行的规则，当前实现只判断该配置字段是否非空，并且还要同时满足调用方允许重命名。迁移时不能把它当成返回布尔值的表达式。

## 字段归一化

- 分类列表以逗号拼接；
- 字数经过统一格式化；
- 简介以 `<usehtml>`、`<md>` 或 `<useweb>` 开头时保留特殊格式，否则经过简介 HTML 格式化；
- 封面 URL 相对 `redirectUrl` 转绝对 URL；
- 目录 URL 使用 `isUrl=true`，空值回退 `baseUrl`；
- 目录 URL 与详情 `baseUrl` 相同则缓存当前 body 到 `tocHtml`；
- 文件源的下载 URL 使用 URL 列表解析，空列表抛出“下载链接为空”。

因此详情页可能同时完成书籍详情和目录页准备，目录流程必须先检查 `bookUrl == tocUrl && tocHtml`，避免重复请求。

## 数据流、状态和提交边界

详情请求按以下顺序处理：

```text
BookSource + Book + canReName
  -> 书源类型归一化
  -> infoHtml 命中检查或请求 bookUrl
  -> loginCheckJs / 重定向处理
  -> init 改变规则输入
  -> name/author/kind/wordCount/lastChapter/intro/coverUrl
  -> tocUrl 或 downloadUrls 归一化
  -> BookUpdate 结果 + 临时 tocHtml
  -> 上层保存 Book
```

`infoHtml` 和 `tocHtml` 是本次运行的临时响应，不属于书源导出数据。核心库应返回明确的 `BookInfoResult`，至少包含更新后的 `book`、是否使用缓存、最终响应 URL、是否准备了 `tocHtml` 和字段级诊断；持久化由 Node、SSR 或应用层决定。Android 直接修改传入的 `Book`，并在详情完成后由调用方保存，TypeScript 不能因此把数据库写入放进规则引擎。

```ts
export interface BookInfoResult {
  /** 详情字段更新后的书籍副本，不包含未提交的数据库状态。 */
  book: Book
  /** 是否直接使用了已有 infoHtml。 */
  usedInfoCache: boolean
  /** 详情请求或缓存的最终响应 URL。 */
  finalUrl: string
  /** 详情页同时准备的目录响应，未准备时为空。 */
  tocHtml?: string
  /** 实际改变的 Book 字段路径。 */
  updatedFields: string[]
  /** 字段级警告或流程错误诊断。 */
  diagnostics: RuntimeDiagnostic[]
}
```

状态转换为 `created -> loading -> parsing -> normalized -> completed`。缓存命中从 `created -> parsing`，请求失败、必需输入失败或文件源无下载地址进入 `failed`；取消可以从任意活动状态进入 `cancelled`，不得提交部分 Book 更新。提交应在所有字段处理完成后执行一次，字段处理中间值只存在于局部副本，避免详情失败时污染已有书籍。

字段失败策略必须保留 Android 的差异：`init`、书名、作者和目录地址属于主流程，解析失败直接抛出异常，不产生字段级诊断；分类、字数、最新章节、简介和封面读取失败记录字段诊断并继续；文件源的 `downloadUrls` 为空是流程失败。`canReName` 由调用方权限和规则字段非空共同决定，不能由书源页面内容动态改变。

完成事件应携带 `bookUrl`、`origin`、最终响应 URL、更新字段集合和诊断。若 `tocUrl` 等于详情响应基准 URL，必须同时保存 `tocHtml`，目录流程随后直接消费该响应；若目录地址不同，只保存地址，不提前请求目录。

## JavaScript 源差异

JS 源的 `getBookInfo(book)` 是可选函数，缺失或返回空时保留搜索阶段字段。返回对象只允许覆盖明确的详情字段，包括 `tocUrl`；不能覆盖 `bookUrl`、阅读进度等运行状态。`downloadUrls` 必须是字符串数组，过滤空字符串、`javascript:` 和重复 URL；`variable` 支持对象或 JSON 字符串并替换现有书籍变量。

Web 输入绑定 sourceRevision 和 Book 的 baseRevision。返回的 updatedFields 是明确允许提交的集合，不执行整对象覆盖；失败返回诊断并保持输入对象不变。infoHtml/tocHtml 复用必须同时带最终响应 URL、源版本和会话身份；跨 HTTP 使用服务端缓存引用，不能仅传一段 HTML 就假定属于当前源。成功返回后应用提交 changes，提交失败与规则解析失败分开。
