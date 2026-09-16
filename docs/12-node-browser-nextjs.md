# Node、Edge、浏览器和框架入口

| 能力 | Node 服务 | 浏览器 SPA | Next.js SSR |
| --- | --- | --- | --- |
| 直连书源 | 可以，受网络和站点限制 | 通常受 CORS 限制 | 服务端可以 |
| HTML/CSS/XPath/JSONPath | 由 Node adapter 提供 | 可提供轻量解析器 | 与 Node 共用 |
| Cookie 持久化 | 服务端会话/数据库 | 浏览器 Cookie 或代理会话 | 必须按请求隔离 |
| JS 书源 | 受限脚本沙箱 | 不应直接执行不可信脚本 | 受限脚本沙箱 |
| WebView/WebJS | 默认不提供，需独立浏览器 adapter | 可选真实浏览器能力 | 不应在普通 SSR 进程内隐式启动 |
| 缓存 | Redis/文件/内存均可 | IndexedDB/上层服务 | 请求缓存 + 服务端共享缓存 |

## SPA 边界

SPA 只调用后端代理 API，例如 `explore`、`search`、`book-info`、`toc`、`content`。不要把任意书源 URL 和 Cookie 直接交给浏览器；代理层要做源白名单、超时、响应大小和日志脱敏。

## Node 服务

Node adapter 提供 HTTP、HTML DOM、XPath、JSONPath、Cookie 和缓存实现。每个请求创建 `RuntimeContext`，并通过 `try/finally` 清理临时脚本 scope、请求级 Cookie 和 AbortController 监听器。

Node 服务的请求数据流固定为：

```text
HTTP 请求
  -> 校验 action、sourceUrl、book/chapter 输入和来源白名单
  -> 创建 requestId、AbortController、RuntimeHost 和 VariableStore
  -> 调用 source-core 的 import/search/book-info/toc/content
  -> 将领域结果或结构化错误转换为 API DTO
  -> 提交允许的缓存/持久化变更
  -> finally 释放 scope、Cookie 视图、监听器和临时响应体
```

服务端 API 至少要区分 `explore`、`search`、`book-info`、`toc` 和 `content` 五种 action。导入和编辑预览使用受权限控制的独立入口。请求 DTO 只接收书源身份、流程输入、分页和取消上下文，不能接收任意宿主对象；响应 DTO 包含 `requestId`、阶段、结果数据、诊断和能力状态。`source-core` 的 `SourceRuntimeError` 映射为稳定错误码和 HTTP 状态，原始异常只写脱敏日志，不能把密码、Cookie、Token 或完整私有请求体返回给浏览器。

Node/Next adapter 的默认 HTTP 映射固定为：输入、解析和 schema 错误为 `400`；来源白名单或宿主能力不足为 `403`；单次或流程超时为 `408`；客户端主动取消可用 `499`；上游请求失败为 `502`；缓存、正文存储和其他未分类内部错误为 `500`。错误 DTO 必须同时保留稳定 `code`、`stage`、`requestId` 和可安全展示的 `message`；实际部署若使用不同状态码，必须在 adapter 文档和 conformance fixture 中明确覆盖。

运行上下文的所有权属于一次 HTTP 请求。请求结束、客户端断开、超时、异常和正常完成都必须触发同一清理路径；共享缓存只能共享经过书源身份、资源身份和版本 token 隔离的结果，不能共享 Cookie、变量、JS 全局对象或当前 `Book`。

## Next.js SSR

服务器组件或 route handler 可以直接调用核心库，但必须：

- 从请求上下文创建独立 `RuntimeHost` 或隔离 CookieStore；
- 用 `AbortSignal` 关联客户端断开；
- 设置短于平台限制的请求超时；
- 禁止把 `Book`、变量 map、JS scope 或 header map 放进模块级单例；
- 对书源响应做大小限制和内容类型检查。

Next.js 的服务端数据流与 Node 服务一致。服务器组件负责读取请求上下文并调用服务端 facade，route handler 负责 DTO 和错误映射，浏览器组件只接收脱敏结果。动态书源响应不能被静态生成缓存；若使用 Next 的 `fetch` 缓存，缓存键必须包含书源身份、请求 URL、规则版本和必要的用户会话边界。流式响应或客户端断开时，`AbortSignal` 必须继续传递到分页、解析和脚本执行。

## 浏览器安全

书源脚本是外部输入。浏览器端编辑器可以做语法解析、静态检查和脱敏预览，但运行脚本必须交给后端沙箱。`@webjs`、文件访问、代理和 DNS 覆盖属于能力缺失，不应在浏览器中伪造成功。

## Edge 与 React Router

Edge 只作为候选宿主。是否可执行某条书源，取决于目标部署环境能否提供该书源所需的 HTTP、HTML/XPath/JSONPath、Cookie、受限脚本、文件、浏览器与存储端口。适配器需按 [能力清单](19-capability-inventory.md) 和实际 fixture 输出能力报告；缺少能力时把操作交给具备该能力的服务端入口，或返回结构化 capability error。不能因为简单声明式书源在 Edge 上成功，就宣称所有 JS 源、WebJS 或媒体源可运行。

React Router 的服务端入口与 Next.js route handler 使用同一 package API 和请求隔离规则。框架只决定请求如何进入、结果如何传给页面，以及部署适配器如何创建 `RuntimeHost`；书源规则、字段归一化、错误与保存 token 不能在框架层另写一份。SPA、Next.js 和 React Router 的最小应用调用顺序见 [独立 package 的调用契约](18-package-usage.md)。
