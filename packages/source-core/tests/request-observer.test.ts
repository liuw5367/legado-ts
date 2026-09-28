import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceRequestRuntime } from '../src/index.ts'
import type { CharsetCodec, NetworkResponse, NormalizedSource, RequestObserver, RequestPlan } from '../src/index.ts'

const source: NormalizedSource = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: '观察器', bookSourceType: 0, enabled: true, ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }
const encoding: CharsetCodec = { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) }

function response(plan: RequestPlan, status: number): NetworkResponse {
  return { url: plan.url, status, headers: { 'content-type': 'text/plain' }, bytes: new TextEncoder().encode('body'), redirected: false }
}

test('请求观察器按重试顺序收到真实计划与结果，观察器异常不影响主请求', async () => {
  const events: string[] = []
  let calls = 0
  const observer: RequestObserver = {
    onStart: (event) => { events.push(`start:${event.attempt}:${event.plan.method}`); throw new Error('observer failure') },
    onComplete: (event) => events.push(`complete:${event.attempt}:${event.response.status}`),
    onError: (event) => events.push(`error:${event.attempt}:${event.error instanceof Error ? event.error.message : String(event.error)}`),
  }
  const runtime = new SourceRequestRuntime({
    network: { request: async (plan) => response(plan, ++calls === 1 ? 500 : 200) },
    encoding,
    requestObserver: observer,
  })
  const result = await runtime.request({ source, url: '/book,{"retry":1}', stage: 'search', options: { budget: { timeoutMs: 1000, maxRequests: 2, maxPages: 1, maxResponseBytes: 1000, maxTotalBytes: 2000, maxRequestBodyBytes: 1000, maxRedirects: 1 } } })
  assert.equal(result.status, 200)
  assert.deepEqual(events, ['start:0:GET', 'complete:0:500', 'start:1:GET', 'complete:1:200'])
})

test('网络异常也会生成错误观察事件并继续保留原始错误', async () => {
  const events: string[] = []
  const runtime = new SourceRequestRuntime({
    network: { request: async () => { throw new Error('network down') } },
    encoding,
    requestObserver: { onError: (event) => events.push(`${event.attempt}:${event.error instanceof Error ? event.error.message : String(event.error)}`) },
  })
  await assert.rejects(() => runtime.request({ source, url: '/book', stage: 'detail', options: {} }), /network down/u)
  assert.deepEqual(events, ['0:network down'])
})
