import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BookCandidate, BookMetadata, Chapter, ChapterContent, NormalizedSource, RuntimeResult, WorkflowPage } from '@legado/source-core'
import { ReaderApplication } from '../src/application.ts'
import type { SearchOperationResult } from '../src/application.ts'
import type { ReaderSourceSession } from '../src/application.ts'
import type { SourceCatalogResult, SourceEntry } from '../src/source-catalog.ts'
import { ReaderStorage, editionKey } from '../src/storage.ts'

function source(url = 'https://source.test', name = '测试书源'): NormalizedSource {
  return { bookSourceUrl: url, bookSourceName: name, bookSourceType: 0, enabled: true, ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }
}

function entry(value: NormalizedSource, index = 0): SourceEntry {
  const fingerprint = `fingerprint-${index}`
  const candidate = { id: `source-${index}`, sourceUuid: `uuid-${index}`, origin: { kind: 'text' as const }, rawText: JSON.stringify(value), raw: { rawText: JSON.stringify(value), kind: 'json' as const, origin: { kind: 'text' as const }, parsed: value, unknownFields: {}, fieldShapes: {} }, source: value, unknownFields: {}, replacements: [], diagnostics: [], writable: true, status: 'ready' as const, sourceFingerprint: fingerprint }
  return { id: `${value.bookSourceUrl}\u0000${fingerprint}`, source: value, candidate, fingerprint, state: 'available' }
}

function result<T>(status: 'success' | 'failed' | 'capability-missing' | 'cancelled', value: T | null): RuntimeResult<T> {
  return { status, value, diagnostics: [], trace: [] }
}

class FakeSession implements ReaderSourceSession {
  private readonly candidates: BookCandidate[]
  private readonly delayMs: number
  private readonly failDetail: boolean

  public constructor(candidates: BookCandidate[], delayMs = 0, failDetail = false) {
    this.candidates = candidates
    this.delayMs = delayMs
    this.failDetail = failDetail
  }

  public attachCache(): void {}

  public async search(_keyword: string, signal?: AbortSignal): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
    if (signal?.aborted) return result<WorkflowPage<BookCandidate>>('cancelled', null)
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs))
    if (signal?.aborted) return result<WorkflowPage<BookCandidate>>('cancelled', null)
    return result('success', { items: this.candidates, cursor: { index: 0 } })
  }

  public async detail(_candidate: BookCandidate): Promise<RuntimeResult<WorkflowPage<BookMetadata>>> {
    if (this.failDetail) throw new Error('详情请求失败')
    return result<WorkflowPage<BookMetadata>>('capability-missing', null)
  }

  public async toc(_book: BookMetadata): Promise<RuntimeResult<WorkflowPage<Chapter>>> {
    return result<WorkflowPage<Chapter>>('failed', null)
  }

  public async content(_chapter: Chapter, _book: BookMetadata): Promise<RuntimeResult<ChapterContent>> {
    return result<ChapterContent>('failed', null)
  }
}

test('已知书源页面读取本地候选，不触发搜索', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-app-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source())
  const catalog: SourceCatalogResult = { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }
  const application = new ReaderApplication({ catalog, storage })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const edition = editionKey(sourceEntry.source.bookSourceUrl, 'https://source.test/book/1')
  try {
    await storage.upsertBook({ bookId, name: '测试书', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl: 'https://source.test/book/1', name: '测试书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const sources = await application.knownSources(bookId)
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.state, 'available')
    await storage.saveReadingPosition({ bookId, position: { editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/book/1', chapterUrl: 'https://source.test/book/1/c1', index: 0, title: '第一章', paragraphIndex: 2, offset: 3, lastReadAt: '2026-01-02T00:00:00.000Z' } })
    const opened = await application.openStoredBook(bookId)
    assert.equal(opened.reading?.positions[edition]?.chapterUrl, 'https://source.test/book/1/c1')
    assert.equal(typeof opened.reading?.lastOpenedAt, 'string')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('来源目录存在同一 sourceId 的冲突定义时保留冲突状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-source-conflict-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/conflict', '冲突书源 A'), 0)
  const second = entry(source('https://source.test/conflict', '冲突书源 B'), 1)
  first.state = 'conflict'
  second.state = 'conflict'
  const application = new ReaderApplication({ catalog: { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  try {
    await storage.upsertBook({ bookId, name: '冲突书', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: editionKey(first.source.bookSourceUrl, 'https://source.test/conflict/book'), sourceId: first.source.bookSourceUrl, sourceFingerprint: first.fingerprint, bookUrl: 'https://source.test/conflict/book', name: '冲突书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    assert.equal((await application.knownSources(bookId))[0]?.state, 'conflict')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('搜索进度包含书源总数、已完成数和当前书源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-progress-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/one', '第一个书源'), 0)
  const second = entry(source('https://source.test/two', '第二个书源'), 1)
  const progress: Array<{ total: number; completed: number; active: string[] }> = []
  const application = new ReaderApplication({ catalog: { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: (value) => new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '测试书', rawFields: {}, traceRef: 'fake' }]) })
  try {
    const operation = await application.search('测试书', undefined, undefined, (item) => progress.push({ total: item.total, completed: item.completed, active: item.activeSources }))
    assert.equal(operation.results.length, 2)
    assert.equal(progress.at(-1)?.total, 2)
    assert.equal(progress.at(-1)?.completed, 2)
    assert.ok(progress.some((item) => item.active.includes('第一个书源') || item.active.includes('第二个书源')))
    const opened = await application.openSearchResult(operation.results[0]!, operation.results)
    assert.equal((await storage.listSearchHistory())[0]?.openedBookIds.includes(opened.book.bookId), true)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('手动搜索更多书源会合并匹配书源到本地记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-more-sources-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/one', '第一个书源'), 0)
  const second = entry(source('https://source.test/two', '第二个书源'), 1)
  const catalog: SourceCatalogResult = { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }
  const application = new ReaderApplication({ catalog, storage, sessionFactory: (value) => new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '测试书', author: '作者', rawFields: {}, traceRef: 'fake' }]) })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const firstUrl = 'https://source.test/one/book'
  try {
    await storage.upsertBook({ bookId, name: '测试书', author: '作者', activeEditionKey: editionKey(first.source.bookSourceUrl, firstUrl), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: editionKey(first.source.bookSourceUrl, firstUrl), sourceId: first.source.bookSourceUrl, sourceFingerprint: first.fingerprint, bookUrl: firstUrl, name: '测试书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const operation = await application.searchMoreSources(bookId)
    assert.equal(operation.results.length, 1)
    const known = await storage.listKnownSources(bookId)
    assert.equal(known.length, 2)
    assert.equal(known.some((item) => item.sourceId === second.source.bookSourceUrl), true)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('取消搜索后返回已取消结果且不会遗留活动请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-cancel-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source(), 0)
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: (value) => new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '测试书', rawFields: {}, traceRef: 'fake' }], 50) })
  const controller = new AbortController()
  try {
    const pending = application.search('测试书', undefined, controller.signal)
    setTimeout(() => controller.abort(), 5)
    const operation = await pending
    assert.equal(operation.cancelled, true)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('缺少候选书名时不会把不同书源候选错误合并', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-empty-title-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/one', '第一个书源'), 0)
  const second = entry(source('https://source.test/two', '第二个书源'), 1)
  const application = new ReaderApplication({ catalog: { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: (_value) => new FakeSession([]) })
  try {
    const selected = { candidate: { sourceId: first.source.bookSourceUrl, bookUrl: 'https://source.test/one/book', rawFields: {}, traceRef: 'selected' }, source: first, searchId: 'search-1', arrivalIndex: 0 }
    const related = { candidate: { sourceId: second.source.bookSourceUrl, bookUrl: 'https://source.test/two/book', rawFields: {}, traceRef: 'related' }, source: second, searchId: 'search-1', arrivalIndex: 1 }
    const opened = await application.openSearchResult(selected, [selected, related])
    assert.equal(opened.sources.length, 1)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('详情请求失败时不会提交孤儿书籍和书源记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-detail-failure-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source(), 0)
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => new FakeSession([], 0, true) })
  try {
    const selected = { candidate: { sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/book/failure', name: '失败书', rawFields: {}, traceRef: 'selected' }, source: sourceEntry, searchId: 'search-1', arrivalIndex: 0 }
    await assert.rejects(() => application.openSearchResult(selected), /详情请求失败/)
    assert.deepEqual(await storage.listBooks(), [])
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('搜索快照按书源完成顺序发布并按匹配等级稳定排序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-ranking-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/slow', '慢书源'), 0)
  const second = entry(source('https://source.test/fast', '快书源'), 1)
  const snapshots: SearchOperationResult[] = []
  const application = new ReaderApplication({
    catalog: { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false },
    storage,
    sessionFactory: (value) => value.bookSourceUrl.includes('slow')
      ? new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/other`, name: '其他结果', author: '作者', rawFields: {}, traceRef: 'other' }], 25)
      : new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/exact`, name: '测试书', author: '作者', rawFields: {}, traceRef: 'exact' }, { sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/contains`, name: '测试书：续集', author: '作者', rawFields: {}, traceRef: 'contains' }]),
  })
  try {
    const operation = await application.search('测试书', undefined, undefined, undefined, (snapshot) => snapshots.push(snapshot))
    assert.ok(snapshots.length >= 3)
    const early = snapshots.find((snapshot) => snapshot.results.length > 0 && snapshot.sources.length === 1)
    assert.notEqual(early, undefined)
    assert.notEqual(early?.results[0]?.searchId, operation.searchId)
    assert.deepEqual(operation.groups.map((group) => group.rank), ['exact', 'contains', 'other'])
    assert.equal(operation.groups[0]?.source.source.bookSourceName, '快书源')
    assert.ok(operation.sources.every((item) => item.durationMs >= 0))
    assert.ok(operation.elapsedMs >= 0)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('换源搜索只接受书名和作者完整匹配的候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-source-match-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/one', '第一个书源'), 0)
  const second = entry(source('https://source.test/two', '第二个书源'), 1)
  const catalog: SourceCatalogResult = { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }
  const application = new ReaderApplication({ catalog, storage, sessionFactory: (value) => new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '测试书', author: value.bookSourceUrl.includes('/two') ? '其他作者' : '作者', rawFields: {}, traceRef: 'fake' }]) })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const firstUrl = 'https://source.test/one/book'
  try {
    await storage.upsertBook({ bookId, name: '测试书', author: '作者', activeEditionKey: editionKey(first.source.bookSourceUrl, firstUrl), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: editionKey(first.source.bookSourceUrl, firstUrl), sourceId: first.source.bookSourceUrl, sourceFingerprint: first.fingerprint, bookUrl: firstUrl, name: '测试书', author: '作者', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const updates: SearchOperationResult[] = []
    const result = await application.searchMoreSources(bookId, undefined, undefined, (snapshot) => updates.push(snapshot))
    assert.equal(result.results.length, 0)
    assert.equal(updates.at(-1)?.results.length, 0)
    assert.equal((await storage.listKnownSources(bookId)).length, 1)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
