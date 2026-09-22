import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverBooks, loadBookDetails, searchBooks } from '../src/public/index.ts'
import type { BookCandidate, NormalizedSource, WorkflowPorts } from '../src/public/index.ts'

const source = {
  bookSourceUrl: 'https://source.test',
  bookSourceName: 'Source',
  exploreUrl: '/explore?page={{page}}',
  searchUrl: '/search?q={{keyword}}&page={{page}}',
  explorePageStart: 1,
  ruleExplore: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', nextPage: 'next' },
  ruleSearch: { bookList: 'list', bookName: 'name', bookUrl: 'url' },
  ruleBookInfo: { name: 'detail-name', author: 'detail-author', intro: 'detail-intro', tocUrl: 'detail-toc' },
} as unknown as NormalizedSource

function ports(calls: string[]): WorkflowPorts {
  return {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ rule, content, stage }) => {
        if (rule === 'list') return { status: 'success', value: stage === 'search' ? [{ name: 'Search A', url: '/book/search' }] : [{ name: 'A', url: '/book/a', author: 'Author' }, { name: 'A duplicate', url: '/book/a', author: 'Author' }, { name: 'No URL' }] }
        if (rule === 'next') return { status: 'success', value: 'next-token' }
        if (rule === 'name') return { status: 'success', value: (content as { name?: string }).name }
        if (rule === 'url') return { status: 'success', value: (content as { url?: string }).url }
        if (rule === 'author') return { status: 'success', value: (content as { author?: string }).author }
        if (rule === 'detail-name') return { status: 'success', value: 'A detail' }
        if (rule === 'detail-author') return { status: 'empty', value: '' }
        if (rule === 'detail-intro') return { status: 'failed', value: null, message: 'detail parser failed' }
        if (rule === 'detail-toc') return { status: 'success', value: '/toc/a' }
        return { status: 'empty', value: null }
      },
    },
  }
}

test('发现工作流保留书源内身份、页码起点、去重和 partial 诊断', async () => {
  const calls: string[] = []
  const result = await discoverBooks(ports(calls), { source })
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.cursor.index, 1)
  assert.equal(result.value?.nextCursor?.token, 'next-token')
  assert.equal(result.value?.items.length, 1)
  assert.deepEqual(result.value?.items[0], {
    sourceId: 'https://source.test',
    bookUrl: '/book/a',
    name: 'A',
    author: 'Author',
    rawFields: { name: 'A', bookUrl: '/book/a', author: 'Author' },
    traceRef: 'discover:0',
  })
  assert.equal(calls[0], 'https://source.test/explore?page=1')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'identity-missing'))
})

test('搜索工作流编码关键词并区分空关键词', async () => {
  const calls: string[] = []
  const result = await searchBooks(ports(calls), { source, keyword: '中文 test' })
  assert.equal(result.status, 'success')
  assert.equal(calls[0], 'https://source.test/search?q=%E4%B8%AD%E6%96%87%20test&page=0')

  const empty = await searchBooks(ports(calls), { source, keyword: '' })
  assert.equal(empty.status, 'empty')
  assert.equal(calls.length, 1)
})

test('搜索和详情工作流保留最新章节与更新时间字段', async () => {
  const calls: string[] = []
  const latestSource = {
    ...source,
    ruleSearch: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookLastChapter: 'last-chapter', bookUpdateTime: 'updated-at' },
    ruleBookInfo: { name: 'detail-name', author: 'detail-author', intro: 'detail-intro', tocUrl: 'detail-toc', lastChapter: 'detail-last-chapter', updateTime: 'detail-updated-at' },
  } as unknown as NormalizedSource
  const base = ports(calls)
  base.rules = {
    evaluate: async (request) => {
      if (request.rule === 'last-chapter') return { status: 'success', value: '列表最新章' }
      if (request.rule === 'updated-at') return { status: 'success', value: '2026-09-22' }
      if (request.rule === 'detail-last-chapter') return { status: 'success', value: '详情最新章' }
      if (request.rule === 'detail-updated-at') return { status: 'success', value: '2026-09-23' }
      return ports(calls).rules.evaluate(request)
    },
  }
  const searched = await searchBooks(base, { source: latestSource, keyword: '中文' })
  assert.equal(searched.value?.items[0]?.lastChapter, '列表最新章')
  assert.equal(searched.value?.items[0]?.updateTime, '2026-09-22')
  const detailed = await loadBookDetails(base, { source: latestSource, candidates: [searched.value!.items[0]!] })
  assert.equal(detailed.value?.items[0]?.lastChapter, '详情最新章')
  assert.equal(detailed.value?.items[0]?.updateTime, '2026-09-23')
})

test('搜索 URL 模板支持书源地址和安全页码算术表达式', async () => {
  const calls: string[] = []
  const templated = { ...source, searchPageStart: 1, searchUrl: '/search?start={{(page-1)*10}}&source={{source.bookSourceUrl}}&q={{key}}' } as unknown as NormalizedSource
  const result = await searchBooks(ports(calls), { source: templated, keyword: '中文' })
  assert.equal(result.status, 'success')
  assert.equal(calls[0], 'https://source.test/search?start=0&source=https://source.test&q=%E4%B8%AD%E6%96%87')
})

test('详情工作流只覆盖有值字段，记录明确空值和字段失败', async () => {
  const calls: string[] = []
  const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl: '/book/a', name: 'A', rawFields: { name: 'A', bookUrl: '/book/a' }, traceRef: 'discover:0' }
  const result = await loadBookDetails(ports(calls), { source, candidates: [candidate] })
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.items[0]?.name, 'A detail')
  assert.deepEqual(result.value?.items[0]?.emptyFields, ['author'])
  assert.equal(result.value?.items[0]?.fieldErrors.intro, 'detail parser failed')
  assert.equal(result.value?.items[0]?.tocUrl, '/toc/a')
  assert.equal(calls[0], 'https://source.test/book/a')
})

test('工作流取消不会继续发起下一次请求', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  controller.abort()
  const result = await discoverBooks(ports(calls), { source, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(calls.length, 0)
})

test('列表字段规则执行期间取消会返回 cancelled', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const workflowPorts = ports(calls)
  workflowPorts.rules = {
    evaluate: async (request) => {
      if (request.field === 'bookName') controller.abort()
      return { status: 'cancelled', value: null }
    },
  }
  const result = await discoverBooks(workflowPorts, { source, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'cancelled'))
})
