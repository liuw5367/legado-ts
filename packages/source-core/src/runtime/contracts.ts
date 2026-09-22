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

export interface EncodingHost extends CharsetCodec {
  /** 将文本或 bytes 编码为 Base64。 */
  base64Encode(input: string | Uint8Array): string
  /** 将 Base64 解码为 bytes；非法输入必须失败。 */
  base64Decode(value: string): Uint8Array
  /** 将 bytes 编码为小写十六进制。 */
  hexEncode(input: Uint8Array): string
  /** 将偶数长度十六进制解码为 bytes。 */
  hexDecode(value: string): Uint8Array
  /** 按 JavaScript/Android 书源约定编码 URI。 */
  encodeUri(value: string): string
  /** 解码 URI；非法转义必须失败。 */
  decodeUri(value: string): string
}

export type DigestAlgorithm = 'md5' | 'sha1' | 'sha256' | 'sha512'

export interface SymmetricCrypto {
  /** 解密 bytes，保留原始二进制边界。 */
  decrypt(input: Uint8Array): Uint8Array
  /** 加密 bytes，保留原始二进制边界。 */
  encrypt(input: Uint8Array): Uint8Array
  /** 解密后按指定字符集转为文字。 */
  decryptText(input: Uint8Array, charset?: string): string
  /** 文字按指定字符集编码后加密。 */
  encryptText(input: string, charset?: string): Uint8Array
}

export interface CryptoHost {
  /** 计算摘要十六进制结果。 */
  digestHex(input: string | Uint8Array, algorithm?: DigestAlgorithm): string
  /** 计算摘要 Base64 结果。 */
  digestBase64(input: string | Uint8Array, algorithm?: DigestAlgorithm): string
  /** 计算 HMAC 十六进制结果。 */
  hmacHex(input: string | Uint8Array, key: string | Uint8Array, algorithm?: DigestAlgorithm): string
  /** 创建带明确 transformation、key 和 iv 的对称加密对象。 */
  createSymmetricCrypto(transformation: string, key: Uint8Array, iv?: Uint8Array): SymmetricCrypto
}

export type ArchiveFormat = 'gzip' | 'zip' | '7z' | 'rar'

export interface ArchiveLimits {
  /** 最多返回的非目录条目数。 */
  maxEntries: number
  /** 单个展开条目的最大字节数。 */
  maxEntryBytes: number
  /** 全部展开条目的最大字节数。 */
  maxTotalBytes: number
  /** 解压后大小与压缩大小允许的最大比例。 */
  maxCompressionRatio: number
}

export interface ArchiveEntry {
  /** 归一化后的相对路径。 */
  path: string
  /** 条目内容。 */
  data: Uint8Array
}

export interface ArchiveHost {
  /** 受预算解包；不支持或不安全的格式必须明确失败。 */
  extract(input: Uint8Array, format: ArchiveFormat, limits?: Partial<ArchiveLimits>): Promise<ArchiveEntry[]>
}

export interface ConcurrencyHost {
  /** 按 key 排队执行；任务必须使用传入 signal 响应取消。 */
  run<T>(key: string, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
  /** 取消某个 key 的排队和运行任务。 */
  cancel(key: string): void
  /** 取消并清理所有 key 的任务。 */
  clear(): void
}

export interface FontMapping {
  /** 查询 Unicode 对应的 glyph id；未找到时返回 0。 */
  glyphIdByUnicode(unicode: number): number
  /** 查询 Unicode 对应的轮廓签名；缺少轮廓时返回 undefined。 */
  glyphByUnicode(unicode: number): string | undefined
  /** 用轮廓签名反查 Unicode；未找到时返回 0。 */
  unicodeByGlyph(glyph: string | undefined): number
  /** Android 兼容的空白 Unicode 判断。 */
  isBlankUnicode(unicode: number): boolean
}

export interface FontQueryOptions {
  /** 是否使用宿主内存缓存；默认开启。 */
  useCache?: boolean
  /** 单个字体允许解析的最大字节数。 */
  maxBytes?: number
  /** 解析开始前的取消信号；同步解析无法在同一线程中被外部打断。 */
  signal?: AbortSignal
}

export interface FontHost {
  /** 解析 TTF/TrueType sfnt bytes；不接受文件路径，不访问全局文件系统。 */
  queryTTF(input: Uint8Array, options?: FontQueryOptions): FontMapping
  /** 解析 Base64 字体；与 queryTTF 使用同一缓存和预算语义。 */
  queryBase64TTF(input: string, options?: FontQueryOptions): FontMapping
  /** 按 Android replaceFont 语义将错误字体文字映射为正确文字。 */
  replaceFont(text: string, error: FontMapping | null, correct: FontMapping | null, filter?: boolean): string
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
