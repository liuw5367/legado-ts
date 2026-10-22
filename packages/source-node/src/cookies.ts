import { CookieJar, getPublicSuffix } from 'tough-cookie'
import type { CookieStore } from './types.ts'

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
    if (url.trim().length === 0 || cookie.trim().length === 0) return
    const merged = { ...cookieToMap(await this.get(url) ?? ''), ...cookieToMap(cookie) }
    await this.set(url, mapToCookie(merged) ?? '')
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
  const result: Record<string, string> = {}
  if (cookie.trim().length === 0) return result
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key.length > 0 && (value.length > 0 || value === 'null')) result[key] = value
  }
  return result
}

function mapToCookie(cookie: Readonly<Record<string, string>> | null | undefined): string | undefined {
  if (cookie === null || cookie === undefined) return undefined
  const entries = Object.entries(cookie)
  return entries.length === 0 ? undefined : entries.map(([key, value]) => `${key}=${value}`).join('; ')
}
