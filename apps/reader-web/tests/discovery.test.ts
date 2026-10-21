import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository, type StoredSourceRecord } from '../server/db/repository.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { getDiscoveryCategories, listDiscoverySources, loadDiscoveryPage, openDiscoveryBook, parseDiscoveryCategories, updateDiscoveryControl } from '../server/runtime/discovery.ts'
import { discoveryBookSchema, discoveryPageSchema } from '../shared/discovery.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'discovery-tests-existing-runtime-state-key'
const definition = {
  bookSourceUrl: 'https://8.8.8.8/discovery-source', bookSourceName: '发现源', bookSourceType: 0,
  exploreUrl: JSON.stringify([{ title: '榜单' }, { title: '热门', url: '/popular?page={{page}}' }, { title: '完结', url: '/finished' }]),
  ruleExplore: { bookList: 'article', name: 'h2@text', author: '.author@text', bookUrl: 'a@href', nextPage: '.next@href' },
  ruleBookInfo: { name: 'h1@text', author: '.author@text', intro: '.intro@text', tocUrl: 'a@href' },
}
async function setup(extra: Record<string, unknown> = {}) {
  const repository = new MemoryReaderRepository()
  const imported = await importSources({ kind: 'text', text: JSON.stringify({ ...definition, ...extra }) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, definition.bookSourceUrl)
  await repository.commitImportPreview('user-a', previewId, candidates.map((item) => item.id))
  const source = (await repository.listAllSourcesForUser('user-a'))[0]!
  const categories = parseDiscoveryCategories(source).categories
  return { repository, source, input: { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: categories[0]?.id ?? '' } }
}
function listHtml(id = '1', next = '') { return `<article><h2>目标书${id}</h2><span class="author">作者</span><a href="/book-${id}">详情</a></article>${next}` }
const detailHtml = '<h1>目标书1</h1><span class="author">作者</span><p class="intro">简介</p><a href="/toc">目录</a>'

test('categories parse JSON, grouping, text URLs and malformed/dynamic configurations', async () => {
  const { source } = await setup()
  const first = parseDiscoveryCategories(source).categories
  assert.deepEqual(first.map(({ title, group, url }) => ({ title, group, url })), [{ title: '热门', group: '榜单', url: '/popular?page={{page}}' }, { title: '完结', group: '榜单', url: '/finished' }])
  assert.deepEqual(parseDiscoveryCategories(source).categories, first)
  const withExplore = (exploreUrl: string): StoredSourceRecord => ({ ...source, normalizedSource: { ...source.normalizedSource, exploreUrl } })
  assert.deepEqual(parseDiscoveryCategories(withExplore('男频\n热门::/a&&完结::/b::c')).categories.map(({ title, group, url }) => [title, group, url]), [['热门', '男频', '/a'], ['完结', '男频', '/b::c']])
  assert.equal(parseDiscoveryCategories(withExplore('https://8.8.8.8/books')).categories[0]?.title, '浏览')
  for (const text of ['@js:java.get()', '<JS>java.get()</JS>', '[invalid']) assert.ok(parseDiscoveryCategories(withExplore(text)).message)
  assert.deepEqual(parseDiscoveryCategories(withExplore('')).categories, [])
})

test('dynamic discovery categories execute with a persistent infoMap and then request the selected URL', async (t) => {
  const { repository, source } = await setup({
    exploreUrl: '@js:var count = Number(infoMap.get("count") || "0") + 1; infoMap.put("count", String(count)); infoMap.saveNow(); [{ title: "动态榜单", url: "/dynamic?count=" + count }]',
  })
  const categories = await getDiscoveryCategories(repository, 'user-a', source.sourceId)
  assert.equal(categories.message, undefined)
  assert.deepEqual(categories.categories.map(({ title, type }) => ({ title, type })), [{ title: '动态榜单', type: undefined }])
  const categoryId = categories.categories[0]?.id
  assert.ok(categoryId)
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    calls.push(String(url))
    return new Response(listHtml())
  })
  const page = await loadDiscoveryPage(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId })
  assert.equal(page.items[0]?.name, '目标书1')
  assert.match(calls[0]!, /dynamic\?count=1/u)
})

test('discovery controls validate values, execute actions and refresh the selected list without exposing scripts', async (t) => {
  const { repository, source } = await setup({
    exploreUrl: JSON.stringify([
      { title: '关键词', type: 'text', viewName: "'筛选词'", action: 'infoMap.put("last", infoMap.get("关键词")); java.refreshExplore()' },
      { title: '方向', type: 'toggle', chars: ['男', '女'], default: '男', action: 'java.refreshExplore()' },
      { title: '刷新', type: 'button', action: 'java.refreshExplore()' },
      { title: '榜单', url: '/control-list' },
    ]),
  })
  const categories = await getDiscoveryCategories(repository, 'user-a', source.sourceId)
  const text = categories.categories.find((item) => item.title === '关键词')
  const toggle = categories.categories.find((item) => item.title === '方向')
  const list = categories.categories.find((item) => item.title === '榜单')
  assert.ok(text && toggle && list)
  assert.equal('action' in text, false)
  assert.equal(text.label, '筛选词')
  assert.equal(toggle.value, '男')
  await assert.rejects(updateDiscoveryControl(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: toggle.id, value: '无效' }), /选项无效/u)
  const changed = await updateDiscoveryControl(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: text.id, value: 'abc' })
  assert.equal(changed.refreshed, true)
  assert.equal(changed.categories.find((item) => item.id === text.id)?.value, 'abc')
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => { calls.push(String(url)); return new Response(listHtml()) })
  const page = await loadDiscoveryPage(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: list.id })
  assert.equal(page.items[0]?.name, '目标书1')
  assert.match(calls[0]!, /control-list/u)
})

test('discovery lists only eligible account sources and never exposes category URLs', async () => {
  const { repository, source } = await setup()
  assert.equal((await listDiscoverySources(repository, 'user-a')).sources.length, 1)
  assert.deepEqual(await listDiscoverySources(repository, 'other-user'), { sources: [] })
  const categories = await getDiscoveryCategories(repository, 'user-a', source.sourceId)
  assert.equal('url' in categories.categories[0]!, false)
  assert.equal('normalizedSource' in categories.source, false)
  await assert.rejects(getDiscoveryCategories(repository, 'other-user', source.sourceId), /书源不可用/u)
  const hidden = await setup({ enabledExplore: false })
  assert.deepEqual(await listDiscoverySources(hidden.repository, 'user-a'), { sources: [] })
  await assert.rejects(getDiscoveryCategories(hidden.repository, 'user-a', hidden.source.sourceId), /未启用发现/u)
})

test('discovery queries one page at a time and follows signed next-page URLs', async (t) => {
  const { repository, input } = await setup({ explorePageStart: 3 })
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    calls.push(String(url))
    return new Response(calls.length === 1 ? listHtml('1', '<a class="next" href="/next?cursor=xyz">下一页</a>') : '<main></main>')
  })
  const first = await loadDiscoveryPage(repository, 'user-a', input)
  assert.equal(first.cursor.index, 3)
  assert.equal(first.items[0]?.name, '目标书1')
  assert.equal('rawFields' in first.items[0]!, false)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /page=3/u)
  assert.ok(first.nextCursor?.signature)
  const second = await loadDiscoveryPage(repository, 'user-a', { ...input, cursor: first.nextCursor! })
  assert.equal(second.status, 'empty')
  assert.equal(second.nextCursor, undefined)
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1]!).pathname, '/next')
})

test('tampered cursors, category IDs, source versions and other accounts never execute requests', async (t) => {
  const { repository, input } = await setup()
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(listHtml()))
  const first = await loadDiscoveryPage(repository, 'user-a', input)
  const before = fetch.mock.callCount()
  await assert.rejects(loadDiscoveryPage(repository, 'user-a', { ...input, cursor: { ...first.cursor, token: 'https://8.8.4.4/arbitrary' } }), /分页信息无效/u)
  await assert.rejects(loadDiscoveryPage(repository, 'user-a', { ...input, categoryId: '/arbitrary' }), /分类已失效/u)
  await assert.rejects(loadDiscoveryPage(repository, 'user-a', { ...input, fingerprint: 'stale' }), /书源已更新/u)
  await assert.rejects(loadDiscoveryPage(repository, 'other-user', input), /书源不可用/u)
  assert.equal(fetch.mock.callCount(), before)
})

test('open discovery book revalidates identity, persists details without a search or shelf change', async (t) => {
  const { repository, input } = await setup()
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => new Response(new URL(String(url)).pathname.startsWith('/book-') ? detailHtml : listHtml()))
  const page = await loadDiscoveryPage(repository, 'user-a', input)
  const request = { ...input, cursor: page.cursor, bookUrl: page.items[0]!.bookUrl }
  const created = await openDiscoveryBook(repository, 'user-a', request)
  assert.equal(created.edition.metadata.intro, '简介')
  assert.equal(await repository.isOnBookshelf('user-a', created.book.id), false)
  assert.equal((await repository.getHome('user-a')).searchHistory.length, 0)
  assert.equal((await openDiscoveryBook(repository, 'user-a', request)).book.id, created.book.id)
  await assert.rejects(openDiscoveryBook(repository, 'user-a', { ...request, bookUrl: 'https://8.8.8.8/book-missing' }), /列表已更新/u)
})

test('opening another discovered edition keeps the active edition and existing shelf membership', async (t) => {
  const { repository, input } = await setup()
  let selectedBook = '1'
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => new Response(new URL(String(url)).pathname.startsWith('/book-') ? detailHtml.replace('简介', '来源' + selectedBook + '的简介') : listHtml(selectedBook).replace('目标书2', '目标书1')))
  const first = await openDiscoveryBook(repository, 'user-a', { ...input, bookUrl: 'https://8.8.8.8/book-1' })
  await repository.addToBookshelf('user-a', first.book.id)
  selectedBook = '2'
  const second = await openDiscoveryBook(repository, 'user-a', { ...input, bookUrl: 'https://8.8.8.8/book-2' })
  assert.equal(second.book.id, first.book.id)
  assert.equal(second.book.activeEditionKey, first.edition.editionKey)
  assert.notEqual(second.edition.editionKey, first.edition.editionKey)
  assert.equal(await repository.isOnBookshelf('user-a', first.book.id), true)
  assert.equal(second.edition.metadata.intro, '来源2的简介')
  assert.equal((await repository.getBook('user-a', first.book.id))?.intro, '来源1的简介')
})

test('source failures and cancelled discovery release the runtime lease for subsequent requests', async (t) => {
  const { repository, source, input } = await setup()
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture failure') })
  await assert.rejects(loadDiscoveryPage(repository, 'user-a', input))
  const lease = await repository.acquireSourceRuntimeLease('user-a', source.sourceId, source.fingerprint, 'check-lease', 1000)
  assert.ok(lease)
  await repository.releaseSourceRuntimeLease('user-a', source.sourceId, source.fingerprint, lease.leaseToken)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(loadDiscoveryPage(repository, 'user-a', input, controller.signal), /取消/u)
  assert.ok(await repository.acquireSourceRuntimeLease('user-a', source.sourceId, source.fingerprint, 'after-cancel', 1000))
  await repository.releaseSourceRuntimeLease('user-a', source.sourceId, source.fingerprint, 'after-cancel')
})

test('discovery rejects a source already leased by a search operation', async () => {
  const { repository, source, input } = await setup()
  const lease = await repository.acquireSourceRuntimeLease('user-a', source.sourceId, source.fingerprint, 'search-lease', 1000)
  assert.ok(lease)
  try { await assert.rejects(loadDiscoveryPage(repository, 'user-a', input), /其他请求使用/u) }
  finally { await repository.releaseSourceRuntimeLease('user-a', source.sourceId, source.fingerprint, lease.leaseToken) }
})

test('static categories execute JS explore with the chosen URL and retain detail variables', async () => {
  const { repository, input } = await setup({ mainJs: [
    'function explore(url, page) { if (url !== "/popular?page={{page}}") throw new Error("wrong category"); return page === 1 ? [{ name: "脚本书", author: "作者", bookUrl: "/js-book", variable: "token", marker: "kept" }] : []; }',
    'function getBookInfo(book) { if (book.variable !== "token" || book.rawFields.marker !== "kept") throw new Error("missing discovery state"); return { tocUrl: "/toc", intro: "脚本详情" }; }',
  ].join('\n') })
  const first = await loadDiscoveryPage(repository, 'user-a', input)
  assert.equal(first.items[0]?.name, '脚本书')
  assert.equal((await loadDiscoveryPage(repository, 'user-a', { ...input, cursor: first.nextCursor! })).status, 'empty')
  const book = await openDiscoveryBook(repository, 'user-a', { ...input, cursor: first.cursor, bookUrl: first.items[0]!.bookUrl })
  assert.equal(book.edition.metadata.intro, '脚本详情')
})

test('partial discovery keeps valid books and reports skipped items', async (t) => {
  const { repository, input } = await setup()
  t.mock.method(globalThis, 'fetch', async () => new Response(listHtml() + '<article><a href="/missing-name">坏项</a></article>'))
  const result = await loadDiscoveryPage(repository, 'user-a', input)
  assert.equal(result.status, 'partial')
  assert.equal(result.items.length, 1)
  assert.match(result.message ?? '', /部分书籍解析失败/u)
})

test('discovery contracts reject missing identities, negative pages and unsigned cursors', () => {
  const input = { sourceId: 'source', fingerprint: 'fp', categoryId: 'category' }
  assert.equal(discoveryPageSchema.safeParse(input).success, true)
  assert.equal(discoveryPageSchema.safeParse({ ...input, cursor: { index: -1, signature: 'x' } }).success, false)
  assert.equal(discoveryPageSchema.safeParse({ ...input, cursor: { index: 2, token: '/arbitrary' } }).success, false)
  assert.equal(discoveryBookSchema.safeParse(input).success, false)
})

test('discovery rejects a cursor from before a control refresh', async (t) => {
  const { repository, source } = await setup({
    exploreUrl: JSON.stringify([{ title: '方向', type: 'toggle', chars: ['男', '女'], default: '男', action: 'java.refreshExplore()' }, { title: '榜单', url: '/control-list' }]),
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(listHtml()))
  const categories = await getDiscoveryCategories(repository, 'user-a', source.sourceId)
  const control = categories.categories.find((item) => item.title === '方向')!
  const list = categories.categories.find((item) => item.title === '榜单')!
  const first = await loadDiscoveryPage(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: list.id })
  await updateDiscoveryControl(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: control.id, value: '女' })
  await assert.rejects(loadDiscoveryPage(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: list.id, cursor: first.cursor }), /筛选已更新/u)
})
