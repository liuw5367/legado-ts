import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestPlan } from '../src/public/index.ts'

test('请求计划解析相对地址、方法和请求体预算', () => {
  const result = createRequestPlan({
    url: '/search',
    baseUrl: 'https://example.test/root',
    method: 'post',
    body: '中文',
    budget: { maxRequestBodyBytes: 8 },
  })
  assert.ok(result.plan)
  assert.equal(result.plan.url, 'https://example.test/search')
  assert.equal(result.plan.method, 'POST')

  const tooLarge = createRequestPlan({ url: 'https://example.test', body: 'long', budget: { maxRequestBodyBytes: 2 } })
  assert.equal(tooLarge.error?.code, 'request-body-too-large')
})

test('请求计划拒绝 WebView 静默降级和不支持的方法', () => {
  assert.equal(createRequestPlan({ url: 'https://example.test', execution: { useWebView: true } }).error?.code, 'webview-required')
  assert.equal(createRequestPlan({ url: 'https://example.test', method: 'PATCH' }).error?.code, 'invalid-method')
})
