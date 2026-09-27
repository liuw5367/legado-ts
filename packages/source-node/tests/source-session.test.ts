import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetworkHost, NormalizedSource, WorkflowRuleOutput } from '@legado/source-core'
import { createNodeSourceSession } from '../src/index.ts'

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
