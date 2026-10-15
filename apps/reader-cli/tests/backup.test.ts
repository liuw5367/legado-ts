import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readBackupZip } from '@legado/reader-backup'
import { READER_SETTINGS_DEFAULTS } from '../src/reader-settings.ts'
import { ReaderStorage, editionKey } from '../src/storage.ts'

test('CLI 导出包含跨端用户文件，导入只覆盖选择的分类', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-backup-'))
  const paths = { dataRoot: join(root, 'data'), cacheRoot: join(root, 'cache') }
  const sourceId = 'https://source.test'
  const bookUrl = 'https://source.test/book/1'
  const edition = editionKey(sourceId, bookUrl)
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const staleBookId = '3f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const first = new ReaderStorage({ paths })
  const second = new ReaderStorage({ paths: { dataRoot: join(root, 'target-data'), cacheRoot: join(root, 'target-cache') } })
  const third = new ReaderStorage({ paths: { dataRoot: join(root, 'reading-only-data'), cacheRoot: join(root, 'reading-only-cache') } })
  try {
    await first.initialize()
    await first.upsertBook({ bookId, name: '源书', activeEditionKey: edition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await first.toggleBookshelf(bookId)
    await first.mergeKnownSources(bookId, [{ editionKey: edition, sourceId, sourceFingerprint: 'fp', bookUrl, name: '源书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    await first.saveReadingPosition({ bookId, position: { editionKey: edition, sourceId, bookUrl, chapterUrl: `${bookUrl}/c1`, index: 0, title: '第一章', paragraphIndex: 3, offset: 4, lastReadAt: '2026-01-02T00:00:00.000Z' } })
    await first.addSearchHistory({ keyword: '三体', sourceScope: 'all', startedAt: '2026-01-03T00:00:00.000Z', summary: { searched: 1, success: 1, empty: 0, failed: 0, capabilityMissing: 0, candidates: 1 }, openedBookIds: [bookId] })
    const zip = await first.createBackupZip()
    const archive = await readBackupZip(zip)
    assert.ok(archive.files.has('bookshelf.json'))
    assert.ok(archive.files.has(`books/${bookId}/book.json`))
    assert.ok(archive.files.has('reading-history.json'))
    await second.initialize()
    await second.upsertBook({ bookId: staleBookId, name: '应被替换的旧书', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await second.toggleBookshelf(staleBookId)
    await second.addSearchHistory({ keyword: '本地记录', sourceScope: 'all', startedAt: '2026-01-04T00:00:00.000Z', summary: { searched: 1, success: 1, empty: 0, failed: 0, capabilityMissing: 0, candidates: 0 }, openedBookIds: [] })
    await second.restoreBackup(zip, ['bookshelf', 'reading'])
    assert.equal((await second.getReadingRecord(bookId))?.positions[edition]?.offset, 4)
    assert.equal(await second.getBook(staleBookId), undefined)
    assert.equal(await second.isOnBookshelf(staleBookId), false)
    assert.equal((await second.listSearchHistory())[0]?.keyword, '本地记录')
    assert.deepEqual(await second.getReaderSettings(), READER_SETTINGS_DEFAULTS)

    await third.initialize()
    await third.upsertBook({ bookId, name: '本地书籍', activeEditionKey: edition, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' })
    await third.toggleBookshelf(bookId)
    await assert.rejects(third.restoreBackup(zip, ['reading']), /书籍版本不存在/u)
    await third.mergeKnownSources(bookId, [{ editionKey: edition, sourceId, sourceFingerprint: 'fp', bookUrl, rawFields: {}, discoveredAt: '2026-02-01T00:00:00.000Z', matchKind: 'selected' }])
    await third.restoreBackup(zip, ['reading'])
    assert.equal((await third.getBook(bookId))?.name, '本地书籍')
    assert.equal(await third.isOnBookshelf(bookId), true)
    assert.equal((await third.getReadingRecord(bookId))?.positions[edition]?.offset, 4)
  } finally {
    await first.close().catch(() => undefined)
    await second.close().catch(() => undefined)
    await third.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
