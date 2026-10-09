import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Chapter, ContentIdentity } from '@legado/source-core'
import { defaultStoragePaths, normalizeSearchName, ReaderStorage, editionKey } from '../src/storage.ts'
import { READER_SETTINGS_DEFAULTS } from '../src/reader-settings.ts'

async function temporaryStorage(): Promise<{ storage: ReaderStorage; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') }, maxCacheBytes: 128 })
  await storage.initialize()
  return { storage, root }
}

test('默认数据和缓存目录位于用户配置目录', () => {
  const home = '/tmp/reader-cli-test-home'
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const paths = defaultStoragePaths(platform, { HOME: home, LOCALAPPDATA: '/tmp/local-app-data', XDG_STATE_HOME: '/tmp/state', XDG_CACHE_HOME: '/tmp/cache' })
    assert.equal(paths.dataRoot, join(home, '.config', 'reader-cli', 'data-v1'))
    assert.equal(paths.cacheRoot, join(home, '.config', 'reader-cli', 'cache-v1'))
  }
})

test('阅读器并发设置使用默认值并通过带 envelope 的文件持久化', async () => {
  const { storage, root } = await temporaryStorage()
  try {
    assert.deepEqual(await storage.getReaderSettings(), READER_SETTINGS_DEFAULTS)
    await storage.saveReaderSettings({ ...READER_SETTINGS_DEFAULTS, searchConcurrency: 1, sourceSearchConcurrency: 32, sourceCheckConcurrency: 8, showReaderBookTitle: false, readerHeaderSeparator: 'hidden' })
    assert.deepEqual(await storage.getReaderSettings(), { ...READER_SETTINGS_DEFAULTS, searchConcurrency: 1, sourceSearchConcurrency: 32, sourceCheckConcurrency: 8, showReaderBookTitle: false, readerHeaderSeparator: 'hidden' })
    const persisted = JSON.parse(await readFile(join(root, 'data-v1', 'reader-settings.json'), 'utf8')) as { schemaVersion?: number; data?: Record<string, unknown> }
    assert.equal(persisted.schemaVersion, 1)
    assert.equal(persisted.data?.sourceSearchConcurrency, 32)
    assert.equal(persisted.data?.readerHeaderSeparator, 'hidden')
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('旧阅读器设置缺少新增字段时补齐默认值', async () => {
  const { storage, root } = await temporaryStorage()
  try {
    await writeFile(join(root, 'data-v1', 'reader-settings.json'), JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: '2026-10-09T00:00:00.000Z', data: { searchConcurrency: 2, sourceSearchConcurrency: 3, sourceCheckConcurrency: 5 } }))
    assert.deepEqual(await storage.getReaderSettings(), { ...READER_SETTINGS_DEFAULTS, searchConcurrency: 2, sourceSearchConcurrency: 3, sourceCheckConcurrency: 5 })
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('非法阅读器并发设置读取时回退为默认值', async () => {
  const { storage, root } = await temporaryStorage()
  try {
    await writeFile(join(root, 'data-v1', 'reader-settings.json'), JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: '2026-10-09T00:00:00.000Z', data: { ...READER_SETTINGS_DEFAULTS, searchConcurrency: 0, sourceSearchConcurrency: 99, sourceCheckConcurrency: 1.5, showReaderChapterTitle: 'no', readerHeaderSeparator: 'space' } }))
    assert.deepEqual(await storage.getReaderSettings(), READER_SETTINGS_DEFAULTS)
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('搜索历史按规范化名称只保留最新记录并显示完成时间', async () => {
  const { storage, root } = await temporaryStorage()
  try {
    assert.equal(normalizeSearchName('  Ｔｅｓｔ\t书  '), 'test 书')
    await storage.addSearchHistory({ keyword: '三体', sourceScope: 'all', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', summary: { searched: 1, success: 1, empty: 0, failed: 0, capabilityMissing: 0, candidates: 1 }, openedBookIds: [] })
    await storage.addSearchHistory({ keyword: '  三体 ', sourceScope: 'all', startedAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-02T00:00:02.000Z', summary: { searched: 2, success: 2, empty: 0, failed: 0, capabilityMissing: 0, candidates: 3 }, openedBookIds: [] })
    const history = await storage.listSearchHistory()
    assert.equal(history.length, 1)
    assert.equal(history[0]?.keyword, '  三体 ')
    assert.equal(history[0]?.completedAt, '2026-01-02T00:00:02.000Z')
    assert.equal(JSON.parse(await readFile(join(root, 'data-v1', 'search-history.json'), 'utf8')).data.length, 1)
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('多文件存储保留搜索、书架和阅读记录，并派生书架标记', async () => {
  const { storage, root } = await temporaryStorage()
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const sourceId = 'https://source.test'
  const url = 'https://source.test/book/1'
  const edition = editionKey(sourceId, url)
  try {
    await storage.upsertBook({ bookId, name: '测试书', activeEditionKey: edition, metadataEditionKey: edition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: edition, sourceId, sourceFingerprint: 'fingerprint', bookUrl: url, name: '测试书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    assert.equal(await storage.toggleBookshelf(bookId), true)
    await storage.saveReadingPosition({ bookId, position: { editionKey: edition, sourceId, bookUrl: url, chapterUrl: `${url}/c1`, index: 0, title: '第一章', paragraphIndex: 1, offset: 4, lastReadAt: '2026-01-02T00:00:00.000Z' } })
    const views = await storage.homeViews()
    assert.equal(views.length, 1)
    assert.equal(views[0]?.isOnBookshelf, true)
    assert.equal(views[0]?.lastReadAt, '2026-01-02T00:00:00.000Z')
    assert.equal((await storage.toggleBookshelf(bookId)), false)
    assert.equal((await storage.homeViews())[0]?.isOnBookshelf, false)
    assert.equal((await storage.getReadingRecords())[0]?.lastReadAt, '2026-01-02T00:00:00.000Z')
    for (let index = 0; index < 105; index += 1) await storage.addSearchHistory({ keyword: `书${index}`, sourceScope: 'all', startedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`, summary: { searched: 1, success: 1, empty: 0, failed: 0, capabilityMissing: 0, candidates: 1 }, openedBookIds: [] })
    assert.equal((await storage.listSearchHistory(200)).length, 100)
    const persisted = JSON.parse(await readFile(join(root, 'data-v1', 'books', bookId, 'book.json'), 'utf8')) as { data?: { name?: string } }
    assert.equal(persisted.data?.name, '测试书')
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('目录快照按书源版本持久化并可在重启后读取', async () => {
  const { storage, root } = await temporaryStorage()
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const edition = editionKey('https://source.test', 'https://source.test/book/1')
  const first: Chapter = { sourceId: 'https://source.test', bookUrl: 'https://source.test/book/1', chapterUrl: 'https://source.test/book/1/c1', index: 0, title: '第一章', rawFields: {}, traceRef: 'toc:0' }
  try {
    await storage.saveTocSnapshot(bookId, edition, { editionKey: edition, revision: 'revision-1', chapters: [first], bookPatch: { totalChapterNum: 1, lastCheckTime: 123, latestChapterTitle: '第一章' }, updatedAt: '2026-01-01T00:00:00.000Z' })
    assert.deepEqual(await storage.getTocSnapshot(bookId, edition), { editionKey: edition, revision: 'revision-1', chapters: [first], bookPatch: { totalChapterNum: 1, lastCheckTime: 123, latestChapterTitle: '第一章' }, updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.close()
    const reopened = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
    await reopened.initialize()
    assert.equal((await reopened.getTocSnapshot(bookId, edition))?.revision, 'revision-1')
    await reopened.close()
  } finally {
    await storage.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('最终正文存储使用书源与目录身份隔离，并拒绝旧写入令牌', async () => {
  const { storage, root } = await temporaryStorage()
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const identity: ContentIdentity = { sessionId: bookId, sourceId: 'https://source.test', bookUrl: 'https://source.test/book/1', chapterKey: 'chapter-1', tocRevision: 'toc-1', chapterIndex: 0, resourceKind: 'text', sourceRevision: 'fingerprint-a', semanticVersion: 'content-v1' }
  const chapter: Chapter = { sourceId: identity.sourceId, bookUrl: identity.bookUrl, chapterUrl: 'https://source.test/book/1/c1', index: 0, title: '第一章', rawFields: {}, traceRef: 'toc:0' }
  const store = storage.contentStore(bookId)
  try {
    const first = await store.reserve(identity, 'operation-1')
    const second = await store.reserve(identity, 'operation-2')
    const stale = await store.write({ token: first, record: { content: '旧正文', finalUrl: chapter.chapterUrl, chapter }, saveChapterMetadata: true })
    assert.equal(stale.status, 'stale')
    const committed = await store.write({ token: second, record: { content: '新正文', finalUrl: chapter.chapterUrl, chapter }, saveChapterMetadata: true })
    assert.equal(committed.status, 'committed')
    assert.equal((await store.read(identity))?.content, '新正文')
    const isolated = { ...identity, sourceRevision: 'fingerprint-b' }
    assert.equal(await store.read(isolated), undefined)
    await storage.close()
    const reopened = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
    await reopened.initialize()
    assert.equal((await reopened.contentStore(bookId).read(identity))?.content, '新正文')
    await reopened.close()
  } finally {
    await storage.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('缓存可读写，并按总量清理而不影响持久数据', async () => {
  const { storage, root } = await temporaryStorage()
  try {
    const cache = storage.workflowCache()
    await cache.set('source\u0000content\u0000https://source.test/c1', '一'.repeat(100))
    await cache.set('source\u0000content\u0000https://source.test/c2', '二'.repeat(100))
    const first = await cache.get('source\u0000content\u0000https://source.test/c1')
    const second = await cache.get('source\u0000content\u0000https://source.test/c2')
    assert.ok(first === undefined || second === undefined)
    await storage.close()
    assert.equal(await readFile(join(root, 'data-v1', 'manifest.json'), 'utf8').then(() => true), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('书源定义指纹隔离目录和正文缓存', async () => {
  const { storage, root } = await temporaryStorage()
  try {
    const key = 'source\u0000content\u0000https://source.test/c1'
    const first = storage.workflowCache('fingerprint-a')
    const second = storage.workflowCache('fingerprint-b')
    await first.set(key, '旧规则正文')
    await second.set(key, '新规则正文')
    assert.equal(await first.get(key), '旧规则正文')
    assert.equal(await second.get(key), '新规则正文')
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('损坏的书籍文件不会阻塞首页读取', async () => {
  const { storage, root } = await temporaryStorage()
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const bookPath = join(root, 'data-v1', 'books', bookId, 'book.json')
  try {
    await storage.upsertBook({ bookId, name: '将被损坏', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await writeFile(bookPath, '{ not-json', 'utf8')
    assert.deepEqual(await storage.listBooks(), [])
    const files = await readdir(join(root, 'data-v1', 'books', bookId))
    assert.ok(files.some((item) => item.startsWith('book.json.corrupt-')))
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('缓存索引路径校验不会删除缓存目录外的文件', async () => {
  const { storage, root } = await temporaryStorage()
  const manifestPath = join(root, 'data-v1', 'manifest.json')
  try {
    await storage.close()
    const indexPath = join(root, 'cache-v1', 'index.json')
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z', data: { entries: [{ relativePath: '../data-v1/manifest.json', category: 'content', bytes: 999999, lastAccessedAt: '2026-01-01T00:00:00.000Z' }] } }), 'utf8')
    const reopened = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') }, maxCacheBytes: 1 })
    await reopened.initialize()
    await reopened.workflowCache().set('source\u0000content\u0000https://source.test/c1', '缓存')
    await reopened.close()
    assert.equal(await readFile(manifestPath, 'utf8').then(() => true), true)
  } finally {
    await storage.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
