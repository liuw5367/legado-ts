import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { discoverBooks, importSources, loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '../src/public/index.ts'
import type { NormalizedSource, RequestPlan, WorkflowPorts } from '../src/public/index.ts'

test('07-A fixture manifest keeps source conformance cases executable', async () => {
  const text = await readFile(new URL('../../../fixtures/phase-07-a/manifest.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(text) as { version: number; fixtures: Array<Record<string, unknown>> }
  assert.equal(manifest.version, 1)
  assert.ok(manifest.fixtures.length >= 1)
  const ids = new Set<string>()
  for (const fixture of manifest.fixtures) {
    assert.equal(typeof fixture.id, 'string')
    assert.equal(ids.has(fixture.id as string), false)
    ids.add(fixture.id as string)
    assert.equal(fixture.android, 'not-run')
    assert.equal(fixture.typescript, 'source-conformance.test.ts')
    assert.equal(fixture.sensitive, 'none')
  }
})

const sourceDefinition = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'Source conformance',
  exploreUrl: '/explore?page={{page}}',
  searchUrl: '/search?q={{keyword}}&page={{page}}',
  explorePageStart: 1,
  ruleExplore: { bookList: 'bookList', bookName: 'bookName', bookAuthor: 'bookAuthor', bookUrl: 'bookUrl' },
  ruleSearch: { bookList: 'bookList', bookName: 'bookName', bookAuthor: 'bookAuthor', bookUrl: 'bookUrl' },
  ruleBookInfo: { name: 'detailName', author: 'detailAuthor', tocUrl: 'detailToc' },
  ruleToc: { chapterList: 'chapterList', chapterName: 'chapterName', chapterUrl: 'chapterUrl' },
  ruleContent: { content: 'content' },
}

function conformancePorts(calls: string[], plans?: RequestPlan[]): WorkflowPorts {
  return {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        plans?.push(plan)
        const path = new URL(plan.url).pathname
        const body = path === '/explore' ? 'explore' : path === '/search' ? 'search' : path === '/book/one' ? 'detail-or-toc' : path === '/chapter/one' ? 'content' : 'unknown'
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(body), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ field, stage, content }) => {
        if (field === 'bookList') return { status: 'success', value: [{ name: 'Fixture book', author: 'Fixture author', url: '/book/one' }] }
        if (field === 'bookName' || field === 'bookAuthor' || field === 'bookUrl') {
          const item = content as { name: string; author: string; url: string }
          return { status: 'success', value: field === 'bookName' ? item.name : field === 'bookAuthor' ? item.author : item.url }
        }
        if (stage === 'detail' && field === 'name') return { status: 'success', value: 'Fixture detail' }
        if (stage === 'detail' && field === 'author') return { status: 'success', value: 'Fixture author' }
        if (stage === 'detail' && field === 'tocUrl') return { status: 'success', value: '/book/one' }
        if (field === 'chapterList') return { status: 'success', value: [{ title: 'Chapter one', url: '/chapter/one' }] }
        if (field === 'chapterName') return { status: 'success', value: (content as { title: string }).title }
        if (field === 'chapterUrl') return { status: 'success', value: (content as { url: string }).url }
        if (field === 'content') return { status: 'success', value: '正文内容' }
        return { status: 'empty', value: null }
      },
    },
  }
}

test('仅提供 NetworkHost 时仍解析 Android URL 选项并保留请求语义', async () => {
  const definition = {
    ...sourceDefinition,
    searchUrl: '/search?tag=a,b&q={{keyword}},{"method":"POST","body":"q=fixture","headers":{"X-Rule":"yes"},"charset":"gbk","followRedirects":false,"timeout":1234}',
  }
  const imported = await importSources(JSON.stringify(definition))
  const source = imported[0]?.source
  assert.ok(source)
  const plans: RequestPlan[] = []
  const ports = conformancePorts([], plans)
  ports.network.encodeCharset = (value, charset) => {
    assert.equal(charset, 'gbk')
    const bytes: number[] = []
    for (const character of value) {
      if (character === '中') bytes.push(0xd6, 0xd0)
      else if (character === '文') bytes.push(0xce, 0xc4)
      else bytes.push(...new TextEncoder().encode(character))
    }
    return new Uint8Array(bytes)
  }
  const result = await searchBooks(ports, { source, keyword: '中文' })
  assert.equal(result.status, 'success')
  const plan = plans[0]
  assert.ok(plan)
  assert.equal(plan.url, 'https://fixture.invalid/search?tag=a,b&q=%D6%D0%CE%C4')
  assert.equal(plan.method, 'POST')
  assert.equal(plan.body, 'q=fixture')
  assert.equal(plan.headers['X-Rule'], 'yes')
  assert.equal(plan.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(plan.requestCharset, 'gbk')
  assert.equal(plan.responseCharset, 'gbk')
  assert.equal(plan.followRedirects, false)
  assert.equal(plan.budget.timeoutMs, 1234)
})

test('NetworkHost 直连路径显式报告 WebView 能力缺失', async () => {
  const definition = { ...sourceDefinition, searchUrl: '/search,{"webView":true}' }
  const imported = await importSources(JSON.stringify(definition))
  const source = imported[0]?.source
  assert.ok(source)
  const calls: string[] = []
  const result = await searchBooks(conformancePorts(calls), { source, keyword: '中文' })
  assert.equal(result.status, 'capability-missing')
  assert.equal(calls.length, 0)
  assert.ok(result.diagnostics.some((item) => item.code === 'capability-missing'))
})

test('正文规则携带 webJs 时 NetworkHost 直连路径不会降级请求', async () => {
  const imported = await importSources(JSON.stringify({ ...sourceDefinition, ruleContent: { content: 'content', webJs: 'document.body.innerText' } }))
  const source = imported[0]?.source
  assert.ok(source)
  const calls: string[] = []
  const result = await loadChapterContent(conformancePorts(calls), {
    source,
    chapter: { sourceId: 'fixture', bookUrl: 'https://fixture.invalid/book/one', chapterUrl: 'https://fixture.invalid/chapter/one', index: 0 },
  })
  assert.equal(result.status, 'capability-missing')
  assert.equal(calls.length, 0)
  assert.ok(result.diagnostics.some((item) => item.code === 'capability-missing'))
})

test('07-A public entry runs one source through discover/search/detail/toc/content', async () => {
  const imported = await importSources(JSON.stringify(sourceDefinition))
  assert.equal(imported.length, 1)
  assert.equal(imported[0]?.status, 'ready')
  const source = imported[0]?.source
  assert.ok(source)

  const calls: string[] = []
  const ports = conformancePorts(calls)
  const discovered = await discoverBooks(ports, { source })
  assert.equal(discovered.status, 'success')
  assert.equal(discovered.value?.items[0]?.name, 'Fixture book')

  const searched = await searchBooks(ports, { source, keyword: '中文' })
  assert.equal(searched.status, 'success')
  assert.equal(calls[1], 'https://fixture.invalid/search?q=%E4%B8%AD%E6%96%87&page=1')

  const details = await loadBookDetails(ports, { source, candidates: discovered.value?.items ?? [] })
  assert.equal(details.status, 'success')
  assert.equal(details.value?.items[0]?.name, 'Fixture detail')
  const book = details.value?.items[0]
  assert.ok(book)

  const toc = await loadTableOfContents(ports, { source, book })
  assert.equal(toc.status, 'success')
  assert.equal(toc.value?.items[0]?.title, 'Chapter one')
  const chapter = toc.value?.items[0]
  assert.ok(chapter)

  const content = await loadChapterContent(ports, { source, chapter })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.cleaned, '正文内容')
  assert.deepEqual(calls, [
    'https://fixture.invalid/explore?page=1',
    'https://fixture.invalid/search?q=%E4%B8%AD%E6%96%87&page=1',
    'https://fixture.invalid/book/one',
    'https://fixture.invalid/chapter/one',
  ])
})

test('07-A already-aborted source workflow is cancelled before network', async () => {
  const imported = await importSources(JSON.stringify(sourceDefinition))
  const source = imported[0]?.source as NormalizedSource
  const calls: string[] = []
  const controller = new AbortController()
  controller.abort()
  const result = await discoverBooks(conformancePorts(calls), { source, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(calls.length, 0)
})
