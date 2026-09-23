import { lookup } from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import type { NetworkHost, NetworkResponse, RequestPlan } from '@legado/source-core'
import iconv from 'iconv-lite'
import { Agent } from 'undici'
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

type DnsAddress = LookupAddress

function parseDnsIpAddresses(value: string): DnsAddress[] {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (values.length === 0) throw new Error('dnsIp must contain an IPv4 or IPv6 address')
  return values.map((address) => {
    const family = isIP(address)
    if (family === 0) throw new Error('dnsIp must contain only IPv4 or IPv6 addresses')
    return { address, family }
  })
}

function lookupFailure(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ENOTFOUND' })
}

function scopedDnsLookup(targetHost: string, configured: readonly DnsAddress[]): NonNullable<ConnectionOptions['lookup']> {
  return (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | DnsAddress[], family?: number) => void): void => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family ?? 0
    const addresses = hostname.toLowerCase() === targetHost.toLowerCase()
      ? configured.filter((item) => family === 0 || item.family === family)
      : undefined
    if (addresses !== undefined) {
      if (addresses.length === 0) { callback(lookupFailure('dnsIp contains no address for the requested family'), ''); return }
      if (options.all === true) callback(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
      return
    }
    void lookup(hostname, { all: true, ...(family === 0 ? {} : { family }) }).then((results) => {
      if (results.length === 0) { callback(lookupFailure('host lookup returned no addresses'), ''); return }
      if (options.all === true) callback(null, results)
      else callback(null, results[0]!.address, results[0]!.family)
    }, (error: unknown) => callback(error instanceof Error ? Object.assign(error, { code: 'ENOTFOUND' }) : lookupFailure('host lookup failed'), ''))
  }
}

async function assertSafeUrl(raw: string, options: NodeNetworkOptions, dnsAddresses?: readonly DnsAddress[]): Promise<URL> {
  const url = new URL(raw)
  const protocols = options.protocols ?? ['http:', 'https:']
  if (!protocols.includes(url.protocol)) throw new Error('request protocol is not allowed')
  if (url.username !== '' || url.password !== '') throw new Error('request URL must not contain credentials')
  if (options.allowPrivateNetworks === true) return url
  if (url.hostname === 'localhost' || isPrivateAddress(url.hostname)) throw new Error('private network request is not allowed')
  if (dnsAddresses !== undefined) {
    if (dnsAddresses.some((address) => isPrivateAddress(address.address))) throw new Error('private network request is not allowed')
    return url
  }
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

function encodeFormBody(input: string, charset: string | undefined): string {
  const encodePart = (value: string): string => {
    let alreadyEncoded = true
    for (let index = 0; index < value.length; index += 1) {
      const current = value[index]!
      if (current === '%' && /^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) { index += 2; continue }
      if (!/^[A-Za-z0-9*._-]$/.test(current)) { alreadyEncoded = false; break }
    }
    if (charset === undefined && alreadyEncoded) return value
    return [...value].map((character) => {
      if (character === ' ') return '+'
      if (/^[A-Za-z0-9*._-]$/.test(character)) return character
      const bytes = encodeRequestBody(character, charset ?? 'utf-8')
      return [...bytes].map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('')
    }).join('')
  }
  return input.split('&').map((field) => {
    const equals = field.indexOf('=')
    return equals < 0 ? encodePart(field) : `${encodePart(field.slice(0, equals))}=${encodePart(field.slice(equals + 1))}`
  }).join('&')
}

export class NodeNetworkHost implements NetworkHost {
  private readonly cookieStore: CookieStore
  private readonly options: NodeNetworkOptions

  public constructor(options: NodeNetworkOptions = {}) {
    this.options = options
    this.cookieStore = options.cookieStore ?? new NodeCookieStore()
  }

  public encodeCharset(value: string, charset: string): Uint8Array {
    return encodeRequestBody(value, charset)
  }

  public async request(plan: RequestPlan): Promise<NetworkResponse> {
    const configuredDns = typeof plan.execution.dnsIp === 'string' && plan.execution.dnsIp.trim().length > 0 ? parseDnsIpAddresses(plan.execution.dnsIp) : undefined
    let currentUrl = await assertSafeUrl(plan.url, this.options, configuredDns)
    const dispatcher = configuredDns === undefined ? undefined : new Agent({ connect: { lookup: scopedDnsLookup(currentUrl.hostname, configuredDns) } })
    let currentMethod = plan.method
    let currentBody = plan.body
    let redirected = false
    let redirects = 0
    let requestCount = 0
    let totalBytes = 0
    let stripSensitiveHeaders = false
    try {
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
      const contentType = [...headers.entries()].find(([key]) => key.toLowerCase() === 'content-type')?.[1]
      const body = currentBody === undefined
        ? undefined
        : typeof currentBody === 'string'
          ? contentType?.toLowerCase().startsWith('application/x-www-form-urlencoded') === true
            ? Uint8Array.from(Buffer.from(encodeFormBody(currentBody, plan.requestCharset), 'ascii'))
            : plan.requestCharset === undefined ? currentBody : Uint8Array.from(encodeRequestBody(currentBody, plan.requestCharset))
          : Uint8Array.from(currentBody)
      if (body !== undefined && (typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength) > plan.budget.maxRequestBodyBytes) throw new Error('request body exceeds byte budget')
      const signal = timeoutSignal(plan)
      const init = { method: currentMethod, headers, redirect: 'manual', signal, ...(dispatcher === undefined ? {} : { dispatcher }) } as RequestInit
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
    } finally {
      if (dispatcher !== undefined) await dispatcher.close()
    }
  }
}

function encodeRequestBody(value: string, charset: string): Uint8Array {
  if (!iconv.encodingExists(charset)) throw new Error(`unsupported request charset: ${charset}`)
  return Uint8Array.from(iconv.encode(value, charset))
}
