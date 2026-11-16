import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySourceScriptCache, searchBooks } from '@legado/source-core'
import type { ClockHost, NetworkHost, NormalizedSource, WorkflowRuleOutput } from '@legado/source-core'
import { DEFAULT_ANDROID_USER_AGENT, NodeCookieStore, createNodeSourceSession } from '../src/index.ts'

const baseSource = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'fixture',
  jsLib: JSON.stringify({ helper: 'https://fixture.invalid/library.js' }),
} as NormalizedSource

test('Node 书源会话跨操作保留 source 变量和 jsLib 缓存，不同会话彼此隔离', async () => {
  const urls: string[] = []
  const network: NetworkHost = {
    request: async (plan) => {
      urls.push(plan.url)
      const text = 'function cachedHelper() { return "cached"; }'
      return {
        url: plan.url,
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
        bytes: new TextEncoder().encode(text),
        redirected: false,
      }
    },
  }
  const session = createNodeSourceSession(baseSource, { network })
  const evaluate = (rule: string): Promise<WorkflowRuleOutput> => session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'sessionProbe',
    rule,
    content: '',
  }))

  assert.equal((await evaluate('@js:cachedHelper()')).value, 'cached')
  assert.equal((await evaluate('@js:cachedHelper()')).value, 'cached')
  assert.equal(urls.length, 1, '同一会话的后续操作复用远程 jsLib')

  assert.equal((await evaluate("@js:source.put('sessionKey', 'session-value'); source.get('sessionKey')")).value, 'session-value')
  assert.equal((await evaluate("@js:source.putVariable('session-variable'); source.getVariable()")).value, 'session-variable')
  assert.deepEqual(session.snapshotVariables(), {})

  const isolated = createNodeSourceSession(baseSource, { network })
  const isolatedOutput = await isolated.run((ports) => ports.rules.evaluate({
    source: isolated.source,
    stage: 'search',
    field: 'sessionProbe',
    rule: "@js:source.get('sessionKey')",
    content: '',
  }))
  assert.equal(isolatedOutput.status, 'empty')
  assert.equal(isolated.snapshotVariables().sessionKey, undefined)
  assert.equal((await isolated.run((ports) => ports.rules.evaluate({
    source: isolated.source,
    stage: 'search',
    field: 'sessionProbe',
    rule: '@js:cachedHelper()',
    content: '',
  }))).value, 'cached')
  assert.equal(urls.length, 2, '新会话重新加载远程 jsLib')
})

test('mainJs bridge 请求进入发现工作流观测，而不是只显示为无请求', async () => {
  const urls: string[] = []
  const source = { ...baseSource, jsLib: '', mainJs: 'function search(key, page) { java.ajax("https://fixture.invalid/bridge?token=secret"); return [{name:"bridge书", bookUrl:"/book"}]; }' } as NormalizedSource
  const session = createNodeSourceSession(source, {
    network: {
      request: async (plan) => {
        urls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('ok'), redirected: false }
      },
    },
  })
  const result = await session.run((ports) => searchBooks(ports, { source: session.source, keyword: 'bridge' }))
  assert.equal(result.status, 'success')
  assert.deepEqual(urls, ['https://fixture.invalid/bridge?token=secret'])
  assert.deepEqual(result.observations?.map((item) => item.phase), ['planned', 'requested', 'response-received', 'success'])
  assert.equal(result.observations?.[0]?.target, 'https://fixture.invalid/bridge?token=%5Bredacted%5D')
  session.close()
})

test('Node 会话快照恢复源键值、登录状态和字符串缓存', async () => {
  const source = { ...baseSource, jsLib: '' } as NormalizedSource
  const first = createNodeSourceSession(source)
  await first.run((ports) => ports.rules.evaluate({
    source: first.source,
    stage: 'search',
    field: 'snapshot',
    rule: '@js:source.put("key", "value"); source.putVariable("variable"); source.putLoginHeader(JSON.stringify({Authorization:"Bearer saved"})); source.putLoginInfo(JSON.stringify({user:"alice"})); cache.put("saved", "cache-value"); "ok"',
    content: '',
  }))
  const snapshot = first.snapshotRuntimeState()
  assert.equal(snapshot.sourceValues?.[source.bookSourceUrl]?.key, 'value')
  assert.equal(snapshot.sourceVariables?.[source.bookSourceUrl], 'variable')
  assert.equal(snapshot.loginHeaders?.[source.bookSourceUrl], JSON.stringify({ Authorization: 'Bearer saved' }))
  assert.equal(snapshot.loginInfos?.[source.bookSourceUrl], JSON.stringify({ user: 'alice' }))
  assert.equal(snapshot.cache?.values?.saved?.value, 'cache-value')
  first.close()

  const restored = createNodeSourceSession(source, { initialRuntimeState: snapshot })
  const result = await restored.run((ports) => ports.rules.evaluate({
    source: restored.source,
    stage: 'search',
    field: 'snapshot',
    rule: '@js:[source.get("key"), source.getVariable(), source.getLoginHeader(), source.getLoginInfo(), cache.get("saved")].join("|")',
    content: '',
  }))
  assert.equal(result.value, 'value|variable|{"Authorization":"Bearer saved"}|{"user":"alice"}|cache-value')
  restored.close()
})

test('Node 会话快照仅恢复可序列化 jsLib 状态，闭包函数不会跨域伪造恢复', async () => {
  const source = { ...baseSource, jsLib: 'var serializableCounter = (typeof serializableCounter === "undefined" ? 0 : serializableCounter) + 1; var closureValue = (() => { const hidden = 7; return () => hidden; })();' } as NormalizedSource
  const first = createNodeSourceSession(source)
  const firstValue = await first.run((ports) => ports.rules.evaluate({ source: first.source, stage: 'search', field: 'jsLib', rule: '@js:JSON.stringify([serializableCounter, typeof closureValue, closureValue()])', content: '' }))
  assert.equal(firstValue.value, '[1,"function",7]')
  const snapshot = first.snapshotRuntimeState()
  first.close()
  const restored = createNodeSourceSession(source, { initialRuntimeState: snapshot })
  const restoredValue = await restored.run((ports) => ports.rules.evaluate({ source: restored.source, stage: 'search', field: 'jsLib', rule: '@js:JSON.stringify([serializableCounter, typeof closureValue, closureValue()])', content: '' }))
  assert.equal(restoredValue.value, '[2,"function",7]')
  restored.close()
})

test('共享宿主缓存中的同库来源在 refreshJSLib 后一起重置全局状态并保留普通变量和缓存', async () => {
  const sharedCache = new MemorySourceScriptCache()
  const library = 'function nextCount(value) { return (value || 0) + 1; }'
  const first = createNodeSourceSession({ ...baseSource, bookSourceUrl: 'https://first.invalid', jsLib: library } as NormalizedSource, { sharedCache })
  const second = createNodeSourceSession({ ...baseSource, bookSourceUrl: 'https://second.invalid', jsLib: library } as NormalizedSource, { sharedCache })
  const rule = '@js:globalThis.fixtureCounter = nextCount(globalThis.fixtureCounter); globalThis.fixtureP5SourceValue = Number(java.get("fixtureVariable") || 0) + 1; java.put("fixtureVariable", String(globalThis.fixtureP5SourceValue)); globalThis.fixtureP5CacheValue = Number(cache.get("fixtureCache") || 0) + 1; cache.put("fixtureCache", String(globalThis.fixtureP5CacheValue)); JSON.stringify({counter:globalThis.fixtureCounter,sourceValue:globalThis.fixtureP5SourceValue,cacheValue:globalThis.fixtureP5CacheValue})'
  const evaluate = (session: ReturnType<typeof createNodeSourceSession>, currentSource: NormalizedSource, currentRule = rule): Promise<WorkflowRuleOutput> => session.run((ports) => ports.rules.evaluate({ source: currentSource, stage: 'search', field: 'jsLibPeerRefresh', rule: currentRule, content: '' }))
  const value = async (session: ReturnType<typeof createNodeSourceSession>, currentSource: NormalizedSource): Promise<unknown> => {
    const output = await evaluate(session, currentSource)
    assert.equal(output.status, 'success', JSON.stringify(output))
    return JSON.parse(String(output.value))
  }
  const firstSource = first.source
  const secondSource = second.source

  try {
    const initial = await Promise.all([value(first, firstSource), value(second, secondSource)]) as Array<{ counter: number; sourceValue: number; cacheValue: number }>
    assert.deepEqual(initial.map((entry) => [entry.counter, entry.sourceValue]).sort(), [[1, 1], [1, 1]])
    assert.deepEqual(initial.map((entry) => entry.cacheValue).sort(), [1, 2])
    assert.equal((await evaluate(first, firstSource, '@js:source.refreshJSLib(); "refreshed"')).value, 'refreshed')
    assert.deepEqual(await value(first, firstSource), { counter: 1, sourceValue: 2, cacheValue: 3 })
    assert.deepEqual(await value(second, secondSource), { counter: 1, sourceValue: 2, cacheValue: 4 })
  } finally {
    first.close()
    second.close()
  }
})

test('共享宿主中的 refreshJSLib 清除同库的远程 jsLib 响应缓存', async () => {
  const sharedCache = new MemorySourceScriptCache()
  const libraryUrl = 'https://fixture.invalid/shared-library.js'
  const sourceDefinition = { ...baseSource, jsLib: JSON.stringify({ helper: libraryUrl }) } as NormalizedSource
  let downloadCount = 0
  const network: NetworkHost = {
    request: async (plan) => {
      downloadCount += 1
      const library = `function fixtureVersion() { return "version-${downloadCount}"; }`
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(library), redirected: false }
    },
  }
  const first = createNodeSourceSession({ ...sourceDefinition, bookSourceUrl: 'https://first.invalid' } as NormalizedSource, { sharedCache, network })
  const second = createNodeSourceSession({ ...sourceDefinition, bookSourceUrl: 'https://second.invalid' } as NormalizedSource, { sharedCache, network })
  const evaluate = (session: ReturnType<typeof createNodeSourceSession>, rule: string): Promise<WorkflowRuleOutput> => session.run((ports) => ports.rules.evaluate({ source: session.source, stage: 'search', field: 'jsLibRefresh', rule, content: '' }))

  try {
    assert.equal((await evaluate(first, '@js:fixtureVersion()')).value, 'version-1')
    assert.equal((await evaluate(second, '@js:fixtureVersion()')).value, 'version-1')
    assert.equal(downloadCount, 1, '同一 URL 的远程 jsLib 响应由共享宿主缓存复用')
    assert.equal((await evaluate(first, '@js:source.refreshJSLib(); "refreshed"')).value, 'refreshed')
    assert.equal((await evaluate(second, '@js:fixtureVersion()')).value, 'version-2')
    assert.equal(downloadCount, 2, '刷新移除同库引用的远程响应，peer 来源重新下载')
  } finally {
    first.close()
    second.close()
  }
})

test('Node 会话拒绝把带 sourceKey 的运行时快照恢复到另一书源', async () => {
  const first = createNodeSourceSession({ ...baseSource, jsLib: '' } as NormalizedSource)
  await first.run((ports) => ports.rules.evaluate({ source: first.source, stage: 'search', field: 'snapshot', rule: '@js:source.put("key", "source-a"); cache.put("saved", "a"); "ok"', content: '' }))
  const snapshot = first.snapshotRuntimeState()
  first.close()
  const other = createNodeSourceSession({ ...baseSource, bookSourceUrl: 'https://other.invalid', jsLib: '' } as NormalizedSource, { initialRuntimeState: snapshot })
  const result = await other.run((ports) => ports.rules.evaluate({ source: other.source, stage: 'search', field: 'snapshot', rule: '@js:JSON.stringify([source.get("key"), cache.get("saved")])', content: '' }))
  assert.deepEqual(JSON.parse(String(result.value)), ['', null])
  other.close()
})

test('会话关闭后在途操作的变量快照不会迟到写回', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const session = createNodeSourceSession({ ...baseSource, jsLib: '' } as NormalizedSource)
  const pending = session.run(async (ports) => {
    await gate
    return ports.rules.evaluate({ source: session.source, stage: 'search', field: 'late', rule: '@js:source.putVariable("late"); "ok"', content: '' })
  })
  session.close()
  release()
  await pending
  assert.equal(session.snapshotVariables().late, undefined)
})

test('Node 书源会话持有深拷贝并冻结的书源定义', () => {
  const input = { ...baseSource, extension: { label: 'initial' } } as NormalizedSource
  const session = createNodeSourceSession(input)
  const inputExtension = input.extension as { label: string }
  const sessionExtension = session.source.extension as { label: string }
  inputExtension.label = 'external-change'
  assert.equal(sessionExtension.label, 'initial')
  assert.throws(() => { sessionExtension.label = 'session-change' }, TypeError)
})

test('NodeCookieStore 可以序列化并恢复跨请求 Cookie', async () => {
  const store = new NodeCookieStore()
  await store.set('https://fixture.invalid/path', 'sid=abc; Path=/; HttpOnly')
  const restored = NodeCookieStore.fromSerialized(store.serialize())
  assert.equal(await restored.get('https://fixture.invalid/next'), 'sid=abc')
  assert.throws(() => NodeCookieStore.fromSerialized('{"invalid":true}'))
})

test('NodeCookieStore 模拟 Android 的 Cookie map、替换和有效域共享', async () => {
  const store = new NodeCookieStore()
  await store.set('https://reader.example.com/path', 'sid=abc; theme=dark')
  assert.equal(await store.get('https://cdn.example.com/next'), 'sid=abc; theme=dark')
  assert.equal(await store.getKey('https://cdn.example.com/next', 'sid'), 'abc')
  assert.deepEqual(store.cookieToMap('sid=abc; empty=; literal=null; ignored'), { sid: 'abc', literal: 'null' })
  assert.equal(store.mapToCookie({ sid: 'next', theme: 'light' }), 'sid=next; theme=light')
  await store.replaceCookie('https://cdn.example.com/next', 'sid=next; token=xyz')
  assert.equal(await store.get('https://reader.example.com/path'), 'sid=next; theme=dark; token=xyz')
  await store.remove('https://reader.example.com/path')
  assert.equal(await store.get('https://cdn.example.com/next'), undefined)
})

test('MemorySourceScriptCache 二进制缓存独立于字符串缓存且快照可恢复', () => {
  const cache = new MemorySourceScriptCache()
  cache.put('text', 'value')
  cache.putByteArray?.('bytes', Uint8Array.from([0, 1, 255]))
  const snapshot = cache.snapshot?.()
  assert.equal(snapshot?.version, 1)
  assert.equal(snapshot?.values?.text?.value, 'value')
  assert.equal(snapshot?.bytes?.bytes?.value, 'AAH/')
  const restored = new MemorySourceScriptCache()
  restored.restore?.(snapshot!)
  assert.equal(restored.get('text'), 'value')
  assert.deepEqual(Array.from(restored.getByteArray?.('bytes') ?? []), [0, 1, 255])
  restored.put('keep', 'newer')
  restored.restore?.({ version: 2 } as never)
  assert.equal(restored.get('keep'), 'newer')
  restored.restore?.({ version: 1, values: 'corrupt' } as never)
  assert.equal(restored.get('keep'), 'newer')
})

test('Node session preserves networkOptions defaultUserAgent through the source limiter wrapper', async () => {
  const session = createNodeSourceSession(baseSource, { networkOptions: { defaultUserAgent: 'platform-UA' } })
  const defaultUserAgent = await session.run(async (ports) => ports.network.defaultUserAgent)
  assert.equal(defaultUserAgent, 'platform-UA')
})

test('Node session 可以用 platformOptions 装配稳定设备值和阅读配置', async () => {
  const session = createNodeSourceSession({ ...baseSource, jsLib: '' } as NormalizedSource, {
    platformOptions: { deviceSeed: 'platform-options-test', appVariant: 'fixture', readBookConfig: { reverseToc: true }, themeMode: 'dark' },
  })
  const result = await session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'platform',
    rule: '@js:JSON.stringify([java.androidId(), java.deviceID(), java.getAppVariant(), java.getReadBookConfigMap().reverseToc, java.getThemeMode()])',
    content: '',
  }))
  assert.equal(result.status, 'success', result.message)
  const values = JSON.parse(String(result.value)) as unknown[]
  assert.equal(values[0], values[1])
  assert.equal(values[2], 'fixture')
  assert.equal(values[3], true)
  assert.equal(values[4], 'dark')
  session.close()
})

test('Node session uses the Android baseline User-Agent when no override is supplied', async () => {
  const session = createNodeSourceSession(baseSource)
  const defaultUserAgent = await session.run(async (ports) => ports.network.defaultUserAgent)
  assert.equal(defaultUserAgent, DEFAULT_ANDROID_USER_AGENT)
})

test('Node session preserves the independent login-header provider through the limiter wrapper', async () => {
  const session = createNodeSourceSession(baseSource, { networkOptions: { loginHeaderProvider: (sourceId) => ({ Authorization: `Bearer ${sourceId}` }) } })
  const loginHeaders = await session.run(async (ports) => ports.network.getLoginHeaders?.(baseSource.bookSourceUrl))
  assert.deepEqual(loginHeaders, { Authorization: `Bearer ${baseSource.bookSourceUrl}` })
  assert.equal(await session.run(async (ports) => ports.network.isLoginHeaderSite?.(baseSource.bookSourceUrl, 'https://cdn.fixture.invalid/page')), false)
})

test('Node session 将 source.putLoginHeader 注入后续请求并跨操作保留', async () => {
  const headers: Array<Readonly<Record<string, string>>> = []
  const network: NetworkHost = {
    request: async (plan) => {
      headers.push(plan.headers)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('ok'), redirected: false }
    },
  }
  const session = createNodeSourceSession({ ...baseSource, jsLib: '' } as NormalizedSource, { network })
  const set = await session.run((ports) => ports.rules.evaluate({ source: session.source, stage: 'search', field: 'login', rule: '@js:source.putLoginHeader(JSON.stringify({Authorization: "Bearer session"})); "ok"', content: '' }))
  assert.equal(set.status, 'success')
  await session.run((ports) => {
    if (ports.request === undefined) throw new Error('request adapter missing')
    return ports.request({ source: session.source, url: 'https://fixture.invalid/page', stage: 'search', options: {} })
  })
  await session.run((ports) => {
    if (ports.request === undefined) throw new Error('request adapter missing')
    return ports.request({ source: session.source, url: 'https://fixture.invalid/page2', stage: 'search', options: {} })
  })
  assert.deepEqual(headers.map((value) => value.Authorization), ['Bearer session', 'Bearer session'])
})

test('Node session reports invalid initial concurrentRate and closes its limiter lifecycle', async () => {
  const session = createNodeSourceSession({ ...baseSource, concurrentRate: 'broken' } as NormalizedSource)
  assert.equal(session.diagnostics()[0]?.code, 'invalid-config')
  await session.run(async () => undefined)
  session.close()
  await assert.rejects(() => session.run(async () => undefined), /source session is closed/)
})

test('同一 source session 的 source.putConcurrent 更新普通请求和脚本请求共享的限流窗口', async () => {
  let now = 0
  const waitDurations: number[] = []
  const times: number[] = []
  const clock: ClockHost = {
    now: () => now,
    wait: async (milliseconds, signal) => {
      if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      waitDurations.push(milliseconds)
      now += milliseconds
    },
  }
  const network: NetworkHost = {
    request: async (plan) => {
      times.push(now)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('ok'), redirected: false }
    },
  }
  const session = createNodeSourceSession({ ...baseSource, jsLib: '', concurrentRate: '0' } as NormalizedSource, { network, clock })
  const updated = await session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'concurrentRate',
    rule: '@js:source.putConcurrent("1/100"); "updated"',
    content: '',
  }))
  assert.equal(updated.status, 'success')

  const request = async (): Promise<void> => {
    await session.run((ports) => {
      if (ports.request === undefined) throw new Error('request adapter missing')
      return ports.request({ source: session.source, url: 'https://fixture.invalid/page', stage: 'search', options: {} })
    })
  }
  await request()
  const bridge = await session.run((ports) => ports.rules.evaluate({
    source: session.source,
    stage: 'search',
    field: 'bridgeRequest',
    rule: '@js:java.ajax("https://fixture.invalid/bridge")',
    content: '',
  }))
  assert.equal(bridge.status, 'success')
  assert.equal(bridge.value, 'ok')
  assert.deepEqual(times, [0, 100])
  assert.deepEqual(waitDurations, [100])
})
