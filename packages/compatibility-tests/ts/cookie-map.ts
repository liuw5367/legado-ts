import { createNodeSourceSession } from '../../source-node/src/source-session.ts'
import { NodeCookieStore } from '../../source-node/src/cookies.ts'
import type { NormalizedSource } from '../../source-core/src/index.ts'

const source = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'compatibility-tests',
  jsLib: '',
} as NormalizedSource

function string(input: Record<string, unknown>, name: string, fallback = ''): string {
  return typeof input[name] === 'string' ? input[name] as string : fallback
}

async function runRule(session: ReturnType<typeof createNodeSourceSession>, code: string): Promise<unknown> {
  const result = await session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'cookieMap',
    rule: `@js:${code}`,
    content: '',
  }))
  if (result.status !== 'success' && result.status !== 'empty') throw new Error(result.message ?? result.status)
  return result.value
}

/** 通过真实 QuickJS cookie facade 与 Node 请求宿主执行共享 Cookie Map 案例。 */
export async function executeCookieMap(input: Record<string, unknown>): Promise<unknown> {
  const kind = string(input, 'kind')
  const url = string(input, 'url', 'http://127.0.0.1/probe')
  const cookieStore = new NodeCookieStore()
  const originalFetch = globalThis.fetch
  const requestCookies: Array<string | null> = []
  if (kind === 'merge-request') {
    globalThis.fetch = async (_input, init) => {
      requestCookies.push(new Headers(init?.headers).get('cookie'))
      return new Response('fixture response', { status: 200 })
    }
  }
  const session = createNodeSourceSession(source, {
    cookieStore,
    ...(kind === 'merge-request' ? { networkOptions: { allowPrivateNetworks: true } } : {}),
  })
  try {
    if (kind === 'convert') {
      const cookie = JSON.stringify(string(input, 'cookie'))
      const raw = await runRule(session, `var map = cookie.cookieToMap(${cookie}); var keys = map.keySet().toArray(); JSON.stringify({keys:keys,values:keys.map(function(key){return map.get(key)}),size:map.size(),emptyPresent:map.containsKey(""),prototypePresent:map.containsKey("__proto__"),constructorPresent:map.containsKey("constructor"),cookie:cookie.mapToCookie(map)})`)
      return JSON.parse(String(raw)) as unknown
    }
    if (kind === 'merge-request') {
      await cookieStore.set(url, string(input, 'oldCookie'))
      const nextCookie = JSON.stringify(string(input, 'newCookie'))
      const raw = await runRule(session, `cookie.replaceCookie(${JSON.stringify(url)}, ${nextCookie}); java.ajax(${JSON.stringify(url)}); JSON.stringify({cookie:cookie.getCookie(${JSON.stringify(url)})})`)
      const state = JSON.parse(String(raw)) as { cookie: string }
      return { cookie: state.cookie, requestCookie: requestCookies.at(-1) ?? null }
    }
    throw new Error(`未知 Cookie Map 案例: ${kind}`)
  } finally {
    session.close()
    if (kind === 'merge-request') globalThis.fetch = originalFetch
  }
}
