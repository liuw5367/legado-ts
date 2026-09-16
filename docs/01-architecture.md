# 架构与职责映射

## 当前实现的调用关系

```text
导入
  ImportBookSourceViewModel
    -> BookSourceImport / JsSourceConfig
    -> SourceHelp / BookSourceDao

运行时
  SearchModel / WebBook
    -> AnalyzeUrl                 请求并展开 URL 规则
    -> AnalyzeRule                执行字段规则
    -> BookList / BookInfo
    -> BookChapterList / BookContent
    -> SearchBook / Book / BookChapter
```

`WebBook` 先依据 `mainJs` 是否非空分流：非空时走 `JsSourceBook`，否则走声明式规则流程。声明式流程的四个领域处理器共享 `AnalyzeRule` 和 `AnalyzeUrl`，但每个处理器对空值、字段覆盖和分页有自己的语义。

## TypeScript 目标分层

### 纯核心层

核心层只处理确定性逻辑：

- schema 解析和导入分类；
- 规则文本词法拆分、模式选择和规则链执行；
- 结果归一化、替换、变量作用域和 URL 解析；
- 搜索/详情/目录/正文流程状态机；
- 并发、超时、取消的抽象约定。

### 宿主端口

以下能力通过依赖注入提供：

- `HttpClient`：请求、响应、重定向和响应字节；
- `HtmlParser`：Jsoup 兼容的 HTML/CSS/属性/文本节点访问；
- `XPathParser` 与 `JsonPathParser`；
- `JavaScriptRuntime`：受限脚本执行、超时和取消；
- `CookieStore`、`CacheStore`、`Logger`、`RateLimiter`。

### 上层应用

上层应用负责书源列表、持久化、搜索进度展示、登录页面、代理路由和编辑器 UI。上层不能自行重新解释规则字段；预览和运行时必须调用同一个核心解析器。

## 关键边界

- HTML 解析器产生的 DOM 是规则输入；`getElements` 返回 DOM 节点引用或其适配对象。
- JSONPath 规则可以返回对象、数组或标量；进入 `getString`/`getStringList` 时才转换为文本。
- 规则执行错误和网络错误必须带阶段、字段、书源 URL 和原始规则，方便编辑器显示。
- `mainJs` 与声明式规则是两条执行路径；不能将 JavaScript 书源自动转换成声明式规则后丢弃原脚本。

