import { CookieJar } from 'tough-cookie'
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
    for (const value of Array.isArray(setCookie) ? setCookie : [setCookie]) await this.jar.setCookie(value, url)
  }

  /** Android `CookieStore.removeCookie(url)`：只删除该地址范围内可见的 Cookie。 */
  public async remove(url: string): Promise<void> {
    for (const cookie of await this.jar.getCookies(url)) {
      if (cookie.domain === null) continue
      await this.jar.store.removeCookie(cookie.domain, cookie.path ?? '/', cookie.key)
    }
  }

  public async clear(): Promise<void> {
    await this.jar.removeAllCookies()
  }
}
