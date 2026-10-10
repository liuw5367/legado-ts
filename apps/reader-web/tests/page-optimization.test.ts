import assert from 'node:assert/strict'
import test from 'node:test'
import { BookCache, type BookSnapshot } from '../src/lib/book-cache.ts'
import type { ApiContent } from '../src/lib/api.ts'
import { SearchOperation } from '../src/lib/search-operation.ts'
import { stepSetting } from '../src/lib/setting-step.ts'
import { browserUrl } from '../src/lib/reader-interactions.ts'
import { pageReturnTarget, readingEntryState } from '../src/lib/page-navigation.ts'
import { latestSearchHistory } from '../shared/search-history.ts'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { getBookDetails } from '../server/runtime/book-details.ts'
import { candidateSelectionKey, selectedCandidateIndex } from '../src/lib/search-selection.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function snapshot(revision: string): BookSnapshot {
  return { toc: { userId: 'a', bookId: 'b', editionKey: 'e', sourceFingerprint: 'f', revision, chapters: [], bookPatch: {} }, details: { book: { id: 'b', userId: 'a', name: '书', createdAt: '', updatedAt: '' }, edition: { editionKey: 'e', sourceId: 's', sourceFingerprint: 'f', bookUrl: 'https://example.test', metadata: {} }, sourceName: '源', onBookshelf: false }, editions: [], sources: [] }
}
function content(chapterId: string): ApiContent {
  const chapter = { chapterId, sourceId: 's', bookUrl: 'https://example.test/book', chapterUrl: `https://example.test/chapter/${chapterId}`, index: 0, title: '章节' }
  return { chapter, contentType: 'text', raw: '正文', cleaned: '正文', pages: [], resources: [] }
}

test('shared book cache merges requests, retains success on refresh failure and rejects late responses', async () => {
  const cache = new BookCache()
  const first = deferred<BookSnapshot>()
  let calls = 0
  const one = cache.load('b', 'e', async () => { calls++; return first.promise })
  const two = cache.load('b', 'e', async () => { calls++; return snapshot('unexpected') })
  first.resolve(snapshot('r1'))
  assert.equal((await one).toc.revision, 'r1'); await two
  assert.equal(calls, 1)
  await assert.rejects(cache.load('b', 'e', async () => { throw new Error('offline') }, true), /offline/u)
  assert.equal(cache.get('b', 'e')?.toc.revision, 'r1')
  const late = deferred<BookSnapshot>()
  const old = cache.load('b', 'e', () => late.promise, true)
  const rejected = assert.rejects(old, { name: 'AbortError' })
  await cache.load('b', 'e', async () => snapshot('r3'), true)
  late.resolve(snapshot('r2')); await rejected
  assert.equal(cache.get('b', 'e')?.toc.revision, 'r3')
})

test('cache isolates editions and discards previous book, account and in-flight writes', async () => {
  const cache = new BookCache()
  await cache.load('b', 'e', async () => snapshot('r1'))
  await cache.load('b', 'f', async () => snapshot('r2'))
  assert.equal(cache.get('b', 'e')?.toc.revision, 'r1')
  const late = deferred<BookSnapshot>()
  const request = cache.load('b', 'e', () => late.promise, true)
  const rejected = assert.rejects(request, { name: 'AbortError' })
  await cache.load('other', 'e', async () => snapshot('other'))
  late.resolve(snapshot('late')); await rejected
  assert.equal(cache.get('b', 'e'), undefined)
  cache.clear()
  assert.equal(cache.get('other', 'e'), undefined)
  assert.equal(new BookCache().get('b', 'f'), undefined)
})

test('book cache keeps only the current chapter content and isolates it by book and edition', async () => {
  const cache = new BookCache()
  await cache.load('b', 'e', async () => snapshot('r1'))
  const first = content('c1')
  const second = content('c2')
  cache.setContent('b', 'e', 'c1', first)
  assert.equal(cache.getContent('b', 'e', 'c1'), first)
  cache.setContent('b', 'e', 'c2', second)
  assert.equal(cache.getContent('b', 'e', 'c1'), undefined)
  assert.equal(cache.getContent('b', 'e', 'c2'), second)
  assert.equal(cache.getContent('b', 'other', 'c2'), undefined)
  await cache.load('other', 'e', async () => snapshot('other'))
  assert.equal(cache.getContent('b', 'e', 'c2'), undefined)
})

test('search cancellation before create returns settles server ID without starting the stream', async () => {
  const id = deferred<string>(); const cancelled: string[] = []; let streams = 0
  const operation = new SearchOperation({ create: () => id.promise, stream: async () => { streams++ }, cancel: async (value) => { cancelled.push(value) } })
  const run = operation.start('书', true, () => undefined, () => undefined)
  await operation.cancel(); id.resolve('id')
  assert.deepEqual(await run, { id: 'id', cancelled: true })
  assert.equal(streams, 0); assert.deepEqual(cancelled, ['id'])
})

test('search ignores late stream events and does not start a second operation while cancellation is pending', async () => {
  const end = deferred<void>(); const cancel = deferred<void>(); let events = 0
  let emit!: (value: { type: string; data: unknown }) => void
  const operation = new SearchOperation({ create: async () => 'id', stream: async (_id, event) => { emit = event; await end.promise }, cancel: () => cancel.promise })
  const run = operation.start('书', true, () => { events++ }, () => undefined)
  await Promise.resolve(); await Promise.resolve()
  emit({ type: 'source-result', data: {} })
  const cancelling = operation.cancel()
  emit({ type: 'source-result', data: {} })
  await assert.rejects(operation.start('新书', true, () => undefined, () => undefined), /尚未结束/u)
  end.resolve(); cancel.resolve(); await cancelling; await run
  assert.equal(events, 1)
  const complete = operation.start('下一轮', false, () => undefined, () => undefined)
  await complete
})

test('step controls clamp bounds and never accumulate floating point line-height drift', () => {
  assert.equal(stepSetting(18, 1, 15, 28, 1), 19)
  assert.equal(stepSetting(15, -1, 15, 28, 1), 15)
  assert.equal(stepSetting(28, 1, 15, 28, 1), 28)
  let value = 1.4
  for (let i = 0; i < 12; i++) value = stepSetting(value, 1, 1.4, 2.6, 0.1)
  assert.equal(value, 2.6)
  assert.equal(stepSetting(1.9, -1, 1.4, 2.6, 0.1), 1.8)
})

test('a completed search is not cancelled while its stream finishes closing', async () => {
  const closing = deferred<void>()
  const delivered = deferred<void>()
  let cancellations = 0
  const operation = new SearchOperation({ create: async () => 'search', stream: async (_id, event) => { event({ type: 'done', data: {} }); delivered.resolve(); await closing.promise }, cancel: async () => { cancellations++ } })
  const running = operation.start('书', false, () => undefined, () => undefined)
  await delivered.promise
  await operation.cancel()
  closing.resolve()
  assert.equal((await running).cancelled, false)
  assert.equal(cancellations, 0)
})

test('explicit source selection retains its identity when streamed candidates reorder', () => {
  const one = { sourceId: 'a', sourceFingerprint: 'f', candidate: { sourceId: 'a', bookUrl: 'https://example.test/a' } }
  const two = { sourceId: 'b', sourceFingerprint: 'f', candidate: { sourceId: 'b', bookUrl: 'https://example.test/b' } }
  const selected = candidateSelectionKey(two)
  assert.equal(selectedCandidateIndex([{ item: one, index: 0 }, { item: two, index: 1 }], selected), 1)
  assert.equal(selectedCandidateIndex([{ item: two, index: 0 }, { item: one, index: 1 }], selected), 0)
  assert.equal(selectedCandidateIndex([{ item: one, index: 2 }], undefined), 2)
})

test('reading entry inherits original origin and blocks unsafe return URLs', () => {
  const origin = { backTo: '/', backState: { homeView: 'reading' } }
  const state = readingEntryState({ pathname: '/books/b/toc', search: '?editionKey=e', state: { backTo: '/books/b/read/c?editionKey=e', backState: origin } })
  assert.deepEqual(pageReturnTarget(state, '/books/b/read/d', '/'), { to: '/', state: { homeView: 'reading' } })
  const nested = readingEntryState({ pathname: '/books/b/toc', search: '', state: { backTo: '/books/b/details', backState: { backTo: '/books/b/read/c', backState: origin } } })
  assert.deepEqual(pageReturnTarget(nested, '/books/b/read/d', '/'), { to: '/', state: { homeView: 'reading' } })
  const direct = readingEntryState({ pathname: '/books/b/toc', search: '', state: null })
  assert.equal(pageReturnTarget(direct, '/books/b/read/c', '/').to, '/books/b/toc')
  assert.equal(pageReturnTarget({ backTo: '//evil.test' }, '/books/b/read/c', '/').to, '/')
  assert.equal(browserUrl('javascript:alert(1)'), undefined)
  assert.equal(browserUrl('https://example.test/chapter'), 'https://example.test/chapter')
})

test('history normalizes whitespace and Unicode but preserves different keyword case', () => {
  const result = latestSearchHistory([{ id: 'a', keyword: ' café ', createdAt: '1' }, { id: 'b', keyword: 'cafe\u0301', createdAt: '2' }, { id: 'c', keyword: 'Café', createdAt: '3' }])
  assert.deepEqual(result.map((item) => item.id), ['c', 'b'])
})

test('book detail read verifies ownership and exposes only display metadata without activating an edition', async () => {
  const repository = new MemoryReaderRepository()
  const metadata = { sourceId: 's', bookUrl: 'https://example.test/book', name: '书', author: '作者', variable: 'secret-variable', rawFields: { token: 'private-token' }, traceRef: 'test', emptyFields: [], fieldErrors: {} }
  const first = await repository.createBook('a', { candidate: { sourceId: 's', sourceFingerprint: 'f', candidate: metadata }, metadata, editionKey: 'e', sourceFingerprint: 'f', addToBookshelf: false })
  await repository.createBook('a', { bookId: first.book.id, candidate: { sourceId: 's2', sourceFingerprint: 'f2', candidate: metadata }, metadata: { ...metadata, sourceId: 's2', bookUrl: 'https://example.test/book2' }, editionKey: 'e2', sourceFingerprint: 'f2', activateEdition: false, addToBookshelf: false })
  const before = await repository.getBook('a', first.book.id)
  const details = await getBookDetails(repository, 'a', first.book.id, 'e2')
  assert.equal(details?.edition.editionKey, 'e2')
  assert.equal(details?.onBookshelf, false)
  assert.equal(JSON.stringify(details).includes('secret-variable'), false)
  assert.equal(JSON.stringify(details).includes('private-token'), false)
  assert.deepEqual(await repository.getBook('a', first.book.id), before)
  assert.equal(await getBookDetails(repository, 'b', first.book.id, 'e'), null)
  assert.equal(await getBookDetails(repository, 'a', first.book.id, 'unknown'), null)
  await repository.addToBookshelf('a', first.book.id)
  assert.equal((await getBookDetails(repository, 'a', first.book.id))?.onBookshelf, true)
})
