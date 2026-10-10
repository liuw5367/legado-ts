import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { createReaderRuntime } from '../server/runtime/reader-runtime.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { bookIdentityKey, sameBookIdentity } from '../shared/book-identity.ts'

async function setup() {
  const repository = new MemoryReaderRepository()
  const definitions = ['a', 'b'].map((id) => ({ bookSourceUrl: `https://8.8.8.8/source-${id}`, bookSourceName: `来源${id}`, bookSourceType: 0, lastUpdateTime: 10, searchUrl: `/search-${id}`, ruleSearch: { bookList: 'article', name: 'h2@text', author: '.author@text', bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text', author: '.author@text', tocUrl: 'a@href' } }))
  const imported = await importSources({ kind: 'text', text: JSON.stringify(definitions) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, 'https://8.8.8.8/sources')
  await repository.commitImportPreview('user-a', previewId, candidates.map((item) => item.id))
  const sources = await repository.listSourcesForUser('user-a')
  const run = await repository.createSearch('user-a', { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((item) => item.sourceId) })
  return { repository, runtime: createReaderRuntime(repository), run }
}
function fixtureResponse(url: URL | string): Response {
  const path = new URL(String(url)).pathname
  return path.startsWith('/search-')
    ? new Response(`<article><h2>目标书</h2><span class="author">作者</span><a href="/book-${path.at(-1)}">详情</a></article>`)
    : new Response('<h1>目标书</h1><span class="author">作者</span><a href="/toc">目录</a>')
}

test('book identity never automatically merges missing or different authors', () => {
  assert.equal(sameBookIdentity(' 目标书 ', '作者', '目标书', ' 作者 '), true)
  assert.equal(sameBookIdentity('目标书', undefined, '目标书', undefined), false)
  assert.equal(sameBookIdentity('目标书', '作者', '目标书', '另一位作者'), false)
  assert.equal(bookIdentityKey('目标书', '作者未知'), undefined)
})
test('sources persist, deduplicate, open lazily and preserve book and active edition', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: URL | string) => fixtureResponse(url))
  const { repository, runtime, run } = await setup()
  assert.equal((await runtime.runSearchBatch('user-a', run.id)).candidates.length, 2)
  const created = await runtime.createBookFromSearch('user-a', run.id, 0)
  assert.equal((await repository.listEditions('user-a', created.book.id)).length, 1)
  assert.equal((await repository.listBookSourceCandidates('user-a', created.book.id)).length, 2)
  await runtime.createBookFromSearch('user-a', run.id, 0)
  assert.equal((await repository.listBookSourceCandidates('user-a', created.book.id)).length, 2)
  const before = await repository.getBook('user-a', created.book.id)
  const list = await runtime.listBookSources('user-a', created.book.id)
  assert.equal(list.sources.length, 2)
  assert.equal(list.sources[0]?.status, 'saved')
  const candidate = list.sources.find((item) => item.status === 'discovered')
  assert.ok(candidate?.status === 'discovered')
  const edition = await runtime.openBookSource('user-a', created.book.id, candidate.candidateId)
  assert.notEqual(edition.editionKey, created.edition.editionKey)
  assert.deepEqual(await repository.getBook('user-a', created.book.id), before)
  assert.equal(await repository.getPosition('user-a', created.book.id, edition.editionKey), null)
  assert.equal((await runtime.listBookSources('user-a', created.book.id)).sources.every((item) => item.status === 'saved'), true)
  const calls = fetch.mock.callCount()
  await runtime.openBookSource('user-a', created.book.id, candidate.candidateId)
  assert.equal(fetch.mock.callCount(), calls)
  await assert.rejects(runtime.openBookSource('user-b', created.book.id, candidate.candidateId), /不存在/u)
  await assert.rejects(runtime.listBookSources('user-b', created.book.id), /不存在/u)
})

test('cached JavaScript candidates keep detail rehydration state', async () => {
  const repository = new MemoryReaderRepository()
  const imported = await importSources({ kind: 'text', text: JSON.stringify({
    bookSourceUrl: 'https://js-cache.test/source',
    bookSourceName: 'JavaScript 缓存源',
    bookSourceType: 0,
    mainJs: [
      'function search(key) { return [{ name: key, author: "作者", bookUrl: "/book-a", variable: "{\\"token\\":\\"a\\"}", cacheToken: "a" }, { name: key, author: "作者", bookUrl: "/book-b", variable: "{\\"token\\":\\"b\\"}", cacheToken: "b" }]; }',
      'function getBookInfo(book) { if (book.bookUrl.endsWith("/book-b") && (book.variable !== "{\\"token\\":\\"b\\"}" || book.rawFields.cacheToken !== "b")) throw new Error("cached detail state missing"); return { tocUrl: book.bookUrl + "/toc" }; }',
    ].join('\n'),
  }) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, 'https://js-cache.test/source')
  await repository.commitImportPreview('user-a', previewId, candidates.map((item) => item.id))
  const source = (await repository.listSourcesForUser('user-a'))[0]!
  const run = await repository.createSearch('user-a', { keyword: '目标书', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const runtime = createReaderRuntime(repository)
  const batch = await runtime.runSearchBatch('user-a', run.id)
  assert.equal(batch.candidates.length, 2)
  const created = await runtime.createBookFromSearch('user-a', run.id, 0)
  const discovered = (await runtime.listBookSources('user-a', created.book.id)).sources.find((item) => item.status === 'discovered')
  assert.ok(discovered?.status === 'discovered')
  const edition = await runtime.openBookSource('user-a', created.book.id, discovered.candidateId)
  assert.equal(edition.bookUrl, 'https://js-cache.test/book-b')
})

test('sources arriving after shelving are cached at batch settlement', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => fixtureResponse(url))
  const { repository, runtime, run } = await setup()
  let bookId = ''
  await runtime.runSearchBatchStream('user-a', run.id, async (_source, snapshot) => {
    if (bookId.length === 0) bookId = (await runtime.createBookFromSearch('user-a', snapshot.id, 0)).book.id
  })
  assert.equal((await repository.listBookSourceCandidates('user-a', bookId)).length, 2)
})
test('different authors cannot attach to a known book and unknown authors are not cached automatically', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    const text = await fixtureResponse(url).text()
    return new Response(new URL(String(url)).pathname === '/search-b' ? text.replace('>作者<', '>其他作者<') : text)
  })
  const known = await setup()
  const batch = await known.runtime.runSearchBatch('user-a', known.run.id)
  const first = batch.candidates.findIndex((item) => item.candidate.author === '作者')
  const other = batch.candidates.findIndex((item) => item.candidate.author === '其他作者')
  const created = await known.runtime.createBookFromSearch('user-a', known.run.id, first)
  assert.equal((await known.runtime.listBookSources('user-a', created.book.id)).sources.length, 1)
  await assert.rejects(known.runtime.createBookFromSearch('user-a', known.run.id, other, created.book.id), /不匹配/u)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => new Response((await fixtureResponse(url).text()).replace('<span class="author">作者</span>', '')))
  const unknown = await setup()
  await unknown.runtime.runSearchBatch('user-a', unknown.run.id)
  const selected = await unknown.runtime.createBookFromSearch('user-a', unknown.run.id, 0)
  assert.equal((await unknown.repository.listBookSourceCandidates('user-a', selected.book.id)).length, 0)
  assert.equal((await unknown.runtime.listBookSources('user-a', selected.book.id)).sources.length, 1)
})
test('detail mismatch and unavailable sources preserve the active edition', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => fixtureResponse(url))
  const { repository, runtime, run } = await setup()
  await runtime.runSearchBatch('user-a', run.id)
  const created = await runtime.createBookFromSearch('user-a', run.id, 0)
  const item = (await runtime.listBookSources('user-a', created.book.id)).sources.find((source) => source.status === 'discovered')
  assert.ok(item?.status === 'discovered')
  const before = await repository.getBook('user-a', created.book.id)
  t.mock.method(globalThis, 'fetch', async () => new Response('<h1>另一本书</h1><span class="author">其他作者</span>'))
  await assert.rejects(runtime.openBookSource('user-a', created.book.id, item.candidateId), /不匹配/u)
  assert.deepEqual(await repository.getBook('user-a', created.book.id), before)
  assert.equal((await repository.listEditions('user-a', created.book.id)).length, 1)
  for (const action of ['disable', 'enable', 'delete'] as const) {
    const state = (await repository.listSourceStatesForUser('user-a')).find((entry) => entry.source.sourceId === item.sourceId)!
    await repository.applySourceActions('user-a', action, [{ sourceId: item.sourceId, expectedSourceRevision: state.sourceRevision }])
    assert.equal((await runtime.listBookSources('user-a', created.book.id)).sources.length, action === 'enable' ? 2 : 1)
  }
})
test('cache failure is separate from successful shelving', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => fixtureResponse(url))
  const { repository, runtime, run } = await setup()
  await runtime.runSearchBatch('user-a', run.id)
  t.mock.method(repository, 'saveBookSourceCandidates', async () => { throw new Error('fixture cache failure') })
  const created = await runtime.createBookFromSearch('user-a', run.id, 0)
  assert.equal(created.cacheWarning?.code, 'source-cache-failed')
  assert.equal((await repository.getHome('user-a')).bookshelf[0]?.book.id, created.book.id)
})

test('partial and cancelled batches cache only committed successful candidates', async (t) => {
  for (const cancel of [false, true]) {
    t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/search-b') {
        if (!cancel) throw new Error('fixture source unavailable')
        return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
      }
      return fixtureResponse(url)
    })
    const { repository, runtime, run } = await setup()
    let bookId = ''
    const batch = await runtime.runSearchBatchStream('user-a', run.id, async (_source, snapshot) => {
      if (bookId.length === 0 && snapshot.candidates.length > 0) {
        bookId = (await runtime.createBookFromSearch('user-a', run.id, 0)).book.id
        if (cancel) await runtime.cancelSearch('user-a', run.id)
      }
    })
    assert.equal(batch.sourceStatus, cancel ? 'cancelled' : 'partial')
    assert.equal((await repository.listBookSourceCandidates('user-a', bookId)).length, 1)
    t.mock.restoreAll()
  }
})

test('updated source fingerprints invalidate discovered and saved entries', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => fixtureResponse(url))
  const { repository, runtime, run } = await setup()
  await runtime.runSearchBatch('user-a', run.id)
  const created = await runtime.createBookFromSearch('user-a', run.id, 0)
  const state = (await repository.listSourceStatesForUser('user-a'))[0]!
  const imported = await importSources({ kind: 'text', text: JSON.stringify({ ...state.source.normalizedSource, searchUrl: '/updated', lastUpdateTime: 100 }) })
  const candidates = compareImportCandidates(imported, new Map([[state.source.sourceId, state]]))
  const previewId = randomUUID()
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, 'https://8.8.8.8/update')
  await repository.commitImportPreview('user-a', previewId, candidates.map((item) => item.id))
  assert.equal((await runtime.listBookSources('user-a', created.book.id)).sources.length, 1)
})
