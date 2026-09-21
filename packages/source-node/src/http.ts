import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { NetworkHost, NetworkResponse, RequestPlan } from '@legado/source-core'
import { NodeCookieStore } from './cookies.ts'
import type { CookieStore, NodeNetworkOptions } from './types.ts'

function ipv4Private(value: string): boolean {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item))) return false
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
}

function ipv4Mapped(value: string): string | undefined {
  const normalized = value.toLowerCase()
  if (!normalized.startsWith('::ffff:')) return undefined
  const tail = normalized.slice('::ffff:'.length)
  if (isIP(tail) === 4) return tail
  const words = tail.split(':')
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined
  const high = Number.parseInt(words[0]!, 16)
  const low = Number.parseInt(words[1]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function ipv6Private(value: string): boolean {
  const normalized = value.toLowerCase()
  const mapped = ipv4Mapped(normalized)
  return mapped !== undefined ? ipv4Private(mapped) : normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  const kind = isIP(normalized)
  return kind === 4 ? ipv4Private(normalized) : kind === 6 ? ipv6Private(normalized) : false
}

async function assertSafeUrl(raw: string, options: NodeNetworkOptions): Promise<URL> {
  const url = new URL(raw)
  const protocols = options.protocols ?? ['http:', 'https:']
  if (!protocols.includes(url.protocol)) throw new Error('request protocol is not allowed')
  if (url.username !== '' || url.password !== '') throw new Error('request URL must not contain credentials')
  if (options.allowPrivateNetworks === true) return url
  if (url.hostname === 'localhost' || isPrivateAddress(url.hostname)) throw new Error('private network request is not allowed')
  const lookupHost = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
  const addresses = await lookup(lookupHost, { all: true, verbatim: true })
  if (addresses.some((address) => isPrivateAddress(address.address))) throw new Error('private network request is not allowed')
  return url
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  throwIfAborted(signal)
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel('response too large')
        throw new Error('response exceeds byte budget')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function responseHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const setCookie = response.headers.getSetCookie?.()
  if (setCookie !== undefined && setCookie.length > 0) headers['set-cookie'] = setCookie
  return headers
}

function timeoutSignal(plan: RequestPlan): AbortSignal {
  const deadlineRemaining = plan.budget.deadlineMs === undefined ? undefined : plan.budget.deadlineMs - Date.now()
  const timeoutMs = deadlineRemaining === undefined ? plan.budget.timeoutMs : Math.min(plan.budget.timeoutMs, Math.max(0, deadlineRemaining))
  const timeout = AbortSignal.timeout(timeoutMs)
  return plan.budget.signal === undefined ? timeout : AbortSignal.any([timeout, plan.budget.signal])
}

export class NodeNetworkHost implements NetworkHost {
  private readonly cookieStore: CookieStore
  private readonly options: NodeNetworkOptions

  public constructor(options: NodeNetworkOptions = {}) {
    this.options = options
    this.cookieStore = options.cookieStore ?? new NodeCookieStore()
  }

  public async request(plan: RequestPlan): Promise<NetworkResponse> {
    let currentUrl = await assertSafeUrl(plan.url, this.options)
    let currentMethod = plan.method
    let currentBody = plan.body
    let redirected = false
    let redirects = 0
    let requestCount = 0
    let totalBytes = 0
    let stripSensitiveHeaders = false
    while (true) {
      if (requestCount >= plan.budget.maxRequests) throw new Error('request count budget exceeded')
      requestCount += 1
      const headers = new Headers(plan.headers)
      if (stripSensitiveHeaders) {
        headers.delete('authorization')
        headers.delete('proxy-authorization')
        headers.delete('cookie')
      }
      const cookie = await this.cookieStore.get(currentUrl.toString())
      if (cookie !== undefined && !headers.has('cookie')) headers.set('cookie', cookie)
      const body = currentBody === undefined ? undefined : typeof currentBody === 'string' ? currentBody : Uint8Array.from(currentBody)
      const signal = timeoutSignal(plan)
      const init: RequestInit = { method: currentMethod, headers, redirect: 'manual', signal }
      if (body !== undefined) init.body = body as BodyInit
      const response = await fetch(currentUrl, init)
      const headersRecord = responseHeaders(response)
      const setCookie = headersRecord['set-cookie']
      if (setCookie !== undefined) await this.cookieStore.set(currentUrl.toString(), setCookie)
      const location = response.headers.get('location')
      if (plan.followRedirects && location !== null && response.status >= 300 && response.status < 400) {
        const redirectBytes = await readBody(response, Math.min(plan.budget.maxResponseBytes, plan.budget.maxTotalBytes - totalBytes), signal)
        totalBytes += redirectBytes.byteLength
        if (totalBytes > plan.budget.maxTotalBytes) throw new Error('total response byte budget exceeded')
        if (redirects >= plan.budget.maxRedirects) throw new Error('redirect budget exceeded')
        redirects += 1
        const nextUrl = await assertSafeUrl(new URL(location, currentUrl).toString(), this.options)
        if (nextUrl.origin !== currentUrl.origin) stripSensitiveHeaders = true
        if ((response.status === 301 || response.status === 302 || response.status === 303) && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
          currentMethod = 'GET'
          currentBody = undefined
        }
        currentUrl = nextUrl
        redirected = true
        continue
      }
      const bytes = await readBody(response, Math.min(plan.budget.maxResponseBytes, plan.budget.maxTotalBytes - totalBytes), signal)
      totalBytes += bytes.byteLength
      if (totalBytes > plan.budget.maxTotalBytes) throw new Error('total response byte budget exceeded')
      return { url: currentUrl.toString(), status: response.status, headers: headersRecord, bytes, redirected }
    }
  }
}
