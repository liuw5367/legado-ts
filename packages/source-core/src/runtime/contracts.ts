import type { RuleValue } from '../rules/types.ts'

export type HttpMethod = 'GET' | 'POST' | 'HEAD'

export interface RequestBudget {
  /** 单次请求超时时间，单位为毫秒。 */
  timeoutMs: number
  /** 当前操作的绝对截止时间，单位为 Unix 毫秒。 */
  deadlineMs?: number
  /** 当前操作允许的请求总数。 */
  maxRequests: number
  /** 当前操作允许的分页/重定向页数。 */
  maxPages: number
  /** 单个解压响应的最大字节数。 */
  maxResponseBytes: number
  /** 当前操作所有响应累计的最大字节数。 */
  maxTotalBytes: number
  /** 请求体的最大字节数。 */
  maxRequestBodyBytes: number
  /** 单个请求允许的重定向次数。 */
  maxRedirects: number
  /** 取消请求、读取和后续解析。 */
  signal?: AbortSignal
}

export interface RequestExecutionHints {
  /** 是否必须使用 WebView；HTTP adapter 不得静默降级。 */
  useWebView: boolean
  /** WebView 页面脚本。 */
  webJs?: string
  /** WebView/资源嗅探正则。 */
  sourceRegex?: string
  /** DNS 覆盖提示，由 Node 宿主安全策略决定是否接受。 */
  dnsIp?: string
  /** 代理提示，由 Node 宿主显式策略决定是否接受。 */
  proxy?: string
  /** Android 兼容服务节点提示。 */
  serverId?: number
  /** WebView 加载后的等待时间。 */
  webViewDelayTimeMs?: number
}

export interface RequestPlan {
  /** 规则展开后的绝对 URL。 */
  url: string
  /** 已验证的 HTTP 方法。 */
  method: HttpMethod
  /** 已合并且脱敏前的请求头；宿主不得把 Cookie 写回此对象。 */
  headers: Readonly<Record<string, string>>
  /** 请求体；宿主发送前必须按 budget 校验字节数。 */
  body?: string | Uint8Array
  /** 请求参数使用的字符集。 */
  requestCharset?: string
  /** 响应 bytes 解码使用的字符集提示。 */
  responseCharset?: string
  /** 是否允许跟随重定向。 */
  followRedirects: boolean
  /** 响应分支。 */
  responseType: 'text' | 'bytes'
  /** HTTP 以外的宿主能力提示。 */
  execution: RequestExecutionHints
  /** 请求和响应共享预算。 */
  budget: RequestBudget
}

export interface RequestPlanInput {
  /** 可以是绝对 URL，也可以相对 baseUrl。 */
  url: string
  /** 相对 URL 使用的基准地址。 */
  baseUrl?: string
  /** 请求方法；省略时使用 GET。 */
  method?: string
  /** 请求头。 */
  headers?: Readonly<Record<string, string>>
  /** 请求体。 */
  body?: string | Uint8Array
  /** 请求参数编码。 */
  requestCharset?: string
  /** 响应编码提示。 */
  responseCharset?: string
  /** 是否跟随重定向。 */
  followRedirects?: boolean
  /** 响应类型。 */
  responseType?: 'text' | 'bytes'
  /** 执行提示。 */
  execution?: Partial<RequestExecutionHints>
  /** 请求预算。 */
  budget?: Partial<RequestBudget>
}

export type RequestPlanErrorCode = 'invalid-url' | 'invalid-method' | 'invalid-budget' | 'request-body-too-large' | 'webview-required'

export interface RequestPlanResult {
  /** 通过验证的不可变请求计划。 */
  plan?: RequestPlan
  /** 计划构造错误。 */
  error?: { code: RequestPlanErrorCode; message: string }
}

export interface NetworkResponse {
  /** 最终响应地址。 */
  url: string
  /** HTTP 状态码；网络失败不得伪造为 200。 */
  status: number
  /** 响应头；Set-Cookie 可保留为数组。 */
  headers: Readonly<Record<string, string | string[]>>
  /** 已解压的响应 bytes。 */
  bytes: Uint8Array
  /** 是否经历过重定向。 */
  redirected: boolean
}

export interface NetworkHost {
  /** 物化并执行核心生成的请求计划。 */
  request(plan: RequestPlan): Promise<NetworkResponse>
}

export interface CharsetCodec {
  /** 将文本编码为指定字符集。 */
  encode(text: string, charset: string): Uint8Array
  /** 将响应 bytes 按指定字符集解码。 */
  decode(bytes: Uint8Array, charset: string): string
}

export interface ParserNode {
  /** 文档内稳定节点身份。 */
  readonly id: string
  /** 节点类型；核心不依赖第三方 DOM 类。 */
  readonly kind: 'element' | 'text' | 'document'
}

export interface HtmlDocument {
  /** 选择元素，不改变文档和已有节点。 */
  select(selector: string): ParserNode[]
  /** 读取节点属性。 */
  attr(node: ParserNode, name: string): string | undefined
  /** 读取节点文本、直接文本或 HTML。 */
  read(node: ParserNode, output: 'text' | 'textNodes' | 'ownText' | 'html' | 'all'): string
  /** 以节点为根创建可继续选择的文档视图。 */
  child(node: ParserNode): HtmlDocument
}

export interface HtmlParser {
  /** 解析 HTML/XML 文本；XML 模式由调用方显式选择。 */
  parse(input: string, mode?: 'html' | 'xml'): HtmlDocument
}

export interface XPathParser {
  /** 返回节点、标量或列表；adapter 不把所有结果提前转为文本。 */
  evaluate(document: HtmlDocument, expression: string): RuleValue | ParserNode[] | null
}

export interface JsonPathParser {
  /** 返回 JSONPath 的标量、对象或列表；空选择返回空列表。 */
  evaluate(value: unknown, expression: string): RuleValue | null
}
