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
  assert.equal((await repository.getEdition(userA, value.book.id, 'edition-a'))?.bookId, value.book.id)
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
