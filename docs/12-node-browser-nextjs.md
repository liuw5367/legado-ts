# Node、浏览器和 Next.js

| 能力 | Node 服务 | 浏览器 SPA | Next.js SSR |
| --- | --- | --- | --- |
| 直连书源 | 可以，受网络和站点限制 | 通常受 CORS 限制 | 服务端可以 |
| HTML/CSS/XPath/JSONPath | 由 Node adapter 提供 | 可提供轻量解析器 | 与 Node 共用 |
| Cookie 持久化 | 服务端会话/数据库 | 浏览器 Cookie 或代理会话 | 必须按请求隔离 |
| JS 书源 | 受限脚本沙箱 | 不应直接执行不可信脚本 | 受限脚本沙箱 |
| WebView/WebJS | 默认不提供，需独立浏览器 adapter | 可选真实浏览器能力 | 不应在普通 SSR 进程内隐式启动 |
| 缓存 | Redis/文件/内存均可 | IndexedDB/上层服务 | 请求缓存 + 服务端共享缓存 |

## SPA 边界

SPA 只调用后端代理 API，例如 `search`、`book-info`、`toc`、`content`。不要把任意书源 URL和 Cookie直接交给浏览器；代理层要做源白名单、超时、响应大小和日志脱敏。

## Node 服务

Node adapter 提供 HTTP、HTML DOM、XPath、JSONPath、Cookie 和缓存实现。每个请求创建 `RuntimeContext`，并通过 `try/finally` 清理临时脚本 scope、请求级 Cookie 和 AbortController 监听器。

## Next.js SSR

服务器组件或 route handler 可以直接调用核心库，但必须：

- 从请求上下文创建独立 `RuntimeHost` 或隔离 CookieStore；
- 用 `AbortSignal` 关联客户端断开；
- 设置短于平台限制的请求超时；
- 禁止把 `Book`、变量 map、JS scope 或 header map 放进模块级单例；
- 对书源响应做大小限制和内容类型检查。

## 浏览器安全

书源脚本是外部输入。浏览器端编辑器可以做语法解析、静态检查和脱敏预览，但运行脚本必须交给后端沙箱。`@webjs`、文件访问、代理和 DNS 覆盖属于能力缺失，不应在浏览器中伪造成功。

