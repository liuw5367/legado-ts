import assert from 'node:assert/strict'
import test from 'node:test'
import { clearDiscoveryChoice, DiscoveryStore, type DiscoveryRequest } from '../src/lib/discovery-state.ts'
import type { DiscoveryCategories, DiscoveryCursor, DiscoveryPage, DiscoverySource } from '../shared/discovery.ts'

const source: DiscoverySource = { sourceId: 'source-a', name: '甲源', fingerprint: 'fp-a' }
const other: DiscoverySource = { sourceId: 'source-b', name: '乙源', fingerprint: 'fp-b' }
const cursor = (index: number): DiscoveryCursor => ({ index, signature: `signed-${index}` })
const page = (index: number, names: string[], next?: number): DiscoveryPage => ({ cursor: cursor(index), items: names.map((name) => ({ sourceId: source.sourceId, bookUrl: '/book-' + name, name })), status: 'success', ...(next === undefined ? {} : { nextCursor: cursor(next) }) })
function categoryData(selected = source): DiscoveryCategories { return { source: selected, categories: [{ id: selected.sourceId + '-popular', title: '热门' }, { id: selected.sourceId + '-new', title: '新书' }] } }
function fixture(overrides: { load?: (body: Record<string, unknown>, signal?: AbortSignal | null) => Promise<DiscoveryPage>; sources?: DiscoverySource[] } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const request: DiscoveryRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    calls.push({ path, body })
    if (path === '/api/discovery/sources') return { sources: overrides.sources ?? [source, other] } as T
    if (path.startsWith('/api/discovery/categories')) return categoryData(path.includes(encodeURIComponent(other.sourceId)) ? other : source) as T
    if (path === '/api/discovery/books') return { book: { id: 'book' }, edition: { editionKey: 'edition' } } as T
    return (overrides.load === undefined ? page(1, ['一', '二'], 2) : await overrides.load(body, init?.signal)) as T
  }
  return { request, calls }
}

test('first visit selects one source/category, and returning restores pages and scroll without requery', async () => {
  const { request, calls } = fixture()
  const store = new DiscoveryStore('user', request)
  await store.initialize()
  assert.equal(store.getSnapshot().source?.sourceId, source.sourceId)
  assert.equal(store.getSnapshot().categoryId, 'source-a-popular')
  assert.equal(calls.filter(({ path }) => path === '/api/discovery/page').length, 1)
  store.scrollY = 600
  store.suspend()
  await store.initialize(source.sourceId, 'source-a-popular')
  assert.equal(store.scrollY, 600)
  assert.equal(store.getSnapshot().items.length, 2)
  assert.equal(calls.filter(({ path }) => path === '/api/discovery/page').length, 1)
})

test('pagination preserves order, deduplicates by URL and ends on repeated cursors or duplicate-only pages', async () => {
  let count = 0
  const { request } = fixture({ load: async () => ++count === 1 ? page(1, ['一', '二'], 2) : page(2, ['二', '三'], 2) })
  const store = new DiscoveryStore('user', request)
  await store.initialize(); await store.loadMore()
  assert.deepEqual(store.getSnapshot().items.map(({ book }) => book.name), ['一', '二', '三'])
  assert.equal(store.getSnapshot().nextCursor, undefined)
  assert.equal(store.getSnapshot().items[2]?.cursor.index, 2)
  const duplicate = new DiscoveryStore('user', fixture({ load: async (body) => body.cursor === undefined ? page(1, ['一'], 2) : page(2, ['一'], 3) }).request)
  await duplicate.initialize(); await duplicate.loadMore()
  assert.equal(duplicate.getSnapshot().nextCursor, undefined)
})

test('next-page failure keeps data/cursor and retries the same page', async () => {
  let attempts = 0
  const { request, calls } = fixture({ load: async (body) => {
    if (body.cursor === undefined) return page(1, ['一'], 2)
    if (++attempts === 1) throw new Error('暂时失败')
    return page(2, ['二'])
  } })
  const store = new DiscoveryStore('user', request)
  await store.initialize(); await store.loadMore()
  assert.equal(store.getSnapshot().items.length, 1)
  assert.equal(store.getSnapshot().error, '暂时失败')
  assert.equal(store.getSnapshot().nextCursor?.index, 2)
  await store.loadMore()
  assert.equal(store.getSnapshot().items.length, 2)
  assert.equal(store.getSnapshot().error, '')
  assert.deepEqual(calls.filter(({ path }) => path === '/api/discovery/page').slice(1).map(({ body }) => body.cursor), [cursor(2), cursor(2)])
})

test('switching categories ignores late results even when the transport does not cancel', async () => {
  let resolveOld!: (value: DiscoveryPage) => void
  let started!: () => void
  const start = new Promise<void>((resolve) => { started = resolve })
  const { request } = fixture({ load: async (body) => {
    if (body.categoryId === 'source-a-popular') { started(); return new Promise<DiscoveryPage>((resolve) => { resolveOld = resolve }) }
    return page(1, ['新分类'])
  } })
  const store = new DiscoveryStore('user', request)
  const first = store.initialize(source.sourceId, 'source-a-popular')
  await start
  await store.initialize(source.sourceId, 'source-a-new')
  resolveOld(page(1, ['旧分类'])); await first
  assert.equal(store.getSnapshot().categoryId, 'source-a-new')
  assert.deepEqual(store.getSnapshot().items.map(({ book }) => book.name), ['新分类'])
})

test('switching sources resets category, page cursor and scroll', async () => {
  const { request, calls } = fixture()
  const store = new DiscoveryStore('user', request)
  await store.initialize(); store.scrollY = 400
  await store.initialize(other.sourceId)
  assert.equal(store.getSnapshot().source?.sourceId, other.sourceId)
  assert.equal(store.getSnapshot().categoryId, 'source-b-popular')
  assert.equal(store.scrollY, 0)
  assert.equal(calls.filter(({ path }) => path === '/api/discovery/page').at(-1)?.body.cursor, undefined)
})

test('opening a later-page book sends its original cursor and keeps the list for return', async () => {
  const { request, calls } = fixture({ load: async (body) => body.cursor === undefined ? page(1, ['一'], 2) : page(2, ['二']) })
  const store = new DiscoveryStore('user', request)
  await store.initialize(); await store.loadMore()
  const result = await store.openBook(store.getSnapshot().items[1]!)
  assert.equal(result?.book.id, 'book')
  assert.deepEqual(calls.at(-1)?.body.cursor, cursor(2))
  assert.equal(calls.at(-1)?.body.bookUrl, '/book-二')
  assert.equal(store.getSnapshot().items.length, 2)
})

test('saved choice is account-scoped and invalid or unavailable choices fall back safely', async () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } as Storage
  const { request } = fixture()
  const first = new DiscoveryStore('a', request, storage)
  await first.initialize(other.sourceId, 'source-b-new')
  const returning = new DiscoveryStore('a', request, storage)
  await returning.initialize()
  assert.equal(returning.getSnapshot().categoryId, 'source-b-new')
  const different = new DiscoveryStore('b', request, storage)
  await different.initialize()
  assert.equal(different.getSnapshot().source?.sourceId, source.sourceId)
  const removed = new DiscoveryStore('a', fixture({ sources: [source] }).request, storage)
  await removed.initialize()
  assert.equal(removed.getSnapshot().categoryId, 'source-a-popular')
  clearDiscoveryChoice('a', storage)
  assert.equal(values.has('legado.discovery.v1:a'), false)
  const disabledStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } } as unknown as Storage
  const unavailable = new DiscoveryStore('a', request, disabledStorage)
  await unavailable.initialize()
  assert.equal(unavailable.getSnapshot().loaded, true)
})

test('empty sources and empty categories settle as empty, while request failures remain retryable', async () => {
  const empty = new DiscoveryStore('user', fixture({ sources: [] }).request)
  await empty.initialize()
  assert.equal(empty.getSnapshot().source, null)
  assert.equal(empty.getSnapshot().loaded, true)
  let failed = true
  const { request } = fixture()
  const retry = new DiscoveryStore('user', async <T>(path: string, init?: RequestInit) => { if (failed) throw new Error('offline'); return request<T>(path, init) })
  await retry.initialize()
  assert.equal(retry.getSnapshot().loaded, false)
  assert.equal(retry.getSnapshot().error, 'offline')
  failed = false; await retry.initialize()
  assert.equal(retry.getSnapshot().items.length, 2)
})
