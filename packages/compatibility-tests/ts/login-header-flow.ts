import { createNodeSourceSession, type NodeSourceRuntimeSnapshot, type NodeSourceSession } from '../../source-node/src/source-session.ts'
import { NodeCookieStore } from '../../source-node/src/cookies.ts'
import type { NormalizedSource } from '../../source-core/src/index.ts'

interface LoginHeaderTarget {
  name: string
  url: string
  headers?: Record<string, string>
}

interface LoginHeaderInput {
  source: { bookSourceUrl: string; header: string }
  initialCookie: string
  loginHeader: string
  targets: LoginHeaderTarget[]
  requestLimit: number
  variants: { cases: Array<{ name: string; initialCookie: string; loginHeader: string }> }
}

interface CapturedRequest {
  url: string
  authorization: string | null
  cookie: string | null
}

async function setLoginHeader(session: NodeSourceSession, raw: string): Promise<string | null> {
  const result = await session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'loginHeader',
    rule: `@js:source.putLoginHeader(${JSON.stringify(raw)}); JSON.stringify(source.getLoginHeader())`,
    content: '',
  }))
  if (result.status !== 'success' && result.status !== 'empty') throw new Error(result.message ?? result.status)
  return JSON.parse(String(result.value)) as string | null
}

async function getLoginHeaders(session: NodeSourceSession): Promise<Record<string, string> | null> {
  return session.run(async (ports) => {
    const value = await ports.network.getLoginHeaders?.(session.source.bookSourceUrl)
    return value === undefined ? null : Object.fromEntries(Object.entries(value))
  })
}

async function removeLoginHeader(session: NodeSourceSession): Promise<string | null> {
  const result = await session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'loginHeader',
    rule: '@js:source.removeLoginHeader(); JSON.stringify(source.getLoginHeader())',
    content: '',
  }))
  if (result.status !== 'success' && result.status !== 'empty') throw new Error(result.message ?? result.status)
  return JSON.parse(String(result.value)) as string | null
}

/** TS 使用真实 NodeSourceSession、SourceRequestHost、NodeNetworkHost 与 CookieJar，只替换 fetch 传输。 */
export async function executeLoginHeaderFlow(rawInput: Record<string, unknown>) {
  const input = rawInput as unknown as LoginHeaderInput
  const source = { ...input.source, bookSourceName: 'login-header-compatibility', jsLib: '' } as NormalizedSource
  const cookieStore = new NodeCookieStore()
  const captured: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (request, init) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
    const headers = new Headers(init?.headers)
    captured.push({ url, authorization: headers.get('authorization'), cookie: headers.get('cookie') })
    return new Response('fixture response', { status: 200 })
  }

  const createSession = (initialRuntimeState?: NodeSourceRuntimeSnapshot): NodeSourceSession => createNodeSourceSession(source, {
    cookieStore,
    networkOptions: { allowPrivateNetworks: true, defaultUserAgent: 'fixture-user-agent' },
    ...(initialRuntimeState === undefined ? {} : { initialRuntimeState }),
  })
  const request = async (session: NodeSourceSession, url: string): Promise<CapturedRequest> => {
    const previousCount = captured.length
    await session.run((ports) => {
      if (ports.request === undefined) throw new Error('source request adapter missing')
      return ports.request({ source: session.source, url, stage: 'search', options: {} })
    })
    if (captured.length !== previousCount + 1) throw new Error(`请求夹具数量错误: ${url}`)
    return captured[captured.length - 1]!
  }
  const publicHeaders = ({ authorization, cookie }: CapturedRequest) => ({ authorization, cookie })

  let first: NodeSourceSession | undefined
  let restored: NodeSourceSession | undefined
  try {
    await cookieStore.set(source.bookSourceUrl, input.initialCookie)
    first = createSession()
    const stored = await setLoginHeader(first, input.loginHeader)
    const cookieAfterPut = (await cookieStore.get(source.bookSourceUrl)) || null
    const requests = [] as Array<{ name: string; headers: { authorization: string | null; cookie: string | null } }>
    for (const target of input.targets) {
      const requestUrl = target.headers === undefined ? target.url : `${target.url},${JSON.stringify({ headers: target.headers })}`
      const result = await request(first, requestUrl)
      requests.push({ name: target.name, headers: publicHeaders(result) })
    }
    const snapshot = JSON.parse(JSON.stringify(first.snapshotRuntimeState())) as NodeSourceRuntimeSnapshot
    first.close()
    first = undefined

    restored = createSession(snapshot)
    const restoredTarget = input.targets[1]!
    const restoredState = {
      header: await restored.run((ports) => ports.rules.evaluate({
        source: restored!.source,
        stage: 'search',
        field: 'loginHeader',
        rule: '@js:JSON.stringify(source.getLoginHeader())',
        content: '',
      })).then((result) => {
        if (result.status !== 'success' && result.status !== 'empty') throw new Error(result.message ?? result.status)
        return JSON.parse(String(result.value)) as string | null
      }),
      request: publicHeaders(await request(restored, restoredTarget.url)),
    }
    const deletedHeader = await removeLoginHeader(restored)
    const deleted = {
      header: deletedHeader,
      cookie: (await cookieStore.get(source.bookSourceUrl)) || null,
      request: publicHeaders(await request(restored, input.targets[0]!.url)),
    }

    const variants = [] as Array<{ name: string; stored: string | null; loginHeaders: Record<string, string> | null; cookie: string | null }>
    for (const variant of input.variants.cases) {
      const variantCookieStore = new NodeCookieStore()
      await variantCookieStore.set(source.bookSourceUrl, variant.initialCookie)
      const variantSession = createNodeSourceSession(source, {
        cookieStore: variantCookieStore,
        networkOptions: { allowPrivateNetworks: true, defaultUserAgent: 'fixture-user-agent' },
      })
      try {
        const variantStored = await setLoginHeader(variantSession, variant.loginHeader)
        variants.push({
          name: variant.name,
          stored: variantStored,
          loginHeaders: await getLoginHeaders(variantSession),
          cookie: (await variantCookieStore.get(source.bookSourceUrl)) || null,
        })
      } finally {
        variantSession.close()
        await variantCookieStore.clear()
      }
    }
    if (captured.length > input.requestLimit) throw new Error('登录头请求超过夹具预算')
    return { stored, cookieAfterPut, requests, restored: restoredState, deleted, variants }
  } finally {
    first?.close()
    restored?.close()
    await cookieStore.clear()
    globalThis.fetch = originalFetch
  }
}
