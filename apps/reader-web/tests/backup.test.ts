import assert from 'node:assert/strict'
import test from 'node:test'
import { editionKey as sharedEditionKey, parseJson, readBackupZip } from '@legado/reader-backup'
import { importSources, type BookMetadata } from '@legado/source-core'
import { BackupValidationError, createWebBackup, restoreWebBackup, validateWebBackup } from '../server/backup.ts'
import { MemoryReaderRepository } from '../server/db/repository.ts'

const userId = '00000000-0000-0000-0000-000000000001'
const sourceInput = { bookSourceUrl: 'https://backup.example/source', bookSourceName: '备份书源', bookSourceType: 0, searchUrl: 'https://backup.example/search?q={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }
const metadata: BookMetadata = { sourceId: sourceInput.bookSourceUrl, bookUrl: 'https://backup.example/book/1', tocUrl: 'https://backup.example/book/1/toc', name: '备份书', rawFields: {}, traceRef: 'backup-test', emptyFields: [], fieldErrors: {} }

test('web 端会把无效 ZIP 判定为可展示的备份校验错误', async () => {
  await assert.rejects(validateWebBackup(new MemoryReaderRepository(), userId, new Uint8Array([1, 2, 3])), (error: unknown) => error instanceof BackupValidationError && error.message.includes('ZIP'))
})

test('web 备份可完整恢复书源、书架、阅读、搜索和设置', async () => {
  const source = await importSources({ kind: 'text', text: JSON.stringify([sourceInput]) })
  const parsed = source[0]
  assert.ok(parsed?.source)
  const origin = new MemoryReaderRepository()
  await saveSource(origin, parsed.source, parsed.sourceFingerprint ?? '')
  const edition = sharedEditionKey(metadata.sourceId, metadata.bookUrl)
  const book = await origin.createBook(userId, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: parsed.sourceFingerprint ?? '', candidate: metadata }, metadata, editionKey: edition, sourceFingerprint: parsed.sourceFingerprint ?? '' })
  await origin.savePosition(userId, { userId, bookId: book.book.id, editionKey: edition, chapterId: 'chapter-1', chapterUrl: 'https://backup.example/book/1/1', chapterIndex: 0, title: '第一章', paragraphIndex: 2, offset: 3, version: 1, lastReadAt: '2026-10-15T00:00:00.000Z' })
  const search = await origin.createSearch(userId, { keyword: '备份书', sourceId: metadata.sourceId })
  await origin.updateSearch(userId, search.id, { status: 'success', candidates: [] })
  await origin.saveSettings(userId, { theme: 'dark', readingMode: 'paged', fontSize: 22 })

  await origin.setCustomCover(userId, book.book.id, 'https://covers.test/custom.jpg')
  const zip = await createWebBackup(origin, userId)
  const archive = await readBackupZip(zip)
  const bookDocument = parseJson<{ data: Record<string, unknown> }>(archive, `books/${book.book.id}/book.json`)
  assert.equal(bookDocument.data.customCoverUrl, 'https://covers.test/custom.jpg')
  assert.equal(bookDocument.data.tocUrl, metadata.tocUrl)
  assert.equal(bookDocument.data.metadataEditionKey, edition)
  const restored = new MemoryReaderRepository()
  const stale = await restored.createBook(userId, { candidate: { sourceId: 'https://stale.example/source', sourceFingerprint: 'stale-fp', candidate: { ...metadata, sourceId: 'https://stale.example/source', bookUrl: 'https://stale.example/book', name: '旧书' } }, metadata: { ...metadata, sourceId: 'https://stale.example/source', bookUrl: 'https://stale.example/book', name: '旧书' }, editionKey: sharedEditionKey('https://stale.example/source', 'https://stale.example/book'), sourceFingerprint: 'stale-fp' })
  await restoreWebBackup(restored, userId, zip, ['bookshelf', 'reading', 'search', 'sources', 'settings'])
  const snapshot = await restored.getBackupSnapshot(userId)
  assert.equal(snapshot.sources.length, 1)
  assert.equal(snapshot.books.length, 1)
  assert.equal(snapshot.books[0]?.book.customCoverUrl, 'https://covers.test/custom.jpg')
  assert.equal(snapshot.bookshelf.length, 1)
  assert.equal(snapshot.positions[0]?.offset, 3)
  assert.equal(snapshot.searchHistory[0]?.keyword, '备份书')
  assert.equal(snapshot.settings.theme, 'dark')
  assert.equal(snapshot.books.some((item) => item.book.id === stale.book.id), false)
})

test('只恢复设置和搜索时不会改写书架或书籍数据', async () => {
  const source = new MemoryReaderRepository()
  const localEdition = sharedEditionKey('source-a', metadata.bookUrl)
  const book = await source.createBook(userId, { candidate: { sourceId: 'source-a', sourceFingerprint: 'fp-a', candidate: { ...metadata, sourceId: 'source-a' } }, metadata: { ...metadata, sourceId: 'source-a' }, editionKey: localEdition, sourceFingerprint: 'fp-a' })
  await source.saveSettings(userId, { theme: 'dark' })
  const search = await source.createSearch(userId, { keyword: '导出搜索', sourceId: 'source-a' })
  await source.updateSearch(userId, search.id, { status: 'success', candidates: [] })
  const zip = await createWebBackup(source, userId)

  const target = new MemoryReaderRepository()
  const localTargetEdition = sharedEditionKey('source-local', metadata.bookUrl)
  const localBook = await target.createBook(userId, { candidate: { sourceId: 'source-local', sourceFingerprint: 'fp-local', candidate: { ...metadata, sourceId: 'source-local', name: '本地书' } }, metadata: { ...metadata, sourceId: 'source-local', name: '本地书' }, editionKey: localTargetEdition, sourceFingerprint: 'fp-local' })
  const before = await target.getBackupSnapshot(userId)
  await restoreWebBackup(target, userId, zip, ['search', 'settings'])
  const after = await target.getBackupSnapshot(userId)
  assert.equal(after.settings.theme, 'dark')
  assert.equal(after.searchHistory[0]?.keyword, '导出搜索')
  assert.equal(after.books.length, before.books.length)
  assert.equal(after.books[0]?.book.id, localBook.book.id)
  assert.equal(after.books[0]?.book.name, '本地书')
  assert.equal(after.bookshelf[0]?.bookId, localBook.book.id)
  assert.equal(book.book.name, '备份书')
})

test('书架完整替换会在未选择阅读记录且将产生孤儿时拒绝恢复', async () => {
  const source = new MemoryReaderRepository()
  const edition = sharedEditionKey('source-a', metadata.bookUrl)
  const book = await source.createBook(userId, { candidate: { sourceId: 'source-a', sourceFingerprint: 'fp-a', candidate: { ...metadata, sourceId: 'source-a' } }, metadata: { ...metadata, sourceId: 'source-a' }, editionKey: edition, sourceFingerprint: 'fp-a' })
  const zip = await createWebBackup(source, userId)
  const target = new MemoryReaderRepository()
  const localEdition = sharedEditionKey('source-local', metadata.bookUrl)
  const local = await target.createBook(userId, { candidate: { sourceId: 'source-local', sourceFingerprint: 'fp-local', candidate: { ...metadata, sourceId: 'source-local', name: '本地书' } }, metadata: { ...metadata, sourceId: 'source-local', name: '本地书' }, editionKey: localEdition, sourceFingerprint: 'fp-local' })
  await target.savePosition(userId, { userId, bookId: local.book.id, editionKey: localEdition, chapterId: 'local-chapter', chapterUrl: `${metadata.bookUrl}/local`, chapterIndex: 0, title: '本地章节', paragraphIndex: 0, offset: 0, version: 0 })
  await assert.rejects(restoreWebBackup(target, userId, zip, ['bookshelf']), /孤儿|依赖/u)
  assert.equal((await target.getBook(userId, local.book.id))?.name, '本地书')
  assert.equal((await target.getPosition(userId, local.book.id, localEdition))?.chapterId, 'local-chapter')
  assert.equal(book.book.name, '备份书')
})

test('Memory Repository 恢复搜索记录时不会接管其他用户的搜索运行态', async () => {
  const repository = new MemoryReaderRepository()
  const otherUser = '00000000-0000-0000-0000-000000000002'
  const foreignSearch = await repository.createSearch(otherUser, { keyword: '其他用户', sourceId: 'source-other' })
  const ownSearch = await repository.createSearch(userId, { keyword: '当前用户', sourceId: 'source-own' })
  const snapshot = await repository.getBackupSnapshot(userId)
  const history = snapshot.searchHistory[0]
  assert.ok(history)
  snapshot.searchHistory = [{ ...history, searchId: foreignSearch.id }]
  await repository.restoreBackupSnapshot(userId, snapshot, ['search'])
  const restored = (await repository.getBackupSnapshot(userId)).searchHistory[0]
  assert.ok(restored)
  assert.notEqual(restored.searchId, foreignSearch.id)
  assert.equal((await repository.getSearch(otherUser, foreignSearch.id))?.id, foreignSearch.id)
  assert.equal((await repository.getSearch(userId, ownSearch.id)), null)
})

async function saveSource(repository: MemoryReaderRepository, source: NonNullable<Awaited<ReturnType<typeof importSources>>[number]['source']>, fingerprint: string): Promise<void> {
  await repository.saveImportPreview(userId, { previewId: 'backup-source-preview', expiresAt: new Date(Date.now() + 60_000).toISOString(), writableCount: 1, candidates: [{ id: 'backup-source-candidate', sourceId: source.bookSourceUrl, name: source.bookSourceName, fingerprint, normalizedSource: source, rawSource: source, disposition: 'new', reason: '可导入' }] }, 'https://backup.example/source.json')
  await repository.commitImportPreview(userId, 'backup-source-preview', ['backup-source-candidate'])
}

test('书单独立评价、分组顺序和启动目标随备份恢复', async () => {
  const source = new MemoryReaderRepository()
  const edition = sharedEditionKey(metadata.sourceId, metadata.bookUrl)
  const created = await source.createBook(userId, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: edition, sourceFingerprint: 'fp' })
  const org = await source.mutateBookOrganization(userId, { kind: 'create', type: 'booklist', name: '重读' })
  const list = org.lists[0]!
  await source.mutateBookOrganization(userId, { kind: 'add', id: list.id, bookId: created.book.id })
  await source.mutateBookOrganization(userId, { kind: 'review', id: list.id, bookId: created.book.id, description: '我的评价' })
  const groups = await source.mutateBookOrganization(userId, { kind: 'create', type: 'shelf_group', name: '科幻' })
  const group = groups.lists.find((row) => row.type === 'shelf_group')!
  await source.mutateBookOrganization(userId, { kind: 'assign', bookId: created.book.id, groupId: group.id })
  await source.saveSettings(userId, { general: { bookshelfInitialGroup: group.id } })
  const target = new MemoryReaderRepository()
  await restoreWebBackup(target, userId, await createWebBackup(source, userId), ['bookshelf', 'reading', 'settings'])
  const restored = await target.getBackupSnapshot(userId)
  assert.equal(restored.organization?.items[0]?.description, '我的评价')
  const restoredGroup = restored.organization?.lists.find((row) => row.name === '科幻')
  assert.ok(restoredGroup)
  assert.equal(restored.bookshelf[0]?.groupId, restoredGroup.id)
  assert.equal(restored.settings.general.bookshelfInitialGroup, restoredGroup.id)
})

test('旧备份恢复保留本地书单和不在书架的依赖书籍', async () => {
  const target = new MemoryReaderRepository()
  const edition = sharedEditionKey(metadata.sourceId, metadata.bookUrl)
  const created = await target.createBook(userId, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: edition, sourceFingerprint: 'fp', addToBookshelf: false })
  const org = await target.mutateBookOrganization(userId, { kind: 'create', type: 'booklist', name: '保留书单' })
  await target.mutateBookOrganization(userId, { kind: 'add', id: org.lists[0]!.id, bookId: created.book.id })
  const archive = await readBackupZip(await createWebBackup(new MemoryReaderRepository(), userId))
  const { createBackupZip } = await import('@legado/reader-backup')
  const zip = createBackupZip(archive.manifest.files.filter((file) => file.path !== 'book-lists.json').map((file) => ({ path: file.path, category: file.category, data: archive.files.get(file.path)! })), { producer: { name: 'reader-cli', version: '0.1.0' } })
  await restoreWebBackup(target, userId, zip, ['bookshelf', 'reading'])
  assert.equal((await target.getBookOrganization(userId)).items[0]?.bookId, created.book.id)
  assert.equal((await target.getBook(userId, created.book.id))?.name, metadata.name)
  assert.equal((await target.getHome(userId)).bookshelf.length, 0)
})
