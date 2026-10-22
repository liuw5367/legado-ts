import { createSourceSession, MemorySourceScriptCache } from '@legado/source-core'
import type { ClockHost, ConcurrencyHost, NetworkHost, NormalizedSource, SourceRuntimeConcurrency, SourceRuntimeState, SourceScriptCache, SourceScriptCacheSnapshot, SourceSession } from '@legado/source-core'
import { NodeCookieStore } from './cookies.ts'
import { NodeCharsetCodec } from './charset.ts'
import type { CookieStore, NodeNetworkOptions } from './types.ts'
import { NodeNetworkHost } from './http.ts'
import { SourceRequestHost } from './source-request-host.ts'
import { SourceRuleHost } from './source-rule-host.ts'
import { NodeSourceFileHost } from './source-file-host.ts'
import { NodeSourceConcurrency } from './source-concurrency.ts'
import { NodeSourceRuntimePlatform } from './runtime-platform.ts'

export interface NodeSourceSessionOptions {
  network?: NetworkHost
  networkOptions?: Omit<NodeNetworkOptions, 'cookieStore'>
  cookieStore?: CookieStore
  encoding?: NodeCharsetCodec
  cache?: SourceScriptCache
  initialVariables?: Readonly<Record<string, string>>
  clock?: ClockHost
  concurrency?: ConcurrencyHost
  /** Android SourceLock shared across operations in this source session. */
  sourceConcurrency?: SourceRuntimeConcurrency
  /** Application/platform bridge for Android JsExtensions outside pure core. */
  platform?: import('@legado/source-core').SourceRuntimePlatform
  /** 书源相对文件路径所在的受控缓存目录；缺省为系统临时目录下的 legado-source-cache。 */
  fileRoot?: string
  /** 从 Web/宿主恢复的源级字符串、登录和缓存状态。 */
  initialRuntimeState?: NodeSourceRuntimeSnapshot
}

export interface NodeSourceRuntimeSnapshot {
  version: 1
  sourceVariables?: Record<string, string>
  sourceValues?: Record<string, Record<string, string>>
  loginHeaders?: Record<string, string>
  loginInfos?: Record<string, string>
  cache?: SourceScriptCacheSnapshot
}

export interface NodeSourceSession extends SourceSession {
  /** 导出不包含真实 Cookie 的 Node 源运行状态，供应用层加密保存。 */
  snapshotRuntimeState(): NodeSourceRuntimeSnapshot
}

/** Node 装配网络、Cookie、字符集和 QuickJS；书源操作生命周期由 core session 管理。 */
export function createNodeSourceSession(source: NormalizedSource, options: NodeSourceSessionOptions = {}): NodeSourceSession {
  const cookieStore = options.cookieStore ?? new NodeCookieStore()
  const network: NetworkHost = options.network ?? new NodeNetworkHost({ ...options.networkOptions, cookieStore })
  const encoding = options.encoding ?? new NodeCharsetCodec()
  const loginHeaders = new Map<string, string>()
  const loginInfos = new Map<string, string>()
  const sourceVariables = new Map<string, string>()
  const sourceValues = new Map<string, Map<string, string>>()
  const runtimeState = options.initialRuntimeState
  const sourceKey = source.bookSourceUrl
  const initialValue = runtimeState?.sourceVariables?.[sourceKey]
  if (initialValue !== undefined) sourceVariables.set(sourceKey, initialValue)
  const initialValues = runtimeState?.sourceValues?.[sourceKey]
  if (initialValues !== undefined) sourceValues.set(sourceKey, new Map(Object.entries(initialValues)))
  const restoredLoginHeaders = runtimeState?.loginHeaders?.[sourceKey]
  const restoredLoginInfos = runtimeState?.loginInfos?.[sourceKey]
  const sourceConcurrency = options.sourceConcurrency ?? new NodeSourceConcurrency()
  const platform = options.platform ?? new NodeSourceRuntimePlatform()
  if (restoredLoginHeaders !== undefined) loginHeaders.set(sourceKey, restoredLoginHeaders)
  if (restoredLoginInfos !== undefined) loginInfos.set(sourceKey, restoredLoginInfos)
  const cache = options.cache ?? new MemorySourceScriptCache()
  if (runtimeState?.cache !== undefined) cache.restore?.(runtimeState.cache)
  const sourceState: SourceRuntimeState = {
    getVariable: (currentSource) => sourceVariables.get(currentSource.bookSourceUrl) ?? '',
    setVariable: (currentSource, value) => { if (value === null) sourceVariables.delete(currentSource.bookSourceUrl); else sourceVariables.set(currentSource.bookSourceUrl, value) },
    getValue: (currentSource, key) => sourceValues.get(currentSource.bookSourceUrl)?.get(key) ?? '',
    putValue: (currentSource, key, value) => {
      let values = sourceValues.get(currentSource.bookSourceUrl)
      if (values === undefined) { values = new Map<string, string>(); sourceValues.set(currentSource.bookSourceUrl, values) }
      values.set(key, value)
      return value
    },
    getLoginHeader: (currentSource) => loginHeaders.get(currentSource.bookSourceUrl) ?? null,
    putLoginHeader: async (currentSource, value) => {
      loginHeaders.set(currentSource.bookSourceUrl, value)
      try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const cookie = Object.entries(parsed).find(([key]) => key.toLowerCase() === 'cookie')?.[1]
          if (cookie !== undefined) {
            const url = new URL(currentSource.bookSourceUrl).toString()
            await cookieStore.remove(url)
            await cookieStore.set(url, String(cookie))
          }
        }
      } catch {
        // Android ignores malformed login headers for cookie replacement but keeps the raw header.
      }
    },
    removeLoginHeader: async (currentSource) => {
      loginHeaders.delete(currentSource.bookSourceUrl)
      await cookieStore.remove(new URL(currentSource.bookSourceUrl).toString())
    },
    getLoginInfo: (currentSource) => loginInfos.get(currentSource.bookSourceUrl) ?? null,
    getLoginInfoMap: (currentSource) => {
      const raw = loginInfos.get(currentSource.bookSourceUrl)
      if (raw === undefined) return undefined
      try {
        const parsed: unknown = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]))
          : {}
      } catch {
        return {}
      }
    },
    putLoginInfo: (currentSource, value) => { loginInfos.set(currentSource.bookSourceUrl, value); return true },
    removeLoginInfo: (currentSource) => { loginInfos.delete(currentSource.bookSourceUrl) },
  }
  const loginAwareNetwork = (base: NetworkHost): NetworkHost => ({
    request: (plan) => base.request(plan),
    ...(base.defaultUserAgent === undefined ? {} : { defaultUserAgent: base.defaultUserAgent }),
    getLoginHeaders: async (sourceId) => {
      const external = base.getLoginHeaders === undefined ? undefined : await base.getLoginHeaders(sourceId)
      const raw = loginHeaders.get(sourceId)
      let stored: Readonly<Record<string, string>> | undefined
      if (raw !== undefined) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) stored = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]))
        } catch {
          stored = undefined
        }
      }
      return external === undefined && stored === undefined ? undefined : { ...(external ?? {}), ...(stored ?? {}) }
    },
    ...(base.isLoginHeaderSite === undefined ? {} : { isLoginHeaderSite: base.isLoginHeaderSite.bind(base) }),
    ...(base.encodeCharset === undefined ? {} : { encodeCharset: base.encodeCharset.bind(base) }),
  })
  const session = createSourceSession({
    source,
    ...(options.initialVariables === undefined ? {} : { initialVariables: options.initialVariables }),
    cache,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    network,
    createPorts: ({ initialVariables, cache, network: limitedNetwork, updateConcurrentRate, requestObserver }) => {
      const requestNetwork = loginAwareNetwork(limitedNetwork ?? network)
      const request = new SourceRequestHost({ network: requestNetwork, cookieStore, encoding, ...(requestObserver === undefined ? {} : { requestObserver }) })
      const file = new NodeSourceFileHost({ network: requestNetwork, encoding, requestBytes: (url, signal, currentSource) => request.requestBytes(url, signal, currentSource), ...(options.fileRoot === undefined ? {} : { root: options.fileRoot }) })
      const rules = new SourceRuleHost({
        request: (input, signal, currentSource, requestObserver) => request.requestFromBridge(input, signal, currentSource, requestObserver),
        setConcurrentRate: updateConcurrentRate,
        initialVariables,
        cache,
        file,
        sourceState,
        concurrency: sourceConcurrency,
        platform,
      })
      request.attachRuleHost(rules)
      return {
        network: requestNetwork,
        rules,
        request: (input) => request.request(input),
        decodeResponse: (response) => request.decodeResponse(response),
        ...(requestObserver === undefined ? {} : { requestObserver }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      }
    },
    onClose: () => sourceConcurrency.close?.(),
  })
  return Object.assign(session, {
    snapshotRuntimeState: (): NodeSourceRuntimeSnapshot => {
      const values = sourceValues.get(sourceKey)
      const cacheSnapshot = cache.snapshot?.()
      return {
        version: 1,
        ...(sourceVariables.has(sourceKey) ? { sourceVariables: { [sourceKey]: sourceVariables.get(sourceKey)! } } : {}),
        ...(values !== undefined && values.size > 0 ? { sourceValues: { [sourceKey]: Object.fromEntries(values) } } : {}),
        ...(loginHeaders.has(sourceKey) ? { loginHeaders: { [sourceKey]: loginHeaders.get(sourceKey)! } } : {}),
        ...(loginInfos.has(sourceKey) ? { loginInfos: { [sourceKey]: loginInfos.get(sourceKey)! } } : {}),
        ...(cacheSnapshot === undefined || (cacheSnapshot.values === undefined && cacheSnapshot.memory === undefined && cacheSnapshot.files === undefined) ? {} : { cache: cacheSnapshot }),
      }
    },
  })
}
