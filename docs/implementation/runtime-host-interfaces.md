# TypeScript 宿主接口

本章定义独立库的**目标端口**。核心负责规则与流程，宿主负责网络、解析器、脚本、状态与日志。以下名称作为目标契约维护；状态和副作用的单一事实源为 [身份、状态与副作用](../standard/state-and-effects.md)。接口示意不代表全部已有实现——流程层已落地的 `WorkflowPorts` / `ReadingPorts` 及 Node 侧 `SourceRuleHost` / `SourceRequestHost` 以 [包使用与当前导出](package-usage.md) 为准；目标 `RuntimeHost`、`ContentSaveToken` 等尚未按该名称导出，差异见 [已知差异](../divergence/known-divergences.md)。

## 请求和响应

```ts
export type HttpMethod = 'GET' | 'POST' | 'HEAD'

export interface HttpRequest {
  /** 规则展开后的初始绝对 URL；重定向发生在请求执行期间。 */
  url: string
  /** HTTP 方法。默认值由 URL 规则层决定，宿主不能自行改写。 */
  method: HttpMethod
  /** 已合并的请求头。Cookie 规则完成后再交给宿主。 */
  headers: Record<string, string>
  /** 原始请求体。表单、JSON、XML 的编码由核心层根据规则决定。 */
  body?: string | Uint8Array
  /** 单次请求超时时间，单位为毫秒。非法值应在进入宿主前报告。 */
  timeoutMs?: number
  /** 是否跟随重定向。未提供时使用核心层定义的默认值。 */
  followRedirects?: boolean
  /** 来自 RequestPlan 的 WebView、DNS、代理、节点和响应执行提示。 */
  execution?: RequestExecutionHints
  /** 当前操作的请求/响应/总字节预算；宿主必须在发送和解压过程中执行。 */
  budget?: RequestBudget
  /** 取消当前请求、规则执行和后续分页的信号。 */
  signal?: AbortSignal
}

export interface HttpResponse {
  /** 最终响应 URL，供相对链接和后续分页使用。 */
  url: string
  /** HTTP 状态码。网络失败没有响应时不能伪造为 200。 */
  status: number
  /** 响应头。重复头可以保留为数组，不能静默丢失 Set-Cookie。 */
  headers: Record<string, string | string[]>
  /** HTTP 解压后的原始响应字节；宿主必须先执行 maxResponseBytes/maxTotalBytes，超限不得返回部分成功。 */
  bytes: Uint8Array
  /** 是否发生过重定向。不能仅根据 url 是否变化推断。 */
  redirected: boolean
}

export interface HttpClient {
  /** 执行一次已经由核心层展开的请求，并保留取消和超时语义。 */
  request(request: HttpRequest): Promise<HttpResponse>
}

export interface CharsetCodec {
  /** 将请求参数或文本按指定字符集编码；不支持时返回能力错误。 */
  encode(text: string, charset: string): Uint8Array
  /** 按核心选定的响应字符集解码，保留 bytes 供诊断及二进制分支使用。 */
  decode(bytes: Uint8Array, charset: string): string
}
```

`HttpClient` 接收的是已经展开的 `HttpRequest`。页码、关键字、URL 内嵌 JavaScript、请求体编码、Cookie 合并和相对 URL 解析属于核心层。代理、DNS 覆盖、WebView 和真实浏览器行为属于宿主能力，通过[运行时统一契约](runtime-contracts.md)的 `RequestExecutionHints` 显式传递，不能通过偷偷修改 `url` 或 `headers` 来伪装成普通 HTTP。

## 解析器端口

```ts
export interface HtmlNode {
  /** 当前节点在本次解析文档中的稳定身份，用于节点链和调试。 */
  readonly id: string
}

export interface HtmlDocument {
  /** 根据默认 CSS 选择器选择元素。 */
  select(selector: string): HtmlNode[]
  /** 读取节点属性；属性不存在时返回 undefined。 */
  attr(node: HtmlNode, name: string): string | undefined
  /** 读取节点文本、文本节点、直属文本或 HTML。 */
  read(node: HtmlNode, output: 'text' | 'textNodes' | 'ownText' | 'html' | 'all'): string
  /** 将节点转换为可继续执行规则链的文档视图。 */
  child(node: HtmlNode): HtmlDocument
}

export interface HtmlParser {
  /** 解析已经解码的文本；XML 声明使用 xml 模式，表格容器补齐由核心处理。 */
  parse(input: string, baseUrl?: string, mode?: 'html' | 'xml'): HtmlDocument
}

export interface XPathParser {
  /** 解析 XPath 规则使用的文档；宿主决定 HTML 修复和 XML 模式。 */
  parse(input: string): HtmlDocument
  /** 返回 XPath 选中的节点、对象、列表或字符串。 */
  evaluate(document: HtmlDocument, expression: string): unknown
}

export interface JsonPathParser {
  /** 返回 JSONPath 选中的值，空选择返回 undefined 或空列表，由核心层归一化。 */
  evaluate(value: unknown, expression: string): unknown
}
```

解析器端口只表达平台能力，规则模式、链条、索引、组合符号、替换和 URL 归一化仍由核心规则引擎控制。`HtmlDocument` 必须支持规则文档所需的元素选择、链式节点、属性、`text`、`textNodes`、`ownText`、`html`、`all` 和非破坏性索引过滤。`XPathParser` 和 `JsonPathParser` 要让核心层区分节点、对象、列表、字符串及空结果，不能把所有结果提前转成字符串。`XPathParser.parse` 是必需方法：核心规则运行时对文本内容先 `parse` 再 `evaluate`，只实现 `evaluate` 的适配器不满足该类型。

解析器适配器不变量：parse 返回的节点 ID 在 select/child 中稳定，child 不删除节点；空选择、空字符串、空列表、null、undefined 可区分。核心选择 HTML/XML 模式并补表格容器。CSS/XPath/JSONPath 语法错误分别可识别，合法无匹配是空结果。核心在兼容 JSONPath 入口捕获特定 parser error 转为空值，不能吞取消或预算错误。

`HtmlDocument.read` 的输出只负责文本和 HTML 序列化，节点选择仍通过 `HtmlNode` 传递；核心层负责旧式 `class.foo`、`tag.a`、`id.main`、索引、范围、排除和 `@` 终端输出的解释。这样同一个 parser adapter 可以被规则预览和运行时流程复用，而不会在编辑器中复制选择器语义。

## 脚本、Cookie 和缓存

```ts
export interface JavaScriptRuntime {
  /** 在受限环境中执行一段脚本，并返回可被 JS 语义归一化的值。 */
  execute(input: {
    /** 当前调用的绑定对象，如 source、book、chapter 和流程变量。 */
    bindings: Record<string, unknown>
    /** 要执行的脚本或函数表达式。 */
    code: string
    /** 当前调用身份；嵌套脚本不能脱离该操作创建新命名空间。 */
    operationId: string
    /** 脚本超时时间，单位为毫秒。 */
    timeoutMs?: number
    /** 脚本内存、调用深度和返回值大小限制。 */
    budget: {
      maxScriptMemoryBytes: number
      maxScriptTimeMs: number
      maxCallDepth: number
      maxResultBytes: number
      deadlineMs: number
    }
    /** 与请求绑定的取消信号。 */
    signal?: AbortSignal
  }): Promise<unknown>
}

export interface CookieStore {
  /** 读取当前 sessionId + sourceId 命名空间内、目标 URL 域和路径可见的 Cookie。 */
  get(url: string): Promise<string | undefined>
  /** 保存响应中的 Cookie，并按域、路径和安全属性处理。 */
  set(url: string, setCookie: string | string[]): Promise<void>
  /** 显式清除当前会话/书源 Cookie；不能作为请求 finally 的清理动作。 */
  clear(): Promise<void>
}

export interface CacheStore {
  /** 按当前 sessionId + sourceId 命名空间读取缓存，并校验版本 token。 */
  get<T>(key: string, versionToken?: string): Promise<T | undefined>
  /** 写入带身份、过期时间和版本 token 的缓存。 */
  set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void>
  /** 删除当前上下文可见的缓存项。 */
  delete(key: string): Promise<void>
}

export interface CacheWriteOptions {
  /** 缓存存活时间，未提供时使用宿主默认值。 */
  ttlMs?: number
  /** 缓存有效版本，隔离规则结果；防旧写入另用 ContentSaveToken。 */
  versionToken?: string
}

export interface ContentCacheRecord {
  /** 归一化后的正文、资源 URL 或文件链接。 */
  content: string
  /** 生成正文时收到的最终响应 URL；缓存命中必须原样返回。 */
  finalUrl: string
  /** 与正文一起产生的章节更新。 */
  chapter: BookChapter
  /** 音频歌词或视频弹幕；普通正文没有该字段。 */
  auxiliary?: { kind: 'lyrics' | 'danmaku'; content: string }
}

export interface ContentWriteInput {
  /** 当前正文请求生成的内容身份和版本 token。 */
  token: ContentSaveToken
  /** 正文及其最终 URL、章节元数据和附加资源必须作为一个缓存记录提交。 */
  record: ContentCacheRecord
  /** 是否在正文写入边界内保存章节标题、图片等元数据。 */
  saveChapterMetadata: boolean
}

export interface ContentIdentity {
  /** 源、书和章节的稳定身份；不得只使用章节 URL。 */
  sessionId: string
  sourceId: string
  bookUrl: string
  chapterKey: string
  /** 目录刷新和章节索引，防止旧目录正文回写到新目录。 */
  tocRevision: string
  chapterIndex: number
  /** 资源种类；正文、图片、音频、视频和文件必须使用不同身份。 */
  resourceKind: 'text' | 'image' | 'audio' | 'video' | 'file'
  /** 规则语义和源版本，防止旧规则写入新缓存。 */
  sourceRevision: string
  semanticVersion: string
}

export interface ContentSaveToken {
  /** 一次正文或资源写入的操作身份。 */
  operationId: string
  /** 为目标资源保留的写入代次。 */
  writeVersion: string
  /** 生成 token 时使用的内容身份。 */
  identity: ContentIdentity
  /** token 失效时返回 stale，不允许继续写入。 */
  expiresAt?: number
}

export interface ContentStore {
  /** 按稳定资源身份读取缓存，不递增写入代次；旧的不完整记录按未命中处理。 */
  read(identity: ContentIdentity): Promise<ContentCacheRecord | undefined>
  /** 只在 token 仍为当前版本时写正文、最终 URL、章节元数据和附加资源。 */
  write(input: ContentWriteInput): Promise<StoreWriteResult>
  /** 为要求保存的新操作原子预留写入代次；缓存命中时不调用。 */
  reserve(identity: ContentIdentity, operationId: string): Promise<ContentSaveToken>
}

export interface ResourceValue {
  /** 资源最终 URL；可与二进制 bytes 同时存在。 */
  url?: string
  /** MIME 类型；未知时为空，不根据 URL 后缀强行猜测。 */
  mimeType?: string
  /** 资源编码；二进制资源通常为空。 */
  charset?: string
  /** 解密或下载后的原始字节。 */
  bytes: Uint8Array
}

export interface ResourceStore {
  /** 按资源身份读取图片、音频、视频或文件；不递增写入代次。 */
  read(identity: ContentIdentity): Promise<ResourceValue | undefined>
  /** 只有 token 仍有效时保存资源和关联元数据。 */
  write(input: { token: ContentSaveToken; resource: ResourceValue }): Promise<StoreWriteResult>
  /** 为资源写入预留代次，语义与 ContentStore 一致。 */
  reserve(identity: ContentIdentity, operationId: string): Promise<ContentSaveToken>
}

export interface StoreWriteResult {
  /** 已确认提交、被拒绝、因版本/取消失效，或无法确认底层结果。 */
  status: 'committed' | 'rejected' | 'stale' | 'cancelled' | 'unknown'
  /** 仅为兼容调用方保留；判断结果必须使用 status。 */
  committed: boolean
  operationId: string
  resourceKey: string
  reason?: string
}

export interface RateLimiter {
  /** 更新书源级共享限流记录；空值或 0 表示不额外限流。已有记录更新时，非法配置沿用旧记录，首次非法值的 Android fallback 见请求规则。 */
  configure(sourceId: string, concurrentRate?: string | null): void
  /** 清理书源编辑/删除后的共享记录，避免旧配置影响新请求。 */
  clear(sourceId: string): void
  /** 按 sourceId 共享窗口记录，等待当前书源允许发起下一次请求；bypass 时跳过书源限流。 */
  wait(sourceId: string, options?: RateLimitWaitOptions): Promise<void>
}

export interface RateLimitWaitOptions {
  signal?: AbortSignal
  /** Android 的 ajaxAll/ajaxTestAll 在此开关为 true 时绕过限流，但仍受宿主线程/并发上限约束。 */
  bypass?: boolean
}

export interface Logger {
  /** 记录结构化运行信息，字段值可能包含脱敏后的规则上下文。 */
  debug(event: string, data?: Record<string, unknown>): void
  /** 记录可恢复的规则或宿主警告。 */
  warn(event: string, data?: Record<string, unknown>): void
  /** 记录阶段失败。Cookie、Token、密码和 Authorization 必须已脱敏。 */
  error(event: string, data?: Record<string, unknown>): void
}
```

## JavaScript 书源宿主 API

规则引擎使用的 `RuntimeHost` 接口与脚本看到的 `java`、`sourceApi`、`cookie`、`cache` 属于两层契约。`RuntimeHost` 可以是异步 TypeScript 接口，脚本绑定必须保留 Android 书源常用的同步调用形态。Node 宿主可以在独立 worker 或受限脚本线程中实现同步外观，但网络、文件和浏览器权限仍由宿主控制。

```ts
export interface JsResponse {
  /** 请求最终 URL。 */
  url: string
  /** 真实 HTTP 状态码；兼容 ajax/connect 捕获错误时也可能是合成响应，需结合 error 判断。Android StrResponse 以 code() 方法暴露，无 status 属性，移植时需适配访问器差异。 */
  status: number
  /** 响应头。 */
  headers: Record<string, string | string[]>
  /** 文本响应；二进制响应通过宿主专用能力处理。 */
  body: string
  /** 兼容包装的网络或宿主错误，存在时不得进入成功解析分支。 */
  error?: {
    /** 稳定的错误编码。 */
    code: string
    /** 可安全展示的错误说明。 */
    message: string
  }
}

export interface JsCacheApi {
  /** 读取当前 sessionId + sourceId 命名空间的持久化文本缓存，不存在或过期时返回 null。 */
  get(key: string, onlyDisk?: boolean): string | null
  /** 写入当前命名空间的缓存，saveTimeSec 为 0 表示不过期；宿主仍执行大小和总量限制。 */
  put(key: string, value: string, saveTimeSec?: number): void
  /** 删除缓存和对应内存副本。 */
  delete(key: string): void
  /** 读取只存在于内存的缓存。 */
  getFromMemory(key: string): string | null
  /** 写入只存在于内存的缓存。 */
  putMemory(key: string, value: string): void
  /** 删除只存在于内存的缓存。 */
  deleteMemory(key: string): void
  /** 读取当前书源命名空间的文本文件缓存；key 只能是相对 opaque key，不存在时为 null。 */
  getFile(key: string): string | null
  /** 写入受文件大小、总量、过期和私有权限限制的缓存，saveTimeSec 单位秒。 */
  putFile(key: string, value: string, saveTimeSec?: number): void
}

export interface JsCookieApi {
  /** 读取目标 URL 对应的 Cookie 字符串。 */
  getCookie(tag: string, key?: string): string
  /** 按目标域合并保存 Cookie；没有必要时由宿主拒绝跨域写入。 */
  setCookie(tag: string, cookie: string): void
  /** 删除目标域 Cookie。 */
  removeCookie(tag: string): void
}

export interface SourceApi {
  /** 读取书源级自定义变量的 JSON 字符串，不存在时返回空字符串。 */
  getVariable(): string
  /** 保存或删除书源级自定义变量。 */
  putVariable(variable: string | null): void
  /** 读取登录请求头；不存在时返回 null。 */
  getLoginHeader(): string | null
  /** 保存登录请求头 JSON。 */
  putLoginHeader(headerJson: string): void
  /** 删除登录请求头。 */
  removeLoginHeader(): void
  /** 读取登录表单信息；不存在时返回 null。 */
  getLoginInfo(): string | null
  /** 加密保存登录表单信息。 */
  putLoginInfo(infoJson: string): boolean
  /** 删除登录表单信息。 */
  removeLoginInfo(): void
  /** 书源自定义键值存储，键空间必须按书源身份隔离。 */
  get(key: string): string
  /** 写入当前源命名空间，返回兼容 API 定义的文本结果。 */
  put(key: string, value: string): string
  /** 更新书源级 concurrentRate；编辑或删除源后宿主必须清理对应限流记录。 */
  putConcurrent(value: string): void
}

export interface JavaApi {
  /** 声明式规则 JS 的变量读取；绑定对象是 AnalyzeRule，按 local/chapter/book/rule-data/source 顺序执行。 */
  get?(key: string): string
  /** 声明式规则 JS 的变量写入；绑定对象是 AnalyzeRule，按 chapter/book/rule-data/source 选择目标。 */
  put?(key: string, value: string): string
  /** 批量正文中保存单章正文；只允许在批量上下文调用。 */
  cacheContent(chapter: BookChapter | string, content: string): boolean
  /** 使用当前书源访问文本 URL；失败时按 Android 兼容策略返回错误文本或 null。 */
  ajax(url: string, callTimeoutMs?: number): string | null
  /** 并发访问多个 URL，结果顺序与输入数组一致，受书源限流和并发上限约束。 */
  ajaxAll(urls: string[], skipRateLimit?: boolean): JsResponse[]
  /** 并发测试多个 URL；skipRateLimit=true 时只绕过书源限流，不绕过宿主并发上限。 */
  ajaxTestAll(urls: string[], timeoutMs: number, skipRateLimit?: boolean): JsResponse[]
  /** 访问文本 URL 并返回结构化响应；错误响应可按 Android 兼容形态返回，但不得伪造成成功。 */
  connect(url: string, headerJson?: string, callTimeoutMs?: number): JsResponse
  /** 下载或读取缓存中的文本脚本文件。 */
  cacheFile(url: string, saveTimeSec?: number): string
  /** 下载文件并返回宿主私有缓存中的 opaque 相对标识；拒绝绝对路径、路径穿越和超出资源预算的响应。 */
  downloadFile(url: string): string
  /** 读取按书源域隔离的 Cookie。 */
  getCookie(tag: string, key?: string): string
  // AnalyzeRule、AnalyzeUrl、BaseSource 和 JsSourceEngine 的 java 绑定不是同一个完整对象。
  // 声明式规则中的 java.get/put 由 AnalyzeRule 提供；source/sourceApi 的 get/put 是书源级存储。
  // JS 源的 java 绑定只注入 JsExtensions 子集，未注入的方法必须报告 capability-missing，不能凭 source API 补齐。
  /** 使用 WebView 加载页面，属于可选能力。 */
  webView?(html: string | null, url: string | null, js: string | null): string | null
  /** 使用 WebView 获取经过脚本处理的页面源码，属于可选能力。 */
  webViewGetSource?(html: string | null, url: string | null, js: string | null, sourceRegex: string): string | null
}
```

绑定关系：java 是当前规则/JS 源提供的兼容外观，source/sourceApi 是书源配置与方法视图，cookie/cache 为会话隔离视图。book/chapter 是独立绑定，不能把 source 当成 Book。JavaApi 表是起始子集，完整继承方法及重载登记见 [能力清单](../standard/capability-inventory.md)。

脚本 API 错误分为参数/上下文错误、能力缺失和兼容返回错误。ajax/connect 的错误文本仍按原 API 返回给脚本，另记录 request 诊断；不擅自截断原脚本对该文本的处理。最终是否为正文成功由正文规则判断，不能宣称网络成功。cacheContent 歧义、非批量、关闭或旧 token 均不得误写其他章节。

文件、进程、真实浏览器和验证码 API 默认关闭。`importScript`、`downloadFile`、`webView`、`webViewGetSource`、登录 UI 和交互式播放器只有对应 capability 开启时才注入；未注入的函数不能由脚本自行模拟。所有脚本绑定都要按请求和书源身份创建，不能引用模块级可变对象。

本节列出的 `JavaApi`、`JsCacheApi`、`JsCookieApi` 和 `SourceApi` 是先实施的核心 allowlist。`JsExtensions` 中未列出的 Android UI、阅读器交互或其他平台专用方法仍属于能力盘点对象；移植时逐项判断它是否承担书源处理行为。需要支持的行为通过版本化接口、明确 capability 和 conformance fixture 增加；建议放弃的行为须经用户审核。

脚本 scope 按调用隔离，不把用户状态放在模块单例。没有 JS 能力时，仅不含任何脚本依赖的声明式操作可运行；含插值、URL JS、loginCheckJs 或 mainJs 都必须报告 javascript 能力缺失。详见[运行边界与部署验收](../operations/runtime-security-and-deployment.md)。

## RuntimeHost

```ts
export interface RuntimeScope {
  /** 宿主认证后的用户或匿名会话命名空间。 */
  sessionId: string
  /** 已认证用户；匿名调用为空。 */
  userId?: string
  /** 当前书源身份。 */
  sourceId: string
  /** 当前领域操作身份。 */
  operationId: string
}

export interface RuntimeHost {
  /** 当前宿主明确开放的能力集合。 */
  capabilities: RuntimeCapabilities
  /** 所有 Cookie、缓存、变量和文件能力都必须绑定到该作用域。 */
  scope: RuntimeScope
  /** URL 规则展开后的 HTTP 请求执行器。 */
  http: HttpClient
  /** 受支持字符集的字节转换，不默认以 UTF-8 替代未知字符集。 */
  charset: CharsetCodec
  /** HTML 文档和 DOM 规则所需的解析器。 */
  html: HtmlParser
  /** XPath 规则解析器。 */
  xpath: XPathParser
  /** JSONPath 规则解析器。 */
  jsonPath: JsonPathParser
  /** JS 书源和规则内嵌 JavaScript 的受限执行器。 */
  js: JavaScriptRuntime
  /** 当前运行上下文的 Cookie 存储。 */
  cookies: CookieStore
  /** 为每个请求创建变量视图，并负责书源、书籍和章节变量的持久化边界。 */
  variables: VariableStoreFactory
  /** 章节、目录和请求结果缓存。 */
  cache: CacheStore
  /** 正文内容、章节元数据和版本 token 的存储。 */
  content: ContentStore
  /** 图片、音频、视频和文件等二进制资源。 */
  resources: ResourceStore
  /** 可选的书源级限流器。 */
  rateLimiter?: RateLimiter
  /** 可选的结构化日志器。 */
  logger?: Logger
}
```

```ts
export interface VariableStoreFactory {
  /** 创建与 requestId、sourceUrl 和可选 bookUrl 绑定的变量存储。 */
  create(input: VariableStoreContext): VariableStore
}

export interface VariableStore {
  /** 按 local/chapter/book/rule-data/source 优先级查询；local 命中空串即返回，其他作用域空串继续查找。 */
  get(key: string): string | undefined
  /** 写入指定作用域，书籍/章节变更随领域结果提交。 */
  put(scope: 'local' | 'chapter' | 'book' | 'rule-data' | 'source', key: string, value: string | null): void
  /** 释放本次视图，等待在途操作，不清除持久化会话数据。 */
  close(): Promise<void>
}

export interface VariableStoreContext {
  /** 当前 HTTP 或预览请求的身份。 */
  requestId: string
  /** 当前领域操作身份；重试不改变。 */
  operationId: string
  /** 当前用户/匿名会话命名空间；不能由规则文本自报。 */
  sessionId: string
  /** 已认证用户；匿名调用为空。 */
  userId?: string
  /** 当前书源身份。 */
  sourceUrl: string
  /** 可选的书籍身份。 */
  bookUrl?: string
  /** 可选的章节身份。 */
  chapterKey?: string
  /** 取消变量读写和持久化的信号。 */
  signal?: AbortSignal
}
```

`VariableStore` 是宿主持久化视图；规则引擎使用的 `RuleVariableView` 负责 `set/delete/has/snapshot`。宿主实现可以通过 adapter 把规则视图的作用域写入 `VariableStore`，但两者不能继续使用同一个接口名描述不同方法。

```ts
export type RuntimeCapability =
  | 'network'
  | 'javascript'
  | 'charset'
  | 'archive'
  | 'font'
  | 'crypto'
  | 'batch-content'
  | 'file-cache'
  | 'webview'
  | 'webjs'
  | 'login-ui'
  | 'interactive-ui'
  | 'dns-override'
  | 'proxy'

export interface RuntimeCapabilities {
  /** 宿主明确允许注入的能力集合，缺失能力必须形成 capability error。 */
  has(capability: RuntimeCapability): boolean
  /** 返回只读能力名称，供诊断和 fixture 记录。 */
  list(): ReadonlySet<RuntimeCapability>
}
```

核心流程只能依赖 `RuntimeHost`，不能直接 import `fetch`、axios、undici、Jsoup、某个浏览器 DOM 或 Node 文件 API。宿主实现可以组合多个第三方库，但必须把差异收敛在端口内部。

## 错误模型

```ts
export type RuntimeStage =
  | 'import' | 'url' | 'request' | 'rule'
  | 'explore' | 'search' | 'book-info' | 'toc' | 'content' | 'review' | 'javascript'
  | 'storage' | 'capability' | 'lifecycle' | 'editor'

export interface RuntimeDiagnostic {
  /** 诊断发生的阶段。 */
  stage: RuntimeStage
  /** 稳定的错误或警告编码。 */
  code: string
  /** 可选的领域字段路径。 */
  field?: string
  /** 面向日志、编辑器和测试的简短说明。 */
  message: string
  /** 该问题是否允许当前流程继续。 */
  canContinue: boolean
}

export class SourceRuntimeError extends Error {
  constructor(
    /** 可安全展示的简短说明，不包含原始凭据或堆栈。 */
    message: string,
    /** 稳定分类和供服务端诊断的上下文。 */
    readonly detail: {
      /** 稳定错误码；不能只依赖 message 判断失败类别。 */
      code: string
      /** 失败发生的核心阶段。 */
      stage: RuntimeStage
      /** 发生错误的书源 URL。 */
      sourceUrl?: string
      /** 发生错误的字段路径。 */
      field?: string
      /** 规则身份；公共输出使用此身份和摘要，不暴露原文。 */
      ruleId?: string
      ruleSummary?: string
      /** 编辑器内部可选的原始规则；不得进入公共 DTO、日志或审计记录。 */
      rawRule?: string
      /** 底层异常，仅供日志和调试，不作为稳定断言文本。 */
      cause?: unknown
    },
  ) { super(message) }
}
```

字段读取的空结果和流程级失败必须区分。JSONPath 空结果可以由核心层归一化为空值，请求失败、必需 JS 函数缺失、目录最终为空、非卷正文为空和宿主能力缺失则必须保留明确阶段和错误类别。取消应原样传播为可识别的取消错误，不能包装成普通规则失败。

## 端口不变量

1. 核心层交给宿主的请求已经完成规则展开，但宿主必须保留最终响应 URL、状态码、响应头和取消语义。
2. Cookie 的读取和写入按目标域、路径和当前请求上下文隔离，不能使用跨用户全局 Cookie。
3. 解析器返回的空值、空列表、字符串和节点集合保持可区分，最终字段类型由规则和流程层归一化。
4. JS 绑定对象按调用隔离，脚本对 `source`、`book` 和输入文档的修改不能泄漏到其他请求。
5. 缓存键至少包含书源身份、资源身份和版本 token，不能用章节 URL 单独覆盖不同规则版本的结果。
6. 所有日志和 fixture 在落盘或展示前脱敏 Cookie、Token、密码、Authorization 和私有请求体。
