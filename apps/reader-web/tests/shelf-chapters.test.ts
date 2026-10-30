import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { createReaderRuntime } from '../server/runtime/reader-runtime.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { refreshShelfChapters } from '../server/runtime/shelf-chapters.ts'
import { shelfChapterSummary } from '../shared/shelf-chapters.ts'
import { mutationDomains } from '../src/lib/page-data.ts'
import { hasBookUpdate, setBookUpdate, subscribeBookUpdates } from '../src/lib/book-updates.ts'
import type { ApiToc } from '../src/lib/api.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'shelf-tests-runtime-state-key-32-bytes'

const toc: ApiToc = { bookId: 'b', editionKey: 'e', sourceFingerprint: 'f', revision: 'r', chapters: [
  { chapterId: 'v', chapterUrl: '/v', index: 0, title: '第一卷', isVolume: true },
  { chapterId: 'c1', chapterUrl: '/1', index: 1, title: '第一章' },
  { chapterId: 'c2', chapterUrl: '/2', index: 2, title: '第二章' },
] }

test('章节摘要排除卷标题，保留未知状态并按阅读位置计算未读数', () => {
  assert.deepEqual(shelfChapterSummary(null, null), { chapterCount: null, latestChapterTitle: null, unreadChapterCount: null })
  assert.equal(shelfChapterSummary(null, null, '已有最新章节').latestChapterTitle, '已有最新章节')
  assert.deepEqual(shelfChapterSummary(toc, null), { chapterCount: 2, latestChapterTitle: '第二章', unreadChapterCount: 2 })
  assert.equal(shelfChapterSummary(toc, { chapterId: 'c1' }).unreadChapterCount, 1)
  assert.equal(shelfChapterSummary(toc, { chapterId: 'c2' }).unreadChapterCount, 0)
  assert.equal(shelfChapterSummary(toc, { chapterId: '旧ID', chapterIndex: 1 }).unreadChapterCount, 1)
})

test('真实目录刷新增加未读数，不修改阅读位置；无新增、首次获取、失败和隔离', async (t) => {
  const repository = new MemoryReaderRepository()
  const imported = await importSources({ kind: 'text', text: JSON.stringify({ bookSourceUrl: 'https://8.8.8.8/source', bookSourceName: '测试源', bookSourceType: 0, ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href' } }) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('a', { previewId, expiresAt: new Date(Date.now() + 60000).toISOString(), candidates, writableCount: 1 }, 'https://8.8.8.8/source')
  await repository.commitImportPreview('a', previewId, candidates.map((item) => item.id))
  const source = (await repository.listSourcesForUser('a'))[0]!
  const metadata = { sourceId: source.sourceId, bookUrl: 'https://8.8.8.8/book', tocUrl: 'https://8.8.8.8/toc', name: '书', rawFields: {}, traceRef: 'test', emptyFields: [], fieldErrors: {} }
  const { book } = await repository.createBook('a', { candidate: { sourceId: source.sourceId, sourceFingerprint: source.fingerprint, candidate: metadata }, metadata, editionKey: 'e', sourceFingerprint: source.fingerprint, addToBookshelf: true })
  let count = 2
  let fail = false
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new Error('模拟外站失败')
    return new Response(Array.from({ length: count }, (_, index) => `<a href="/${index + 1}">第${index + 1}章</a>`).join(''))
  })
  const runtime = createReaderRuntime(repository)
  const first = await refreshShelfChapters(repository, runtime, 'a', book.id, 'e')
  assert.equal(first.previousChapterCount, null)
  assert.equal(first.hasNewChapters, false)
  const chapter = (await repository.getTocSummary('a', book.id, 'e'))!.chapters[0]!
  await repository.savePosition('a', { userId: 'a', bookId: book.id, editionKey: 'e', chapterId: chapter.chapterId, chapterUrl: chapter.chapterUrl, chapterIndex: chapter.index, title: chapter.title!, paragraphIndex: 0, offset: 0, version: 1 })
  const before = await repository.getPosition('a', book.id, 'e')
  count = 5
  const refreshed = await refreshShelfChapters(repository, runtime, 'a', book.id, 'e')
  assert.equal(refreshed.previousChapterCount, 2)
  assert.equal(refreshed.chapterCount, 5)
  assert.equal(refreshed.hasNewChapters, true)
  assert.equal(refreshed.unreadChapterCount, 4)
  assert.equal(refreshed.position?.chapterId, before?.chapterId)
  assert.deepEqual(await repository.getPosition('a', book.id, 'e'), before)
  assert.equal((await repository.getHome('a')).bookshelf[0]!.chapters.unreadChapterCount, 4)
  assert.equal((await refreshShelfChapters(repository, runtime, 'a', book.id, 'e')).hasNewChapters, false)
  count = 1
  assert.equal((await refreshShelfChapters(repository, runtime, 'a', book.id, 'e')).hasNewChapters, false)
  await repository.savePosition('a', { ...before!, chapterUrl: '/missing', chapterIndex: 0, title: '缺失章节', version: 100 })
  assert.equal((await refreshShelfChapters(repository, runtime, 'a', book.id, 'e')).unreadChapterCount, null)
  const cached = await repository.getTocSummary('a', book.id, 'e')
  fail = true
  await assert.rejects(refreshShelfChapters(repository, runtime, 'a', book.id, 'e'))
  assert.deepEqual(await repository.getTocSummary('a', book.id, 'e'), cached)
  await assert.rejects(refreshShelfChapters(repository, runtime, 'b', book.id, 'e'), /不存在/u)
})

test('单本刷新只使该书目录失效，不重载首页', () => {
  assert.deepEqual(mutationDomains('/api/books/b/toc/refresh?editionKey=e', 'POST'), ['book:b'])
})

test('更新标记按账号和版本隔离，存储不可用时可在会话内清除并通知', () => {
  const id = randomUUID()
  let changes = 0
  const unsubscribe = subscribeBookUpdates(() => changes++)
  try {
    setBookUpdate(id, 'b', 'e', true)
    assert.equal(hasBookUpdate(id, 'b', 'e'), true)
    assert.equal(hasBookUpdate('other', 'b', 'e'), false)
    assert.equal(hasBookUpdate(id, 'b', 'other'), false)
    setBookUpdate(id, 'b', 'e', false)
    assert.equal(hasBookUpdate(id, 'b', 'e'), false)
    assert.equal(changes, 2)
  } finally { unsubscribe() }
})

test('每书仅一份进度，预览不改状态，换源与切回沿用当前章节并排除卷标题', async () => {
  const repository = new MemoryReaderRepository()
  const metadata = { sourceId: 's', bookUrl: 'https://example.test/book', name: '单书状态', rawFields: {}, traceRef: 'test', emptyFields: [], fieldErrors: {} }
  const { book } = await repository.createBook('a', { candidate: { sourceId: 's', sourceFingerprint: 'f', candidate: metadata }, metadata, editionKey: 'e', sourceFingerprint: 'f' })
  await repository.createBook('a', { bookId: book.id, candidate: { sourceId: 's2', sourceFingerprint: 'f2', candidate: metadata }, metadata, editionKey: 'e2', sourceFingerprint: 'f2', activateEdition: false })
  const chapters = toc.chapters.map(({ chapterId: _id, ...chapter }) => ({ ...chapter, rawFields: {}, traceRef: 'test', sourceId: 's', bookUrl: metadata.bookUrl }))
  await repository.saveToc('a', { userId: 'a', bookId: book.id, editionKey: 'e', sourceFingerprint: 'f', revision: 'r', chapters, bookPatch: { lastCheckTime: 0, totalChapterNum: 3 } })
  await repository.savePosition('a', { userId: 'a', bookId: book.id, editionKey: 'e', chapterId: 'c1', chapterUrl: '/1', chapterIndex: 1, title: '第一章', paragraphIndex: 3, offset: 4, version: 1 })
  const initial = await repository.getBook('a', book.id)
  assert.equal(initial?.latestChapterIndex, 1)
  assert.equal(initial?.currentChapterIndex, 0)
  await repository.saveToc('a', { userId: 'a', bookId: book.id, editionKey: 'e2', sourceFingerprint: 'f2', revision: 'r2', chapters: chapters.map((chapter) => ({ ...chapter, chapterUrl: '/other' + chapter.chapterUrl })), bookPatch: { lastCheckTime: 0, totalChapterNum: 3 } })
  assert.deepEqual(await repository.getBook('a', book.id), initial)
  await repository.activateEdition('a', book.id, 'e2')
  assert.equal(await repository.getPosition('a', book.id, 'e'), null)
  const mapped = (await repository.getPosition('a', book.id, 'e2'))!
  assert.equal(mapped.title, '第一章')
  assert.equal(mapped.paragraphIndex, 0)
  await repository.savePosition('a', { ...mapped, chapterUrl: '/other/2', chapterIndex: 2, title: '第二章', version: mapped.version + 1 })
  await repository.activateEdition('a', book.id, 'e')
  const current = (await repository.getPosition('a', book.id, 'e'))!
  assert.equal(current.title, '第二章')
  assert.equal((await repository.getBackupSnapshot('a')).positions.length, 1)
  assert.equal((await repository.getHome('a')).bookshelf[0]!.chapters.unreadChapterCount, 0)
  await repository.savePosition('a', { ...mapped, version: 0 })
  assert.equal((await repository.getPosition('a', book.id))!.editionKey, 'e')
})
