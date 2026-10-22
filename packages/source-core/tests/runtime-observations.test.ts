import assert from 'node:assert/strict'
import test from 'node:test'
import { searchBooks } from '../src/index.ts'
import type { NetworkResponse, NormalizedSource, WorkflowPorts } from '../src/index.ts'

const source: NormalizedSource = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: '请求观测 fixture',
  bookSourceType: 0,
  enabled: true,
  searchUrl: '/search?q={{keyword}}&token=secret',
  ruleSearch: { bookList: 'bookList', bookName: 'name', bookAuthor: 'author', bookUrl: 'url' },
  ruleBookInfo: {},
  ruleToc: {},
  ruleContent: {},
}

function response(url: string): NetworkResponse {
  return { url, status: 200, headers: {}, bytes: new TextEncoder().encode('fixture'), redirected: false }
}

function ports(request: (url: string) => Promise<NetworkResponse>, rows: unknown[]): WorkflowPorts {
  return {
    network: { request: async (plan) => request(plan.url) },
    request: async (input) => request(input.url),
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'bookList') return { status: 'success', value: rows }
        const row = content as Record<string, unknown>
        if (field === 'bookName') return { status: 'success', value: row.name }
        if (field === 'bookAuthor') return { status: 'success', value: row.author }
        if (field === 'bookUrl') return { status: 'success', value: row.url }
        return { status: 'empty', value: null }
      },
    },
  }
}

test('发现/搜索结果保留请求计划、响应和解析完成阶段，并脱敏 query', async () => {
  const result = await searchBooks(ports(async (url) => response(url), [{ name: '观测书', author: '作者', url: '/book' }]), { source, keyword: '关键词' })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.observations?.map((item) => item.phase), ['planned', 'requested', 'response-received', 'success'])
  assert.equal(result.observations?.[0]?.target, 'https://fixture.invalid/search?q=%E5%85%B3%E9%94%AE%E8%AF%8D&token=%5Bredacted%5D')
  assert.equal(result.observations?.[2]?.statusCode, 200)
  assert.equal(result.observations?.[2]?.responseBytes, 7)
})

test('响应成功但列表为空记录 parsed-empty，请求异常记录 failed', async () => {
  const empty = await searchBooks(ports(async (url) => response(url), []), { source, keyword: 'empty' })
  assert.equal(empty.status, 'empty')
  assert.deepEqual(empty.observations?.map((item) => item.phase), ['planned', 'requested', 'response-received', 'parsed-empty'])

  const failed = await searchBooks(ports(async () => { throw new Error('network down') }, []), { source, keyword: 'failed' })
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.observations?.map((item) => item.phase), ['planned', 'requested', 'failed'])
  assert.equal(failed.observations?.at(-1)?.errorCode, 'request-failed')
})

test('能力缺失和取消在真正请求前保留明确终态', async () => {
  const webViewSource = { ...source, searchUrl: '/search,{"webView":true}' }
  const webView = await searchBooks({
    network: { request: async (plan) => response(plan.url) },
    rules: { evaluate: async () => ({ status: 'empty', value: null }) },
  }, { source: webViewSource, keyword: 'webview' })
  assert.equal(webView.status, 'capability-missing')
  assert.deepEqual(webView.observations?.map((item) => item.phase), ['planned', 'capability-missing'])
  assert.equal(webView.observations?.at(-1)?.errorCode, 'capability-missing')

  const controller = new AbortController()
  controller.abort()
  const cancelled = await searchBooks(ports(async () => response('https://fixture.invalid/never'), []), { source, keyword: 'cancelled', signal: controller.signal })
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(cancelled.observations?.map((item) => item.phase), ['planned', 'cancelled'])

  const invalid = await searchBooks(ports(async (url) => response(url), []), { source: { ...source, searchUrl: '' }, keyword: 'invalid' })
  assert.equal(invalid.status, 'failed')
  assert.deepEqual(invalid.observations?.map((item) => item.phase), ['not-started'])
  assert.equal(invalid.observations?.[0]?.errorCode, 'invalid-config')
})

test('非法 JS 候选行产生 skipped observation，不伪装成请求为空', async () => {
  const jsSource = { ...source, mainJs: 'function search() {}' }
  const result = await searchBooks({
    network: { request: async (plan) => response(plan.url) },
    rules: {
      evaluate: async () => ({ status: 'empty', value: null }),
      executeSourceFunction: async () => ({ status: 'success', value: [{ name: '缺地址' }, { name: '有效', bookUrl: '/book' }], exists: true }),
    },
  }, { source: jsSource, keyword: 'js' })
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.observations?.map((item) => item.phase), ['skipped'])
  assert.equal(result.observations?.[0]?.itemIndex, 0)
})
