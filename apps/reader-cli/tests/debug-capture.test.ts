import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowTraceEntry } from '@legado/source-core'
import { DebugCapture, redactHeaders, redactUrl } from '../src/debug-capture.ts'

test('调试捕获脱敏请求头、查询参数和响应大小', () => {
  const capture = new DebugCapture({ sourceId: 'https://source.test', sourceName: '测试', mode: 'light' })
  capture.beginStage('search')
  capture.onStart({ id: 'search-1', source: { bookSourceUrl: 'https://source.test', bookSourceName: '测试' }, stage: 'search', attempt: 0, startedAt: 10, plan: { url: 'https://source.test/search?token=secret&q=book', method: 'GET', headers: { Authorization: 'secret', Accept: 'text/html' }, followRedirects: true, responseType: 'text', execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } } })
  capture.onComplete({ id: 'search-1', source: { bookSourceUrl: 'https://source.test', bookSourceName: '测试' }, stage: 'search', attempt: 0, startedAt: 10, durationMs: 4, plan: { url: 'https://source.test/search', method: 'GET', headers: {}, followRedirects: true, responseType: 'text', execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } }, response: { url: 'https://source.test/result?password=hidden', status: 200, headers: { 'set-cookie': 'secret' }, bytes: new TextEncoder().encode('result'), redirected: true } })
  const record = capture.requests[0]
  assert.ok(record)
  assert.match(record.url, /token=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D/u)
  assert.equal(record.headers.Authorization, '[已隐藏]')
  assert.equal(record.responseHeaders?.['set-cookie'], '[已隐藏]')
  assert.equal(record.status, 200)
  assert.equal(record.responseText, 'result')
  assert.equal(redactUrl('https://source.test/?api_key=abc'), 'https://source.test/?api_key=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D')
  assert.doesNotMatch(redactUrl('https://user:secret@source.test/?access_token=abc'), /secret|abc/u)
  assert.equal(redactHeaders({ Cookie: 'a=b' }).Cookie, '[已隐藏]')
})

test('调试捕获把 trace 和诊断转换为有序处理记录', () => {
  const capture = new DebugCapture({ sourceId: 'source', sourceName: '测试', mode: 'full' })
  const trace: WorkflowTraceEntry[] = [
    { stage: 'search', event: 'request', target: 'search' },
    { stage: 'search', event: 'rule', target: 'bookName', itemIndex: 0 },
    { stage: 'search', event: 'candidate', target: 'candidate:0', itemIndex: 0 },
  ]
  capture.recordResult('search', { status: 'empty', value: null, diagnostics: [{ code: 'empty-page', stage: 'search', message: '没有结果', retryable: false }], trace }, { candidates: 0 })
  capture.recordResult('search', { status: 'success', value: null, diagnostics: [], trace: [{ stage: 'search', event: 'candidate', target: 'candidate:1' }] }, { candidates: 1 })
  assert.equal(capture.stages[0]?.status, 'success')
  assert.ok(capture.processes.some((item) => item.kind === 'rule'))
  assert.ok(capture.processes.some((item) => item.state === 'empty'))
  assert.equal(capture.processes.filter((item) => item.kind === 'rule').length, 1)
  assert.equal(capture.stages[0]?.summary.candidates, 1)
})

test('多书源并发时请求编号不会因各自运行时重置而互相覆盖', () => {
  const capture = new DebugCapture({ sourceId: 'multi', sourceName: '搜索', mode: 'light' })
  const plan = { url: 'https://source.test/search', method: 'GET' as const, headers: {}, followRedirects: true, responseType: 'text' as const, execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } }
  const start = (sourceId: string) => ({ id: 'search-1', source: { bookSourceUrl: sourceId, bookSourceName: sourceId }, stage: 'search' as const, attempt: 0, startedAt: 1, plan })
  capture.onStart(start('https://one.test'))
  capture.onStart({ ...start('https://two.test'), kind: 'bridge' })
  capture.onComplete({ ...start('https://one.test'), durationMs: 2, response: { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('one'), redirected: false } })
  capture.onComplete({ ...start('https://two.test'), durationMs: 3, response: { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('two'), redirected: false } })
  assert.deepEqual(capture.requests.map((item) => item.id), ['request-1', 'request-2'])
  assert.equal(capture.requests[1]?.kind, 'bridge')
  assert.deepEqual(capture.requests.map((item) => item.responseText), ['one', 'two'])
})

test('多书源阶段汇总不会被最后一个空结果覆盖', () => {
  const capture = new DebugCapture({ sourceId: 'multi', sourceName: '搜索', mode: 'light' })
  capture.recordResult('search', { status: 'success', value: null, diagnostics: [], trace: [] }, { candidates: 1 })
  capture.recordResult('search', { status: 'empty', value: null, diagnostics: [], trace: [] }, { candidates: 0 })
  assert.equal(capture.stages[0]?.status, 'partial')
})
