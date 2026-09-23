import assert from 'node:assert/strict'
import test from 'node:test'
import { searchBooks } from '../../source-core/src/public/index.ts'
import type { NetworkHost, NetworkResponse, NormalizedSource, WorkflowPorts } from '../../source-core/src/public/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

/** 语料里常见的真实形态：先清 Cookie，再用 POST JSON 选项搜索。 */
const cookiePrefixUrl = '{{cookie.removeCookie(source.getKey())}}\nhttps://www.22biqu.com/ss/,{\n  "method": "POST",\n  "body": "searchkey={{key}}"\n}'

function response(url: string, body: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
}

function session(network: NetworkHost): { ports: WorkflowPorts; cookies: NodeCookieStore } {
  const cookies = new NodeCookieStore()
  const requestHost = new SourceRequestHost({ network, cookieStore: cookies })
  const ruleHost = new SourceRuleHost({ request: (input, signal, source) => requestHost.requestFromBridge(input, signal, source) })
  requestHost.attachRuleHost(ruleHost)
  return {
    cookies,
    ports: { network, rules: ruleHost, request: (input) => requestHost.request(input), decodeResponse: (input) => requestHost.decodeResponse(input) },
  }
}

test('搜索 URL 的 {{...}} 按内联 JS 求值，不把字面量拼进地址', async () => {
  const calls: Array<{ method: string; url: string; body?: string | Uint8Array }> = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push({ method: plan.method, url: plan.url, ...(plan.body === undefined ? {} : { body: plan.body }) })
      return response(plan.url, '<div class="item"><a class="title" href="/book/1">我本无意成仙</a></div>')
    },
  }
  const { ports, cookies } = session(network)
  await cookies.set('https://www.22biqu.com', 'sid=stale; Path=/')
  const source = {
    bookSourceUrl: 'https://www.22biqu.com',
    bookSourceName: '笔趣阁',
    searchUrl: cookiePrefixUrl,
    ruleSearch: { bookList: '.item', name: '.title@text', bookUrl: 'a@href' },
  } as unknown as NormalizedSource

  const result = await searchBooks(ports, { source, keyword: '我本无意成仙' })
  assert.equal(result.status, 'success')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://www.22biqu.com/ss/')
  assert.equal(calls[0]?.method, 'POST')
  // 关键词按原值进入 POST body，不再被预编码。
  assert.equal(calls[0]?.body, 'searchkey=我本无意成仙')
  // {{cookie.removeCookie(...)}} 在 Android 返回 Unit，展开为空串而不是 "true"。
  assert.equal(await cookies.get('https://www.22biqu.com/ss/'), undefined)
})

test('搜索 URL 支持 java.encodeURI 等内联 JS 表达式和页码算术', async () => {
  const calls: string[] = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push(plan.url)
      return response(plan.url, '<div class="item"><a class="title" href="/book/1">书</a></div>')
    },
  }
  const { ports } = session(network)
  const source = {
    bookSourceUrl: 'https://api.test',
    bookSourceName: '接口源',
    searchUrl: 'https://api.test/search?q={{java.encodeURI(key)}}&offset={{(page-1)*10}}&t={{Date.now()}}',
    ruleSearch: { bookList: '.item', name: '.title@text', bookUrl: 'a@href' },
  } as unknown as NormalizedSource

  const result = await searchBooks(ports, { source, keyword: '中文 词' })
  assert.equal(result.status, 'success')
  const url = new URL(calls[0]!)
  assert.equal(url.searchParams.get('offset'), '0')
  assert.equal(decodeURIComponent(url.searchParams.get('q') ?? ''), '中文 词')
  assert.match(url.searchParams.get('t') ?? '', /^\d+$/)
  assert.ok(!calls[0]!.includes('{{'))
})

test('没有 JavaScript 能力时 URL 表达式展开失败可诊断，不静默保留字面量', async () => {
  const source = {
    bookSourceUrl: 'https://api.test',
    bookSourceName: '接口源',
    searchUrl: 'https://api.test/search?q={{java.base64Encode(key)}}',
    ruleSearch: { bookList: '.item', name: '.title@text', bookUrl: 'a@href' },
  } as unknown as NormalizedSource
  const calls: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => { calls.push(plan.url); return response(plan.url, '') } },
    rules: { evaluate: async () => ({ status: 'capability-missing', value: null, message: '没有 JavaScript 能力' }) },
  }
  const result = await searchBooks(ports, { source, keyword: '关键词' })
  assert.equal(result.status, 'capability-missing')
  assert.equal(calls.length, 0)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'capability-missing'))
})
