import { createSourceSession } from '@legado/source-core'
import type { ClockHost, ConcurrencyHost, NetworkHost, NormalizedSource, SourceScriptCache, SourceSession } from '@legado/source-core'
import { NodeCookieStore } from './cookies.ts'
import { NodeCharsetCodec } from './charset.ts'
import type { CookieStore, NodeNetworkOptions } from './types.ts'
import { NodeNetworkHost } from './http.ts'
import { SourceRequestHost } from './source-request-host.ts'
import { SourceRuleHost } from './source-rule-host.ts'

export interface NodeSourceSessionOptions {
  network?: NetworkHost
  networkOptions?: Omit<NodeNetworkOptions, 'cookieStore'>
  cookieStore?: CookieStore
  encoding?: NodeCharsetCodec
  cache?: SourceScriptCache
  initialVariables?: Readonly<Record<string, string>>
  clock?: ClockHost
  concurrency?: ConcurrencyHost
}

/** Node 装配网络、Cookie、字符集和 QuickJS；书源操作生命周期由 core session 管理。 */
export function createNodeSourceSession(source: NormalizedSource, options: NodeSourceSessionOptions = {}): SourceSession {
  const cookieStore = options.cookieStore ?? new NodeCookieStore()
  const network: NetworkHost = options.network ?? new NodeNetworkHost({ ...options.networkOptions, cookieStore })
  const encoding = options.encoding ?? new NodeCharsetCodec()
  return createSourceSession({
    source,
    ...(options.initialVariables === undefined ? {} : { initialVariables: options.initialVariables }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    network,
    createPorts: ({ initialVariables, cache, network: limitedNetwork, updateConcurrentRate, requestObserver }) => {
      const request = new SourceRequestHost({ network: limitedNetwork ?? network, cookieStore, encoding, ...(requestObserver === undefined ? {} : { requestObserver }) })
      const rules = new SourceRuleHost({
        request: (input, signal, currentSource) => request.requestFromBridge(input, signal, currentSource),
        setConcurrentRate: updateConcurrentRate,
        initialVariables,
        cache,
      })
      request.attachRuleHost(rules)
      return {
        network: limitedNetwork ?? network,
        rules,
        request: (input) => request.request(input),
        decodeResponse: (response) => request.decodeResponse(response),
        ...(requestObserver === undefined ? {} : { requestObserver }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      }
    },
  })
}
