import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetworkHost, NetworkResponse, NormalizedSource } from '../../source-core/src/public/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'

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
