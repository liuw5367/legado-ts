import { SourceRequestError, SourceRequestRuntime } from '@legado/source-core'
import type { NetworkHost, NetworkResponse, NormalizedSource, WorkflowRequest, WorkflowRulePort } from '@legado/source-core'
import chardet from 'chardet'
import { NodeCharsetCodec } from './charset.ts'
import { NodeCookieStore } from './cookies.ts'
import type { CookieStore } from './types.ts'
import type { SourceRuleBridgeRequest } from './source-rule-host.ts'
import type { SourceRequestOptions } from '@legado/source-core'

export interface SourceRequestHostOptions {
  network: NetworkHost
  cookieStore?: CookieStore
  encoding?: NodeCharsetCodec
}

/** bridge 网络子请求允许的最大再入层数；超出后拒绝，防止脚本经 bridge 无限嵌套。 */
const maxBridgeDepth = 3

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function responseCharset(response: NetworkResponse): string | undefined {
  const explicit = headerValue(response.headers['x-legado-response-charset'])
  if (explicit !== undefined) return explicit.trim()
  const contentType = headerValue(response.headers['content-type'])
  return contentType === undefined ? undefined : /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]
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

/** Node 层只组合网络、Cookie 和字符集能力；请求选项与书源请求语义由 source-core 执行。 */
export class SourceRequestHost {
  private readonly cookieStore: CookieStore
  private readonly encoding: NodeCharsetCodec
  private readonly runtime: SourceRequestRuntime
  /** 当前在途 bridge 网络子请求深度；实例级计数足以拦住单宿主上的失控递归。 */
  private bridgeDepth = 0

  public constructor(options: SourceRequestHostOptions) {
    this.cookieStore = options.cookieStore ?? new NodeCookieStore()
    this.encoding = options.encoding ?? new NodeCharsetCodec()
    this.runtime = new SourceRequestRuntime({
      network: options.network,
      encoding: this.encoding,
      decodeResponse: (response) => this.decode(response),
    })
  }

  public attachRuleHost(ruleHost: WorkflowRulePort): void {
    this.runtime.attachRuleHost(ruleHost)
  }

  public request(input: WorkflowRequest): Promise<NetworkResponse> {
    return this.runtime.request(input)
  }

  /** source 随本次 JavaScript bridge 调用传入，避免并发书源共享可变上下文。 */
  public async requestFromBridge(input: SourceRuleBridgeRequest, signal: AbortSignal, source: NormalizedSource): Promise<unknown> {
    const url = text(input.url)
    if (input.kind === 'cookie-get') return this.cookieStore.get(new URL(url, source.bookSourceUrl).toString())
    if (input.kind === 'cookie-set') {
      await this.cookieStore.set(new URL(url, source.bookSourceUrl).toString(), text(input.value))
      return true
    }
    if (input.kind === 'cookie-remove') {
      // Android 按 URL 删除；清空整个 jar 会让同一会话里的其他书源丢凭据。
      await this.cookieStore.remove(new URL(url, source.bookSourceUrl).toString())
      return true
    }
    if (input.kind === 'token') throw new Error('书源 token bridge 不可用')
    if (input.kind !== 'network') throw new Error(`未知书源 bridge: ${input.kind}`)
    if (this.bridgeDepth >= maxBridgeDepth) {
      throw new SourceRequestError('invalid-config', `书源请求嵌套过深（上限 ${maxBridgeDepth}）`)
    }
    const options = object(input.options) as SourceRequestOptions | undefined
    const overrides: SourceRequestOptions = {
      ...(options ?? {}),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    }
    this.bridgeDepth += 1
    try {
      // nested：子请求跳过动态 source header，只保留静态头，切断 header 脚本自递归。
      const response = await this.runtime.requestRaw(source, url, overrides, signal, undefined, 'search', true)
      return this.decode(response)
    } finally {
      this.bridgeDepth -= 1
    }
  }

  public decodeResponse(response: NetworkResponse): string {
    return this.decode(response)
  }

  private decode(response: NetworkResponse): string {
    const candidates = [responseCharset(response), bomCharset(response.bytes), htmlMetaCharset(response.bytes), chardet.detect(response.bytes) ?? undefined, 'utf-8']
    const attempted = new Set<string>()
    for (const charset of candidates) {
      const normalized = charset?.trim()
      if (normalized === undefined || normalized.length === 0 || attempted.has(normalized.toLowerCase())) continue
      attempted.add(normalized.toLowerCase())
      try {
        return this.encoding.decode(response.bytes, normalized)
      } catch {
        // 站点声明的字符集无法解码时，继续尝试元数据和 UTF-8 回退。
      }
    }
    return new TextDecoder().decode(response.bytes)
  }
}
