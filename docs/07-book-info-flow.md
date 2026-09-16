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
- 目录 URL与详情 `baseUrl` 相同则缓存当前 body 到 `tocHtml`；
- 文件源的下载 URL使用 URL 列表解析，空列表抛出“下载链接为空”。

因此详情页可能同时完成书籍详情和目录页准备，目录流程必须先检查 `bookUrl == tocUrl && tocHtml`，避免重复请求。

## JavaScript 源差异

JS 源的 `getBookInfo(book)` 是可选函数，缺失或返回空时保留搜索阶段字段。返回对象只允许覆盖明确的详情字段；不能覆盖 `bookUrl`、阅读进度等运行状态。`downloadUrls` 必须是字符串数组，过滤空字符串、`javascript:` 和重复 URL；`variable` 支持对象或 JSON 字符串并替换现有书籍变量。
