import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChapterContent, loadTableOfContents } from '../src/index.ts'
import type { BookMetadata, ChapterIdentity, NormalizedSource, ReadingPorts } from '../src/index.ts'

const source = {
  bookSourceUrl: 'https://source.test',
  bookSourceName: 'Source',
  ruleToc: { chapterList: 'toc-list', chapterName: 'chapter-name', chapterUrl: 'chapter-url', chapterVolume: 'chapter-volume', nextTocUrl: 'toc-next' },
  ruleContent: { content: 'content', nextPage: 'content-next' },
  contentType: 'html',
} as unknown as NormalizedSource

const book: BookMetadata = {
  sourceId: source.bookSourceUrl,
  bookUrl: 'https://source.test/book/a',
  name: 'Book',
  rawFields: { name: 'Book', bookUrl: 'https://source.test/book/a' },
  traceRef: 'detail:0',
  emptyFields: [],
  fieldErrors: {},
}

function readingPorts(calls: string[], failing: string | undefined = undefined): ReadingPorts {
  return {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        if (failing !== undefined && plan.url.includes(failing)) throw new Error('controlled failure')
        const body = plan.url.endsWith('/book/a') ? 'toc-1' : plan.url.endsWith('/toc2') ? 'toc-2' : plan.url.includes('/c1?page=2') ? 'content-2' : plan.url.endsWith('/c1') ? 'content-1' : 'empty'
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'chapterList') {
          return { status: 'success', value: content === 'toc-1' ? [{ title: 'Same title', url: '/c1', volume: 'Volume 1' }, { title: 'Same title', url: '/c2' }] : [{ title: 'Third', url: '/c3' }, { title: 'Same title', url: '/c1', volume: 'Volume 1' }] }
        }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
        if (field === 'chapterVolume') return { status: 'success', value: (content as { volume?: string }).volume ?? null }
        if (field === 'nextTocUrl' && (content === 'toc-1' || content === 'toc-2')) return { status: content === 'toc-1' ? 'success' : 'empty', value: content === 'toc-1' ? '/toc2' : null }
        if (field === 'content') {
          if (content === 'content-1') return { status: 'success', value: '<p>One</p><img src="../img/a.png"><script>bad()</script>' }
          if (content === 'content-2') return { status: 'success', value: '<!-- hidden --><p>Two</p><img src="https://img.test/a.png">' }
          return { status: 'empty', value: null }
        }
        if (field === 'nextPage' && (content === 'content-1' || content === 'content-2')) return { status: content === 'content-1' ? 'success' : 'empty', value: content === 'content-1' ? '/c1?page=2' : null }
        return { status: 'empty', value: null }
      },
    },
  }
}

test('目录工作流支持跨页、卷名传播、相对 URL、同名不同 URL和重复章节', async () => {
  const calls: string[] = []
  const result = await loadTableOfContents(readingPorts(calls), { source, book })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.items.length, 3)
  assert.equal(result.value?.items[0]?.volume, 'Volume 1')
  assert.equal(result.value?.items[1]?.volume, 'Volume 1')
  assert.deepEqual(result.value?.items.map((chapter) => [chapter.title, chapter.chapterUrl]), [
    ['Same title', 'https://source.test/c2'],
    ['Third', 'https://source.test/c3'],
    ['Same title', 'https://source.test/c1'],
  ])
  assert.equal(calls.length, 2)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
})

test('目录按 URL 折叠同地址不同标题的章节（Android BookChapter.equals 只比较 url）', async () => {
  const calls: string[] = []
  const result = await loadTableOfContents({
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'chapterList') return { status: 'success', value: [{ title: '分享章', url: '/same' }, { title: '正式章', url: '/same' }] }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
        return { status: 'empty', value: null }
      },
    },
  }, { source, book })
  assert.equal(result.status, 'success')
  // 同地址只保留反转后最先出现的条目（= 原收集顺序中最后出现的同 URL 章节）。
  assert.deepEqual(result.value?.items.map((chapter) => chapter.title), ['正式章'])
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
})

test('目录复用详情页内容并按最终响应地址解析相对章节', async () => {
  const calls: string[] = []
  const contexts: Array<{ baseUrl: string | undefined; redirectUrl: string | undefined }> = []
  const result = await loadTableOfContents({
    network: { request: async () => { throw new Error('不应重复请求详情页') } },
    rules: {
      evaluate: async (request) => {
        contexts.push({ baseUrl: request.baseUrl, redirectUrl: request.redirectUrl })
        if (request.field === 'chapterList') return { status: 'success', value: [{ title: '第一章', url: 'chapter/1' }] }
        if (request.field === 'chapterName') return { status: 'success', value: (request.content as { title: string }).title }
        if (request.field === 'chapterUrl') return { status: 'success', value: (request.content as { url: string }).url }
        return { status: 'empty', value: null }
      },
    },
  }, { source, book: { ...book, tocUrl: 'https://redirect.test/book/a', tocHtml: '<div>toc</div>' } })
  assert.equal(calls.length, 0)
  assert.equal(result.value?.items[0]?.chapterUrl, 'https://redirect.test/book/chapter/1')
  assert.deepEqual(contexts[0], { baseUrl: 'https://redirect.test/book/a', redirectUrl: 'https://redirect.test/book/a' })
})

test('相对或空目录地址按 Android 的书籍 URL 基准解析', async () => {
  const calls: string[] = []
  const ports = readingPorts(calls)
  await loadTableOfContents(ports, { source, book: { ...book, tocUrl: 'catalog/toc' } })
  assert.equal(calls[0], 'https://source.test/book/catalog/toc')
  calls.length = 0
  await loadTableOfContents(ports, { source, book: { ...book, tocUrl: '   ' } })
  assert.equal(calls[0], book.bookUrl)
})

test('目录分页按 URL 而非响应正文去重，并拆分换行地址列表', async () => {
  const calls: string[] = []
  const ports: ReadingPorts = {
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('same toc body'), redirected: false }
    } },
    rules: { evaluate: async (request) => {
      const page = request.baseUrl?.endsWith('/toc1') === true ? '1' : request.baseUrl?.endsWith('/toc2') === true ? '2' : '3'
      if (request.field === 'chapterList') return { status: 'success', value: [{ title: `Chapter ${page}`, url: `/chapter/${page}` }] }
      if (request.field === 'chapterName') return { status: 'success', value: (request.content as { title: string }).title }
      if (request.field === 'chapterUrl') return { status: 'success', value: (request.content as { url: string }).url }
      if (request.field === 'nextTocUrl' && page === '1') return { status: 'success', value: '/toc2\n/toc3' }
      return { status: 'empty', value: null }
    } },
  }
  const result = await loadTableOfContents(ports, { source, book: { ...book, tocUrl: 'https://source.test/toc1' } })
  assert.deepEqual(calls, ['https://source.test/toc1', 'https://source.test/toc2', 'https://source.test/toc3'])
  assert.equal(result.value?.items.length, 3)
})

test('普通章节缺少 URL 时使用目录基准地址', async () => {
  const result = await loadTableOfContents({
    network: {
      request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: false }),
    },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'chapterList') return { status: 'success', value: [{ title: '第一章' }] }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'empty', value: null }
        return { status: 'empty', value: null }
      },
    },
  }, { source, book })
  assert.equal(result.value?.items[0]?.chapterUrl, book.bookUrl)
})

test('规则成功但正文为空时保留章节并返回可进入的空内容', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/empty', index: 0 }
  const result = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('<html></html>'), redirected: false }) },
    rules: { evaluate: async () => ({ status: 'empty', value: null }) },
  }, { source, chapter })
  assert.equal(result.status, 'empty')
  assert.equal(result.value?.chapter.chapterUrl, chapter.chapterUrl)
  assert.equal(result.value?.cleaned, '')
})

test('缺少正文规则时按 Android 行为显示章节链接', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0 }
  const result = await loadChapterContent({
    network: { request: async () => { throw new Error('不应请求正文') } },
    rules: { evaluate: async () => { throw new Error('不应执行正文规则') } },
  }, { source: { ...source, ruleContent: {} } as NormalizedSource, chapter })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, chapter.chapterUrl)
})

test('章节地址等于详情地址时复用详情响应解析正文', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: book.bookUrl, index: 0 }
  const result = await loadChapterContent({
    network: { request: async () => { throw new Error('不应重复请求详情页') } },
    rules: { evaluate: async ({ field, content }) => field === 'content' && content === '<p>详情正文</p>' ? { status: 'success', value: '详情正文' } : { status: 'empty', value: null } },
  }, { source, chapter, tocHtml: '<p>详情正文</p>' })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, '详情正文')
})

test('已持久化的非法目录地址回退书籍详情地址', async () => {
  const calls: string[] = []
  await loadTableOfContents(readingPorts(calls), { source, book: { ...book, tocUrl: '<!doctype html><html></html>' } })
  assert.equal(calls[0], book.bookUrl)
})

test('目录缓存保留最终响应地址', async () => {
  const values = new Map<string, string>()
  let requests = 0
  const ports: ReadingPorts = {
    network: {
      request: async () => {
        requests += 1
        return { url: 'https://cdn.test/catalog/index.html', status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: true }
      },
    },
    rules: {
      evaluate: async ({ field }) => field === 'chapterList'
        ? { status: 'success', value: [{ title: '第一章', url: 'chapter/1' }] }
        : field === 'chapterName'
          ? { status: 'success', value: '第一章' }
          : field === 'chapterUrl'
            ? { status: 'success', value: 'chapter/1' }
            : { status: 'empty', value: null },
    },
    cache: {
      get: async (key) => values.get(key),
      set: async (key, value) => { values.set(key, value) },
    },
  }
  const first = await loadTableOfContents(ports, { source, book })
  const second = await loadTableOfContents(ports, { source, book })
  assert.equal(first.value?.items[0]?.chapterUrl, 'https://cdn.test/catalog/chapter/1')
  assert.equal(second.value?.items[0]?.chapterUrl, 'https://cdn.test/catalog/chapter/1')
  assert.equal(requests, 1)
})

test('正文工作流拼接多页、净化 HTML、解析图片资源并支持缓存', async () => {
  const calls: string[] = []
  const values = new Map<string, string>()
  const cache = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => { values.set(key, value) },
  }
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const first = await loadChapterContent({ ...readingPorts(calls), cache }, { source, chapter, replacements: [{ pattern: 'One', replacement: 'First' }] })
  assert.equal(first.status, 'success')
  assert.equal(first.value?.pages.length, 2)
  assert.equal(first.value?.raw.includes('One'), true)
  assert.equal(first.value?.cleaned.includes('First'), true)
  assert.equal(first.value?.cleaned.includes('<script>'), false)
  assert.equal(first.value?.cleaned.includes('hidden'), false)
  assert.deepEqual(first.value?.resources, [{ kind: 'image', url: 'https://source.test/img/a.png' }, { kind: 'image', url: 'https://img.test/a.png' }])
  const requestCount = calls.length
  const second = await loadChapterContent({ ...readingPorts(calls), cache }, { source, chapter })
  assert.equal(second.status, 'success')
  assert.equal(calls.length, requestCount)
})

test('正文规则返回 HTML 时未声明 contentType 也进入 HTML 排版流程', async () => {
  const implicitHtmlSource = { ...source, ruleContent: { content: 'content@html', nextPage: 'content-next' } } as NormalizedSource
  delete (implicitHtmlSource as Record<string, unknown>).contentType
  const chapter: ChapterIdentity = { sourceId: implicitHtmlSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent(readingPorts([]), { source: implicitHtmlSource, chapter })
  assert.equal(result.value?.contentType, 'html')
  assert.equal(result.value?.cleaned.includes('<script>'), false)
  assert.deepEqual(result.value?.resources, [{ kind: 'image', url: 'https://source.test/img/a.png' }, { kind: 'image', url: 'https://img.test/a.png' }])
})

test('正文分页使用标准 nextContentUrl 规则并继续读取', async () => {
  const calls: string[] = []
  const fields: string[] = []
  const standardSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next-content' } } as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: standardSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent({
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        const body = plan.url.endsWith('/c1') ? 'page-1' : 'page-2'
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field, content }) => {
        fields.push(field)
        if (field === 'content') return { status: 'success', value: content === 'page-1' ? '第一段' : '第二段' }
        if (field === 'nextContentUrl' && content === 'page-1') return { status: 'success', value: '/c1?page=2' }
        return { status: 'empty', value: null }
      },
    },
  }, { source: standardSource, chapter })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value?.pages, ['第一段', '第二段'])
  assert.deepEqual(calls, ['https://source.test/c1', 'https://source.test/c1?page=2'])
  assert.ok(fields.includes('nextContentUrl'))
})

test('正文分页规则一次返回多个链接时按顺序读取全部页面', async () => {
  const calls: string[] = []
  const multiPageSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next-content' } } as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0 }
  const result = await loadChapterContent({
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url), redirected: false }
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'content') return { status: 'success', value: content }
      if (field === 'nextContentUrl' && content === chapter.chapterUrl) return { status: 'success', value: ['/chapter/2', '/chapter/3'] }
      return { status: 'empty', value: null }
    } },
  }, { source: multiPageSource, chapter })
  assert.deepEqual(calls, ['https://source.test/chapter/1', 'https://source.test/chapter/2', 'https://source.test/chapter/3'])
  assert.equal(result.value?.pages.length, 3)
})

test('正文规则收到最终响应地址并按该地址归一化资源', async () => {
  const contexts: Array<{ field: string; baseUrl: string | undefined; redirectUrl: string | undefined }> = []
  const redirectSource = { ...source, ruleContent: { content: 'content' }, contentType: 'html' } as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: redirectSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent({
    network: {
      request: async () => ({ url: 'https://cdn.test/chapters/one/index.html', status: 200, headers: {}, bytes: new TextEncoder().encode('page'), redirected: true }),
    },
    rules: {
      evaluate: async (request) => {
        contexts.push({ field: request.field, baseUrl: request.baseUrl, redirectUrl: request.redirectUrl })
        return request.field === 'content'
          ? { status: 'success', value: '<p>正文</p><img src="img.png">' }
          : { status: 'empty', value: null }
      },
    },
  }, { source: redirectSource, chapter })
  assert.equal(result.status, 'success')
  assert.deepEqual(contexts[0], { field: 'content', baseUrl: 'https://source.test/c1', redirectUrl: 'https://cdn.test/chapters/one/index.html' })
  assert.equal(result.value?.cleaned.includes('src="https://cdn.test/chapters/one/img.png"'), true)
  assert.deepEqual(result.value?.resources, [{ kind: 'image', url: 'https://cdn.test/chapters/one/img.png' }])
})

test('literal 规则中的 @html 不会误判正文类型', async () => {
  const literalSource = { ...source, ruleContent: { content: 'literal:<script>keep()</script>@html' } } as NormalizedSource
  delete (literalSource as Record<string, unknown>).contentType
  const chapter: ChapterIdentity = { sourceId: literalSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent({
    network: {
      request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('page'), redirected: false }),
    },
    rules: {
      evaluate: async ({ field }) => field === 'content'
        ? { status: 'success', value: '<script>keep()</script>@html' }
        : { status: 'empty', value: null },
    },
  }, { source: literalSource, chapter })
  assert.equal(result.value?.contentType, 'text')
  assert.equal(result.value?.cleaned, '<script>keep()</script>@html')
})

test('目录保留卷、VIP、购买状态和更新时间，并按书籍 reverseToc 排序', async () => {
  const volumeSource = {
    ...source,
    ruleToc: {
      chapterList: 'list',
      chapterName: 'name',
      chapterUrl: 'url',
      isVolume: 'volume',
      isVip: 'vip',
      isPay: 'pay',
      updateTime: 'updated',
    },
    ruleContent: { content: 'content' },
  } as NormalizedSource
  const rawItems = [
    { title: '卷一', url: '', isVolume: true, isVip: 'yes', isPay: '0', updateTime: '2026-01-01' },
    { title: '第一章', url: '/c1', isVolume: false, isVip: 'no', isPay: '1', updateTime: '2026-01-02' },
    { title: '卷二', url: null, isVolume: true, isVip: 'false', isPay: false, updateTime: '2026-01-03' },
  ]
  const ports: ReadingPorts = {
    network: { request: async () => { throw new Error('目录使用详情缓存，不应请求') } },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'chapterList') return { status: 'success', value: rawItems }
        const keyByField: Record<string, string> = { chapterName: 'title', chapterUrl: 'url', isVolume: 'isVolume', isVip: 'isVip', isPay: 'isPay', updateTime: 'updateTime' }
        const key = keyByField[field]
        if (key === undefined) return { status: 'empty', value: null }
        const value = (content as Record<string, unknown>)[key]
        return value === null || value === undefined ? { status: 'empty', value: null } : { status: 'success', value }
      },
    },
  }
  const defaultResult = await loadTableOfContents(ports, { source: volumeSource, book: { ...book, tocHtml: 'toc' } })
  assert.equal(defaultResult.status, 'success')
  assert.deepEqual(defaultResult.value?.items.map((item) => item.title), ['卷一', '第一章', '卷二'])
  assert.equal(defaultResult.value?.items[0]?.chapterUrl, '卷一0')
  assert.equal(defaultResult.value?.items[0]?.isVolume, true)
  assert.equal(defaultResult.value?.items[0]?.isVip, true)
  assert.equal(defaultResult.value?.items[0]?.isPay, false)
  assert.equal(defaultResult.value?.items[0]?.updateTime, '2026-01-01')
  assert.equal(defaultResult.value?.items[1]?.volume, '卷一')
  assert.equal(defaultResult.value?.items[1]?.isPay, true)
  assert.notEqual(defaultResult.value?.items[0]?.chapterUrl, defaultResult.value?.items[2]?.chapterUrl)

  const reverseResult = await loadTableOfContents(ports, { source: volumeSource, book: { ...book, tocHtml: 'toc', readConfig: { reverseToc: true } } })
  assert.deepEqual(reverseResult.value?.items.map((item) => item.title), ['卷二', '第一章', '卷一'])

  const sourceReverseResult = await loadTableOfContents(ports, { source: { ...volumeSource, reverseToc: true } as NormalizedSource, book: { ...book, tocHtml: 'toc' } })
  assert.deepEqual(sourceReverseResult.value?.items.map((item) => item.title), ['卷一', '第一章', '卷二'])

  let contentRequests = 0
  const volumeContent = await loadChapterContent({
    network: { request: async () => { contentRequests += 1; throw new Error('卷节点不应请求正文') } },
    rules: { evaluate: async () => ({ status: 'success', value: 'unexpected' }) },
  }, { source: volumeSource, chapter: defaultResult.value!.items[0]! })
  assert.equal(volumeContent.status, 'empty')
  assert.equal(volumeContent.value?.cleaned, '')
  assert.equal(contentRequests, 0)
})

test('卷节点只有标题占位 URL 才跳过正文请求', async () => {
  const calls: string[] = []
  const result = await loadChapterContent({
    network: { request: async (plan) => { calls.push(plan.url); return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('response'), redirected: false } } },
    rules: { evaluate: async ({ field }) => field === 'nextPage' ? ({ status: 'empty', value: null }) : ({ status: 'success', value: '卷正文' }) },
  }, {
    source,
    chapter: { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: '/volume-content', index: 0, title: '卷一', isVolume: true },
  })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, '卷正文')
  assert.deepEqual(calls, ['https://source.test/volume-content'])
})

test('JS 源实际 URL 的卷节点允许返回空正文', async () => {
  const jsSource = { ...source, mainJs: 'function getContent(chapter, book, nextChapterUrl) { return ""; }' } as NormalizedSource
  const result = await loadChapterContent({
    network: { request: async () => { throw new Error('JS 正文不发 HTTP 请求') } },
    rules: {
      evaluate: async () => ({ status: 'empty', value: null }),
      executeSourceFunction: async () => ({ status: 'empty', value: '', exists: true }),
    },
  }, {
    source: jsSource,
    chapter: { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/volume-content', index: 0, title: '卷一', isVolume: true },
  })
  assert.equal(result.status, 'empty')
  assert.equal(result.value?.cleaned, '')
})

test('目录标题为空时跳过节点及其 VIP/购买规则', async () => {
  const calls: string[] = []
  let emptyTitleFlagCalls = 0
  const emptyTitleSource = {
    ...source,
    ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url', isVolume: 'volume', isVip: 'vip', isPay: 'pay' },
  } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async () => ({ url: 'https://source.test/book/a', status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: false }) },
    rules: {
      evaluate: async ({ field, content }) => {
        calls.push(field)
        if (field === 'chapterList') return { status: 'success', value: [{ title: '', url: '/ignored', isVolume: true, isVip: true, isPay: true }, { title: '有效章节', url: '/valid' }] }
        const item = content as { title: string; url?: string; isVolume?: boolean; isVip?: boolean; isPay?: boolean }
        if (field === 'chapterName') return { status: item.title.length === 0 ? 'empty' : 'success', value: item.title || null }
        if (field === 'chapterUrl') return { status: 'success', value: item.url }
        if (field === 'isVolume') return { status: 'success', value: item.isVolume }
        if (field === 'isVip') {
          if (item.title.length === 0) emptyTitleFlagCalls += 1
          return { status: 'success', value: item.isVip }
        }
        if (field === 'isPay') {
          if (item.title.length === 0) emptyTitleFlagCalls += 1
          return { status: 'success', value: item.isPay }
        }
        return { status: 'empty', value: null }
      },
    },
  }, { source: emptyTitleSource, book })
  assert.deepEqual(result.value?.items.map((item) => item.title), ['有效章节'])
  assert.equal(emptyTitleFlagCalls, 0)
})

test('正文已有内容后下一页失败返回 partial；空正文返回 empty', async () => {
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const partial = await loadChapterContent(readingPorts(calls, 'c1?page=2'), { source, chapter })
  assert.equal(partial.status, 'partial')
  assert.ok(partial.value?.cleaned.includes('One'))
  assert.ok(partial.diagnostics.some((diagnostic) => diagnostic.code === 'request-failed'))

  const empty = await loadChapterContent(readingPorts([]), { source, chapter: { ...chapter, chapterUrl: 'https://source.test/empty' } })
  assert.equal(empty.status, 'empty')
  assert.equal(empty.value?.cleaned, '')
})

test('目录首个请求失败返回 failed 而不是 empty', async () => {
  const result = await loadTableOfContents(readingPorts([], '/book/a'), { source, book })
  assert.equal(result.status, 'failed')
  assert.equal(result.value?.items.length, 0)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'request-failed'))
})

test('目录和正文取消不继续读取', async () => {
  const controller = new AbortController()
  controller.abort()
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const toc = await loadTableOfContents(readingPorts(calls), { source, book, signal: controller.signal })
  const content = await loadChapterContent(readingPorts(calls), { source, chapter, signal: controller.signal })
  assert.equal(toc.status, 'cancelled')
  assert.equal(content.status, 'cancelled')
  assert.equal(calls.length, 0)
})

test('正文下一页循环时停止并保留已读取内容', async () => {
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/loop', index: 0 }
  const result = await loadChapterContent({
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('loop'), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field }) => field === 'content'
        ? { status: 'success', value: '<p>Loop</p>' }
        : { status: 'success', value: '/loop' },
    },
  }, { source, chapter })
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.cleaned, '<p>Loop</p>')
  assert.equal(calls.length, 1)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('循环')))
})

test('正文分页命中 nextChapterUrl 时停止解析，不并入下一章', async () => {
  const calls: string[] = []
  const ports: ReadingPorts = {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url.endsWith('/c1') ? 'page-1' : 'page-2'), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'content') return { status: 'success', value: content === 'page-1' ? '第一章正文' : '第二章正文' }
        if (field === 'nextContentUrl') return content === 'page-1' ? { status: 'success', value: '/c2' } : { status: 'empty', value: null }
        return { status: 'empty', value: null }
      },
    },
  }
  const nextSource = { ...source, ruleContent: { content: 'content', nextContentUrl: 'next-content' }, contentType: 'text' } as unknown as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent(ports, { source: nextSource, chapter, nextChapterUrl: 'https://source.test/c2' })
  assert.equal(result.value?.cleaned, '第一章正文')
  assert.deepEqual(calls, ['https://source.test/c1'])
  assert.equal(result.status, 'success')
})

test('正文分页拆分换行 URL 列表并保留内容相同的不同页面', async () => {
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const multiPageSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next-content' } } as unknown as NormalizedSource
  const result = await loadChapterContent({
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('same response'), redirected: false }
    } },
    rules: { evaluate: async (request) => {
      if (request.field === 'content') return { status: 'success', value: 'same page text' }
      if (request.field === 'nextContentUrl' && request.baseUrl?.endsWith('/c1')) return { status: 'success', value: '/c2\n/c3' }
      return { status: 'empty', value: null }
    } },
  }, { source: multiPageSource, chapter })
  assert.deepEqual(calls, ['https://source.test/c1', 'https://source.test/c2', 'https://source.test/c3'])
  assert.equal(result.value?.pages.length, 3)
  assert.equal(result.value?.cleaned, 'same page text\n\nsame page text\n\nsame page text')
})

test('正文相对下一章地址固定按第一页最终响应地址解析', async () => {
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const nextSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next-content' } } as unknown as NormalizedSource
  const result = await loadChapterContent({
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: 'https://cdn.test/read/c1', status: 200, headers: {}, bytes: new TextEncoder().encode('page one'), redirected: true }
    } },
    rules: { evaluate: async ({ field }) => field === 'content'
      ? { status: 'success', value: 'first chapter' }
      : { status: 'success', value: 'nextchapter' } },
  }, { source: nextSource, chapter, nextChapterUrl: 'nextchapter' })
  assert.deepEqual(calls, ['https://source.test/c1'])
  assert.equal(result.value?.cleaned, 'first chapter')
})

test('正文应用源级 replaceRegex：逐行 trim 后按规则求值', async () => {
  const seen: string[] = []
  const replaceSource = { ...source, ruleContent: { content: 'content', replaceRegex: '##广告##' }, contentType: 'text' } as unknown as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'content') return { status: 'success', value: '  广告  \n正文' }
        if (field === 'replaceRegex') {
          seen.push(String(content))
          return { status: 'success', value: String(content).replace('广告', '') }
        }
        return { status: 'empty', value: null }
      },
    },
  }
  const result = await loadChapterContent(ports, { source: replaceSource, chapter })
  assert.deepEqual(seen, ['广告\n正文'])
  assert.equal(result.value?.cleaned, '正文')
})

test('正文 title 规则提取章节标题并处理标题里的图片', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const titleSource = { ...source, ruleContent: { content: 'content', title: 'content-title' }, contentType: 'html' } as unknown as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: {
      evaluate: async ({ field, rule }) => {
        if (field === 'content') return { status: 'success', value: '<p>正文</p>' }
        if (rule === 'content-title') return { status: 'success', value: '第一章 初见<img src="data:image/png;base64,AAAA">' }
        return { status: 'empty', value: null }
      },
    },
  }
  const result = await loadChapterContent(ports, { source: titleSource, chapter })
  // Android AppPattern.imgRegex 把「data:/http 到结尾」当作图片地址，标题保留它之前的部分。
  assert.equal(result.value?.title, '第一章 初见<img src="')
  assert.equal(result.value?.cleaned, '<p>正文</p>')

  const plainPorts: ReadingPorts = {
    ...ports,
    rules: {
      evaluate: async ({ field, rule }) => {
        if (field === 'content') return { status: 'success', value: '<p>正文</p>' }
        if (rule === 'content-title') return { status: 'success', value: '第二章 开始' }
        return { status: 'empty', value: null }
      },
    },
  }
  const plain = await loadChapterContent(plainPorts, { source: titleSource, chapter })
  assert.equal(plain.value?.title, '第二章 开始')
})

test('正文请求携带 ruleContent 的 webJs 与 sourceRegex 执行提示', async () => {
  const seen: Array<{ webJs?: string; sourceRegex?: string } | undefined> = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const hintSource = { ...source, ruleContent: { content: 'content', webJs: 'web-js', sourceRegex: 'source-regex' } } as unknown as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: '<p>正文</p>' } : { status: 'empty', value: null } },
    request: async (input) => {
      seen.push(input.execution)
      return { url: input.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }
    },
  }
  await loadChapterContent(ports, { source: hintSource, chapter })
  assert.deepEqual(seen, [{ webJs: 'web-js', sourceRegex: 'source-regex' }])
})

test('正文请求被取消时返回 cancelled，不把半截正文当成成功', async () => {
  const controller = new AbortController()
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const ports: ReadingPorts = {
    network: {
      request: async () => {
        controller.abort()
        throw new Error('aborted')
      },
    },
    rules: { evaluate: async () => ({ status: 'success', value: '正文' }) },
  }
  const cancelled = await loadChapterContent(ports, { source, chapter, signal: controller.signal })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.value, null)

  // 首页成功后第二页被取消，同样不能以 success 交付。
  let attempts = 0
  const second = await loadChapterContent({
    network: {
      request: async (plan) => {
        attempts += 1
        if (attempts > 1) {
          controller.abort()
          throw new Error('aborted')
        }
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('第一页'), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field, content }) => field === 'content'
        ? { status: 'success', value: String(content) }
        : { status: 'success', value: 'https://source.test/c1?page=2' },
    },
  }, { source, chapter, signal: controller.signal })
  assert.equal(second.status, 'cancelled')
  assert.equal(second.value, null)
})

test('章节标题规则失败时给出诊断并沿用目录标题', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const titleSource = { ...source, ruleContent: { content: 'content', title: 'content-title' } } as unknown as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: {
      evaluate: async ({ field }) => field === 'content'
        ? { status: 'success', value: '正文' }
        : { status: 'failed', value: null, message: '标题规则解析失败' },
    },
  }
  const result = await loadChapterContent(ports, { source: titleSource, chapter })
  assert.equal(result.value?.cleaned, '正文')
  assert.equal(result.value?.title, undefined)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'item-skipped' && diagnostic.field === 'title'))
})

test('正文分页只有首页携带 sourceRegex，后续页只带 webJs（BookContent.kt:92）', async () => {
  const seen: Array<{ url: string; execution?: { webJs?: string; sourceRegex?: string } }> = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: 'https://source.test/book/a', chapterUrl: 'https://source.test/c1', index: 0 }
  const hintSource = { ...source, ruleContent: { content: 'content', nextPage: 'content-next', webJs: 'web-js', sourceRegex: 'source-regex' } } as unknown as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'content') return { status: 'success', value: `第${content === 'body-2' ? '二' : '一'}页` }
        if (field === 'nextPage') return { status: 'success', value: content === 'body-1' ? '/c1?page=2' : null }
        return { status: 'empty', value: null }
      },
    },
    request: async (input) => {
      seen.push({ url: input.url, ...(input.execution === undefined ? {} : { execution: input.execution }) })
      return { url: input.url, status: 200, headers: {}, bytes: new TextEncoder().encode(input.url.includes('page=2') ? 'body-2' : 'body-1'), redirected: false }
    },
  }
  const result = await loadChapterContent(ports, { source: hintSource, chapter })
  assert.equal(result.status, 'success')
  assert.deepEqual(seen.map((item) => item.execution), [
    { webJs: 'web-js', sourceRegex: 'source-regex' },
    { webJs: 'web-js' },
  ])
})
