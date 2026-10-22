# 规则、变量与请求

规则实现位于 [`rules/`](../src/rules/)，请求计划位于 [`runtime/request-plan.ts`](../src/runtime/request-plan.ts)，书源请求适配位于 [`workflows/source-request.ts`](../src/workflows/source-request.ts)。本页说明 core 已实现的边界；规则语义的 Android 来源见[上游资料](../../../docs/upstream/README.md)，兼容缺口见[差异登记](../../../docs/compatibility/known-divergences.md)。

## 编译与求值

`compileRule` 把规则文本转成不可变的 `CompiledRule`：

- `RuleAtom` 记录原文、UTF-16 span、模式、正文、所需 capability、前置 `put` 和结果替换；
- `RuleSequence` 记录 `&&`、`||`、`%%` 组合及子规则；
- `RuleMode` 当前包括 `Default`、`XPath`、`Json`、`Js`、`Regex` 和 `WebJs`；
- `inspectRuleCapabilities` 返回 text、variables、parser、javascript 或 webview 等要求。

`evaluateRule` 使用 `RuleContext` 的 content、source、可选 book/chapter、变量视图和取消信号。默认预算为 1000 步、32 层深度和 256 KiB 输出；调用方可覆盖，但不能绕过宿主的脚本、网络或总字节预算。结果状态为 `success`、`empty`、`failed`、`cancelled`、`capability-missing` 或 `budget-exceeded`，并带 `RuleDiagnostic[]` 和 `VariableChange[]`。

Default 模式只对纯文本、literal 和变量插值做安全处理；CSS、XPath、JSONPath、JavaScript、WebView 和递归模板需要对应 `WorkflowRulePort` 能力。合法空列表、空字符串、null、节点集合和能力缺失必须保持可区分，不能把 parser 缺失伪装成空结果。

## 变量作用域

`RuleVariableView` 的作用域按 `local`、`chapter`、`book`、`rule-data`、`source` 区分。读取遵守从具体到通用的顺序；写入只能进入本次调用允许的作用域；`snapshot` 用于 session 在操作结束时提交 source 变量变化。`MemoryVariableView` 只提供内存实现，不替代应用持久化。

请求脚本可以看到 `book` 和内部章节 scope，但内部 `__legadoInternalChapterScope` 不会被映射成 URL 脚本的全局 `chapter`。正文首请求的 chapter 仅用于 `java.get/put`，分页和副内容请求不携带章节作用域。

## URL 与 RequestPlan

`createRequestPlan` 负责：

1. 以 `baseUrl` 展开绝对或相对 URL，只接受 HTTP(S)；
2. 将方法限制为 `GET`、`POST`、`HEAD`，验证请求体字节数和预算；
3. 合并 Header、请求/响应字符集、followRedirects、text/bytes 响应类型；
4. 保留 WebView、DNS、代理、Cookie、serverId、限流旁路等执行提示。

默认预算和稳定错误码位于 [`request-plan.ts`](../src/runtime/request-plan.ts)。`useWebView` 目前返回 `webview-required`，普通 Node HTTP 不能静默降级；是否可执行由目标宿主另行登记。

## SourceRequestRuntime

`SourceRequestRuntime` 把书源 URL 的 JSON options 或 `@js`/bodyJs/header 脚本转换为 `NetworkHost` 可执行的请求：

- URL options 的方法、body、charset、responseCharset、retry、timeout、followRedirects、webView、proxy、dnsIp 和 sourceRegex 先经过受控解析；
- source header、宿主默认 User-Agent、独立登录凭据和 URL options Header 按 Android 兼容顺序合并，显式 URL Header 可以覆盖；
- Cookie、Content-Type charset、JSON/XML/form body 和响应重定向由 runtime 处理，NetworkHost 只执行已经形成的计划；
- `bodyJs`、规则脚本和 bridge 子请求沿用当前操作的 signal、stage、book 和响应最终 URL；请求入口为整条脚本请求链生成默认 30 秒绝对 deadline（显式值最多 30 分钟），子请求继承该 deadline；动态 Header 的递归重入按当前 TS 策略限制；
- HTTP/解析/脚本错误映射为 `SourceRequestError`，错误码为 `invalid-config`、`capability-missing`、`cancelled` 或 `rule-failed`。

源码事实以 [`source-request.ts`](../src/workflows/source-request.ts) 和请求测试为准；不要从历史统一 `HttpClient`/`RuntimeHost` 示例推导当前字段。

## SourceRuleRuntime 与 session

`SourceRuleRuntime` 组合 parser、JavaScript、encoding、crypto、font 和 bridge port；它不持有全局 source 或用户状态。`createSourceSession` 在会话边界添加 source 级 `concurrentRate`、脚本缓存和 source 变量快照，每次 `run` 创建隔离工作流上下文，结束后合并变量差异，`close()` 释放限流等待。Node 宿主为声明式 `jsLib` 提供绑定 session identity 的可序列化状态键；它只恢复 JSON/数字等 DTO，不能把 QuickJS 函数、闭包、宿主对象或句柄写入缓存，整源 JS 仍按调用重建作用域。

应用编辑或删除书源时必须关闭旧 session；不允许以模块级单例共享 guest JavaScript、Cookie、变量或解析节点。

## 请求与规则测试

规则修改运行 `packages/source-core/tests/rules.test.ts`、`runtime.test.ts` 和对应 source fixture；请求修改运行 `request-url.test.ts`、`request-observer.test.ts` 或 `source-request.test.ts`。网络、WebView、登录和跨端 golden 未执行时，状态写入[兼容性状态](../../../docs/compatibility/status.md)，不写成“已兼容”。
