import { createRequestPlan } from '../runtime/request-plan.ts'
import { resolveSourceRequestUrl, splitSourceRequestUrl } from '../runtime/request-url.ts'
import type { CharsetCodec, NetworkHost, NetworkResponse } from '../runtime/contracts.ts'
import type { NormalizedSource } from '../model/types.ts'
import type { WorkflowRequest, WorkflowRuleOutput, WorkflowRulePort, WorkflowStage } from './types.ts'

/** 请求边界内的结构化失败分类；与 WorkflowDiagnostic.code 对齐，避免压成可重试网络错误。 */
export type SourceRequestErrorCode = 'invalid-config' | 'capability-missing' | 'cancelled' | 'rule-failed'

/**
 * 请求运行时抛出的结构化错误。helpers 在 catch 中映射为不可重试诊断，
 * 不走合成 500 的 loginCheck 回退。
 */
export class SourceRequestError extends Error {
  public readonly code: SourceRequestErrorCode
  /** 关联的规则字段（url/bodyJs/header 等）；计划级错误可省略。 */
  public readonly field?: string

  public constructor(code: SourceRequestErrorCode, message: string, field?: string) {
    super(message)
    this.name = 'SourceRequestError'
    this.code = code
    if (field !== undefined) this.field = field
  }
}

export interface SourceRequestOptions {
  method?: string
  body?: unknown
  headers?: Readonly<Record<string, string>>
  charset?: string
  responseCharset?: string
  webView?: boolean
  webJs?: string
  sourceRegex?: string
  js?: string
  bodyJs?: string
  type?: string
  retry?: number | string
  timeout?: number | string
  followRedirects?: boolean | number | string
  dnsIp?: string
  resolveIp?: string
  serverID?: number | string
  webViewDelayTime?: number | string
  [key: string]: unknown
}

export interface SourceRequestRuntimeOptions {
  network: NetworkHost
  encoding: CharsetCodec
  decodeResponse?: (response: NetworkResponse) => string
  rules?: WorkflowRulePort
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function headerObject(value: unknown): Readonly<Record<string, string>> | undefined {
  const input = typeof value === 'string' ? parseJson(value) : value
  const record = object(input)
  if (record === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') result[key] = String(item)
  return result
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    try {
      return JSON.parse(relaxedJson(value)) as unknown
    } catch {
      return undefined
    }
  }
}

/** 将 Android 来源文件中常见的单引号字符串转换为合法 JSON，保留双引号字符串内的转义。 */
function relaxedJson(input: string): string {
  let result = ''
  let doubleQuoted = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    if (doubleQuoted) {
      result += current
      if (current === '\\' && input[index + 1] !== undefined) result += input[++index]!
      else if (current === '"') doubleQuoted = false
      continue
    }
    if (current === '"') { doubleQuoted = true; result += current; continue }
    if (current !== "'") { result += current; continue }
    let value = ''
    for (index += 1; index < input.length; index += 1) {
      const item = input[index]!
      if (item === '\\') {
        const next = input[index + 1]
        if (next === "'") { value += "'"; index += 1 } else { value += item; if (next !== undefined) { value += next; index += 1 } }
      } else if (item === "'") break
      else value += item
    }
    result += JSON.stringify(value)
  }
  return result
}

function mergeHeaders(...values: Array<Readonly<Record<string, string>> | undefined>): Readonly<Record<string, string>> | undefined {
  const result: Record<string, string> = {}
  for (const value of values) if (value !== undefined) for (const [key, item] of Object.entries(value)) {
    const existing = Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
    result[existing ?? key] = item
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function getHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  return value
}

function withoutHeader(headers: Readonly<Record<string, string>> | undefined, name: string): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name.toLowerCase()))
  return Object.keys(result).length === 0 ? undefined : result
}

function optionBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || (typeof value === 'string' && value.trim().toLowerCase() === 'true')) return true
  if (value === 0 || value === '0' || (typeof value === 'string' && value.trim().toLowerCase() === 'false')) return false
  return undefined
}

function optionInteger(value: unknown, minimum = 0): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN
  return Number.isSafeInteger(number) && number >= minimum ? number : undefined
}

// 表单组件只保留 RFC 3986 非保留字符；空格由编码器单独写成加号。
const formSafe = (value: string): boolean => /^[A-Za-z0-9*._-]$/.test(value)

function isValidFormEncoded(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    // 保留已有的合法百分号字节序列，其他不安全字符需要重新编码。
    if (input[index] === '%' && /^[\da-f]{2}$/i.test(input.slice(index + 1, index + 3))) {
      index += 2
      continue
    }
    if (!formSafe(input[index]!)) return false
  }
  return true
}

function encodedFormCharacter(value: string, codec: CharsetCodec, charset: string | undefined): string {
  if (value === ' ') return '+'
  if (formSafe(value)) return value
  if (charset?.toLowerCase() === 'escape') {
    return [...value].map((character) => {
      const code = character.codePointAt(0)!
      if (code <= 0xff) return `%${code.toString(16).padStart(2, '0').toUpperCase()}`
      const units = character.length === 2 ? [character.charCodeAt(0), character.charCodeAt(1)] : [code]
      return units.map((unit) => `%u${unit.toString(16).padStart(4, '0').toUpperCase()}`).join('')
    }).join('')
  }
  const bytes = codec.encode(value, charset ?? 'utf-8')
  return [...bytes].map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('')
}

function encodeFormPart(value: string, codec: CharsetCodec, charset?: string): string {
  if (charset === undefined && isValidFormEncoded(value)) return value
  return [...value].map((character) => encodedFormCharacter(character, codec, charset)).join('')
}

function encodeForm(value: string, codec: CharsetCodec, charset?: string): string {
  return value.split('&').map((field) => {
    const equals = field.indexOf('=')
    if (equals < 0) return encodeFormPart(field, codec, charset)
    return `${encodeFormPart(field.slice(0, equals), codec, charset)}=${encodeFormPart(field.slice(equals + 1), codec, charset)}`
  }).join('&')
}

function contentTypeCharset(contentType: string | undefined): string | undefined {
  return contentType === undefined ? undefined : /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]
}

function originBaseUrl(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}`
}

function responseContentType(response: NetworkResponse): string | undefined {
  const value = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
  return headerValue(value)
}

function isXmlResponse(response: NetworkResponse): boolean {
  return /^(application|text)\/\w*\+?xml.*$/.test(responseContentType(response) ?? '')
}

function isJsonBody(value: string): boolean {
  // Android 将首尾分别由对象/数组括号包围的请求体作为结构化文本处理。
  const trimmed = value.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function isXmlBody(value: string): boolean {
  // 识别 XML 声明或普通 XML 根标签，避免按表单格式编码。
  return /^\s*(?:<\?xml\b|<[A-Za-z][\w:.-]*(?:\s[^>]*|\s*\/?)>)/i.test(value)
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function responseCharset(response: NetworkResponse): string | undefined {
  const explicit = headerValue(response.headers['x-legado-response-charset'])
  if (explicit !== undefined) return explicit.trim()
  const contentType = headerValue(response.headers['content-type'])
  if (contentType === undefined) return undefined
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)
  return match?.[1]
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0]
}

function bomCharset(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) return 'utf-32be'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) return 'utf-32le'
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  return undefined
}

function htmlMetaCharset(bytes: Uint8Array): string | undefined {
  const sample = String.fromCharCode(...bytes.subarray(0, 8192))
  const xml = /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)/i.exec(sample)
  if (xml?.[1] !== undefined) return xml[1]
  for (const tag of sample.matchAll(/<meta\b[^>]*>/gi)) {
    const direct = /\bcharset\s*=\s*["']?([^\s"'/>;]+)/i.exec(tag[0])
    if (direct?.[1] !== undefined) return direct[1]
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag[0])?.[1]
    const nested = content === undefined ? undefined : /charset\s*=\s*([^\s;]+)/i.exec(content)?.[1]
    if (nested !== undefined) return nested.replace(/["']+$/g, '')
  }
  return undefined
}

export class SourceRequestRuntime {
  private readonly network: NetworkHost
  private readonly encoding: CharsetCodec
  private readonly decodeOverride?: SourceRequestRuntimeOptions['decodeResponse']
  private ruleHost: WorkflowRulePort | undefined

  public constructor(options: SourceRequestRuntimeOptions) {
    this.network = options.network
    this.encoding = options.encoding
    this.decodeOverride = options.decodeResponse
    this.ruleHost = options.rules
  }

  public attachRuleHost(ruleHost: WorkflowRulePort): void {
    this.ruleHost = ruleHost
  }

  public async request(input: WorkflowRequest): Promise<NetworkResponse> {
    // 书源随这次调用显式传递：宿主上没有「当前书源」字段，同一宿主并发不同书源不会串源。
    const resolved = await this.resolveExpression(input.url, input.stage, input.options.signal, input.source)
    const overrides: SourceRequestOptions = {
      ...(input.execution?.webJs === undefined ? {} : { webJs: input.execution.webJs }),
      ...(input.execution?.sourceRegex === undefined ? {} : { sourceRegex: input.execution.sourceRegex }),
    }
    return this.requestRaw(input.source, resolved, overrides, input.options.signal, input.options.budget, input.stage)
  }

  public decodeResponse(response: NetworkResponse): string {
    return this.decode(response)
  }

  private async resolveExpression(input: string, stage: WorkflowStage, signal: AbortSignal | undefined, source: NormalizedSource): Promise<string> {
    const trimmed = input.trim()
    // Android 对整条规则匹配 JS_PATTERN：<js> 与任意位置的 @js: 按出现顺序执行。
    const blocks = [...trimmed.matchAll(/<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/gi)]
    if (blocks.length > 0) {
      let result = trimmed
      let end = 0
      for (const block of blocks) {
        const literal = trimmed.slice(end, block.index!).trim()
        if (literal.length > 0) result = literal.split('@result').join(result)
        result = await this.evaluateUrlScript(block[1] ?? block[2] ?? '', result, stage, source, signal)
        end = block.index! + block[0]!.length
      }
      const tail = trimmed.slice(end).trim()
      return tail.length > 0 ? tail.split('@result').join(result) : result
    }
    return input
  }

  /** 脚本执行上下文：evaluate 字段名与诊断字段名在 bodyJs 上按基线分别为 body/bodyJs。 */
  private async runSourceScript(
    code: string,
    stage: WorkflowStage,
    source: NormalizedSource,
    content: string,
    signal: AbortSignal | undefined,
    context: { evaluateField: string; field: string; baseUrl?: string; redirectUrl?: string; scriptStage?: 'search' | 'book' | 'mainJs' | 'chapter' | 'content' },
  ): Promise<unknown> {
    if (this.ruleHost === undefined) throw new SourceRequestError('capability-missing', '脚本执行需要 JavaScript 宿主', context.field)
    const scriptStage = context.scriptStage ?? (stage === 'detail' ? 'book' : 'search')
    const baseUrl = context.baseUrl ?? source.bookSourceUrl
    const redirectUrl = context.redirectUrl ?? baseUrl
    let output: WorkflowRuleOutput
    try {
      // 可选钩子优先；只实现必需 evaluate 的宿主用 @js: 规则回退，保持与基线默认路径一致。
      if (this.ruleHost.executeWorkflowJavaScript !== undefined) {
        output = await this.ruleHost.executeWorkflowJavaScript({ source, code, stage: scriptStage, content, baseUrl, redirectUrl, ...(signal === undefined ? {} : { signal }) })
      } else {
        output = await this.ruleHost.evaluate({ source, stage, field: context.evaluateField, rule: `@js:${code}`, content, baseUrl, redirectUrl, ...(signal === undefined ? {} : { signal }) })
      }
    } catch (error) {
      if (signal?.aborted === true) throw new SourceRequestError('cancelled', '脚本执行已取消', context.field)
      throw new SourceRequestError('rule-failed', error instanceof Error ? error.message : '脚本执行失败', context.field)
    }
    if (signal?.aborted === true || output.status === 'cancelled') throw new SourceRequestError('cancelled', output.message ?? '脚本执行已取消', context.field)
    if (output.status === 'capability-missing') throw new SourceRequestError('capability-missing', output.message ?? '脚本需要 JavaScript 能力', context.field)
    if (output.status !== 'success') throw new SourceRequestError('rule-failed', output.message ?? '脚本执行失败', context.field)
    return output.value
  }

  private async evaluateUrlScript(
    code: string,
    result: string,
    stage: WorkflowStage,
    source: NormalizedSource,
    signal?: AbortSignal,
    context?: { evaluateField?: string; field?: string; baseUrl?: string; redirectUrl?: string },
  ): Promise<string> {
    const value = await this.runSourceScript(code, stage, source, result, signal, {
      evaluateField: context?.evaluateField ?? 'url',
      field: context?.field ?? 'url',
      ...(context?.baseUrl === undefined ? {} : { baseUrl: context.baseUrl }),
      ...(context?.redirectUrl === undefined ? {} : { redirectUrl: context.redirectUrl }),
    })
    return text(value)
  }

  public async requestRaw(source: NormalizedSource, rawUrl: string, overrides: SourceRequestOptions = {}, signal?: AbortSignal, budget?: WorkflowRequest['options']['budget'], stage: WorkflowStage = 'search', nested = false, skipRateLimit = false): Promise<NetworkResponse> {
    const split = splitSourceRequestUrl(rawUrl)
    const options = { ...(split.options as SourceRequestOptions | undefined), ...overrides }
    if (optionBoolean(options.webView) === true || (typeof options.webJs === 'string' && options.webJs.length > 0)) {
      throw new SourceRequestError('capability-missing', '书源请求需要 WebView')
    }
    const requestedMethod = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET'
    // AnalyzeUrl maps every method except POST and HEAD to GET.
    const method = requestedMethod === 'POST' || requestedMethod === 'HEAD' ? requestedMethod : 'GET'
    const sourceHeaders = await this.sourceHeaders(source, signal, nested)
    const defaultHeaders = getHeader(sourceHeaders, 'user-agent') === undefined && this.network.defaultUserAgent !== undefined
      ? { 'User-Agent': this.network.defaultUserAgent }
      : undefined
    let headers = mergeHeaders(sourceHeaders, defaultHeaders, headerObject(options.headers))
    const proxy = getHeader(headers, 'proxy')?.trim() || undefined
    headers = withoutHeader(headers, 'proxy')
    const dnsIpValue = options.dnsIp ?? options.resolveIp
    const dnsIp = dnsIpValue === undefined || dnsIpValue === null ? undefined : String(dnsIpValue).trim() || undefined
    if (proxy !== undefined && dnsIp !== undefined) {
      throw new SourceRequestError('invalid-config', 'dnsIp cannot be used together with a proxy', 'header')
    }
    const charset = typeof options.charset === 'string' && options.charset.trim().length > 0 ? options.charset.trim() : undefined
    const requestCharset = charset?.toLowerCase() === 'escape' ? undefined : charset
    const responseCharsetHint = typeof options.responseCharset === 'string' && options.responseCharset.trim().length > 0 ? options.responseCharset.trim() : undefined
    const cookieJar = optionBoolean(source.enabledCookieJar) ?? source.enabledCookieJar !== null
    // 非 UTF-8 编码必须由 CharsetCodec 真正支持；helpers 默认路径缺 encodeCharset 时会在此失败，
    // 不得用 TextEncoder 冒充后静默发错字节。
    if (requestCharset !== undefined && requestCharset.toLowerCase().replaceAll('-', '') !== 'utf8') {
      try {
        this.encoding.encode('测', requestCharset)
      } catch {
        throw new SourceRequestError('capability-missing', `当前网络宿主不支持 ${requestCharset} 编码`, 'url')
      }
    }
    const bodyValue = options.body === undefined || typeof options.body === 'string' || options.body instanceof Uint8Array ? options.body : JSON.stringify(options.body)
    let body: string | Uint8Array | undefined

    if (method === 'POST') {
      const contentType = getHeader(headers, 'content-type')
      if (typeof bodyValue === 'string' && (bodyValue.trim() === '' || (!isJsonBody(bodyValue) && !isXmlBody(bodyValue) && contentType === undefined))) {
        // 表单 body 统一由核心编码为字节，保证 WorkflowPorts 默认路径与 Node 门面一致。
        const encoded = encodeForm(bodyValue, this.encoding, charset)
        body = this.encoding.encode(encoded, requestCharset ?? 'utf-8')
        if (contentType === undefined) headers = mergeHeaders(headers, { 'Content-Type': 'application/x-www-form-urlencoded' })
      } else if (bodyValue === undefined) {
        body = new Uint8Array()
        if (contentType === undefined) headers = mergeHeaders(headers, { 'Content-Type': 'application/x-www-form-urlencoded' })
      } else if (bodyValue instanceof Uint8Array) body = bodyValue
      else {
        const bodyCharset = contentTypeCharset(contentType) ?? 'utf-8'
        body = this.encoding.encode(bodyValue, bodyCharset)
        if (contentType === undefined) headers = mergeHeaders(headers, { 'Content-Type': 'application/json; charset=utf-8' })
      }
    }

    const timeoutMs = optionInteger(options.timeout, 1)
    const followRedirects = optionBoolean(options.followRedirects)
    const retry = Math.min(optionInteger(options.retry) ?? 0, 10)
    const serverId = optionInteger(options.serverID, 0)
    const webViewDelayTimeMs = optionInteger(options.webViewDelayTime, 0)
    const makePlan = (url: string) => createRequestPlan({
      url,
      baseUrl: source.bookSourceUrl,
      method,
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
      ...(requestCharset === undefined ? {} : { requestCharset }),
      ...(responseCharsetHint === undefined ? {} : { responseCharset: responseCharsetHint }),
      ...(followRedirects === undefined ? {} : { followRedirects }),
      responseType: typeof options.type === 'string' && options.type.length > 0 ? 'bytes' : 'text',
      execution: {
        useWebView: false,
        ...(typeof options.sourceRegex === 'string' ? { sourceRegex: options.sourceRegex } : {}),
        ...(dnsIp === undefined ? {} : { dnsIp }),
        ...(proxy === undefined ? {} : { proxy }),
        cookieJar,
        ...(serverId === undefined ? {} : { serverId }),
        ...(webViewDelayTimeMs === undefined ? {} : { webViewDelayTimeMs }),
        ...(skipRateLimit ? { skipRateLimit: true } : {}),
      },
      budget: { ...(budget ?? {}), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(signal === undefined ? {} : { signal }) },
    })
    // 查询编码走 CharsetCodec：Node 提供完整字符集，helpers 默认路径仅在宿主声明 encodeCharset 时可编非 UTF-8。
    const queryEncoder = (value: string, requestedCharset: string) => this.encoding.encode(value, requestedCharset)
    const initialUrl = resolveSourceRequestUrl(split.url, source.bookSourceUrl, charset, queryEncoder)
    let request = makePlan(initialUrl)
    if (request.plan === undefined) {
      throw new SourceRequestError(request.error?.code === 'webview-required' ? 'capability-missing' : 'invalid-config', request.error?.message ?? '书源请求计划无效')
    }

    // AnalyzeUrl updates baseUrl to the target origin before applying URL options.
    // It keeps this same baseUrl for bodyJs, even after an option-js rewrite or redirect.
    const scriptBaseUrl = originBaseUrl(request.plan.url)
    if (typeof options.js === 'string' && options.js.trim().length > 0) {
      const planUrl = request.plan.url
      const rewritten = await this.evaluateUrlScript(options.js, planUrl, stage, source, signal, { evaluateField: 'url', field: 'url', baseUrl: scriptBaseUrl, redirectUrl: planUrl })
      const rewrittenUrl = resolveSourceRequestUrl(rewritten, source.bookSourceUrl, charset, queryEncoder)
      request = makePlan(rewrittenUrl)
      if (request.plan === undefined) {
        throw new SourceRequestError(request.error?.code === 'webview-required' ? 'capability-missing' : 'invalid-config', request.error?.message ?? '书源 URL 脚本生成了无效地址', 'url')
      }
    }

    let response: NetworkResponse | undefined
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
      response = await this.network.request(request.plan)
      const successful = response.status >= 200 && response.status < 300
      const redirect = response.status >= 300 && response.status < 400
      if (successful || redirect || attempt === retry) break
    }
    if (response === undefined) throw new Error('书源请求失败')

    let result: NetworkResponse = response
    if (responseCharsetHint !== undefined) result = { ...result, headers: { ...result.headers, 'x-legado-response-charset': responseCharsetHint } }
    if (typeof options.type === 'string' && options.type.length > 0) {
      result = { ...result, bytes: new TextEncoder().encode(hex(result.bytes)), headers: { ...result.headers, 'x-legado-response-charset': 'utf-8' } }
    } else {
      const decoded = this.decode(result)
      const isXml = isXmlResponse(result)
      if (isXml && !decoded.trim().toLowerCase().startsWith('<?xml')) {
        result = { ...result, bytes: new TextEncoder().encode(`<?xml version="1.0"?>${decoded}`), headers: { ...result.headers, 'x-legado-response-charset': 'utf-8' } }
      } else if (typeof options.bodyJs === 'string' && options.bodyJs.trim().length > 0) {
        const transformed = await this.evaluateUrlScript(options.bodyJs, decoded, stage, source, signal, {
          evaluateField: 'body',
          field: 'bodyJs',
          baseUrl: scriptBaseUrl,
          redirectUrl: result.url,
        })
        result = { ...result, bytes: new TextEncoder().encode(transformed), headers: { ...result.headers, 'x-legado-response-charset': 'utf-8' } }
      }
    }
    return result
  }

  private async sourceHeaders(source: NormalizedSource, signal?: AbortSignal, nested = false): Promise<Readonly<Record<string, string>> | undefined> {
    const header = source.header
    if (header === undefined || header === null) return undefined
    if (typeof header === 'object' && !Array.isArray(header)) return headerObject(header)
    if (typeof header !== 'string') return undefined
    const trimmed = header.trim()
    const script = /^<js>([\s\S]*?)<\/js>$/i.exec(trimmed)?.[1]
      ?? (/^@js:([\s\S]*)$/i.exec(trimmed)?.[1])
    if (script !== undefined) {
      // bridge 子请求不再执行动态 header，避免 header→java.ajax→同一 header 的异步递归；静态头仍合并。
      if (nested) return undefined
      // 头脚本不携带请求 URL 上下文，stage 固定为 search，与基线 Node 门面一致。
      let value: unknown
      try {
        value = await this.runSourceScript(script, 'search', source, '', signal, {
          evaluateField: 'header',
          field: 'header',
          scriptStage: 'search',
        })
      } catch (error) {
        if (error instanceof SourceRequestError && error.code === 'rule-failed') return undefined
        throw error
      }
      const dynamic = headerObject(value)
      return dynamic
    }
    const result = headerObject(header)
    return result
  }

  private decode(response: NetworkResponse): string {
    if (this.decodeOverride !== undefined) return this.decodeOverride(response)
    const bom = bomCharset(response.bytes)
    // Android StrResponse removes UTF-8 BOM before checking Content-Type or HTML metadata.
    const bytes = bom === 'utf-8' ? response.bytes.subarray(3) : response.bytes
    const candidates = [
      responseCharset(response),
      bom,
      htmlMetaCharset(bytes),
      'utf-8',
    ]
    const attempted = new Set<string>()
    for (const charset of candidates) {
      const normalized = charset?.trim()
      if (normalized === undefined || normalized.length === 0 || attempted.has(normalized.toLowerCase())) continue
      attempted.add(normalized.toLowerCase())
      try {
        return this.encoding.decode(bytes, normalized)
      } catch {
        // 站点声明的字符集无法解码时，继续尝试剩余元数据和 UTF-8 回退。
      }
    }
    return new TextDecoder().decode(bytes)
  }
}
