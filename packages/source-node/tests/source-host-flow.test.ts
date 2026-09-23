import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { importSources, loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '../../source-core/src/public/index.ts'
import type { NetworkHost, NetworkResponse, WorkflowPorts } from '../../source-core/src/public/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const sourceFile = new URL('../../../fixtures/source/collection/14328_c803e1b071690d18ce7acb5184727058.json', import.meta.url)

function response(url: string, body: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
}

test('真实 HTML 书源规则可使用统一宿主贯通搜索、详情、目录和正文', async () => {
  const imported = await importSources(await readFile(sourceFile, 'utf8'))
  const source = imported.find((candidate) => candidate.source?.bookSourceName === '笔趣阁成人版')?.source
  assert.ok(source)

  const calls: string[] = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push(`${plan.method} ${plan.url}`)
      const url = new URL(plan.url)
      if (url.pathname.startsWith('/search/')) return response(plan.url, '<section><div class="novel-item"><a class="title" href="/book/local"><span>我本无意成仙</span></a><div class="meta"><span class="author">作者</span></div><div class="desc">本地简介</div></div></section>')
      if (url.pathname === '/book/local') return response(plan.url, '<h1>我本无意成仙</h1><div class="info"><dl><dt>作者</dt><dd>作者</dd></dl></div><div class="desc-content">详情简介</div><a href="/book/local/toc">章节目录</a>')
      if (url.pathname === '/book/local/toc') return response(plan.url, '<div class="chapter-list"><a href="/chapter/1"><h4>第一章 初见</h4></a></div>')
      if (url.pathname === '/chapter/1') return response(plan.url, '<div class="content"><p>正文内容：规则宿主流程通过。</p></div>')
      return response(plan.url, '')
    },
  }
  let requestHost: SourceRequestHost
  const ruleHost = new SourceRuleHost({ request: (input, signal, source) => requestHost.requestFromBridge(input, signal, source) })
  requestHost = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  requestHost.attachRuleHost(ruleHost)
  const ports: WorkflowPorts = {
    network,
    rules: ruleHost,
    request: (input) => requestHost.request(input),
    decodeResponse: (input) => requestHost.decodeResponse(input),
  }

  ruleHost.setBindings({ key: '我本无意成仙', page: 1 })
  const search = await searchBooks(ports, { source, keyword: '我本无意成仙', maxItems: 3 })
  assert.equal(search.status, 'success')
  const candidate = search.value?.items[0]
  assert.ok(candidate)
  assert.equal(candidate.name, '我本无意成仙')
  // 相对详情地址按响应地址转绝对（Android isUrl 语义）。
  assert.equal(candidate.bookUrl, 'https://www.bbqqgg.com/book/local')

  ruleHost.setBindings({ key: '我本无意成仙', book: candidate })
  const details = await loadBookDetails(ports, { source, candidates: [candidate] })
  assert.equal(details.status, 'success')
  const book = details.value?.items[0]
  assert.ok(book)
  assert.equal(book.tocUrl, 'https://www.bbqqgg.com/book/local/toc')

  ruleHost.setBindings({ key: '我本无意成仙', book })
  const toc = await loadTableOfContents(ports, { source, book, maxPages: 3 })
  assert.equal(toc.status, 'success')
  const chapter = toc.value?.items[0]
  assert.ok(chapter)
  assert.equal(chapter.title, '第一章 初见')
  assert.equal(chapter.chapterUrl, 'https://www.bbqqgg.com/chapter/1')

  ruleHost.setBindings({ key: '我本无意成仙', book, chapter })
  const content = await loadChapterContent(ports, { source, chapter, maxPages: 3 })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.contentType, 'html')
  assert.equal(content.value?.cleaned, '<p>正文内容：规则宿主流程通过。</p>')
  assert.equal(calls.length, 4)
})
