import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DebugCapture } from '../src/debug-capture.ts'
import { exportDebugSession, panelText } from '../src/debug-export.ts'

test('调试会话可导出 Markdown 和 JSON，且只包含脱敏副本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-debug-'))
  try {
    const capture = new DebugCapture({ sourceId: 'source', sourceName: '测试', mode: 'full' })
    capture.beginStage('search')
    capture.onStart({ id: 'search-1', source: { bookSourceUrl: 'source', bookSourceName: '测试' }, stage: 'search', attempt: 0, startedAt: 1, plan: { url: 'https://source.test/?token=secret', method: 'GET', headers: { Authorization: 'secret' }, followRedirects: true, responseType: 'text', execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } } })
    capture.onComplete({ id: 'search-1', source: { bookSourceUrl: 'source', bookSourceName: '测试' }, stage: 'search', attempt: 0, startedAt: 1, durationMs: 2, plan: { url: 'https://source.test', method: 'GET', headers: {}, followRedirects: true, responseType: 'text', execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } }, response: { url: 'https://source.test', status: 200, headers: {}, bytes: new TextEncoder().encode('ok'), redirected: false } })
    capture.onStart({ id: 'search-2', source: { bookSourceUrl: 'source', bookSourceName: '测试' }, stage: 'search', attempt: 0, startedAt: 3, plan: { url: 'https://source.test/?token=secret', method: 'GET', headers: {}, followRedirects: true, responseType: 'text', execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } } })
    capture.onError({ id: 'search-2', source: { bookSourceUrl: 'source', bookSourceName: '测试' }, stage: 'search', attempt: 0, startedAt: 3, durationMs: 4, plan: { url: 'https://source.test', method: 'GET', headers: {}, followRedirects: true, responseType: 'text', execution: { useWebView: false }, budget: { timeoutMs: 1, maxRequests: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 1 } }, error: new Error('failed https://source.test/?token=secret') })
    capture.recordResult('search', { status: 'failed', value: null, diagnostics: [{ code: 'request-failed', stage: 'search', message: 'failed https://source.test/?token=secret', retryable: false }], trace: [{ stage: 'search', event: 'rule', target: 'token=secret' }] })
    const result = await exportDebugSession(capture, root)
    const markdown = await readFile(result.markdownPath, 'utf8')
    const json = await readFile(result.jsonPath, 'utf8')
    assert.match(markdown, /书源调试记录/u)
    assert.doesNotMatch(markdown, /secret/u)
    assert.doesNotMatch(json, /secret/u)
    assert.match(panelText(capture, 'requests'), /GET/u)
    assert.match(panelText(capture, 'response', 0, 'ok'), /ok/u)
    assert.doesNotMatch(panelText(capture, 'response', 0, 'missing'), /ok/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
