import { createSourceSession } from '@legado/source-core'
import type { NetworkHost, NormalizedSource, SourceScriptCache, SourceSession } from '@legado/source-core'
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
    createPorts: ({ initialVariables, cache }) => {
      const request = new SourceRequestHost({ network, cookieStore, encoding })
      const rules = new SourceRuleHost({
        request: (input, signal, currentSource) => request.requestFromBridge(input, signal, currentSource),
        initialVariables,
        cache,
      })
      request.attachRuleHost(rules)
      return {
        network,
        rules,
        request: (input) => request.request(input),
        decodeResponse: (response) => request.decodeResponse(response),
      }
    },
  })
}
