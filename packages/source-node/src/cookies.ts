import { CookieJar } from 'tough-cookie'
import type { CookieStore } from './types.ts'

export class NodeCookieStore implements CookieStore {
  private readonly jar: CookieJar

  public constructor(jar = new CookieJar()) {
    this.jar = jar
  }

  public async get(url: string): Promise<string | undefined> {
    const value = await this.jar.getCookieString(url)
    return value === '' ? undefined : value
  }

  public async set(url: string, setCookie: string | string[]): Promise<void> {
    for (const value of Array.isArray(setCookie) ? setCookie : [setCookie]) await this.jar.setCookie(value, url)
  }

  public async clear(): Promise<void> {
    await this.jar.removeAllCookies()
  }
}
