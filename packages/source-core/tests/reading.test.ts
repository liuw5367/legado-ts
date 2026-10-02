import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedConcurrencyHost, loadChapterContent, loadTableOfContents } from '../src/index.ts'
import { formatChapterBody, unescapeHtml4 } from '../src/workflows/html-format.ts'
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
  assert.deepEqual(result.value?.items.map((chapter) => [chapter.url, chapter.baseUrl]), [
    ['/c2', 'https://source.test/book/a'],
    ['/c3', 'https://source.test/toc2'],
    ['/c1', 'https://source.test/toc2'],
  ])
  assert.equal(calls.length, 2)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
})

test('目录下一页规则失败或缺少宿主能力时终止并丢弃半份目录', async () => {
  for (const state of ['failed', 'capability-missing'] as const) {
    const outputStatus: 'failed' | 'capability-missing' = state
    const calls: string[] = []
    const result = await loadTableOfContents({
      network: { request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: false }
      } },
      rules: { evaluate: async ({ field, content }) => {
        if (field === 'chapterList') return { status: 'success', value: [{ title: '第一章', url: '/chapter/1' }] }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
        if (field === 'nextTocUrl') return { status: outputStatus, value: null, message: 'next toc unavailable' }
        return { status: 'empty', value: null }
      } },
    }, { source, book })
    assert.equal(result.status, outputStatus, state)
    assert.equal(result.value, null, state)
    assert.equal(calls.length, 1, state)
    const expectedCode = state === 'failed' ? 'rule-failed' : 'capability-missing'
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.field === 'nextTocUrl' && diagnostic.code === expectedCode), state)
  }
})

test('目录先求下一页规则，再解析当前页章节字段', async () => {
  const calls: string[] = []
  const orderedSource = {
    ...source,
    ruleToc: {
      chapterList: 'list',
      nextTocUrl: 'next',
      chapterName: 'name',
      chapterUrl: 'url',
      updateTime: 'time',
      isVolume: 'volume',
      chapterVolume: 'volume-name',
      isVip: 'vip',
      isPay: 'pay',
    },
  } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: false }) },
    rules: {
      evaluate: async ({ field, content }) => {
        calls.push(field)
        if (field === 'chapterList') return { status: 'success', value: [{ title: '第一章', url: '/chapter/1' }] }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
        if (field === 'updateTime') return { status: 'success', value: '2026-01-01' }
        if (field === 'isVolume' || field === 'isVip' || field === 'isPay') return { status: 'success', value: false }
        if (field === 'chapterVolume') return { status: 'empty', value: null }
        return { status: 'empty', value: null }
      },
    },
  }, { source: orderedSource, book })
  assert.equal(result.status, 'success')
  assert.deepEqual(calls.slice(0, 9), ['chapterList', 'nextTocUrl', 'chapterName', 'chapterUrl', 'updateTime', 'isVolume', 'chapterVolume', 'isVip', 'isPay'])
})

test('目录章节字段规则失败时不返回已解析的半份目录', async () => {
  const failingSource = { ...source, ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url' } } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: false }) },
    rules: {
      evaluate: async ({ field }) => {
        if (field === 'chapterList') return { status: 'success', value: [{ title: '第一章', url: '/chapter/1' }] }
        if (field === 'chapterName') return { status: 'failed', value: null, message: 'chapter name failed' }
        return { status: 'empty', value: null }
      },
    },
  }, { source: failingSource, book })
  assert.equal(result.status, 'failed')
  assert.equal(result.value, null)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'rule-failed' && diagnostic.field === 'chapterName'))
})

test('目录更新时间按 Android 投影 tag 与字数，卷占位使用页内原始索引', async () => {
  const sourceWithInfo = {
    ...source,
    ruleToc: { chapterList: 'chapters', chapterName: 'name', chapterUrl: 'url', isVolume: 'volume', updateTime: 'info', nextTocUrl: 'next' },
  } as unknown as NormalizedSource
  const firstPage = [
    { title: '第一章', url: '/c1', info: '字数：1234字 新更' },
    { title: '', url: '', info: '' },
    { title: '卷二', url: '', volume: true, info: '字数：99字 卷注' },
  ]
  const secondPage = [
    { title: '卷三', url: '', volume: true, info: '字数：77字 卷注' },
    { title: '第二章', url: '/c2', info: '更新 88字' },
  ]
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url.endsWith('/toc2') ? 'toc-2' : 'toc-1'), redirected: false }) },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'chapterList') return { status: 'success', value: content === 'toc-2' ? secondPage : firstPage }
        const row = content as typeof firstPage[number] | typeof secondPage[number]
        if (field === 'chapterName') return { status: 'success', value: row.title }
        if (field === 'chapterUrl') return { status: 'success', value: row.url }
        if (field === 'isVolume') return { status: 'success', value: row.volume ?? false }
        if (field === 'updateTime') return { status: 'success', value: row.info }
        if (field === 'nextTocUrl') return content === 'toc-1' ? { status: 'success', value: '/toc2' } : { status: 'empty', value: null }
        return { status: 'empty', value: null }
      },
    },
  }
  const pageBook = { ...book, tocUrl: 'https://source.test/toc' }
  const defaultResult = await loadTableOfContents(ports, { source: sourceWithInfo, book: pageBook })
  assert.deepEqual(defaultResult.value?.items.map((chapter) => [chapter.title, chapter.chapterUrl, chapter.updateTime, chapter.tag, chapter.wordCount]), [
    ['第一章', 'https://source.test/c1', '字数：1234字 新更', ' 新更', '1234字'],
    ['卷二', '卷二2', '字数：99字 卷注', '字数：99字 卷注', undefined],
    ['卷三', '卷三0', '字数：77字 卷注', '字数：77字 卷注', undefined],
    ['第二章', 'https://source.test/c2', '更新 88字', '更新', '88字'],
  ])
  const disabled = await loadTableOfContents(ports, { source: sourceWithInfo, book: pageBook, tocCountWords: false })
  assert.deepEqual(disabled.value?.items.map((chapter) => [chapter.tag, chapter.wordCount]), [
    ['字数：1234字 新更', undefined],
    ['字数：99字 卷注', undefined],
    ['字数：77字 卷注', undefined],
    ['更新 88字', undefined],
  ])
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

test('目录仅在原始书籍地址等于目录地址时复用 tocHtml', async () => {
  const contexts: Array<{ baseUrl: string | undefined; redirectUrl: string | undefined }> = []
  const reuseResult = await loadTableOfContents({
    network: { request: async () => { throw new Error('相同详情地址不应重复请求') } },
    rules: {
      evaluate: async (request) => {
        contexts.push({ baseUrl: request.baseUrl, redirectUrl: request.redirectUrl })
        if (request.field === 'chapterList') return { status: 'success', value: [{ title: '第一章', url: 'chapter/1' }] }
        if (request.field === 'chapterName') return { status: 'success', value: (request.content as { title: string }).title }
        if (request.field === 'chapterUrl') return { status: 'success', value: (request.content as { url: string }).url }
        return { status: 'empty', value: null }
      },
    },
  }, { source, book: { ...book, tocUrl: book.bookUrl, tocHtml: '<div>toc</div>' } })
  assert.equal(reuseResult.value?.items[0]?.chapterUrl, 'https://source.test/book/chapter/1')
  assert.deepEqual(contexts[0], { baseUrl: book.bookUrl, redirectUrl: book.bookUrl })

  let requests = 0
  const noReuseResult = await loadTableOfContents({
    network: { request: async () => {
      requests += 1
      return { url: 'https://redirect.test/book/a', status: 200, headers: {}, bytes: new TextEncoder().encode('toc'), redirected: true }
    } },
    rules: {
      evaluate: async (request) => {
        if (request.field === 'chapterList') return { status: 'success', value: [{ title: '第一章', url: 'chapter/1' }] }
        if (request.field === 'chapterName') return { status: 'success', value: (request.content as { title: string }).title }
        if (request.field === 'chapterUrl') return { status: 'success', value: (request.content as { url: string }).url }
        return { status: 'empty', value: null }
      },
    },
  }, { source, book: { ...book, tocUrl: 'https://redirect.test/book/a', tocHtml: '<div>stale</div>' } })
  assert.equal(requests, 1)
  assert.equal(noReuseResult.value?.items[0]?.chapterUrl, 'https://redirect.test/book/chapter/1')
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

test('目录串行下一页沿用请求地址作为 baseUrl 与 redirectUrl', async () => {
  const calls: string[] = []
  const contexts: Array<{ body: string; field: string; baseUrl: string | undefined; redirectUrl: string | undefined }> = []
  const serialSource = { ...source, ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url', nextTocUrl: 'next' } } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => {
      calls.push(plan.url)
      if (plan.url.endsWith('/toc')) return { url: 'https://cdn.test/catalog/index.html', status: 200, headers: {}, bytes: new TextEncoder().encode('first'), redirected: true }
      return { url: 'https://other.test/redirected/next', status: 200, headers: {}, bytes: new TextEncoder().encode('second'), redirected: true }
    } },
    rules: { evaluate: async (request) => {
      contexts.push({ body: String(request.content), field: request.field, baseUrl: request.baseUrl, redirectUrl: request.redirectUrl })
      if (request.field === 'chapterList') return { status: 'success', value: [{ title: String(request.content), url: `chapter/${String(request.content)}` }] }
      if (request.field === 'chapterName') return { status: 'success', value: (request.content as { title: string }).title }
      if (request.field === 'chapterUrl') return { status: 'success', value: (request.content as { url: string }).url }
      if (request.field === 'nextTocUrl' && request.content === 'first') return { status: 'success', value: '/next' }
      return { status: 'empty', value: null }
    } },
  }, { source: serialSource, book: { ...book, tocUrl: 'https://source.test/toc' } })
  assert.deepEqual(calls, ['https://source.test/toc', 'https://cdn.test/next'])
  assert.deepEqual(result.value?.items.map((chapter) => chapter.title), ['first', 'second'])
  const secondPageContexts = contexts.filter((context) => context.body === 'second')
  assert.ok(secondPageContexts.length > 0)
  assert.ok(secondPageContexts.every((context) => context.baseUrl === 'https://cdn.test/next' && context.redirectUrl === 'https://cdn.test/next'))
})

test('目录按章节原始 URL 去重而非按解析后的绝对地址去重', async () => {
  const sourceWithPages = { ...source, ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url', nextTocUrl: 'next' } } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => {
      const body = plan.url.endsWith('/index.html') ? 'first' : 'second'
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') return { status: 'success', value: [{ title: content === 'first' ? '旧章节' : '新章节', url: 'chapter' }] }
      if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
      if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
      if (field === 'nextTocUrl' && content === 'first') return { status: 'success', value: 'https://source.test/other/page2' }
      return { status: 'empty', value: null }
    } },
  }, { source: sourceWithPages, book: { ...book, tocUrl: 'https://source.test/catalog/index.html' } })
  assert.deepEqual(result.value?.items.map((chapter) => [chapter.title, chapter.url, chapter.chapterUrl]), [['新章节', 'chapter', 'https://source.test/other/chapter']])
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
})

test('目录多 URL 分支保留重复输入地址并分别解析', async () => {
  const calls: string[] = []
  let branchCount = 0
  const branchSource = { ...source, ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url', nextTocUrl: 'next' } } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => {
      calls.push(plan.url)
      const body = plan.url.endsWith('/toc') ? 'root' : `branch-${++branchCount}`
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') return { status: 'success', value: content === 'root' ? [] : [{ title: String(content), url: `/chapter/${content}` }] }
      if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
      if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
      if (field === 'nextTocUrl' && content === 'root') return { status: 'success', value: ['/branch', '/branch'] }
      return { status: 'empty', value: null }
    } },
  }, { source: branchSource, book: { ...book, tocUrl: 'https://source.test/toc' } })
  assert.deepEqual(calls, ['https://source.test/toc', 'https://source.test/branch', 'https://source.test/branch'])
  assert.deepEqual(result.value?.items.map((chapter) => chapter.title), ['branch-1', 'branch-2'])
})

test('目录多 URL 分支按输入顺序解析、受应用并发额度限制且不递归分支 next URL', async () => {
  const calls: string[] = []
  const nextRuleBodies: string[] = []
  let activeBranches = 0
  let maxActiveBranches = 0
  const concurrency = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const result = await loadTableOfContents({
    network: { request: async (plan) => {
      calls.push(plan.url)
      if (plan.url.endsWith('/toc1')) return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('root'), redirected: false }
      activeBranches += 1
      maxActiveBranches = Math.max(maxActiveBranches, activeBranches)
      const delay = plan.url.endsWith('/tocA') ? 20 : plan.url.endsWith('/tocB') ? 1 : 5
      await new Promise((resolve) => setTimeout(resolve, delay))
      activeBranches -= 1
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url.endsWith('/tocA') ? 'page-A' : plan.url.endsWith('/tocB') ? 'page-B' : 'page-D'), redirected: false }
    } },
    concurrency,
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') {
        if (content === 'root') return { status: 'success', value: [] }
        const title = content === 'page-A' ? 'A' : content === 'page-B' ? 'B' : 'D'
        return { status: 'success', value: [{ title, url: `/chapter/${title}` }] }
      }
      if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
      if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
      if (field === 'nextTocUrl') {
        nextRuleBodies.push(String(content))
        if (content === 'root') return { status: 'success', value: ['/tocA', '/tocB', '/tocD'] }
        if (content === 'page-A') return { status: 'success', value: '/tocC' }
      }
      return { status: 'empty', value: null }
    } },
  }, { source, book: { ...book, tocUrl: 'https://source.test/toc1' } })
  assert.deepEqual(calls, ['https://source.test/toc1', 'https://source.test/tocA', 'https://source.test/tocB', 'https://source.test/tocD'])
  assert.deepEqual(result.value?.items.map((chapter) => chapter.title), ['A', 'B', 'D'])
  assert.deepEqual(nextRuleBodies, ['root'])
  assert.equal(maxActiveBranches, 2)
  await concurrency.drain()
})

test('目录多 URL 分支把首页计入 maxPages 预算', async () => {
  const calls: string[] = []
  const pageLimitedSource = { ...source, ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url', nextTocUrl: 'next' } } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url.endsWith('/toc') ? 'root' : 'branch'), redirected: false }
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') return { status: 'success', value: content === 'branch' ? [{ title: 'Only branch', url: '/c1' }] : [] }
      if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
      if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
      if (field === 'nextTocUrl') return { status: 'success', value: ['/branchA', '/branchB'] }
      return { status: 'empty', value: null }
    } },
  }, { source: pageLimitedSource, book: { ...book, tocUrl: 'https://source.test/toc' }, maxPages: 2 })
  assert.deepEqual(calls, ['https://source.test/toc', 'https://source.test/branchA'])
  assert.deepEqual(result.value?.items.map((chapter) => chapter.title), ['Only branch'])
  assert.ok(result.diagnostics.some((item) => item.message.includes('页数超过限制')))
})

test('目录并发分支均分剩余累计响应字节预算', async () => {
  const budgets: number[] = []
  const pageLimitedSource = { ...source, ruleToc: { chapterList: 'list', chapterName: 'name', chapterUrl: 'url', nextTocUrl: 'next' } } as NormalizedSource
  const result = await loadTableOfContents({
    network: { request: async (plan) => {
      budgets.push(plan.budget.maxTotalBytes)
      const body = plan.url.endsWith('/toc') ? 'root' : plan.url.endsWith('/branchA') ? 'one' : 'two'
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') return { status: 'success', value: content === 'root' ? [] : [{ title: String(content), url: `/chapter/${content}` }] }
      if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
      if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
      if (field === 'nextTocUrl') return { status: 'success', value: ['/branchA', '/branchB'] }
      return { status: 'empty', value: null }
    } },
  }, { source: pageLimitedSource, book: { ...book, tocUrl: 'https://source.test/toc' }, maxBytes: 10 })
  assert.deepEqual(budgets, [10, 3, 3])
  assert.equal(budgets.slice(1).reduce((sum, budget) => sum + budget, 0), 6)
  assert.equal(result.value?.items.length, 2)
})

test('目录并发分页失败时取消兄弟任务并等待其清理完成', async () => {
  const concurrency = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const calls: string[] = []
  let siblingSettled = false
  const result = await loadTableOfContents({
    concurrency,
    network: { request: async (plan) => {
      calls.push(plan.url)
      if (plan.url.endsWith('/toc')) return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('root'), redirected: false }
      if (plan.url.endsWith('/branchA')) {
        const signal = plan.budget.signal!
        try {
          await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
        } finally {
          siblingSettled = true
        }
        throw new DOMException('aborted', 'AbortError')
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('controlled branch failure')
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') return { status: 'success', value: content === 'root' ? [{ title: 'First', url: '/first' }] : [] }
      if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
      if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
      if (field === 'nextTocUrl') return { status: 'success', value: ['/branchA', '/branchB'] }
      return { status: 'empty', value: null }
    } },
  }, { source, book: { ...book, tocUrl: 'https://source.test/toc' } })
  assert.deepEqual(calls, ['https://source.test/toc', 'https://source.test/branchA', 'https://source.test/branchB'])
  assert.equal(siblingSettled, true)
  assert.ok(result.diagnostics.some((item) => item.code === 'request-failed'))
  assert.equal(result.value, null)
  await concurrency.drain()
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
  assert.equal(result.value?.items[0]?.url, book.bookUrl)
  assert.equal(result.value?.items[0]?.baseUrl, book.bookUrl)
})

test('规则成功但非卷正文为空时返回失败且不交付半份内容', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/empty', index: 0 }
  const result = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('<html></html>'), redirected: false }) },
    rules: { evaluate: async () => ({ status: 'empty', value: null }) },
  }, { source, chapter })
  assert.equal(result.status, 'failed')
  assert.equal(result.value, null)
})

test('缺少正文规则时按 Android 行为显示章节链接', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, url: '/raw/chapter/1', baseUrl: 'https://source.test/catalog/index.html', chapterUrl: 'https://wrong.test/derived', index: 0 }
  const result = await loadChapterContent({
    network: { request: async () => { throw new Error('不应请求正文') } },
    rules: { evaluate: async () => { throw new Error('不应执行正文规则') } },
  }, { source: { ...source, ruleContent: {} } as NormalizedSource, chapter })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, chapter.url)
})

test('正文请求和规则绑定优先使用章节原始 URL 与 baseUrl', async () => {
  const calls: string[] = []
  let binding: { url?: string; baseUrl?: string; chapterUrl?: string } | undefined
  const chapter: ChapterIdentity = {
    sourceId: source.bookSourceUrl,
    bookUrl: book.bookUrl,
    url: 'chapter/one',
    baseUrl: 'https://cdn.test/catalog/index.html',
    chapterUrl: 'https://wrong.test/derived',
    index: 0,
  }
  const result = await loadChapterContent({
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }
    } },
    rules: { evaluate: async (request) => {
      binding = request.bindings?.chapter as typeof binding
      return request.field === 'content' ? { status: 'success', value: '正文' } : { status: 'empty', value: null }
    } },
  }, { source: { ...source, ruleContent: { content: 'content' } } as NormalizedSource, chapter })
  assert.equal(result.status, 'success')
  assert.deepEqual(calls, ['https://cdn.test/catalog/chapter/one'])
  assert.deepEqual({ url: binding?.url, baseUrl: binding?.baseUrl, chapterUrl: binding?.chapterUrl }, { url: 'chapter/one', baseUrl: 'https://cdn.test/catalog/index.html', chapterUrl: 'https://wrong.test/derived' })
  assert.equal(result.value?.chapter.url, 'chapter/one')
  assert.equal(result.value?.chapter.baseUrl, 'https://cdn.test/catalog/index.html')
})

test('正文分页的空页保留 pages 位置并参与换行拼接', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const pageSource = { ...source, ruleContent: { content: 'content', nextPage: 'next' }, contentType: 'text' } as unknown as NormalizedSource
  const result = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url.endsWith('/c1') ? 'page-1' : 'page-2'), redirected: false }) },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'content') return content === 'page-1' ? { status: 'empty', value: null } : { status: 'success', value: '第二页正文' }
      if (field === 'nextPage' && content === 'page-1') return { status: 'success', value: '/c2' }
      return { status: 'empty', value: null }
    } },
  }, { source: pageSource, chapter })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value?.pages, ['', '第二页正文'])
  assert.equal(result.value?.raw, '\n第二页正文')
  assert.equal(result.value?.cleaned, '\n第二页正文')
})

test('JS 正文绑定使用章节原始 URL 与页面基准地址', async () => {
  let request: { chapter: { url: string | undefined; baseUrl: string | undefined; chapterUrl: string | undefined } } | undefined
  const jsSource = { ...source, mainJs: 'function getContent(chapter) { return chapter.url; }' } as NormalizedSource
  const chapter: ChapterIdentity = {
    sourceId: source.bookSourceUrl,
    bookUrl: book.bookUrl,
    url: '/raw/chapter',
    baseUrl: 'https://source.test/catalog/page.html',
    chapterUrl: 'https://wrong.test/derived',
    index: 0,
  }
  const result = await loadChapterContent({
    network: { request: async () => { throw new Error('JS 正文不应请求网络') } },
    rules: {
      evaluate: async () => ({ status: 'empty', value: null }),
      executeSourceFunction: async (input) => {
        const boundChapter = input.bindings?.chapter as { url?: string; baseUrl?: string; chapterUrl?: string }
        request = { chapter: { url: boundChapter.url, baseUrl: boundChapter.baseUrl, chapterUrl: boundChapter.chapterUrl } }
        return { status: 'success', value: input.args[0] && typeof input.args[0] === 'object' ? (input.args[0] as { url?: string }).url : '', exists: true }
      },
    },
  }, { source: jsSource, chapter })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, '/raw/chapter')
  assert.deepEqual(request, { chapter: { url: '/raw/chapter', baseUrl: 'https://source.test/catalog/page.html', chapterUrl: 'https://wrong.test/derived' } })
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

test('目录每次请求都保留最终响应地址，不读取原始页面缓存', async () => {
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
  assert.equal(requests, 2)
})

test('正文工作流拼接多页、净化 HTML，并忽略原始页面缓存', async () => {
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
  assert.equal(calls.length, requestCount * 2)
})

test('正文格式按 Android 顺序处理块标签、HTML4 实体、usehtml 与图片请求选项', () => {
  const raw = '<usehtml><p>原样&nbsp;&amp;</p></usehtml><p>A&nbsp;&amp;B</p><div>C<br>D</div><!--hide--><img data-original="../cover.png"><img src=\'pic.png, {"headers":{"X-Test":"yes"}}\'>'
  const formatted = formatChapterBody(raw, 'https://cdn.test/chapters/one/index.html')
  assert.deepEqual(formatted, {
    content: '<usehtml><p>原样&nbsp;&amp;</p></usehtml>\n　　A &B\n　　C\n　　D\n　　<img src="https://cdn.test/chapters/cover.png"><img src="https://cdn.test/chapters/one/pic.png,{"headers":{"X-Test":"yes"}}">',
    imageUrls: ['https://cdn.test/chapters/cover.png', 'https://cdn.test/chapters/one/pic.png,{"headers":{"X-Test":"yes"}}'],
  })
  assert.deepEqual(formatChapterBody('<usehtml><p>raw&nbsp;&amp;</p></usehtml>', 'https://source.test/ch/1', { adaptSpecialStyle: false }), {
    content: '　　raw &',
    imageUrls: [],
  })
  assert.equal(unescapeHtml4('&Alpha; &#169; &#x1F600; &apos; &unknown;'), 'Α © 😀 &apos; &unknown;')
  assert.deepEqual(formatChapterBody('<img src="HTTPS://Images.test/cover path.png">', 'https://source.test/ch/1'), {
    content: '<img src="HTTPS://Images.test/cover path.png">',
    imageUrls: ['HTTPS://Images.test/cover path.png'],
  })
})

test('text contentType 不会跳过 Android 正文格式化；音视频链接保持原文', async () => {
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const textSource = { ...source, contentType: 'text', ruleContent: { content: 'content' } } as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: '<p>Body &copy;</p><img data-src="../img.png">' } : { status: 'empty', value: null } },
  }
  const text = await loadChapterContent(ports, { source: textSource, chapter })
  assert.equal(text.value?.contentType, 'text')
  assert.equal(text.value?.raw, '<p>Body &copy;</p><img data-src="../img.png">')
  assert.equal(text.value?.cleaned, '　　Body ©\n　　<img src="https://source.test/img.png">')
  assert.deepEqual(text.value?.resources, [{ kind: 'image', url: 'https://source.test/img.png' }])

  for (const bookSourceType of [1, 4]) {
    const mediaSource = { ...textSource, bookSourceType, contentType: 'html' } as NormalizedSource
    const media = await loadChapterContent(ports, { source: mediaSource, chapter })
    assert.equal(media.value?.cleaned, '<p>Body &copy;</p><img data-src="../img.png">')
    assert.deepEqual(media.value?.resources, [])
  }
})

test('正文 subContent 对在线文本原样追加且先于全文替换', async () => {
  const calls: string[] = []
  let replacementInput = ''
  const textSource = { ...source, bookSourceType: 0, ruleContent: { content: 'content', subContent: 'sub', replaceRegex: 'replace' } } as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => { calls.push(plan.url); return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('chapter-body'), redirected: false } } },
    rules: {
      evaluate: async ({ field, content }) => {
        if (field === 'content') return { status: 'success', value: 'Main' }
        if (field === 'subContent') return { status: 'success', value: '  https://aux.test/inline  ' }
        if (field === 'replaceRegex') {
          replacementInput = String(content)
          return { status: 'success', value: `replaced:${content}` }
        }
        return { status: 'empty', value: null }
      },
    },
  }
  const chapter: ChapterIdentity = { sourceId: textSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0 }
  const result = await loadChapterContent(ports, { source: textSource, chapter })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.raw, 'Main\n  https://aux.test/inline  ')
  assert.deepEqual(result.value?.pages, ['Main', '  https://aux.test/inline  '])
  assert.equal(replacementInput, 'Main\nhttps://aux.test/inline')
  assert.equal(result.value?.cleaned, '　　replaced:Main\n　　https://aux.test/inline')
  assert.deepEqual(calls, ['https://source.test/chapter/1'])
})

test('音频副内容请求歌词并合并章节变量；视频内联弹幕 trim 后保存', async () => {
  const calls: string[] = []
  const audioSource = { ...source, bookSourceType: 1, ruleContent: { content: 'content', subContent: 'sub' } } as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => {
      calls.push(plan.url)
      const body = plan.url.endsWith('/chapter/1') ? 'chapter-body' : 'lyrics from response'
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
    } },
    rules: { evaluate: async ({ field }) => field === 'content'
      ? { status: 'success', value: 'Audio URL' }
      : field === 'subContent'
        ? { status: 'success', value: '  HtTpS://source.test/lyrics  ' }
        : { status: 'empty', value: null } },
  }
  const chapter = Object.freeze({ sourceId: audioSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0, variable: '{"keep":"yes"}' })
  const audio = await loadChapterContent(ports, { source: audioSource, chapter })
  assert.equal(audio.status, 'success')
  assert.equal(audio.value?.raw, 'Audio URL')
  assert.deepEqual(audio.value?.auxiliary, { kind: 'lyrics', content: 'lyrics from response' })
  assert.equal(chapter.variable, '{"keep":"yes"}')
  assert.deepEqual(JSON.parse(audio.value?.chapter.variable ?? '{}'), { keep: 'yes', lyric: 'lyrics from response' })
  assert.deepEqual(calls, ['https://source.test/chapter/1', 'https://source.test/lyrics'])

  const videoSource = { ...source, bookSourceType: 4, ruleContent: { content: 'content', subContent: 'sub' } } as NormalizedSource
  const videoChapter = { ...chapter, variable: '{"keep":"yes"}' }
  const video = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('chapter-body'), redirected: false }) },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: 'Video URL' } : field === 'subContent' ? { status: 'success', value: '  inline danmaku \n' } : { status: 'empty', value: null } },
  }, { source: videoSource, chapter: videoChapter })
  assert.deepEqual(video.value?.auxiliary, { kind: 'danmaku', content: 'inline danmaku' })
  assert.deepEqual(JSON.parse(video.value?.chapter.variable ?? '{}'), { keep: 'yes', danmaku: 'inline danmaku' })
})

test('非在线文本非音视频类型不追加 subContent；歌词请求失败保留主正文并可诊断', async () => {
  const imageSource = { ...source, bookSourceType: 2, ruleContent: { content: 'content', subContent: 'sub' } } as NormalizedSource
  const imageChapter = { sourceId: imageSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0, variable: '{"keep":"yes"}' }
  const image = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('chapter-body'), redirected: false }) },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: 'Image resource' } : field === 'subContent' ? { status: 'success', value: 'ignored inline data' } : { status: 'empty', value: null } },
  }, { source: imageSource, chapter: imageChapter })
  assert.equal(image.value?.raw, 'Image resource')
  assert.equal(image.value?.auxiliary, undefined)
  assert.equal(imageChapter.variable, '{"keep":"yes"}')

  const audioSource = { ...source, bookSourceType: 1, ruleContent: { content: 'content', subContent: 'sub' } } as NormalizedSource
  const failingPorts: ReadingPorts = {
    network: { request: async (plan) => {
      if (plan.url.endsWith('/lyrics')) throw new Error('lyrics unavailable')
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('chapter-body'), redirected: false }
    } },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: 'Main content' } : field === 'subContent' ? { status: 'success', value: 'https://source.test/lyrics' } : { status: 'empty', value: null } },
  }
  const audioChapter = { sourceId: audioSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0, variable: '{"keep":"yes"}' }
  const failedLyrics = await loadChapterContent(failingPorts, { source: audioSource, chapter: audioChapter })
  assert.equal(failedLyrics.status, 'partial')
  assert.equal(failedLyrics.value?.raw, 'Main content')
  assert.equal(failedLyrics.value?.auxiliary, undefined)
  assert.equal(failedLyrics.value?.chapter.variable, '{"keep":"yes"}')
  assert.ok(failedLyrics.diagnostics.some((item) => item.code === 'request-failed' && item.field === 'subContent'))

  const failedRule = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('chapter-body'), redirected: false }) },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: 'Main content' } : field === 'subContent' ? { status: 'failed', value: null, message: 'bad subContent rule' } : { status: 'empty', value: null } },
  }, { source: audioSource, chapter: { sourceId: audioSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0 } })
  assert.equal(failedRule.status, 'failed')
  assert.equal(failedRule.value, null)
  assert.ok(failedRule.diagnostics.some((item) => item.code === 'rule-failed' && item.field === 'subContent'))
})

test('subContent HTTP 请求期间取消会取消整个正文工作流', async () => {
  const controller = new AbortController()
  const audioSource = { ...source, bookSourceType: 1, ruleContent: { content: 'content', subContent: 'sub' } } as NormalizedSource
  const ports: ReadingPorts = {
    network: { request: async (plan) => {
      if (plan.url.endsWith('/lyrics')) {
        controller.abort()
        throw new Error('request aborted')
      }
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('chapter-body'), redirected: false }
    } },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: 'Main content' } : field === 'subContent' ? { status: 'success', value: 'https://source.test/lyrics' } : { status: 'empty', value: null } },
  }
  const result = await loadChapterContent(ports, { source: audioSource, chapter: { sourceId: audioSource.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', index: 0 }, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.value, null)
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

test('正文多 URL 分支按输入顺序受限并发，分支不递归且不携带首页 webJs/sourceRegex', async () => {
  const requests: Array<{ url: string; execution?: { webJs?: string; sourceRegex?: string } }> = []
  const nextRuleBodies: string[] = []
  let activeBranches = 0
  let maxActiveBranches = 0
  const concurrency = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const multiSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next', webJs: 'page script', sourceRegex: 'resource pattern' } } as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent({
    concurrency,
    network: { request: async () => { throw new Error('complete request adapter should be used') } },
    request: async ({ url, execution }) => {
      requests.push({ url, ...(execution === undefined ? {} : { execution }) })
      const isBranch = url !== chapter.chapterUrl
      if (isBranch) {
        activeBranches += 1
        maxActiveBranches = Math.max(maxActiveBranches, activeBranches)
        await new Promise((resolve) => setTimeout(resolve, url.endsWith('/pageA') ? 20 : 1))
        activeBranches -= 1
      }
      const body = url === chapter.chapterUrl ? 'first' : url.endsWith('/pageA') ? 'A' : 'B'
      return { url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
    },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'content') return { status: 'success', value: content }
      if (field === 'nextContentUrl') {
        nextRuleBodies.push(String(content))
        return content === 'first' ? { status: 'success', value: ['/pageA', '/pageB'] } : { status: 'success', value: '/nested' }
      }
      return { status: 'empty', value: null }
    } },
  }, { source: multiSource, chapter })
  assert.deepEqual(requests.map((request) => request.url), [chapter.chapterUrl, 'https://source.test/pageA', 'https://source.test/pageB'])
  assert.deepEqual(requests[0]?.execution, { webJs: 'page script', sourceRegex: 'resource pattern' })
  assert.deepEqual(requests.slice(1).map((request) => request.execution), [undefined, undefined])
  assert.deepEqual(nextRuleBodies, ['first'])
  assert.deepEqual(result.value?.pages, ['first', 'A', 'B'])
  assert.equal(maxActiveBranches, 2)
  await concurrency.drain()
})

test('正文多 URL 分支把首页计入 maxPages 预算', async () => {
  const calls: string[] = []
  const multiSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next' } } as NormalizedSource
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const result = await loadChapterContent({
    network: { request: async (plan) => {
      calls.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url.endsWith('/c1') ? 'first' : 'A'), redirected: false }
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'content') return { status: 'success', value: content }
      if (field === 'nextContentUrl') return { status: 'success', value: ['/pageA', '/pageB'] }
      return { status: 'empty', value: null }
    } },
  }, { source: multiSource, chapter, maxPages: 2 })
  assert.deepEqual(calls, [chapter.chapterUrl, 'https://source.test/pageA'])
  assert.deepEqual(result.value?.pages, ['first', 'A'])
  assert.ok(result.diagnostics.some((item) => item.message.includes('页数超过限制')))
})

test('取消目录并发分页后等待所有活动网络请求清理', async () => {
  const concurrency = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const controller = new AbortController()
  let branchesStarted = 0
  let settledBranches = 0
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const reading = loadTableOfContents({
    concurrency,
    network: { request: async (plan) => {
      if (plan.url.endsWith('/toc')) return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('root'), redirected: false }
      branchesStarted += 1
      if (branchesStarted === 2) resolveStarted()
      try {
        await new Promise<void>((_resolve, reject) => plan.budget.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
      } finally {
        settledBranches += 1
      }
      throw new DOMException('aborted', 'AbortError')
    } },
    rules: { evaluate: async ({ field, content }) => {
      if (field === 'chapterList') return { status: 'success', value: content === 'root' ? [] : [] }
      if (field === 'nextTocUrl') return { status: 'success', value: ['/branchA', '/branchB'] }
      return { status: 'empty', value: null }
    } },
  }, { source, book: { ...book, tocUrl: 'https://source.test/toc' }, signal: controller.signal })
  await started
  controller.abort()
  const result = await reading
  assert.equal(result.status, 'cancelled')
  assert.equal(settledBranches, 2)
  await concurrency.drain()
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
  assert.equal(result.value?.cleaned, 'keep()@html')
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
  const defaultResult = await loadTableOfContents(ports, { source: volumeSource, book: { ...book, tocUrl: book.bookUrl, tocHtml: 'toc' } })
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

  const reverseResult = await loadTableOfContents(ports, { source: volumeSource, book: { ...book, tocUrl: book.bookUrl, tocHtml: 'toc', readConfig: { reverseToc: true } } })
  assert.deepEqual(reverseResult.value?.items.map((item) => item.title), ['卷二', '第一章', '卷一'])

  const sourceReverseResult = await loadTableOfContents(ports, { source: { ...volumeSource, reverseToc: true } as NormalizedSource, book: { ...book, tocUrl: book.bookUrl, tocHtml: 'toc' } })
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

test('正文已有内容后下一页失败或正文为空均不交付半份内容', async () => {
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const failedPage = await loadChapterContent(readingPorts(calls, 'c1?page=2'), { source, chapter })
  assert.equal(failedPage.status, 'failed')
  assert.equal(failedPage.value, null)
  assert.ok(failedPage.diagnostics.some((diagnostic) => diagnostic.code === 'request-failed'))

  const empty = await loadChapterContent(readingPorts([]), { source, chapter: { ...chapter, chapterUrl: 'https://source.test/empty' } })
  assert.equal(empty.status, 'failed')
  assert.equal(empty.value, null)
})

test('目录首个请求失败返回 failed 而不是 empty', async () => {
  const result = await loadTableOfContents(readingPorts([], '/book/a'), { source, book })
  assert.equal(result.status, 'failed')
  assert.equal(result.value, null)
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
  assert.equal(result.value?.cleaned, '　　Loop')
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

test('正文下一页规则失败或缺少宿主能力时不交付已解析内容', async () => {
  for (const state of ['failed', 'capability-missing'] as const) {
    const outputStatus: 'failed' | 'capability-missing' = state
    const calls: string[] = []
    const nextSource = { ...source, contentType: 'text', ruleContent: { content: 'content', nextContentUrl: 'next-content' } } as unknown as NormalizedSource
    const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
    const result = await loadChapterContent({
      network: { request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('page-1'), redirected: false }
      } },
      rules: { evaluate: async ({ field }) => {
        if (field === 'content') return { status: 'success', value: '第一章正文' }
        if (field === 'nextContentUrl') return { status: outputStatus, value: null, message: 'next content unavailable' }
        return { status: 'empty', value: null }
      } },
    }, { source: nextSource, chapter })
    assert.equal(result.status, outputStatus, state)
    assert.equal(result.value, null, state)
    assert.deepEqual(calls, ['https://source.test/c1'], state)
    const expectedCode = state === 'failed' ? 'rule-failed' : 'capability-missing'
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.field === 'nextContentUrl' && diagnostic.code === expectedCode), state)
  }
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
  assert.equal(result.value?.cleaned, 'same page text\nsame page text\nsame page text')
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
  assert.equal(result.value?.cleaned, '\n正文')
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
  assert.equal(result.value?.imgUrl, 'data:image/png;base64,AAAA">')
  assert.equal(result.value?.cleaned, '　　正文')

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

  const imageOnlyPorts: ReadingPorts = {
    ...ports,
    rules: {
      evaluate: async ({ field, rule }) => {
        if (field === 'content') return { status: 'success', value: '<p>正文</p>' }
        if (rule === 'content-title') return { status: 'success', value: 'data:image/png;base64,AAAA' }
        return { status: 'empty', value: null }
      },
    },
  }
  const imageOnly = await loadChapterContent(imageOnlyPorts, { source: titleSource, chapter: { ...chapter, title: '目录标题' } })
  assert.equal(imageOnly.value?.title, '目录标题')
  assert.equal(imageOnly.value?.imgUrl, 'data:image/png;base64,AAAA')
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
  assert.equal(result.status, 'success')
  assert.equal(result.value?.cleaned, '正文')
  assert.equal(result.value?.title, undefined)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'item-skipped' && diagnostic.field === 'title'))
})

test('调用方非法正文替换只保留诊断，不丢弃已解析正文', async () => {
  const result = await loadChapterContent({
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('body'), redirected: false }) },
    rules: { evaluate: async ({ field }) => field === 'content' ? { status: 'success', value: '正文' } : { status: 'empty', value: null } },
  }, {
    source: { ...source, contentType: 'text', ruleContent: { content: 'content' } } as NormalizedSource,
    chapter: { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 },
    replacements: [{ pattern: '(', replacement: '坏' }],
  })
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.cleaned, '正文')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-config' && diagnostic.field === 'replacements'))
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
