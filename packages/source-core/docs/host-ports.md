# source-core 宿主端口

端口定义在 [`runtime/contracts.ts`](../src/runtime/contracts.ts)、[`workflows/types.ts`](../src/workflows/types.ts) 和 [`model/types.ts`](../src/model/types.ts)。source-core 只编排规则和流程，宿主负责能力、资源和提交；当前导出的是分层端口，不是历史设计中的统一 `RuntimeHost`。

## 工作流端口

`WorkflowPorts` 必须提供：

- `network: NetworkHost`，执行 core 生成的 `RequestPlan`；
- `rules: WorkflowRulePort`，求值声明式规则，按需执行 source function、精确 JavaScript hook 和图片解密脚本；
- 可选 `request`，完整接管 URL/options、Cookie、编码、重试和响应语义；它不是单纯的 raw HTTP transport；
- 可选 `decodeResponse`、`concurrency` 和 `requestObserver`。

`ReadingPorts` 当前是 `WorkflowPorts` 的类型别名。原始页面缓存不属于核心端口，不能从目录/正文流程偷偷读写。

## NetworkHost

`NetworkHost.request(plan)` 接收已经验证的 `RequestPlan`，返回最终 URL、状态码、响应头、bytes 和重定向标记。宿主还可以提供：

- `defaultUserAgent`：只在 source header 没有 User-Agent 时使用；URL options 的显式 Header 最后覆盖；
- `getLoginHeaders(sourceId)` 和 `isLoginHeaderSite`：读取独立凭据并限制初始 URL 的同站范围；core 默认只允许精确主机名；
- `encodeCharset(value, charset)`：为书源 URL 查询或表单参数提供非 UTF-8 编码。

代理、DNS、WebView、CookieJar、serverId 和限流旁路是 `RequestExecutionHints`，宿主必须按自己的安全策略明确接受或返回能力错误。不能通过修改 URL 或 Header 假装已经支持 WebView。

## 规则、解析器和编码端口

`WorkflowRulePort.evaluate` 接收 `WorkflowRuleRequest`，返回 `text`/`nodes` 期望形态的 `WorkflowRuleOutput`；`executeSourceFunction`、`executeWorkflowJavaScript` 和 `executeImageDecodeScript` 是可选能力，未提供时必须报告 `capability-missing`。

规则 runtime 使用以下平台端口：

| 端口 | 最小责任 |
| --- | --- |
| `HtmlParser` / `HtmlDocument` | CSS 选择、子节点、属性、text/textNodes/ownText/html/all 读取和非破坏性 child 视图 |
| `XPathParser` | 先 `parse` 再 `evaluate`，保留节点、标量、列表和空选择的区别 |
| `JsonPathParser` | 返回 JSONPath 的值或空选择；不把对象和数组提前转成文本 |
| `CharsetCodec` | 请求编码和响应 bytes 解码；不支持字符集时报告能力错误 |
| `EncodingHost` / `CryptoHost` | Base64、hex、URI、摘要、HMAC 和对称加密，保留 bytes 边界 |
| `FontHost` / `ArchiveHost` | 受预算解析字体、归档和压缩比，拒绝不安全路径或超量输入 |
| `JavaScriptHost` | 受预算、scope、取消和输出大小限制执行脚本 |

完整接口仍以 [`runtime/contracts.ts`](../src/runtime/contracts.ts) 和 [`runtime/javascript.ts`](../src/runtime/javascript.ts) 为准；本页不复制每个字段。

## 正文 ContentStore

正文 cache-first 工作流使用 `ContentIdentity`、`ContentSaveToken` 和 `ContentStore`：

1. `read(identity)` 读取稳定身份的 `ContentCacheRecord`；正文、图片、音频、视频和文件必须使用不同 `resourceKind`。
2. 未命中或 `refresh=true` 时，core 执行正文流程；需要保存时调用 `reserve(identity, operationId)`。
3. `write({ token, record, saveChapterMetadata })` 只能在 token 仍是当前版本时提交正文、最终响应 URL、章节字段和附加资源。

`StoreWriteResult.status` 是 `committed`、`rejected`、`stale`、`cancelled` 或 `unknown`；调用方不能只看兼容保留的 `committed: boolean`。正文写入必须条件化，不能因为请求完成就覆盖较新目录或规则版本。

## Source session 与关闭

`createSourceSession` 为固定、冻结的 `NormalizedSource` 创建 source 级限流和变量会话。每次 `run`：

- 获取本次操作的 source 变量快照、隔离规则 runtime 和请求观察器；
- 使用共享的 `NetworkHost` 与 `concurrentRate` 窗口，但不共享 guest JS 可变对象；
- 在操作结束时合并 `source` 变量差异，按完成顺序处理并发更新；
- `close()` 释放限流等待，关闭后拒绝新工作流。

应用编辑、覆盖或删除书源时应先关闭旧 session，再用新版本创建。凭据、Repository、书架、用户状态和调度器仍由应用负责。

## 统一接口的边界

历史 `RuntimeHost`、`VariableStore`、`ResourceStore`、`RateLimiter` 和 `Logger` 目标设计没有作为当前统一门面导出，保存在[历史接口设计](../../../docs/archive/runtime-interface-design.md)。需要统一门面时先以当前端口组合，不能直接引用归档名称作为实现依赖。
