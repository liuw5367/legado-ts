import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChapterContent, searchBooks } from '../../source-core/src/index.ts'
import type { NetworkHost, NetworkResponse, NormalizedSource, WorkflowPorts } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

function session(bodies: Readonly<Record<string, string>>, calls: string[]): WorkflowPorts {
  const network: NetworkHost = {
    request: async (plan): Promise<NetworkResponse> => {
      calls.push(plan.url)
      const body = bodies[new URL(plan.url).pathname] ?? '{}'
      return { url: plan.url, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
    },
  }
  const requestHost = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  const ruleHost = new SourceRuleHost({ request: (input, signal, source) => requestHost.requestFromBridge(input, signal, source) })
  requestHost.attachRuleHost(ruleHost)
  return { network, rules: ruleHost, request: (input) => requestHost.request(input), decodeResponse: (input) => requestHost.decodeResponse(input) }
}

test('JSON 接口书源的无前缀键路径规则贯通搜索与正文', async () => {
  const calls: string[] = []
  const ports = session({
    '/search': JSON.stringify({ data: { books: [{ name: '我本无意成仙', author: '甲', url: '/book/1', kind: '玄幻' }] } }),
    '/book/1': JSON.stringify({ data: { chapterInfo: { content: '<p>JSON 正文</p>' } } }),
  }, calls)
  const source = {
    bookSourceUrl: 'https://api.test',
    bookSourceName: '接口源',
    searchUrl: 'https://api.test/search?q={{key}}',
    ruleSearch: { bookList: 'data.books', name: 'name', author: 'author', bookUrl: 'url', kind: 'kind' },
    ruleContent: { content: 'data.chapterInfo.content' },
  } as unknown as NormalizedSource

  const searched = await searchBooks(ports, { source, keyword: '我本无意成仙' })
  assert.equal(searched.status, 'success')
  assert.equal(searched.value?.items.length, 1)
  assert.equal(searched.value?.items[0]?.name, '我本无意成仙')
  assert.equal(searched.value?.items[0]?.bookUrl, 'https://api.test/book/1')
  assert.equal(searched.value?.items[0]?.kind, '玄幻')

  const content = await loadChapterContent(ports, {
    source,
    chapter: { sourceId: source.bookSourceUrl, bookUrl: 'https://api.test/book/1', chapterUrl: 'https://api.test/book/1', index: 0 },
    contentType: 'html',
  })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.cleaned, '<p>JSON 正文</p>')
})
