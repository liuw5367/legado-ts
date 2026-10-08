import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '../../source-core/src/index.ts'
import type { NetworkHost, NetworkResponse, NormalizedSource, WorkflowPorts } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'
import { loadFixtureSources } from './helpers/corpus.ts'

function response(url: string, body: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
}

function ruleOf(source: NormalizedSource, group: string, field: string): string | undefined {
  const groupValue = source[group]
  if (typeof groupValue !== 'object' || groupValue === null || Array.isArray(groupValue)) return undefined
  const value = (groupValue as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 谓词：规则形态需与本测试的本地 HTML mock 结构匹配（非文件名/书源名）。 */
function matchesHtmlHostMock(source: NormalizedSource): boolean {
  const bookList = ruleOf(source, 'ruleSearch', 'bookList')
  const content = ruleOf(source, 'ruleContent', 'content')
  const chapterList = ruleOf(source, 'ruleToc', 'chapterList')
  const chapterName = ruleOf(source, 'ruleToc', 'chapterName')
  const chapterUrl = ruleOf(source, 'ruleToc', 'chapterUrl')
  if (bookList === undefined || content === undefined || chapterList === undefined || chapterName === undefined || chapterUrl === undefined) return false
  if (bookList.startsWith('$') || bookList.startsWith('<js>')) return false
  if (typeof source.searchUrl !== 'string' || source.searchUrl.length === 0) return false
  try {
    new URL(source.bookSourceUrl)
  } catch {
    return false
  }
  return bookList.includes('novel-item') && content.includes('.content') && chapterList.includes('chapter-list')
}

test('真实 HTML 书源规则可使用统一宿主贯通搜索、详情、目录和正文', async () => {
  const sources = await loadFixtureSources()
  const source = sources.find((item) => matchesHtmlHostMock(item))
  assert.ok(source, '语料中未找到与本地 HTML mock 规则形态匹配的书源')
  const base = source.bookSourceUrl

  const calls: string[] = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push(`${plan.method} ${plan.url}`)
      const url = new URL(plan.url)
      if (url.pathname.startsWith('/search')) return response(plan.url, '<section><div class="novel-item"><a class="title" href="/book/local"><span>我本无意成仙</span></a><div class="meta"><span class="author">作者</span></div><div class="desc">本地简介</div></div></section>')
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
  assert.equal(candidate.bookUrl, new URL('/book/local', base).href)

  ruleHost.setBindings({ key: '我本无意成仙', book: candidate })
  const details = await loadBookDetails(ports, { source, candidates: [candidate] })
  assert.equal(details.status, 'success')
  const book = details.value?.items[0]
  assert.ok(book)
  assert.equal(book.tocUrl, new URL('/book/local/toc', base).href)

  ruleHost.setBindings({ key: '我本无意成仙', book })
  const toc = await loadTableOfContents(ports, { source, book, maxPages: 3 })
  assert.equal(toc.status, 'success')
  const chapter = toc.value?.items[0]
  assert.ok(chapter)
  assert.equal(chapter.title, '第一章 初见')
  assert.equal(chapter.chapterUrl, new URL('/chapter/1', base).href)

  ruleHost.setBindings({ key: '我本无意成仙', book, chapter })
  const content = await loadChapterContent(ports, { source, book, chapter, maxPages: 3 })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.contentType, 'html')
  assert.equal(content.value?.cleaned, '　　正文内容：规则宿主流程通过。')
  assert.equal(calls.length, 4)
})

test('真实 JSONPath 过滤书源的目录规则经过离线响应执行', async () => {
  const sources = await loadFixtureSources()
  const source = sources.find((item) => ruleOf(item, 'ruleToc', 'chapterList')?.includes('data.catalog[?(@.grade > 1)]'))
  assert.ok(source, '语料中未找到 JSONPath grade 过滤目录规则')
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'http://m.yuedu.163.com/book/fixture',
    tocUrl: 'http://m.yuedu.163.com/search/book/data.json?source_uuid=fixture',
    name: '本地过滤测试书',
    rawFields: {},
    emptyFields: [],
    fieldErrors: {},
    traceRef: 'book:json-filter',
  }
  const ports: WorkflowPorts = {
    network: {
      request: async (plan) => ({
        url: plan.url,
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        bytes: new TextEncoder().encode(JSON.stringify({ data: { catalog: [
          { grade: 2, uuid: 'one', title: '第一章', needPay: false },
          { grade: 1, uuid: 'volume', title: '第一卷', needPay: false },
          { grade: 3, uuid: 'two', title: '第二章', needPay: true },
        ] } })),
        redirected: false,
      }),
    },
    rules: new SourceRuleHost(),
  }
  const result = await loadTableOfContents(ports, { source, book })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value?.items.map((item) => item.title), ['第一章', '第二章'])
  assert.deepEqual(result.value?.items.map((item) => item.chapterUrl), [
    'http://m.yuedu.163.com/reader/book/content.json?source_uuid=fixture&content_uuid=one',
    'http://m.yuedu.163.com/reader/book/content.json?source_uuid=fixture&content_uuid=two',
  ])
})

test('真实 JavaScript 目录规则通过 java.getElements 解析离线 HTML', async () => {
  const sources = await loadFixtureSources()
  const source = sources.find((item) => {
    const chapterList = ruleOf(item, 'ruleToc', 'chapterList') ?? ''
    return chapterList.includes('#list-chapterAll@dd')
      && ruleOf(item, 'ruleToc', 'chapterName') === 'text'
      && ruleOf(item, 'ruleToc', 'chapterUrl') === 'href'
  })
  assert.ok(source, '语料中未找到 java.getElements 目录规则')
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://www.biquge.casa/123/',
    tocUrl: 'https://www.biquge.casa/123/',
    name: '本地节点测试书',
    rawFields: {},
    emptyFields: [],
    fieldErrors: {},
    traceRef: 'book:js-elements',
  }
  const ports: WorkflowPorts = {
    network: {
      request: async (plan) => response(plan.url, '<div id="list-chapterAll"><dd><a href="chapter/one">第一章</a></dd><dd><a href="chapter/two">第二章</a></dd></div>'),
    },
    rules: new SourceRuleHost(),
  }
  const result = await loadTableOfContents(ports, { source, book })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value?.items.map((item) => item.title), ['第一章', '第二章'])
  assert.deepEqual(result.value?.items.map((item) => item.chapterUrl), [
    'https://www.biquge.casa/123/chapter/one',
    'https://www.biquge.casa/123/chapter/two',
  ])
})

test('声明式目录按当前书源类型准备 book 工作副本', async () => {
  const source = {
    bookSourceUrl: 'https://toc-type.test',
    bookSourceName: 'TOC Type',
    bookSourceType: 1,
    ruleToc: {
      chapterList: 'article',
      chapterName: '@js:String(book.type)',
      chapterUrl: 'href',
    },
  } as unknown as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async (plan) => response(plan.url, '<article><a href="/chapter/1">章节</a></article>') },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://toc-type.test/book',
    tocUrl: 'https://toc-type.test/toc',
    name: '类型测试',
    type: 8,
    rawFields: {},
    emptyFields: [],
    fieldErrors: {},
    traceRef: 'book:type',
  }

  const result = await loadTableOfContents(ports, { source, book })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.equal(result.value?.items[0]?.title, '32')
  assert.equal(result.value?.bookAfter?.type, 32)
  assert.equal(book.type, 8)
})

test('详情 init 保留多节点内容供后续字段规则继续解析', async () => {
  const source = {
    bookSourceUrl: 'https://multi-init.test',
    bookSourceName: 'Multi Init',
    ruleBookInfo: { init: '.part', name: '.title@text', author: '.author@text', canReName: 'true' },
  } as unknown as NormalizedSource
  const network: NetworkHost = {
    request: async (plan) => response(plan.url, '<main><section class="part"><h1 class="title"></h1></section><section class="part"><h1 class="title">目标书</h1><span class="author">作者</span></section></main>'),
  }
  const ports: WorkflowPorts = { network, rules: new SourceRuleHost() }
  const candidate = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://multi-init.test/book/1',
    name: '候选书名',
    rawFields: {},
    traceRef: 'search:0',
  }

  const result = await loadBookDetails(ports, { source, candidates: [candidate] })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.items[0]?.name, '目标书')
  assert.equal(result.value?.items[0]?.author, '作者')
})

test('详情规则区分原始详情地址和重定向后的响应地址', async () => {
  const source = {
    bookSourceUrl: 'https://redirect-source.test',
    bookSourceName: 'Redirect Context',
    ruleBookInfo: {
      name: '@js:baseUrl',
      author: '@js:redirectUrl',
      tocUrl: '@js:baseUrl + "/toc"',
      canReName: 'true',
    },
  } as unknown as NormalizedSource
  const ports: WorkflowPorts = {
    network: {
      request: async () => response('https://redirect-source.test/final/detail', '<main>详情</main>'),
    },
    rules: new SourceRuleHost(),
  }
  const candidate = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://redirect-source.test/original/detail',
    name: '候选书名',
    rawFields: {},
    traceRef: 'search:0',
  }

  const result = await loadBookDetails(ports, { source, candidates: [candidate] })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.items[0]?.name, 'https://redirect-source.test/original/detail')
  assert.equal(result.value?.items[0]?.author, 'https://redirect-source.test/final/detail')
  assert.equal(result.value?.items[0]?.tocUrl, 'https://redirect-source.test/original/detail/toc')
})

test('详情缺少目录地址时回退候选原始地址并复用当前响应', async () => {
  const source = {
    bookSourceUrl: 'https://toc-fallback.test',
    bookSourceName: 'TOC Fallback',
    ruleBookInfo: { name: '@js:baseUrl' },
  } as unknown as NormalizedSource
  const ports: WorkflowPorts = {
    network: {
      request: async () => response('https://redirect-toc.test/book-new', '<div class="toc">当前响应目录</div>'),
    },
    rules: new SourceRuleHost(),
  }
  const candidate = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://toc-fallback.test/book-old',
    name: '候选书',
    rawFields: {},
    traceRef: 'search:0',
  }

  const result = await loadBookDetails(ports, { source, candidates: [candidate] })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.equal(result.value?.items[0]?.tocUrl, 'https://toc-fallback.test/book-old')
  assert.equal(result.value?.items[0]?.tocHtml, '<div class="toc">当前响应目录</div>')
})

test('搜索字段逐步看到当前书籍和最终响应地址', async () => {
  const source = {
    bookSourceUrl: 'https://search-context.test',
    bookSourceName: 'Search Context',
    searchUrl: '/search',
    ruleSearch: {
      bookList: 'article',
      name: '.title@text',
      author: '@js:String(book.name) + "|" + baseUrl + "|" + redirectUrl',
      bookUrl: 'a@href',
    },
  } as unknown as NormalizedSource
  const ports: WorkflowPorts = {
    network: {
      request: async () => response('https://redirect-context.test/results/', '<article><span class="title">上下文书</span><a href="/book">详情</a></article>'),
    },
    rules: new SourceRuleHost(),
  }

  const result = await searchBooks(ports, { source, keyword: '上下文书' })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.equal(result.value?.items[0]?.name, '上下文书')
  assert.equal(result.value?.items[0]?.author, '上下文书|https://redirect-context.test/results/|https://redirect-context.test/results/')
  assert.equal(result.value?.items[0]?.bookUrl, 'https://redirect-context.test/book')
})

test('搜索详情页回退复用同一响应并提供渐进 book 绑定', async () => {
  const source = {
    bookSourceUrl: 'https://fallback-book.test',
    bookSourceName: 'Fallback Book',
    searchUrl: '/search',
    ruleSearch: { bookList: '.missing' },
    ruleBookInfo: {
      init: '.detail',
      name: '.title@text',
      author: '@js:book.putVariable("phase", "author"); book.name + "|" + book.bookUrl + "|" + book.originName',
    },
  } as unknown as NormalizedSource
  let requests = 0
  const ports: WorkflowPorts = {
    network: {
      request: async () => {
        requests += 1
        return response('https://fallback-book.test/final/book', '<main><section class="detail"><h1 class="title">回退详情</h1></section></main>')
      },
    },
    rules: new SourceRuleHost(),
  }

  const result = await searchBooks(ports, { source, keyword: '回退书' })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.equal(requests, 1)
  assert.equal(result.value?.items[0]?.name, '回退详情')
  assert.equal(result.value?.items[0]?.author, '回退详情|https://fallback-book.test/final/book|Fallback Book')
  assert.equal(result.value?.items[0]?.variable, '{"phase":"author"}')
  assert.equal(result.value?.items[0]?.bookUrl, 'https://fallback-book.test/final/book')

  const patterned = { ...source, bookUrlPattern: 'https://fallback-book.test/final/.*' } as unknown as NormalizedSource
  const patternResult = await searchBooks(ports, { source: patterned, keyword: '回退书' })
  assert.equal(patternResult.status, 'success', JSON.stringify(patternResult.diagnostics))
  assert.equal(requests, 2)
  assert.equal(patternResult.value?.items[0]?.author, '回退详情|https://fallback-book.test/final/book|Fallback Book')
})

test('声明式音频正文通过 Node 规则宿主提取 subContent 并写回歌词变量', async () => {
  const source = {
    bookSourceUrl: 'https://audio-sub.test',
    bookSourceName: 'Audio SubContent',
    bookSourceType: 1,
    ruleContent: { content: '@css:.content@text', subContent: '@css:.lyrics@text' },
  } as unknown as NormalizedSource
  const network: NetworkHost = { request: async (plan) => response(plan.url, '<main><div class="content">audio stream</div><pre class="lyrics">line one\nline two</pre></main>') }
  const ports: WorkflowPorts = { network, rules: new SourceRuleHost() }
  const chapter = { sourceId: source.bookSourceUrl, bookUrl: 'https://audio-sub.test/book', chapterUrl: 'https://audio-sub.test/chapter/1', index: 0, variable: '{"existing":"kept"}' }
  const result = await loadChapterContent(ports, { source, chapter })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.raw, 'audio stream')
  assert.deepEqual(result.value?.auxiliary, { kind: 'lyrics', content: 'line one\nline two' })
  assert.equal(chapter.variable, '{"existing":"kept"}')
  assert.deepEqual(JSON.parse(result.value?.chapter.variable ?? '{}'), { existing: 'kept', lyric: 'line one\nline two' })
})

test('AllInOne 正则目录行的 $1/$2/$3 可按捕获上下文提取章节字段', async () => {
  const source = {
    bookSourceUrl: 'https://all-in-one.test',
    bookSourceName: 'All In One',
    ruleToc: {
      chapterList: ':href="(/chapter/[^"]*)"[^>]*>([^<]*)</a>([^<]*)',
      chapterName: '$2',
      chapterUrl: '$1',
      updateTime: '$3',
    },
  } as unknown as NormalizedSource
  const network: NetworkHost = {
    request: async (plan) => response(plan.url, '<a href="/chapter/1">第一章</a>·最新'),
  }
  const ports: WorkflowPorts = { network, rules: new SourceRuleHost() }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://all-in-one.test/book/1',
    tocUrl: 'https://all-in-one.test/book/1/toc',
    name: '书',
    rawFields: {},
    traceRef: 'book:all-in-one',
    emptyFields: [],
    fieldErrors: {},
  }
  const toc = await loadTableOfContents(ports, { source, book })
  assert.equal(toc.status, 'success')
  const chapter = toc.value?.items[0]
  assert.ok(chapter)
  assert.equal(chapter.title, '第一章')
  assert.equal(chapter.chapterUrl, 'https://all-in-one.test/chapter/1')
  assert.equal(chapter.updateTime, '·最新')
})

test('JavaScript 书源按 Android 函数流贯通搜索、详情、目录和章节正文', async () => {
  const source = {
    bookSourceUrl: 'https://js-source.test',
    bookSourceName: 'JS Source',
    mainJs: [
      'function search(key, page) { return [{ name: key, author: "Writer", bookUrl: "/book", coverUrl: "/cover.png" }]; }',
      'function getBookInfo(book) { if (book.type !== 8) throw new Error("getBookInfo type mismatch: " + book.type); return { tocUrl: "/book/toc", coverUrl: "../covers/detail.png", latestChapterTitle: "最后一章" }; }',
      'function getChapters(book) { if (book.type !== 8) throw new Error("getChapters type mismatch: " + book.type); return [{ title: "第一章", url: "./chapter/1", isVip: true }]; }',
      'function getContent(chapter, book, nextChapterUrl) { if (book.type !== 8) throw new Error("getContent type mismatch: " + book.type); return chapter.title + ":" + book.name + ":" + nextChapterUrl; }',
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
  assert.equal(chapter.url, 'https://js-source.test/book/chapter/1')
  assert.equal(chapter.baseUrl, 'https://js-source.test/book/toc')
  assert.equal(chapter.chapterUrl, 'https://js-source.test/book/chapter/1')
  assert.equal(chapter.isVip, true)

  const content = await loadChapterContent(ports, { source, book, chapter, nextChapterUrl: 'https://js-source.test/book/chapter/2' })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.cleaned, '第一章:测试书:https://js-source.test/book/chapter/2')
  assert.deepEqual(requests, [])
})

test('声明式正文规则可以读取 nextChapterUrl 绑定', async () => {
  const source = {
    bookSourceUrl: 'https://next-binding.test',
    bookSourceName: 'Next Binding',
    ruleContent: { content: '@js:nextChapterUrl' },
    contentType: 'text',
  } as unknown as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async (plan) => response(plan.url, '正文页面') },
    rules: new SourceRuleHost(),
  }
  const chapter = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://next-binding.test/book',
    chapterUrl: 'https://next-binding.test/chapter/1',
    index: 0,
    title: '第一章',
  }

  const result = await loadChapterContent(ports, {
    source,
    chapter,
    nextChapterUrl: 'https://next-binding.test/chapter/2',
  })

  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, 'https://next-binding.test/chapter/2')
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
      preUpdateJs: 'book.tocUrl = fromBookInfo ? "/from-info" : "/updated-toc"',
      formatJs: 'if (index === 1) { chapter.title = title + "✓"; chapter.url = "formatted"; chapter.baseUrl = "https://format.test/base/"; chapter.isVip = true; chapter.tag = "formatted-tag"; void 0; }',
    },
    ruleContent: { content: 'literal:正文' },
  } as unknown as import('../../source-core/src/index.ts').NormalizedSource
  const requested: string[] = []
  const network: NetworkHost = { request: async (plan) => { requested.push(plan.url); return response(plan.url, plan.url.endsWith('/base/formatted') ? '<p>正文</p>' : '<a href="/chapter/1">第一章</a>') } }
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
  assert.equal(result.value?.items[0]?.chapterUrl, 'https://format.test/base/formatted')
  assert.equal(result.value?.items[0]?.isVip, true)
  assert.equal(result.value?.items[0]?.tag, 'formatted-tag')
  const content = await loadChapterContent(ports, { source, book, chapter: result.value!.items[0]! })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.cleaned, '正文')
  assert.ok(requested.includes('https://format.test/base/formatted'))
  await loadTableOfContents(ports, { source, book, runPerJs: true, isFromBookInfo: true })
  assert.ok(requested.includes('https://format.test/from-info'))
})

test('声明式目录字段的 JavaScript 绑定按字段顺序渐进回写', async () => {
  const source = {
    bookSourceUrl: 'https://progressive.test',
    bookSourceName: 'Progressive',
    ruleToc: {
      chapterList: 'a',
      chapterName: '@js:chapter.title = "渐进章"; chapter.title',
      chapterUrl: '@js:chapter.url = "/progressive"; chapter.url',
      updateTime: '@js:chapter.updateTime = "更新 1234字"; chapter.updateTime',
      isVolume: '@js:chapter.isVolume = true; chapter.isVolume',
      isVip: '@js:chapter.tag === "更新 1234字" && chapter.isVolume === true',
      isPay: '@js:chapter.isVolume === true',
    },
  } as unknown as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async (plan) => response(plan.url, '<a>原始节点</a>') },
    rules: new SourceRuleHost(),
  }
  const result = await loadTableOfContents(ports, {
    source,
    book: {
      sourceId: source.bookSourceUrl,
      bookUrl: 'https://progressive.test/book',
      tocUrl: 'https://progressive.test/book',
      tocHtml: '<a>原始节点</a>',
      name: '书',
      rawFields: {},
      traceRef: 'progressive',
      emptyFields: [],
      fieldErrors: {},
    },
  })
  assert.equal(result.status, 'success')
  const chapter = result.value?.items[0]
  assert.equal(chapter?.title, '渐进章')
  assert.equal(chapter?.chapterUrl, 'https://progressive.test/progressive')
  assert.equal(chapter?.isVolume, true)
  assert.equal(chapter?.isVip, true)
  assert.equal(chapter?.isPay, true)
  assert.equal(chapter?.tag, '更新 1234字')
  assert.equal(chapter?.wordCount, undefined)
})

test('目录规则读取 preUpdateJs 更新后的 book 对象', async () => {
  const source = {
    bookSourceUrl: 'https://binding-book.test',
    bookSourceName: 'Binding Book',
    ruleToc: {
      chapterList: 'a',
      chapterName: '@js:book.bookUrl',
      chapterUrl: 'href',
      preUpdateJs: 'book.bookUrl = "/new-book"; book.tocUrl = "/new-toc"',
    },
  } as unknown as NormalizedSource
  const requested: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => {
      requested.push(plan.url)
      return response(plan.url, '<a href="/chapter">章节</a>')
    } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://binding-book.test/old-book',
    tocUrl: 'https://binding-book.test/old-toc',
    name: '书',
    rawFields: {},
    traceRef: 'binding-book',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.deepEqual(requested, ['https://binding-book.test/new-toc'])
  assert.equal(result.value?.items[0]?.title, 'https://binding-book.test/new-book')
  assert.equal(result.value?.items[0]?.bookUrl, 'https://binding-book.test/new-book')
  assert.equal(result.value?.bookAfter?.bookUrl, 'https://binding-book.test/new-book')
  assert.equal(result.value?.bookAfter?.tocUrl, 'https://binding-book.test/new-toc')
  assert.equal(result.value?.bookAfter?.tocHtml, undefined)
})

test('preUpdateJs 的 refreshTocUrl 更新详情并让脚本和后续 TOC 使用新地址', async () => {
  const source = {
    bookSourceUrl: 'https://refresh-toc.test',
    bookSourceName: 'Refresh TOC',
    ruleBookInfo: { tocUrl: '$.toc' },
    ruleToc: {
      chapterList: 'a',
      chapterName: 'text',
      chapterUrl: 'href',
      preUpdateJs: 'book.bookUrl = "/new-book"; refreshTocUrl(); book.tocUrl += "?script=read-updated"',
    },
  } as unknown as NormalizedSource
  const requested: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => {
      requested.push(plan.url)
      if (plan.url.endsWith('/new-book')) return response(plan.url, '{"toc":"/new-toc"}')
      if (plan.url === 'https://refresh-toc.test/new-toc?script=read-updated') return response(plan.url, '<a href="/chapter">新目录</a>')
      throw new Error(`unexpected request ${plan.url}`)
    } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://refresh-toc.test/book',
    tocUrl: 'https://refresh-toc.test/old-toc',
    name: '书',
    rawFields: {},
    traceRef: 'refresh-toc',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.deepEqual(requested, [
    'https://refresh-toc.test/new-book',
    'https://refresh-toc.test/new-toc?script=read-updated',
  ])
  assert.equal(result.value?.items[0]?.title, '新目录')
})

test('preUpdateJs 的 reGetBook 精确匹配书名作者并让脚本读取更新后的书籍', async () => {
  const source = {
    bookSourceUrl: 'https://reget-book.test',
    bookSourceName: 'Reget Book',
    searchUrl: '/search?name={{key}}',
    ruleSearch: { bookList: '$.books[*]', name: '$.name<js>putVariable("shared", "new"); putVariable("added", "yes"); result</js>', author: '$.author', bookUrl: '$.url' },
    ruleBookInfo: { tocUrl: '$.toc' },
    ruleToc: {
      chapterList: 'a',
      chapterName: 'text',
      chapterUrl: 'href',
      preUpdateJs: 'reGetBook(); const variables = JSON.parse(book.variable); book.tocUrl = book.bookUrl.endsWith("/new-book") && variables.kept === "value" && variables.shared === "new" && variables.added === "yes" ? "/script-sees/new-book" : "/missing"',
    },
  } as unknown as NormalizedSource
  const requested: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => {
      requested.push(plan.url)
      if (new URL(plan.url).pathname === '/search') return response(plan.url, JSON.stringify({ books: [
        { name: '精准书', author: '另一作者', url: '/wrong' },
        { name: '精准书', author: '作者', url: '/new-book' },
      ] }))
      if (plan.url === 'https://reget-book.test/new-book') return response(plan.url, '{"toc":"/new-toc"}')
      if (plan.url === 'https://reget-book.test/script-sees/new-book') return response(plan.url, '<a href="/chapter">更新后目录</a>')
      throw new Error(`unexpected request ${plan.url}`)
    } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://reget-book.test/old-book',
    tocUrl: 'https://reget-book.test/old-toc',
    name: '精准书',
    author: '作者',
    variable: '{"kept":"value","shared":"old"}',
    rawFields: {},
    traceRef: 'reget-book',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true })

  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics))
  assert.deepEqual(requested.map((url) => new URL(url).pathname), ['/search', '/new-book', '/script-sees/new-book'])
  assert.equal(new URL(requested[0]!).searchParams.get('name'), '精准书')
  assert.equal(result.value?.items[0]?.title, '更新后目录')
})

test('refreshTocUrl 在详情页调用上下文中按 Android 行为跳过重复详情请求', async () => {
  const source = {
    bookSourceUrl: 'https://from-info.test',
    bookSourceName: 'From Info',
    ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href', preUpdateJs: 'refreshTocUrl()' },
  } as unknown as NormalizedSource
  const requested: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => { requested.push(plan.url); return response(plan.url, '<a href="/chapter">目录</a>') } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://from-info.test/book',
    tocUrl: 'https://from-info.test/toc',
    name: '书',
    rawFields: {},
    traceRef: 'from-info',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true, isFromBookInfo: true })

  assert.equal(result.status, 'success')
  assert.deepEqual(requested, ['https://from-info.test/toc'])
})

test('reGetBook 未找到书名和作者都匹配的候选时明确失败', async () => {
  const source = {
    bookSourceUrl: 'https://reget-miss.test',
    bookSourceName: 'Reget miss',
    searchUrl: '/search?name={{key}}',
    ruleSearch: { bookList: '$.books[*]', name: '$.name', author: '$.author', bookUrl: '$.url' },
    ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href', preUpdateJs: 'reGetBook()' },
  } as unknown as NormalizedSource
  const requested: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => {
      requested.push(plan.url)
      return response(plan.url, JSON.stringify({ books: [{ name: '精准书', author: '另一作者', url: '/wrong' }] }))
    } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://reget-miss.test/book',
    name: '精准书',
    author: '作者',
    rawFields: {},
    traceRef: 'reget-miss',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true })

  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0]?.field, 'preUpdateJs')
  assert.equal(requested.length, 1)
})

test('refreshTocUrl 详情请求失败时不继续解析旧目录', async () => {
  const source = {
    bookSourceUrl: 'https://refresh-fail.test',
    bookSourceName: 'Refresh fail',
    ruleBookInfo: { tocUrl: '$.toc' },
    ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href', preUpdateJs: 'refreshTocUrl()' },
  } as unknown as NormalizedSource
  const requested: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => {
      requested.push(plan.url)
      return { ...response(plan.url, 'server error'), status: 503 }
    } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://refresh-fail.test/book',
    tocUrl: 'https://refresh-fail.test/old-toc',
    name: '书',
    rawFields: {},
    traceRef: 'refresh-fail',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true })

  assert.equal(result.status, 'failed')
  assert.equal(result.value, null)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'empty-page' && diagnostic.stage === 'detail'))
  assert.deepEqual(requested, ['https://refresh-fail.test/book'])
})

test('预更新助手中的嵌套请求取消会取消目录工作流', async () => {
  const source = {
    bookSourceUrl: 'https://refresh-cancel.test',
    bookSourceName: 'Refresh cancel',
    ruleBookInfo: { tocUrl: '$.toc' },
    ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href', preUpdateJs: 'refreshTocUrl()' },
  } as unknown as NormalizedSource
  const controller = new AbortController()
  let requests = 0
  const ports: WorkflowPorts = {
    network: { request: async (plan) => {
      requests += 1
      controller.abort()
      return response(plan.url, '{"toc":"/new-toc"}')
    } },
    rules: new SourceRuleHost(),
  }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://refresh-cancel.test/book',
    tocUrl: 'https://refresh-cancel.test/old-toc',
    name: '书',
    rawFields: {},
    traceRef: 'refresh-cancel',
    emptyFields: [],
    fieldErrors: {},
  }

  const result = await loadTableOfContents(ports, { source, book, runPerJs: true, signal: controller.signal })

  assert.equal(result.status, 'cancelled')
  assert.equal(requests, 1)
})

test('formatJs 跨章节保留 gInt 与其他全局状态，并在每次目录操作后重置', async () => {
  const source = {
    bookSourceUrl: 'https://format-state.test',
    bookSourceName: 'Format State',
    ruleToc: {
      chapterList: 'a',
      chapterName: 'text',
      chapterUrl: 'href',
      formatJs: 'gInt = gInt + 1; state = (typeof state === "undefined" ? { count: 0 } : state); state.count += 1; title = title + ":" + gInt + ":" + state.count;',
    },
  } as unknown as NormalizedSource
  const body = '<a href="/chapter/1">第一章</a><a href="/chapter/2">第二章</a>'
  const network: NetworkHost = { request: async (plan) => response(plan.url, body) }
  const ruleHost = new SourceRuleHost()
  const ports: WorkflowPorts = { network, rules: ruleHost }
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://format-state.test/book',
    tocUrl: 'https://format-state.test/toc',
    name: '书',
    rawFields: {},
    traceRef: 'book:format-state',
    emptyFields: [],
    fieldErrors: {},
  }
  const run = () => loadTableOfContents(ports, { source, book })
  const expected = ['第一章:1:1', '第二章:2:2']
  const first = await run()
  assert.deepEqual(first.value?.items.map((chapter) => chapter.title), expected)
  const second = await run()
  assert.deepEqual(second.value?.items.map((chapter) => chapter.title), expected)
  const [parallelOne, parallelTwo] = await Promise.all([run(), run()])
  assert.deepEqual(parallelOne.value?.items.map((chapter) => chapter.title), expected)
  assert.deepEqual(parallelTwo.value?.items.map((chapter) => chapter.title), expected)
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
  assert.equal(toc.status, 'failed')
  assert.equal(toc.value, null)
  assert.ok(toc.diagnostics.some((diagnostic) => diagnostic.message === 'JS 目录为空'))
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
