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
  set<T>(key: string, value: T, options?: { ttlMs?: number; versionToken?: string }): Promise<void>
  /** 删除当前上下文可见的缓存项。 */
  delete(key: string): Promise<void>
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

脚本 scope 必须按调用或请求隔离。SSR 不能把 `source`、Cookie、变量表、JS 全局对象或缓存身份放在模块级可变单例中。`JavaScriptRuntime` 不得使用宿主 `eval`、Node 全局对象或未限制的文件、进程和网络能力。没有脚本沙箱时，普通声明式书源仍可运行，但 JS 源必须报告能力缺失，不能返回伪造成功。

## RuntimeHost

```ts
export interface RuntimeHost {
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
  /** 章节、目录和请求结果缓存。 */
  cache: CacheStore
  /** 可选的书源级限流器。 */
  rateLimiter?: RateLimiter
  /** 可选的结构化日志器。 */
  logger?: Logger
}
```

核心流程只能依赖 `RuntimeHost`，不能直接 import `fetch`、axios、undici、Jsoup、某个浏览器 DOM 或 Node 文件 API。宿主实现可以组合多个第三方库，但必须把差异收敛在端口内部。

## 错误模型

```ts
export type RuntimeStage =
  | 'import' | 'url' | 'request' | 'rule'
  | 'search' | 'book-info' | 'toc' | 'content' | 'review' | 'javascript'

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

