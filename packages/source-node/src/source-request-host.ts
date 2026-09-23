import { createRequestPlan } from '@legado/source-core'
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

function splitOptions(input: string): { url: string; options?: SourceRequestOptions } {
  let quote: string | undefined
  let depth = 0
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    if (quote !== undefined) {
      if (current === '\\') index += 1
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') { quote = current; continue }
    if (current === '{' || current === '[') depth += 1
    else if (current === '}' || current === ']') depth = Math.max(0, depth - 1)
    else if (current === ',' && depth === 0) {
      const url = input.slice(0, index).trim()
      const parsed = parseJson(input.slice(index + 1).trim())
      const options = object(parsed)
      return options === undefined ? { url } : { url, options: options as SourceRequestOptions }
    }
  }
  return { url: input.trim() }
}

function mergeHeaders(...values: Array<Readonly<Record<string, string>> | undefined>): Readonly<Record<string, string>> | undefined {
  const result: Record<string, string> = {}
  for (const value of values) if (value !== undefined) for (const [key, item] of Object.entries(value)) result[key] = item
  return Object.keys(result).length === 0 ? undefined : result
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
    return this.requestRaw(input.source, resolved, overrides, input.options.signal, input.options.budget)
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
    const response = await this.requestRaw(current, url, overrides, signal)
    return this.decode(response)
  }

  public decodeResponse(response: NetworkResponse): string {
    return this.decode(response)
  }

  private async resolveExpression(input: string, stage: WorkflowStage, signal: AbortSignal | undefined, source: NormalizedSource): Promise<string> {
    const trimmed = input.trim()
    const script = trimmed.startsWith('<js>') ? extractBlock(trimmed, '<js>', '</js>') : trimmed.toLowerCase().startsWith('@js:') ? { code: trimmed.slice(4).trim(), tail: '' } : undefined
    if (script === undefined) return input
    if (this.ruleHost === undefined) throw new Error('动态书源 URL 需要 JavaScript 宿主')
    const result = await this.ruleHost.executeJavaScript(script.code, stage === 'search' ? 'search' : 'book', source, '', signal)
    if (result.status !== 'success') throw new Error(result.message ?? '动态书源 URL 执行失败')
    return script.tail.length > 0 ? script.tail : text(result.value)
  }

  private async requestRaw(source: NormalizedSource, rawUrl: string, overrides: SourceRequestOptions, signal?: AbortSignal, budget?: WorkflowRequest['options']['budget']): Promise<NetworkResponse> {
    const split = splitOptions(rawUrl)
    const options = { ...split.options, ...overrides }
    if (options.webView === true) throw new Error('书源请求需要 WebView')
    const headers = mergeHeaders(await this.sourceHeaders(source), headerObject(options.headers))
    const body = options.body === undefined || typeof options.body === 'string' || options.body instanceof Uint8Array ? options.body : JSON.stringify(options.body)
    const request = createRequestPlan({
      url: split.url,
      baseUrl: source.bookSourceUrl,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
      ...(typeof options.charset === 'string' ? { requestCharset: options.charset, responseCharset: options.charset } : {}),
      // webJs 只能在 WebView 里执行：带上 useWebView 让请求计划显式失败，而不是静默走普通 HTTP。
      ...(typeof options.webJs === 'string' || typeof options.sourceRegex === 'string' ? { execution: { ...(typeof options.webJs === 'string' ? { webJs: options.webJs, useWebView: true } : {}), ...(typeof options.sourceRegex === 'string' ? { sourceRegex: options.sourceRegex } : {}) } } : {}),
      budget: { ...(budget ?? {}), ...(signal === undefined ? {} : { signal }) },
    })
    if (request.plan === undefined) throw new Error(request.error?.message ?? '书源请求计划无效')
    const response = await this.network.request(request.plan)
    if (response.status >= 400) throw new Error(`书源请求返回 HTTP ${response.status}`)
    if (typeof options.charset !== 'string') return response
    return { ...response, headers: { ...response.headers, 'x-legado-response-charset': options.charset } }
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

function extractBlock(input: string, open: string, close: string): { code: string; tail: string } {
  const end = input.indexOf(close, open.length)
  if (end < 0) return { code: input.slice(open.length), tail: '' }
  return { code: input.slice(open.length, end), tail: input.slice(end + close.length).trim() }
}
