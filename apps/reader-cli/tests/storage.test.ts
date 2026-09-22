import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultStoragePaths, normalizeSearchName, ReaderStorage, editionKey } from '../src/storage.ts'

async function temporaryStorage(): Promise<{ storage: ReaderStorage; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') }, maxCacheBytes: 128 })
  await storage.initialize()
  return { storage, root }
}

test('默认缓存目录位于用户配置目录', () => {
  const home = '/tmp/reader-cli-test-home'
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const paths = defaultStoragePaths(platform, { HOME: home, LOCALAPPDATA: '/tmp/local-app-data', XDG_STATE_HOME: '/tmp/state', XDG_CACHE_HOME: '/tmp/cache' })
    assert.equal(paths.dataRoot, join(home, '.config', 'reader-cli', 'data-v1'))
    assert.equal(paths.cacheRoot, join(home, '.config', 'reader-cli', 'cache-v1'))
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
