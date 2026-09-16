# TypeScript 宿主接口

本章定义独立库需要的目标端口，不是 Android API 的逐名翻译。核心层负责书源导入、规则解析和搜索、详情、目录、正文编排，宿主负责网络、解析器、脚本沙箱、Cookie、缓存、限流和日志。接口名可以调整，但职责和数据边界不能混入流程代码。

## 请求和响应

```ts
export type HttpMethod = 'GET' | 'POST' | 'HEAD'

export interface HttpRequest {
  /** URL 规则展开、相对 URL 解析和重定向策略处理后的请求 URL。 */
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
  /** 按请求字符集解码后的文本响应。 */
  body?: string
  /** 二进制响应。body 和 bytes 至少有一个可用于当前内容类型。 */
  bytes?: Uint8Array
  /** 是否发生过重定向。不能仅根据 url 是否变化推断。 */
  redirected: boolean
}

export interface HttpClient {
  /** 执行一次已经由核心层展开的请求，并保留取消和超时语义。 */
  request(request: HttpRequest): Promise<HttpResponse>
}
```

`HttpClient` 接收的是已经展开的 `HttpRequest`。页码、关键字、URL 内嵌 JavaScript、请求体编码、Cookie 合并和相对 URL 解析属于核心层。代理、DNS 覆盖、WebView 和真实浏览器行为属于宿主能力，不能通过偷偷修改 `url` 或 `headers` 来伪装成普通 HTTP。

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
  /** 解析 HTML，不修改调用方传入的原始字符串或二进制。 */
  parse(input: string | Uint8Array, baseUrl?: string): HtmlDocument
}

export interface XPathParser {
  /** 返回 XPath 选中的节点、对象、列表或字符串。 */
  evaluate(document: HtmlDocument, expression: string): unknown
}

export interface JsonPathParser {
  /** 返回 JSONPath 选中的值，空选择返回 undefined 或空列表，由核心层归一化。 */
  evaluate(value: unknown, expression: string): unknown
}
```

解析器端口只表达平台能力，规则模式、链条、索引、组合符号、替换和 URL 归一化仍由核心规则引擎控制。`HtmlDocument` 必须支持规则文档所需的元素选择、链式节点、属性、`text`、`textNodes`、`ownText`、`html`、`all` 和非破坏性索引过滤。`XPathParser` 和 `JsonPathParser` 要让核心层区分节点、对象、列表、字符串及空结果，不能把所有结果提前转成字符串。

解析器适配器还要遵守以下不变量：同一次 `parse` 返回的节点 ID 在 `select`、`child` 和后续规则步骤中保持稳定；`child` 只创建节点视图，不从原文档删除节点；空选择、空字符串、空列表、`null` 和 `undefined` 不能互相替换。HTML 解析使用 HTML 模式，XML 声明和表格片段补容器的兼容处理由核心层在调用适配器前完成。CSS 选择器错误、XPath 语法错误和 JSONPath 语法错误必须分别返回可识别的 parser error，合法但无匹配属于空结果。

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
    /** 脚本超时时间，单位为毫秒。 */
    timeoutMs?: number
    /** 与请求绑定的取消信号。 */
    signal?: AbortSignal
  }): Promise<unknown>
}

export interface CookieStore {
  /** 读取目标 URL 域和路径可见的 Cookie。 */
  get(url: string): Promise<string | undefined>
  /** 保存响应中的 Cookie，并按域、路径和安全属性处理。 */
  set(url: string, setCookie: string | string[]): Promise<void>
  /** 清理当前请求上下文的 Cookie，不得默认影响其他用户。 */
  clear(): Promise<void>
}

export interface CacheStore {
  /** 按稳定键读取缓存，并校验版本 token。 */
  get<T>(key: string, versionToken?: string): Promise<T | undefined>
  /** 写入带身份、过期时间和版本 token 的缓存。 */
  set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void>
  /** 删除当前上下文可见的缓存项。 */
  delete(key: string): Promise<void>
}

export interface CacheWriteOptions {
  /** 缓存存活时间，未提供时使用宿主默认值。 */
  ttlMs?: number
  /** 规则或流程版本标识，用于阻止旧结果覆盖新结果。 */
  versionToken?: string
}

export interface ContentWriteInput {
  /** 当前正文请求生成的书籍、章节和版本身份。 */
  token: ContentSaveToken
  /** 归一化后的正文或资源 URL。 */
  content: string
  /** 需要一起更新的章节元数据。 */
  chapter: BookChapter
  /** 是否在正文写入边界内保存章节标题、图片等元数据。 */
  saveChapterMetadata: boolean
}

export interface ContentStore {
  /** 按书籍和章节身份读取正文；token 失效或不存在时返回 undefined。 */
  read(token: ContentSaveToken): Promise<string | undefined>
  /** 只在 token 仍为当前版本时写正文和章节元数据，返回是否实际写入。 */
  write(input: ContentWriteInput): Promise<boolean>
  /** 为下一次正文请求生成当前版本 token。 */
  token(book: Book, chapter: BookChapter): Promise<ContentSaveToken>
}

export interface RateLimiter {
  /** 等待当前书源允许发起下一次请求。 */
  wait(sourceUrl: string, signal?: AbortSignal): Promise<void>
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
  /** 真实 HTTP 状态码；兼容 ajax/connect 捕获错误时也可能是合成响应，需结合 error 判断。 */
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
  /** 读取持久化文本缓存，不存在或过期时返回 null。 */
  get(key: string, onlyDisk?: boolean): string | null
  /** 写入缓存，saveTimeSec 为 0 表示不过期。 */
  put(key: string, value: string, saveTimeSec?: number): void
  /** 删除缓存和对应内存副本。 */
  delete(key: string): void
  /** 读取只存在于内存的缓存。 */
  getFromMemory(key: string): string | null
  /** 写入只存在于内存的缓存。 */
  putMemory(key: string, value: string): void
  /** 删除只存在于内存的缓存。 */
  deleteMemory(key: string): void
  /** 读写受宿主能力限制的文本文件缓存。 */
  getFile(key: string): string | null
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
  put(key: string, value: string): string
}

export interface JavaApi {
  /** 批量正文中保存单章正文；只允许在批量上下文调用。 */
  cacheContent(chapter: BookChapter | string, content: string): boolean
  /** 使用当前书源访问文本 URL；失败时按 Android 兼容策略返回错误文本或 null。 */
  ajax(url: string, callTimeoutMs?: number): string | null
  /** 并发访问多个 URL，结果顺序与输入数组一致，受书源限流和并发上限约束。 */
  ajaxAll(urls: string[], skipRateLimit?: boolean): JsResponse[]
  /** 访问文本 URL 并返回结构化响应；错误响应可按 Android 兼容形态返回，但不得伪造成成功。 */
  connect(url: string, headerJson?: string, callTimeoutMs?: number): JsResponse
  /** 下载或读取缓存中的文本脚本文件。 */
  cacheFile(url: string, saveTimeSec?: number): string
  /** 下载文件并返回宿主私有缓存中的相对标识。 */
  downloadFile(url: string): string
  /** 读取按书源域隔离的 Cookie。 */
  getCookie(tag: string, key?: string): string
  /** 书源级键值存储的兼容别名。 */
  get(key: string): string
  put(key: string, value: string): string
  /** 使用 WebView 加载页面，属于可选能力。 */
  webView?(html: string | null, url: string | null, js: string | null): string | null
  /** 使用 WebView 获取经过脚本处理的页面源码，属于可选能力。 */
  webViewGetSource?(html: string | null, url: string | null, js: string | null, sourceRegex: string): string | null
}
```

绑定关系固定为：`java` 实现 `JavaApi`，`source` 和 `sourceApi` 指向同一 `SourceApi` 视图，`cookie` 实现 `JsCookieApi`，`cache` 实现 `JsCacheApi`。`source` 对象本身还可以作为详情、目录和正文的输入对象，但脚本不得通过它修改 `bookUrl`、阅读进度或用户自定义字段。

脚本 API 的错误处理必须区分三类：调用参数或上下文错误直接抛出 `javascript` 阶段错误；宿主能力未提供返回 `capability` 错误；兼容 Android 的 `ajax` 和 `connect` 网络失败可以返回错误文本或错误响应，但必须在调试事件中保留原始阶段，不能让流程把该文本当作已验证正文。`cacheContent` 章节不唯一、非批量调用、批量上下文已关闭或版本 token 过期时不得静默写入其他章节。

文件、进程、真实浏览器和验证码 API 默认关闭。`importScript`、`downloadFile`、`webView`、`webViewGetSource`、登录 UI 和交互式播放器只有对应 capability 开启时才注入；未注入的函数不能由脚本自行模拟。所有脚本绑定都要按请求和书源身份创建，不能引用模块级可变对象。

本节列出的 `JavaApi`、`JsCacheApi`、`JsCookieApi` 和 `SourceApi` 是第一版 source-core 的核心 allowlist。`JsExtensions` 中未列出的 Android UI、阅读器交互或其他平台专用方法不自动进入独立库；若某个 adapter 需要支持它，必须增加版本化接口、明确 capability 和 conformance fixture。

脚本 scope 必须按调用或请求隔离。SSR 不能把 `source`、Cookie、变量表、JS 全局对象或缓存身份放在模块级可变单例中。`JavaScriptRuntime` 不得使用宿主 `eval`、Node 全局对象或未限制的文件、进程和网络能力。没有脚本沙箱时，普通声明式书源仍可运行，但 JS 源必须报告能力缺失，不能返回伪造成功。

## RuntimeHost

```ts
export interface RuntimeHost {
  /** 当前宿主明确开放的能力集合。 */
  capabilities: RuntimeCapabilities
  /** URL 规则展开后的 HTTP 请求执行器。 */
  http: HttpClient
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

export interface VariableStoreContext {
  /** 当前 HTTP 或预览请求的身份。 */
  requestId: string
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

```ts
export type RuntimeCapability =
  | 'network'
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
  | 'search' | 'book-info' | 'toc' | 'content' | 'review' | 'javascript'
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
    message: string,
    readonly detail: {
      /** 失败发生的核心阶段。 */
      stage: RuntimeStage
      /** 发生错误的书源 URL。 */
      sourceUrl?: string
      /** 发生错误的字段路径。 */
      field?: string
      /** 触发错误的原始规则，输出前应按策略脱敏。 */
      rule?: string
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
