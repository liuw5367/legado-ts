import { CookieJar, getPublicSuffix } from 'tough-cookie'
import type { CookieStore } from './types.ts'

type CookieMapEntries = readonly (readonly [string, string])[]

const cookieMapEntries = new WeakMap<object, CookieMapEntries>()

export class NodeCookieStore implements CookieStore {
  private readonly jar: CookieJar

  public constructor(jar = new CookieJar()) {
    this.jar = jar
  }

  /** 将当前 Cookie jar 编码成可交给宿主持久化的 JSON 字符串。 */
  public serialize(): string {
    return JSON.stringify(this.jar.serializeSync() ?? {})
  }

  /** 从宿主恢复 Cookie jar；输入来自受信任的服务端持久化状态。 */
  public static fromSerialized(value: string): NodeCookieStore {
    return new NodeCookieStore(CookieJar.deserializeSync(value))
  }

  public async get(url: string): Promise<string | undefined> {
    const value = await this.jar.getCookieString(url)
    return value === '' ? undefined : value
  }

  public async set(url: string, setCookie: string | string[]): Promise<void> {
    const values = Array.isArray(setCookie) ? setCookie : splitCookieHeader(setCookie)
    for (const value of values) {
      const normalized = normalizeAndroidCookie(value, url)
      if (normalized.length > 0) await this.jar.setCookie(normalized, url)
    }
  }

  public async getKey(url: string, key: string): Promise<string> {
    return cookieToMap(await this.get(url) ?? '')[key] ?? ''
  }

  public async replaceCookie(url: string, cookie: string): Promise<void> {
    if (url.length === 0 || cookie.length === 0) return
    const merged = new Map(cookieMapEntriesOf(cookieToMap(await this.get(url) ?? '')))
    for (const [key, value] of cookieMapEntriesOf(cookieToMap(cookie))) merged.set(key, value)
    await this.set(url, serializeCookieMap(merged) ?? '')
  }

  public cookieToMap(cookie: string): Record<string, string> {
    return cookieToMap(cookie)
  }

  public mapToCookie(cookie: Readonly<Record<string, string>> | null | undefined): string | undefined {
    return mapToCookie(cookie)
  }

  /** Android `CookieStore.removeCookie(url)`：清理同一有效域名下的 Cookie。 */
  public async remove(url: string): Promise<void> {
    const target = androidCookieDomain(url)
    const serialized = this.jar.serializeSync() ?? { cookies: [] }
    for (const cookie of serialized.cookies ?? []) {
      if (typeof cookie.domain !== 'string' || !sameAndroidDomain(cookie.domain, target) || typeof cookie.key !== 'string') continue
      await this.jar.store.removeCookie(cookie.domain, typeof cookie.path === 'string' ? cookie.path : '/', cookie.key)
    }
  }

  public async clear(): Promise<void> {
    await this.jar.removeAllCookies()
  }
}

function splitCookieHeader(value: string): string[] {
  const parts = value.split(';').map((item) => item.trim()).filter((item) => item.length > 0)
  if (parts.length <= 1) return parts
  const hasSetCookieAttribute = parts.slice(1).some((item) => /^(?:path|domain|max-age|expires|secure|httponly|samesite|partitioned)(?:=|$)/iu.test(item))
  return hasSetCookieAttribute ? [value] : parts.filter((item) => item.includes('='))
}

function normalizeAndroidCookie(value: string, url: string): string {
  if (/(?:^|;)\s*domain\s*=/iu.test(value)) return value
  const domain = androidCookieDomain(url)
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (domain.length > 0 && domain !== host && host !== 'localhost' && !/^\d+(?:\.\d+){3}$/u.test(host)) return `${value}; Domain=${domain}`
  } catch {
    // Invalid URLs are rejected by tough-cookie with its normal diagnostic.
  }
  return value
}

function androidCookieDomain(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
  try { return getPublicSuffix(host) ?? host } catch { return host }
}

function sameAndroidDomain(domain: string, target: string): boolean {
  if (target.length === 0) return false
  const normalized = domain.replace(/^\./u, '').toLowerCase()
  return normalized === target || normalized.endsWith(`.${target}`)
}

function cookieToMap(cookie: string): Record<string, string> {
  const entries = new Map<string, string>()
  if (isAndroidBlank(cookie)) return cookieMapRecord(entries)
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = trimAndroidCookieText(part.slice(0, separator))
    const rawValue = part.slice(separator + 1)
    const value = trimAndroidCookieText(rawValue)
    if (isAndroidNotBlank(rawValue) || value === 'null') entries.set(key, value)
  }
  return cookieMapRecord(entries)
}

function mapToCookie(cookie: Readonly<Record<string, string>> | null | undefined): string | undefined {
  if (cookie === null || cookie === undefined) return undefined
  return serializeCookieMap(cookieMapEntriesOf(cookie))
}

function cookieMapRecord(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const result: Record<string, string> = {}
  const orderedEntries = [...entries]
  for (const [key, value] of orderedEntries) {
    Object.defineProperty(result, key, { value, configurable: true, enumerable: true, writable: true })
  }
  cookieMapEntries.set(result, orderedEntries)
  return result
}

function cookieMapEntriesOf(cookie: Readonly<Record<string, string>>): CookieMapEntries {
  return cookieMapEntries.get(cookie) ?? Object.entries(cookie)
}

function serializeCookieMap(entries: Iterable<readonly [string, string]>): string | undefined {
  const values = [...entries]
  return values.length === 0 ? undefined : values.map(([key, value]) => `${key}=${value}`).join('; ')
}

function trimAndroidCookieText(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1
  return value.slice(start, end)
}

function isAndroidNotBlank(value: string): boolean {
  return Array.from(value).some((character) => !androidWhitespace.test(character))
}

function isAndroidBlank(value: string): boolean {
  return !isAndroidNotBlank(value)
}

// Kotlin Char.isWhitespace() is Character.isWhitespace() or Character.isSpaceChar(); FEFF is not blank there.
const androidWhitespace = /^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u
