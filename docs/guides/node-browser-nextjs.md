# Node、Edge、浏览器和框架入口

本章是目标设计，不代表已有代码。以下描述 Node 服务、浏览器 SPA、Next.js/React Router 与 Edge 作为候选宿主的接入边界和预期数据流；当前仓库尚未实现 TypeScript runtime，流程与能力描述不代表已有实现。

| 能力 | Node 服务 | 浏览器 SPA | Next.js SSR | React Router 服务端 | Edge |
| --- | --- | --- | --- | --- | --- |
| 直连书源 | 可以，受网络和站点限制 | 通常受 CORS 限制，走后端代理 | 服务端可以 | 服务端可以 | 取决于部署出口与目标站点 |
| HTML/CSS/XPath/JSONPath | 由 Node adapter 提供 | 只提供受限解析或调用后端 | 与 Node 共用 | 与 Node facade 共用 | 仅使用已验证的解析器 |
| Cookie 持久化 | 按用户/源隔离的宿主存储 | 使用后端会话，不能冒充目标站 Cookie | 请求独立视图、会话持久化 | 由服务端 adapter 提供 | 只能使用平台允许的隔离存储 |
| JS 书源 | 受限脚本沙箱 | 不直接执行不可信脚本 | 受限脚本沙箱 | 受限脚本沙箱 | 需单独验证脚本运行时 |
| WebView/WebJS | 默认不提供，需浏览器 adapter | 由后端能力提供，页面 DOM 不等价 | 不隐式启动 | 不隐式启动 | 通常为 capability-missing |
| 缓存 | Redis/文件/内存均可 | IndexedDB 或上层服务 | 请求缓存 + 服务端共享缓存 | 与 Node facade 共用 | 仅使用部署平台允许的短期缓存 |

## SPA 边界

SPA 只调用后端代理 API，例如 `explore`、`search`、`book-info`、`toc`、`content`。不要把任意书源 URL 和 Cookie 直接交给浏览器；代理层要做源白名单、超时、响应大小和日志脱敏。

## Node 服务

Node adapter 提供 HTTP、解析器、Cookie 和缓存。请求创建隔离上下文，finally 释放 scope、Cookie 视图和监听器，不删除持久会话 Cookie。

Node 服务的请求数据流固定为：

```text
HTTP 请求
  -> 校验 action、sourceUrl、book/chapter 输入和来源白名单
  -> 创建 requestId、AbortController、RuntimeHost、VariableStore 和 RuleVariableView
  -> 调用 source-core 的 import/search/book-info/toc/content
  -> 将领域结果或结构化错误转换为 API DTO
  -> 提交允许的缓存/持久化变更
  -> finally 释放 scope、Cookie 视图、监听器和临时响应体
```

服务端 API 至少要区分 `explore`、`search`、`book-info`、`toc` 和 `content` 五种 action。导入和编辑预览使用受权限控制的独立入口。请求 DTO 只接收书源身份、流程输入、分页和取消上下文，不能接收任意宿主对象；响应 DTO 包含 `requestId`、阶段、结果数据、诊断和能力状态。`source-core` 的 `SourceRuntimeError` 映射为稳定错误码和 HTTP 状态，原始异常只写脱敏日志，不能把密码、Cookie、Token 或完整私有请求体返回给浏览器。

每个 action 都使用统一 envelope：

```ts
interface ActionRequest<T> {
  requestId: string
  operationId: string
  sourceId: string
  sourceRevision: string
  input: T
  signal?: AbortSignal
}

interface ActionResponse<T> {
  requestId: string
  operationId: string
  status: 'success' | 'empty' | 'partial' | 'failed' | 'cancelled' | 'stale' | 'capability-missing'
  value?: T
  diagnostics: RuntimeDiagnostic[]
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}
```

`value`、错误和诊断可以同时表达部分结果，但 `status` 必须说明调用方能否继续。客户端断开、超时和取消停止新工作；应用等待 cleanup 后记录最终状态，无法发送响应时不把 HTTP 499 当作核心错误。缓存命中、空结果和上游失败分别使用 `success/empty/failed`，不能只依赖 HTTP 200。

目标 HTTP 映射：用户输入错误 400、权限或策略拒绝 403、版本冲突 409、宿主能力缺失 501、上游失败 502、上游/流程等待超时 504、存储/内部错误 500。客户端已断开时停止工作，不假设还能发送 499；取消以内部 code 记录。错误 DTO 保留 code、stage、requestId、operationId 和安全 message；核心错误不依赖 HTTP 状态。具体状态码属于 adapter 版本契约，必须与 Web API bridge 和客户端测试同步。

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

Edge 只作为候选宿主。是否可执行某条书源，取决于目标部署环境能否提供该书源所需的 HTTP、HTML/XPath/JSONPath、Cookie、受限脚本、文件、浏览器与存储端口。适配器需按 [能力清单](../reference/capability-inventory.md) 和实际 fixture 输出能力报告；缺少能力时把操作交给具备该能力的服务端入口，或返回结构化 capability error。不能因为简单声明式书源在 Edge 上成功，就宣称所有 JS 源、WebJS 或媒体源可运行。

能力报告至少包含 `required`、`supported`、`missing`、`dynamicUnknown`、宿主版本和检查时间。`missing` 产生 `capability-missing`，`dynamicUnknown` 只能产生待验证诊断；它们不应被转换为空结果。

React Router 的服务端入口与 Next.js route handler 使用同一 package API 和请求隔离规则。框架只决定请求如何进入、结果如何传给页面，以及部署适配器如何创建 `RuntimeHost`；书源规则、字段归一化、错误与保存 token 不能在框架层另写一份。SPA、Next.js 和 React Router 的最小应用调用顺序见 [独立 package 的调用契约](package-usage.md)。

平台版本、JS 执行限制和部署验收以 [运行边界与部署验收](../operations/runtime-security-and-deployment.md) 为唯一来源。框架尚未选型，不预建 source-next 等包；先用框架无关处理器验证。静态页面可部署 CDN，书源操作仍经过服务端。实例内缓存不能承担跨请求身份或版本存储。
