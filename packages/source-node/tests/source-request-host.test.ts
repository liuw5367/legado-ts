import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetworkHost, NetworkResponse, NormalizedSource } from '../../source-core/src/public/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { NodeCharsetCodec } from '../src/charset.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const source = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'fixture',
  header: JSON.stringify({ 'X-Fixture': 'yes' }),
} as unknown as NormalizedSource

function response(url: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, bytes: new TextEncoder().encode('ok'), redirected: false }
}

test('书源请求宿主解析 URL 后 JSON options 并保留 POST/body/header', async () => {
  const plans: Array<{ method: string; url: string; body?: string; headers: Readonly<Record<string, string>> }> = []
  const network: NetworkHost = {
    request: async (plan) => {
      plans.push({ method: plan.method, url: plan.url, ...(typeof plan.body === 'string' ? { body: plan.body } : {}), headers: plan.headers })
      return response(plan.url)
    },
  }
  const host = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  const result = await host.request({ source, url: '/search,{"method":"POST","body":"q=fixture","headers":{"X-Rule":"yes"},"charset":"utf-8"}', stage: 'search', options: {} })
  assert.equal(new TextDecoder().decode(result.bytes), 'ok')
  assert.deepEqual(plans, [{ method: 'POST', url: 'https://fixture.invalid/search', body: 'q=fixture', headers: { 'X-Fixture': 'yes', 'X-Rule': 'yes' } }])
})

test('书源请求宿主兼容 fixture 中常见的单引号 options 写法', async () => {
  let method = ''
  let body: string | undefined
  const host = new SourceRequestHost({ network: { request: async (plan) => { method = plan.method; body = typeof plan.body === 'string' ? plan.body : undefined; return response(plan.url) } } })
  await host.request({ source, url: "/search,{'method':'POST','body':'q=it\\'s-ok'}", stage: 'search', options: {} })
  assert.equal(method, 'POST')
  assert.equal(body, "q=it's-ok")
})

test('书源请求宿主不会把 WebView 请求静默降级到普通 HTTP', async () => {
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  await assert.rejects(() => host.request({ source, url: '/search,{"webView":true}', stage: 'search', options: {} }), /WebView/)
})

test('响应解码按显式 charset、HTTP header、BOM、HTML meta、自动检测和 UTF-8 依次回退', () => {
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]) // “中文” in GBK.
  const make = (bytes: Uint8Array, headers: NetworkResponse['headers'] = {}): NetworkResponse => ({ ...response('https://fixture.invalid/'), headers, bytes })

  assert.equal(host.decodeResponse(make(gbk, { 'content-type': 'text/html; charset=gbk' })), '中文')
  assert.equal(host.decodeResponse(make(gbk, { 'content-type': 'text/html; charset=utf-8', 'x-legado-response-charset': 'gbk' })), '中文')
  const metaPrefix = new TextEncoder().encode('<meta charset="gbk">')
  const metaBytes = new Uint8Array([...metaPrefix, ...gbk])
  assert.equal(host.decodeResponse(make(metaBytes, { 'content-type': 'text/html' })), '<meta charset="gbk">中文')
  assert.equal(host.decodeResponse(make(metaBytes, { 'content-type': 'text/html; charset=gbk' })), '<meta charset="gbk">中文')

  const detectorText = '第一章，故事开始了。主人公走进书房，看到一本古老的书，封面上写着神秘的文字。'
  const detectorBytes = new NodeCharsetCodec().encode(detectorText, 'gbk')
  assert.equal(host.decodeResponse(make(detectorBytes)), detectorText)
  assert.equal(host.decodeResponse(make(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('第一章')]))), '第一章')
  assert.equal(host.decodeResponse(make(new TextEncoder().encode('第一章'))), '第一章')
})

test('cookie-remove 按地址删除，不波及其他书源的 Cookie', async () => {
  const cookies = new NodeCookieStore()
  await cookies.set('https://a.test/', 'sid=a')
  await cookies.set('https://b.test/', 'sid=b')
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) }, cookieStore: cookies })
  const ruleHost = new SourceRuleHost({ request: (input, signal, source) => host.requestFromBridge(input, signal, source) })
  host.attachRuleHost(ruleHost)
  const other = { bookSourceUrl: 'https://a.test', bookSourceName: 'a' } as unknown as NormalizedSource
  const result = await ruleHost.evaluate({ source: other, stage: 'search', field: 'fixture', rule: '@js:cookie.removeCookie(source.getKey())', content: '' })
  assert.notEqual(result.status, 'failed')
  assert.notEqual(result.status, 'capability-missing')
  assert.equal(await cookies.get('https://a.test/'), undefined)
  assert.equal(await cookies.get('https://b.test/'), 'sid=b')
})

test('桥接请求随求值携带书源，共享宿主跨源并发不串源', async () => {
  const seen: Array<string | undefined> = []
  const host = new SourceRuleHost({ request: async (_input, _signal, source) => { seen.push(source?.bookSourceUrl); return 'ok' } })
  const first = { bookSourceUrl: 'https://a.test', bookSourceName: 'a' } as unknown as NormalizedSource
  const second = { bookSourceUrl: 'https://b.test', bookSourceName: 'b' } as unknown as NormalizedSource
  await Promise.all([
    host.evaluate({ source: first, stage: 'search', field: 'fixture', rule: '@js:java.ajax("https://a.test/1")', content: '' }),
    host.evaluate({ source: second, stage: 'search', field: 'fixture', rule: '@js:java.ajax("https://b.test/1")', content: '' }),
  ])
  assert.deepEqual(seen.sort(), ['https://a.test', 'https://b.test'])
})

test('正文 webJs 提示在没有 WebView 宿主时显式失败', async () => {
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  await assert.rejects(
    () => host.request({ source, url: '/book/1/content', stage: 'detail', options: {}, execution: { webJs: 'window.legado=1' } }),
    /WebView/,
  )
  // 只有 sourceRegex 时不要求 WebView。
  const ok = await host.request({ source, url: '/book/1/content', stage: 'detail', options: {}, execution: { sourceRegex: 'id="content"' } })
  assert.equal(new TextDecoder().decode(ok.bytes), 'ok')
})
