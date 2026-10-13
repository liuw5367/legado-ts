# Android 书籍详情流程

> **来源与现状分层**：本页以固定 Android 源码、测试或行为记录为来源。文中带有 TypeScript、CLI、Web 或“目标设计”标记的段落只说明迁移边界和当前证据，不是 Android 事实，也不是可直接导入的统一 API。当前 core 的唯一事实源见 [source-core 工作流](../../../../packages/source-core/docs/workflows.md) 和 [codec 与订阅](../../../../packages/source-core/docs/codec-and-subscriptions.md)，应用事实见 [reader-cli 实现](../../../../apps/reader-cli/docs/implementation.md) 与 [reader-web 实现](../../../../apps/reader-web/docs/implementation.md)。

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

- 书名和作者分别调用 Android 兼容的 `formatBookName`/`formatBookAuthor`：先删除作者/著者前缀或后缀，再去除首尾空白；清洗结果为空时不覆盖已有字段。只有清洗后的值非空且 `canReName` 与调用方均允许，或原字段为空时，才写入 Book。
- 分类列表以逗号拼接；
- 字数经过统一格式化；
- 简介以 `<usehtml>`、`<md>` 或 `<useweb>` 开头时保留特殊格式，否则经过简介 HTML 格式化；
- 封面 URL 相对 `redirectUrl` 转绝对 URL；
- 目录 URL 使用 `isUrl=true`，空值回退 `baseUrl`；
- 目录 URL 与详情 `baseUrl` 相同则缓存当前 body 到 `tocHtml`；
- 文件源的下载 URL 使用 URL 列表解析，空列表抛出“下载链接为空”。

因此详情页可能同时完成书籍详情和目录页准备，目录流程必须先检查 `bookUrl == tocUrl && tocHtml`，避免重复请求。

## 数据流和提交边界（Android 与迁移注记）

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

`infoHtml` 和 `tocHtml` 是本次运行的临时响应，不属于书源导出数据。当前实现返回 `RuntimeResult<BookMetadata>`；详情工作流不写数据库，统一结果和提交目标分别见 [source-core 工作流](../../../../packages/source-core/docs/workflows.md) 与 [运行时接口归档](../../../archive/runtime-interface-design.md)。

状态转换为 `created -> loading -> parsing -> normalized -> completed`。缓存命中从 `created -> parsing`，请求失败、必需输入失败或文件源无下载地址进入 `failed`；取消可以从任意活动状态进入 `cancelled`，不得提交部分 Book 更新。提交应在所有字段处理完成后执行一次，字段处理中间值只存在于局部副本，避免详情失败时污染已有书籍。

字段失败策略必须保留 Android 的差异：`init`、书名、作者和目录地址属于主流程，解析失败直接抛出异常，不产生字段级诊断；分类、字数、最新章节、简介和封面读取失败记录字段诊断并继续；文件源的 `downloadUrls` 为空是流程失败。`canReName` 由调用方权限和规则字段非空共同决定，不能由书源页面内容动态改变。

完成事件应携带 `bookUrl`、`origin`、最终响应 URL、更新字段集合和诊断。若 `tocUrl` 等于详情响应基准 URL，必须同时保存 `tocHtml`，目录流程随后直接消费该响应；若目录地址不同，只保存地址，不提前请求目录。

## JavaScript 源差异

JS 源的 `getBookInfo(book)` 是可选函数，缺失或返回空时保留搜索阶段字段。返回对象只允许覆盖明确的详情字段，包括 `tocUrl`；不能覆盖 `bookUrl`、阅读进度等运行状态。`downloadUrls` 的兼容归一化规则是：非数组值忽略并记录诊断；数组中只保留非空字符串；大小写不敏感地过滤以 `javascript` 开头的协议值；相对 URL 按 `book.bookUrl` 转为绝对 URL；最后按绝对 URL 去重并保持首次出现顺序。`variable` 支持对象或 JSON 字符串并替换现有书籍变量。

Web 输入绑定 sourceRevision 和 Book 的 baseRevision。返回的 updatedFields 是明确允许提交的集合，不执行整对象覆盖；失败返回诊断并保持输入对象不变。infoHtml/tocHtml 复用必须同时带最终响应 URL、源版本和会话身份；跨 HTTP 使用服务端缓存引用，不能仅传一段 HTML 就假定属于当前源。成功返回后应用提交 changes，提交失败与规则解析失败分开。
