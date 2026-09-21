import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChapterContent, loadTableOfContents } from '../src/public/index.ts'
import type { BookMetadata, ChapterIdentity, NormalizedSource, ReadingPorts } from '../src/public/index.ts'

const source = {
  bookSourceUrl: 'https://source.test',
  bookSourceName: 'Source',
  ruleToc: { chapterList: 'toc-list', chapterName: 'chapter-name', chapterUrl: 'chapter-url', chapterVolume: 'chapter-volume', nextPage: 'toc-next' },
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
          return { status: 'success', value: content === 'toc-1' ? [{ title: 'Same title', url: '/c1', volume: 'Volume 1' }, { title: 'Same title', url: '/c2' }] : [{ title: 'Third', url: '/c3' }, { title: 'Duplicate', url: '/c1' }] }
        }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
        if (field === 'chapterVolume') return { status: 'success', value: (content as { volume?: string }).volume ?? null }
        if (field === 'nextPage' && (content === 'toc-1' || content === 'toc-2')) return { status: content === 'toc-1' ? 'success' : 'empty', value: content === 'toc-1' ? '/toc2' : null }
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
  assert.equal(result.value?.items[2]?.chapterUrl, 'https://source.test/c3')
  assert.equal(calls.length, 2)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
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

test('正文已有内容后下一页失败返回 partial；空正文返回 empty', async () => {
  const calls: string[] = []
  const chapter: ChapterIdentity = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/c1', index: 0 }
  const partial = await loadChapterContent(readingPorts(calls, 'c1?page=2'), { source, chapter })
  assert.equal(partial.status, 'partial')
  assert.ok(partial.value?.cleaned.includes('One'))
  assert.ok(partial.diagnostics.some((diagnostic) => diagnostic.code === 'request-failed'))

  const empty = await loadChapterContent(readingPorts([]), { source, chapter: { ...chapter, chapterUrl: 'https://source.test/empty' } })
  assert.equal(empty.status, 'empty')
  assert.equal(empty.value, null)
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
