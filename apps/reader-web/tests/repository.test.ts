import assert from 'node:assert/strict'
import test from 'node:test'
import type { BookMetadata } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'

const metadata: BookMetadata = {
  sourceId: 'source-a',
  bookUrl: 'https://books.example.test/a',
  name: '测试书',
  rawFields: {},
  traceRef: 'trace',
  emptyFields: [],
  fieldErrors: {},
}

test('memory repository keeps search and bookshelf data isolated by user', async () => {
  const repository = new MemoryReaderRepository([{ sourceId: 'source-a', name: '测试书源', fingerprint: 'fp', enabled: true, rawSource: {}, normalizedSource: { bookSourceUrl: 'source-a', bookSourceName: '测试书源' } }])
  const userA = '00000000-0000-0000-0000-000000000001'
  const userB = '00000000-0000-0000-0000-000000000002'
  const search = await repository.createSearch(userA, { keyword: '测试书', sourceId: 'source-a' }, 'fp')
  await repository.updateSearch(userA, search.id, { status: 'success', candidates: [{ sourceId: 'source-a', sourceFingerprint: 'fp', candidate: { ...metadata, name: '候选书' } }] })
  assert.equal(await repository.getSearch(userB, search.id), null)
  const value = await repository.createBook(userA, { candidate: { sourceId: 'source-a', sourceFingerprint: 'fp', candidate: { ...metadata, name: '候选书' } }, metadata, editionKey: 'edition-a', sourceFingerprint: 'fp' })
  assert.equal((await repository.listBooks(userA)).length, 1)
  assert.equal((await repository.listBooks(userB)).length, 0)
  assert.equal((await repository.getHome(userA)).bookshelf.length, 1)
  assert.equal((await repository.getHome(userB)).bookshelf.length, 0)
  assert.equal((await repository.getEdition(userA, value.book.id, 'edition-a'))?.bookId, value.book.id)
  const history = (await repository.getHome(userA)).searchHistory[0]
  assert.ok(history !== undefined)
  assert.equal(await repository.deleteSearchHistory(userB, history.id), false)
  assert.equal(await repository.deleteSearchHistory(userA, history.id), true)
  assert.equal((await repository.getHome(userA)).searchHistory.length, 0)
})

test('memory repository keeps editions and settings scoped to a book and user', async () => {
  const repository = new MemoryReaderRepository()
  const userA = '00000000-0000-0000-0000-000000000001'
  const userB = '00000000-0000-0000-0000-000000000002'
  const first = await repository.createBook(userA, { candidate: { sourceId: 'source-a', sourceFingerprint: 'fp-a', candidate: { ...metadata, bookUrl: 'https://books.example.test/a' } }, metadata, editionKey: 'edition-a', sourceFingerprint: 'fp-a' })
  const second = await repository.createBook(userA, { bookId: first.book.id, candidate: { sourceId: 'source-b', sourceFingerprint: 'fp-b', candidate: { ...metadata, bookUrl: 'https://books.example.test/b' } }, metadata: { ...metadata, bookUrl: 'https://books.example.test/b' }, editionKey: 'edition-b', sourceFingerprint: 'fp-b' })
  assert.equal(second.book.id, first.book.id)
  assert.equal((await repository.listEditions(userA, first.book.id)).length, 2)
  assert.equal((await repository.listBooks(userA)).length, 1)
  assert.equal((await repository.getHome(userA)).bookshelf.length, 1)
  assert.equal((await repository.setActiveEdition(userA, first.book.id, 'edition-a'))?.editionKey, 'edition-a')
  assert.equal((await repository.getBook(userA, first.book.id))?.activeEditionKey, 'edition-a')
  assert.equal(await repository.getBook(userB, first.book.id), null)
  assert.equal((await repository.getSettings(userA)).theme, 'system')
  await repository.saveSettings(userA, { theme: 'dark', fontSize: 21, lineHeight: 2.1 })
  assert.equal((await repository.getSettings(userA)).fontSize, 21)
  assert.equal((await repository.getSettings(userB)).theme, 'system')
})

test('memory repository upserts content, toc, and reading position by user identity', async () => {
  const repository = new MemoryReaderRepository()
  const userId = '00000000-0000-0000-0000-000000000001'
  const toc = await repository.saveToc(userId, { userId, bookId: 'book-a', editionKey: 'edition-a', sourceFingerprint: 'fp', revision: 'rev-1', chapters: [], bookPatch: { lastCheckTime: 1, totalChapterNum: 0 } })
  assert.equal((await repository.getToc(userId, 'book-a', 'edition-a'))?.revision, toc.revision)
  const content = await repository.saveContent(userId, { userId, bookId: 'book-a', editionKey: 'edition-a', chapterId: 'chapter-a', tocRevision: 'rev-1', sourceFingerprint: 'fp', content: { chapter: { sourceId: 'source-a', bookUrl: 'book-a', chapterUrl: 'chapter-a', index: 0 }, contentType: 'text', raw: '正文', cleaned: '正文', pages: ['正文'], resources: [] } })
  assert.equal((await repository.getContent(userId, 'edition-a', 'rev-1', 'chapter-a'))?.content.cleaned, content.content.cleaned)
  const position = await repository.savePosition(userId, { userId, bookId: 'book-a', editionKey: 'edition-a', chapterId: 'chapter-a', chapterUrl: 'https://books.example.test/a/1', chapterIndex: 0, title: '第一章', paragraphIndex: 2, offset: 3, version: 1 })
  assert.equal((await repository.getPosition(userId, 'book-a', 'edition-a'))?.paragraphIndex, position.paragraphIndex)
})

test('search snapshots retain per-source progress for stream recovery', async () => {
  const repository = new MemoryReaderRepository()
  const userId = '00000000-0000-0000-0000-000000000001'
  const search = await repository.createSearch(userId, { keyword: '多源', sourceId: 'source-a', sourceIds: ['source-a', 'source-b'] })
  assert.deepEqual(search.sourceIds, ['source-a', 'source-b'])
  assert.equal(search.progress.total, 2)
  const updated = await repository.updateSearch(userId, search.id, { sourceStates: [{ sourceId: 'source-a', status: 'success', candidates: [], diagnostics: [], nextCursor: { index: 2 } }, { sourceId: 'source-b', status: 'failed', candidates: [], diagnostics: [{ message: 'timeout' }] }], progress: { completed: 2, total: 2 }, status: 'partial' })
  assert.equal(updated?.sourceStates[0]?.nextCursor?.index, 2)
  assert.equal(updated?.status, 'partial')
  assert.equal((await repository.getHome(userId)).searchHistory[0]?.status, 'partial')
})

test('memory search operation claims can be released and reclaimed', async () => {
  const repository = new MemoryReaderRepository()
  const userId = '00000000-0000-0000-0000-000000000001'
  const search = await repository.createSearch(userId, { keyword: '占用', sourceId: 'source-a' })
  const states = [{ sourceId: 'source-a', status: 'pending' as const, candidates: [], diagnostics: [] }]
  const claimed = await repository.claimSearch(userId, search.id, 'operation-a', states, { completed: 0, total: 1 })
  assert.equal(claimed?.operationId, 'operation-a')
  assert.equal(await repository.claimSearch(userId, search.id, 'operation-b', states, { completed: 0, total: 1 }), null)
  const released = await repository.updateSearch(userId, search.id, { expectedOperationId: 'operation-a', operationId: null, status: 'success' })
  assert.equal(released?.operationId, undefined)
  assert.equal((await repository.claimSearch(userId, search.id, 'operation-b', states, { completed: 0, total: 1 }))?.operationId, 'operation-b')
})
