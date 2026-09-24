import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { importSources, loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '../../source-core/src/index.ts'
import type { NetworkHost, NetworkResponse, WorkflowPorts } from '../../source-core/src/index.ts'
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

test('JavaScript 书源按 Android 函数流贯通搜索、详情、目录和章节正文', async () => {
  const source = {
    bookSourceUrl: 'https://js-source.test',
    bookSourceName: 'JS Source',
    mainJs: [
      'function search(key, page) { return [{ name: key, author: "Writer", bookUrl: "/book", coverUrl: "/cover.png" }]; }',
      'function getBookInfo(book) { return { tocUrl: "/book/toc", coverUrl: "../covers/detail.png", latestChapterTitle: "最后一章" }; }',
      'function getChapters(book) { return [{ title: "第一章", url: "./chapter/1", isVip: true }]; }',
      'function getContent(chapter, book, nextChapterUrl) { return chapter.title + ":" + book.name + ":" + nextChapterUrl; }',
    ].join('\n'),
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const requests: string[] = []
  let requestHost: SourceRequestHost
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => requestHost.requestFromBridge(input, signal, requestSource) })
  const network: NetworkHost = { request: async (plan) => { requests.push(plan.url); return response(plan.url, '') } }
  requestHost = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  requestHost.attachRuleHost(ruleHost)
  const ports: WorkflowPorts = { network, rules: ruleHost, request: (input) => requestHost.request(input), decodeResponse: (input) => requestHost.decodeResponse(input) }

  const search = await searchBooks(ports, { source, keyword: '测试书' })
  const candidate = search.value?.items[0]
  assert.ok(candidate)
  assert.equal(candidate.bookUrl, 'https://js-source.test/book')
  assert.equal(candidate.coverUrl, 'https://js-source.test/cover.png')

  const details = await loadBookDetails(ports, { source, candidates: [candidate] })
  const book = details.value?.items[0]
  assert.ok(book)
  assert.equal(book.tocUrl, 'https://js-source.test/book/toc')
  assert.equal(book.coverUrl, 'https://js-source.test/covers/detail.png')
  assert.equal(book.lastChapter, '最后一章')

  const toc = await loadTableOfContents(ports, { source, book })
  const chapter = toc.value?.items[0]
  assert.ok(chapter)
  assert.equal(chapter.chapterUrl, 'https://js-source.test/book/chapter/1')
  assert.equal(chapter.isVip, true)

  const content = await loadChapterContent(ports, { source, book, chapter, nextChapterUrl: 'https://js-source.test/book/chapter/2' })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.cleaned, '第一章:测试书:https://js-source.test/book/chapter/2')
  assert.deepEqual(requests, [])
})

test('loginCheckJs 收到可调用的 StrResponse 并用返回正文继续解析', async () => {
  const source = {
    bookSourceUrl: 'https://login-check.test',
    bookSourceName: 'Login Check',
    searchUrl: '/search',
    loginCheckJs: 'Packages.io.legado.app.help.http.StrResponse(result.url(), result.body().replace("旧书名", "新书名"))',
    ruleSearch: { bookList: '$.books[*]', name: '$.name', bookUrl: '$.url' },
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const network: NetworkHost = { request: async (plan) => response(plan.url, '{"books":[{"name":"旧书名","url":"/book"}]}') }
  const ports: WorkflowPorts = { network, rules: new SourceRuleHost() }
  const result = await searchBooks(ports, { source, keyword: '书' })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.items[0]?.name, '新书名')

  const retrySource = {
    ...source,
    bookSourceUrl: 'https://login-recover.test',
    searchUrl: '/offline-search',
    loginCheckJs: 'Packages.io.legado.app.help.http.StrResponse(result.url(), JSON.stringify({ books: [{ name: "恢复书", url: "/book" }] }))',
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const offlinePorts: WorkflowPorts = {
    network: { request: async () => { throw new Error('temporary network error') } },
    rules: new SourceRuleHost(),
  }
  const recovered = await searchBooks(offlinePorts, { source: retrySource, keyword: '书' })
  assert.equal(recovered.status, 'success')
  assert.equal(recovered.value?.items[0]?.name, '恢复书')
})

test('目录预处理和标题格式脚本按 Android 绑定更新 tocUrl 与章节标题', async () => {
  const source = {
    bookSourceUrl: 'https://format.test',
    bookSourceName: 'Format Source',
    ruleToc: {
      chapterList: 'a',
      chapterName: 'text',
      chapterUrl: 'href',
      preUpdateJs: 'book.tocUrl = "/updated-toc"',
      formatJs: 'if (index === 1) { chapter.title = title + "✓"; }',
    },
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const requested: string[] = []
  const network: NetworkHost = { request: async (plan) => { requested.push(plan.url); return response(plan.url, '<a href="/chapter/1">第一章</a>') } }
  const ports: WorkflowPorts = { network, rules: new SourceRuleHost() }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://format.test/book',
    tocUrl: 'https://format.test/original-toc',
    name: '书',
    rawFields: {},
    traceRef: 'book:0',
    emptyFields: [],
    fieldErrors: {},
  }
  const result = await loadTableOfContents(ports, { source, book, runPerJs: true })
  assert.equal(result.status, 'success')
  assert.equal(requested[0], 'https://format.test/updated-toc')
  assert.equal(result.value?.items[0]?.title, '第一章✓')
})

test('JavaScript 书源空返回与 Android 一样作为空列表处理', async () => {
  const source = {
    bookSourceUrl: 'https://empty-js-source.test',
    bookSourceName: 'Empty JS Source',
    mainJs: 'function search(key, page) { return; } function getChapters(book) { return null; }',
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const ports: WorkflowPorts = { network: { request: async (plan) => response(plan.url, '') }, rules: new SourceRuleHost() }
  const search = await searchBooks(ports, { source, keyword: '书' })
  assert.equal(search.status, 'empty')
  assert.deepEqual(search.value?.items, [])
  const toc = await loadTableOfContents(ports, {
    source,
    book: { sourceId: source.bookSourceUrl, bookUrl: 'https://empty-js-source.test/book', name: '书', rawFields: {}, traceRef: 'book:0', emptyFields: [], fieldErrors: {} },
  })
  assert.equal(toc.status, 'empty')
  assert.deepEqual(toc.value?.items, [])
})

test('getBookInfo 空字符串沿用搜索阶段字段', async () => {
  const source = {
    bookSourceUrl: 'https://empty-info.test',
    bookSourceName: 'Empty Info',
    mainJs: 'function getBookInfo(book) { return ""; }',
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const candidate = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://empty-info.test/book',
    name: '搜索书名',
    author: '搜索作者',
    rawFields: {},
    traceRef: 'search:0',
  }
  const result = await loadBookDetails({ network: { request: async (plan) => response(plan.url, '') }, rules: new SourceRuleHost() }, { source, candidates: [candidate] })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.items[0]?.name, '搜索书名')
  assert.equal(result.value?.items[0]?.author, '搜索作者')
})
