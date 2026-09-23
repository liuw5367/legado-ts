export interface CookieStore {
  /** 读取当前 source/session Cookie。 */
  get(url: string): Promise<string | undefined>
  /** 保存响应 Set-Cookie。 */
  set(url: string, setCookie: string | string[]): Promise<void>
  /** 按地址清理 Cookie（Android CookieStore.removeCookie(url)），不波及整个命名空间。 */
  remove(url: string): Promise<void>
  /** 显式清理当前 Cookie 命名空间。 */
  clear(): Promise<void>
}

export interface NodeNetworkOptions {
  /** 显式允许的协议；默认只允许 HTTP/HTTPS。 */
  protocols?: readonly string[]
  /** 是否允许环回、私网和链路本地地址；默认拒绝。 */
  allowPrivateNetworks?: boolean
  /** Cookie 存储；不传入时使用当前宿主实例的隔离 jar。 */
  cookieStore?: CookieStore
}
