import { createRequestPlan, splitSourceRequestUrl } from '@legado/source-core'
import type { NetworkHost, NetworkResponse, NormalizedSource, WorkflowRequest, WorkflowStage } from '@legado/source-core'
import chardet from 'chardet'
import { NodeCharsetCodec } from './charset.ts'
import { NodeCookieStore } from './cookies.ts'
import type { CookieStore } from './types.ts'
import type { SourceRuleBridgeRequest, SourceRuleHost } from './source-rule-host.ts'

interface SourceRequestOptions {
  method?: string
  body?: unknown
  headers?: Readonly<Record<string, string>>
  charset?: string
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

export interface SourceRequestHostOptions {
  network: NetworkHost
  cookieStore?: CookieStore
  encoding?: NodeCharsetCodec
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

function isValidEncoded(input: string, allowed: (character: string) => boolean): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    if (current === '%' && /^[\da-f]{2}$/i.test(input.slice(index + 1, index + 3))) {
      index += 2
      continue
    }
    if (!allowed(current)) return false
  }
  return true
}

const querySafeCharacters = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$&()*+,-./:;=?@[\\]^_`{|}~')
const querySafe = (value: string): boolean => querySafeCharacters.has(value)
const formSafe = (value: string): boolean => /^[A-Za-z0-9*._-]$/.test(value)

function encodedCharacter(value: string, codec: NodeCharsetCodec, charset: string | undefined, form: boolean): string {
  if (form && value === ' ') return '+'
  if (form ? formSafe(value) : querySafe(value)) return value
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

function encodeQuery(value: string, codec: NodeCharsetCodec, charset?: string): string {
  if (isValidEncoded(value, querySafe)) return value
  return [...value].map((character) => encodedCharacter(character, codec, charset, false)).join('')
}

function encodeFormPart(value: string, codec: NodeCharsetCodec, charset?: string): string {
  if (charset === undefined && isValidEncoded(value, formSafe)) return value
  return [...value].map((character) => encodedCharacter(character, codec, charset, true)).join('')
}

function encodeForm(value: string, codec: NodeCharsetCodec, charset?: string): string {
  return value.split('&').map((field) => {
    const equals = field.indexOf('=')
    if (equals < 0) return encodeFormPart(field, codec, charset)
    return `${encodeFormPart(field.slice(0, equals), codec, charset)}=${encodeFormPart(field.slice(equals + 1), codec, charset)}`
  }).join('&')
}

function absoluteUrlWithEncodedQuery(input: string, baseUrl: string, codec: NodeCharsetCodec, charset?: string): string {
  const fragmentStart = input.indexOf('#')
  const fragment = fragmentStart < 0 ? '' : input.slice(fragmentStart)
  const address = fragmentStart < 0 ? input : input.slice(0, fragmentStart)
  const queryStart = address.indexOf('?')
  if (queryStart < 0) return new URL(input, baseUrl).toString()
  const absolute = new URL(address.slice(0, queryStart), baseUrl)
  absolute.search = encodeQuery(address.slice(queryStart + 1), codec, charset)
  if (fragment.length > 0) absolute.hash = fragment.slice(1)
  return absolute.toString()
}

function contentTypeCharset(contentType: string | undefined): string | undefined {
  return contentType === undefined ? undefined : /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]
}

function isJsonBody(value: string): boolean {
  const trimmed = value.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function isXmlBody(value: string): boolean {
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
  const sample = Buffer.from(bytes.subarray(0, 8192)).toString('latin1')
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

export class SourceRequestHost {
  private readonly network: NetworkHost
  private readonly cookieStore: CookieStore
  private readonly encoding: NodeCharsetCodec
  private ruleHost?: SourceRuleHost

  public constructor(options: SourceRequestHostOptions) {
    this.network = options.network
    this.cookieStore = options.cookieStore ?? new NodeCookieStore()
    this.encoding = options.encoding ?? new NodeCharsetCodec()
  }

  public attachRuleHost(ruleHost: SourceRuleHost): void {
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

  /** `source` 由规则宿主按本次求值注入：URL 展开等 JS 求值发生在首次请求之前。 */
  public async requestFromBridge(input: SourceRuleBridgeRequest, signal: AbortSignal, source: NormalizedSource): Promise<unknown> {
    const current = source
    const url = text(input.url)
    if (input.kind === 'cookie-get') return await this.cookieStore.get(new URL(url, current.bookSourceUrl).toString())
    if (input.kind === 'cookie-set') {
      await this.cookieStore.set(new URL(url, current.bookSourceUrl).toString(), text(input.value))
      return true
    }
    if (input.kind === 'cookie-remove') {
      // Android 按 URL 删除；清空整个 jar 会让同一会话里的其他书源丢凭据。
      await this.cookieStore.remove(new URL(url, current.bookSourceUrl).toString())
      return true
    }
    if (input.kind === 'token') throw new Error('书源 token bridge 不可用')
    if (input.kind !== 'network') throw new Error(`未知书源 bridge: ${input.kind}`)
    const options = object(input.options) as SourceRequestOptions | undefined
    const overrides: SourceRequestOptions = {
      ...(options ?? {}),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    }
    const response = await this.requestRaw(current, url, overrides, signal, undefined, 'search')
    return this.decode(response)
  }

  public decodeResponse(response: NetworkResponse): string {
    return this.decode(response)
  }

  private async resolveExpression(input: string, stage: WorkflowStage, signal: AbortSignal | undefined, source: NormalizedSource): Promise<string> {
    const trimmed = input.trim()
    const blocks = [...trimmed.matchAll(/<js>([\s\S]*?)<\/js>/gi)]
    if (blocks.length > 0) {
      let result = trimmed
      let end = 0
      for (const block of blocks) {
        const literal = trimmed.slice(end, block.index!).trim()
        if (literal.length > 0) result = literal.split('@result').join(result)
        result = await this.evaluateUrlScript(block[1] ?? '', result, stage, source, signal)
        end = block.index! + block[0]!.length
      }
      const tail = trimmed.slice(end).trim()
      return tail.length > 0 ? tail.split('@result').join(result) : result
    }
    if (!trimmed.toLowerCase().startsWith('@js:')) return input
    return this.evaluateUrlScript(trimmed.slice(4).trim(), '', stage, source, signal)
  }

  private async evaluateUrlScript(code: string, result: string, stage: WorkflowStage, source: NormalizedSource, signal?: AbortSignal): Promise<string> {
    if (this.ruleHost === undefined) throw new Error('动态书源 URL 需要 JavaScript 宿主')
    const scriptStage = stage === 'detail' ? 'book' : 'search'
    const output = await this.ruleHost.executeJavaScript(code, scriptStage, source, result, signal)
    if (output.status !== 'success') throw new Error(output.message ?? '动态书源 URL 执行失败')
    return text(output.value)
  }

  private async requestRaw(source: NormalizedSource, rawUrl: string, overrides: SourceRequestOptions, signal?: AbortSignal, budget?: WorkflowRequest['options']['budget'], stage: WorkflowStage = 'search'): Promise<NetworkResponse> {
    const split = splitSourceRequestUrl(rawUrl)
    const options = { ...(split.options as SourceRequestOptions | undefined), ...overrides }
    if (optionBoolean(options.webView) === true || (typeof options.webJs === 'string' && options.webJs.length > 0)) throw new Error('书源请求需要 WebView')
    const method = (options.method ?? 'GET').toUpperCase()
    const sourceHeaders = await this.sourceHeaders(source)
    let headers = mergeHeaders(sourceHeaders, headerObject(options.headers))
    const charset = typeof options.charset === 'string' && options.charset.trim().length > 0 ? options.charset.trim() : undefined
    const requestCharset = charset?.toLowerCase() === 'escape' ? undefined : charset
    const bodyValue = options.body === undefined || typeof options.body === 'string' || options.body instanceof Uint8Array ? options.body : JSON.stringify(options.body)
    let body: string | Uint8Array | undefined

    if (method === 'POST') {
      const contentType = getHeader(headers, 'content-type')
      if (typeof bodyValue === 'string' && (bodyValue.trim() === '' || (!isJsonBody(bodyValue) && !isXmlBody(bodyValue) && contentType === undefined))) {
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
      ...(requestCharset === undefined ? {} : { requestCharset, responseCharset: requestCharset }),
      ...(followRedirects === undefined ? {} : { followRedirects }),
      responseType: typeof options.type === 'string' && options.type.length > 0 ? 'bytes' : 'text',
      execution: {
        useWebView: false,
        ...(typeof options.sourceRegex === 'string' ? { sourceRegex: options.sourceRegex } : {}),
        ...(typeof (options.dnsIp ?? options.resolveIp) === 'string' ? { dnsIp: String(options.dnsIp ?? options.resolveIp) } : {}),
        ...(serverId === undefined ? {} : { serverId }),
        ...(webViewDelayTimeMs === undefined ? {} : { webViewDelayTimeMs }),
      },
      budget: { ...(budget ?? {}), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(signal === undefined ? {} : { signal }) },
    })
    const initialUrl = absoluteUrlWithEncodedQuery(split.url, source.bookSourceUrl, this.encoding, charset)
    let request = makePlan(initialUrl)
    if (request.plan === undefined) throw new Error(request.error?.message ?? '书源请求计划无效')

    if (typeof options.js === 'string' && options.js.trim().length > 0) {
      const rewritten = await this.evaluateUrlScript(options.js, request.plan.url, stage, source, signal)
      const rewrittenUrl = absoluteUrlWithEncodedQuery(rewritten, source.bookSourceUrl, this.encoding, charset)
      request = makePlan(rewrittenUrl)
      if (request.plan === undefined) throw new Error(request.error?.message ?? '书源 URL 脚本生成了无效地址')
    }

    let response: NetworkResponse | undefined
    let lastError: unknown
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
      try {
        response = await this.network.request(request.plan)
        break
      } catch (error) {
        lastError = error
        if (attempt === retry) throw error
      }
    }
    if (response === undefined) throw lastError instanceof Error ? lastError : new Error('书源请求失败')
    if (response.status >= 400) throw new Error(`书源请求返回 HTTP ${response.status}`)

    let result: NetworkResponse = response
    if (requestCharset !== undefined) result = { ...result, headers: { ...result.headers, 'x-legado-response-charset': requestCharset } }
    if (typeof options.type === 'string' && options.type.length > 0) {
      result = { ...result, bytes: new TextEncoder().encode(hex(result.bytes)), headers: { ...result.headers, 'x-legado-response-charset': 'utf-8' } }
    } else if (typeof options.bodyJs === 'string' && options.bodyJs.trim().length > 0) {
      const decoded = this.decode(result)
      const transformed = await this.evaluateUrlScript(options.bodyJs, decoded, stage, source, signal)
      result = { ...result, bytes: new TextEncoder().encode(transformed), headers: { ...result.headers, 'x-legado-response-charset': 'utf-8' } }
    }
    return result
  }

  private async sourceHeaders(source: NormalizedSource): Promise<Readonly<Record<string, string>> | undefined> {
    const header = source.header
    if (header === undefined || header === null) return undefined
    if (typeof header === 'object' && !Array.isArray(header)) return headerObject(header)
    if (typeof header !== 'string') return undefined
    if (header.trim().toLowerCase().startsWith('@js:')) {
      if (this.ruleHost === undefined) throw new Error('动态 header 需要 JavaScript 宿主')
      const result = await this.ruleHost.executeJavaScript(header.trim().slice(4), 'search', source, '')
      if (result.status !== 'success') throw new Error(result.message ?? '动态 header 执行失败')
      return headerObject(result.value)
    }
    const result = headerObject(header)
    if (result === undefined) throw new Error('书源 header 不是有效 JSON 对象')
    return result
  }

  private decode(response: NetworkResponse): string {
    const candidates = [
      responseCharset(response),
      bomCharset(response.bytes),
      htmlMetaCharset(response.bytes),
      chardet.detect(response.bytes) ?? undefined,
      'utf-8',
    ]
    const attempted = new Set<string>()
    for (const charset of candidates) {
      const normalized = charset?.trim()
      if (normalized === undefined || normalized.length === 0 || attempted.has(normalized.toLowerCase())) continue
      attempted.add(normalized.toLowerCase())
      try {
        return this.encoding.decode(response.bytes, normalized)
      } catch {
        // Continue through the remaining metadata and the UTF-8 fallback when a
        // site advertises a charset that iconv-lite does not support.
      }
    }
    return new TextDecoder().decode(response.bytes)
  }
}
