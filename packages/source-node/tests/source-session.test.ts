import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClockHost, NetworkHost, NormalizedSource, WorkflowRuleOutput } from '@legado/source-core'
import { DEFAULT_ANDROID_USER_AGENT, createNodeSourceSession } from '../src/index.ts'

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

  assert.equal((await evaluate("@js:source.put('sessionKey', 'session-value'); 'written'")).value, 'written')
  assert.equal((await evaluate("@js:getVar('sessionKey', 'source')")).value, 'session-value')
  assert.deepEqual(session.snapshotVariables(), { sessionKey: 'session-value' })

  const isolated = createNodeSourceSession(baseSource, { network })
  const isolatedOutput = await isolated.run((ports) => ports.rules.evaluate({
    source: isolated.source,
    stage: 'search',
    field: 'sessionProbe',
    rule: "@js:getVar('sessionKey', 'source')",
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

test('Node 书源会话持有深拷贝并冻结的书源定义', () => {
  const input = { ...baseSource, extension: { label: 'initial' } } as NormalizedSource
  const session = createNodeSourceSession(input)
  const inputExtension = input.extension as { label: string }
  const sessionExtension = session.source.extension as { label: string }
  inputExtension.label = 'external-change'
  assert.equal(sessionExtension.label, 'initial')
  assert.throws(() => { sessionExtension.label = 'session-change' }, TypeError)
})

test('Node session preserves networkOptions defaultUserAgent through the source limiter wrapper', async () => {
  const session = createNodeSourceSession(baseSource, { networkOptions: { defaultUserAgent: 'platform-UA' } })
  const defaultUserAgent = await session.run(async (ports) => ports.network.defaultUserAgent)
  assert.equal(defaultUserAgent, 'platform-UA')
})

test('Node session uses the Android baseline User-Agent when no override is supplied', async () => {
  const session = createNodeSourceSession(baseSource)
  const defaultUserAgent = await session.run(async (ports) => ports.network.defaultUserAgent)
  assert.equal(defaultUserAgent, DEFAULT_ANDROID_USER_AGENT)
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
