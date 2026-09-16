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

`WebBook` 先依据 `mainJs` 是否非空分流：非空时走 `JsSourceBook`，否则走声明式规则流程。声明式流程的发现、搜索、详情、目录和正文处理共享 `AnalyzeRule` 和 `AnalyzeUrl`，但每个处理器对空值、字段覆盖和分页有自己的语义。

## TypeScript 目标分层

### 纯核心层

核心层解释书源规则，并通过宿主端口编排流程：

- schema 解析和导入分类；
- 发现分类解释、选定分类后的列表流程；
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
- `CookieStore`、`CacheStore`、`VariableStoreFactory`、`Logger`、`RateLimiter`；
- `JavaApi`、`SourceApi`：仅作为 JS 源脚本的受限兼容外观，由宿主按 capability 注入。

### 上层应用

上层应用负责书源列表、持久化、搜索与发现进度展示、登录页面、代理路由和编辑器 UI。上层不能自行重新解释规则字段；预览和运行时必须调用同一个核心解析器。书源交互能力通过版本化宿主接口与应用对接，不因属于 Android UI 就从能力清单中删除。

## 关键边界

- HTML 解析器产生的 DOM 是规则输入；`getElements` 返回 DOM 节点引用或其适配对象。
- JSONPath 规则可以返回对象、数组或标量；进入 `getString`/`getStringList` 时才转换为文本。
- 规则执行错误和网络错误必须带阶段、字段、书源 URL 和原始规则，方便编辑器显示。
- `mainJs` 与声明式规则是两条执行路径；不能将 JavaScript 书源自动转换成声明式规则后丢弃原脚本。

## 统一处理流程

所有领域流程都遵循同一条边界：

```text
上层输入 DTO
  -> 创建 requestId、RuleContext、VariableStore 和 AbortSignal
  -> 书源分流
  -> URL 展开与请求计划
  -> Host 执行请求
  -> AnalyzeRule 等价规则解析
  -> 领域对象归一化
  -> 领域级去重、分页、排序或正文处理
  -> 生成事件、诊断和持久化变更
  -> 上层提交或返回 DTO
  -> finally 清理请求资源
```

核心流程输出“结果加变更”，宿主或上层应用负责提交变更。每个阶段都要明确成功、空结果、可继续错误、终止错误、取消和清理行为；领域流程分别见发现、搜索、详情、目录和正文文档。应用调用顺序见 [独立 package 的调用契约](18-package-usage.md)。
