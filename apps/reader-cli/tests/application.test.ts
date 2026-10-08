import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BookCandidate, BookMetadata, Chapter, ChapterContent, ContentIdentity, ContentStore, NormalizedSource, RuntimeResult, TocPage, WorkflowPage } from '@legado/source-core'
import { ReaderApplication } from '../src/application.ts'
import type { SearchOperationResult } from '../src/application.ts'
import type { ReaderSourceSearchOptions, ReaderSourceSession } from '../src/application.ts'
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
  private readonly contentValue: ChapterContent | undefined
  private readonly onSearch: (() => void) | undefined
  private readonly onSearchFinish: (() => void) | undefined
  private readonly tocValue: RuntimeResult<TocPage> | undefined
  public readonly contentRefreshes: boolean[] = []
  public readonly tocRefreshes: boolean[] = []
  public readonly contentNextChapterUrls: Array<string | undefined> = []
  public readonly contentBooks: BookMetadata[] = []
  public readonly tocBooks: BookMetadata[] = []
  public readonly contentIdentities: ContentIdentity[] = []
  public readonly contentStoreAttached: boolean[] = []
  public readonly searchOptions: ReaderSourceSearchOptions[] = []
  public closed = false

  public constructor(candidates: BookCandidate[], delayMs = 0, failDetail = false, contentValue?: ChapterContent, onSearch?: () => void, onSearchFinish?: () => void, tocValue?: RuntimeResult<TocPage>) {
    this.candidates = candidates
    this.delayMs = delayMs
    this.failDetail = failDetail
    this.contentValue = contentValue
    this.onSearch = onSearch
    this.onSearchFinish = onSearchFinish
    this.tocValue = tocValue
  }

  public attachCache(): void {}

  public close(): void {
    this.closed = true
  }

  public async search(keyword: string, signal?: AbortSignal, _capture?: unknown, options?: ReaderSourceSearchOptions): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
    this.onSearch?.()
    this.searchOptions.push(options ?? {})
    try {
      if (signal?.aborted) return result<WorkflowPage<BookCandidate>>('cancelled', null)
      if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs))
      if (signal?.aborted) return result<WorkflowPage<BookCandidate>>('cancelled', null)
      const candidates = options?.precision === true
        ? this.candidates.filter((candidate) => candidate.name?.includes(keyword) === true || candidate.author?.includes(keyword) === true || candidate.kind?.includes(keyword) === true)
        : this.candidates
      return result('success', { items: candidates, cursor: { index: 0 } })
    } finally {
      this.onSearchFinish?.()
    }
  }

  public async detail(_candidate: BookCandidate): Promise<RuntimeResult<WorkflowPage<BookMetadata>>> {
    if (this.failDetail) throw new Error('详情请求失败')
    return result<WorkflowPage<BookMetadata>>('capability-missing', null)
  }

  public async toc(_book: BookMetadata, _signal?: AbortSignal, options?: { refresh?: boolean }): Promise<RuntimeResult<TocPage>> {
    this.tocBooks.push(_book)
    this.tocRefreshes.push(options?.refresh === true)
    return this.tocValue ?? result<WorkflowPage<Chapter>>('failed', null)
  }

  public async content(chapter: Chapter, _book: BookMetadata, _signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string; contentStore?: ContentStore; contentIdentity?: ContentIdentity }): Promise<RuntimeResult<ChapterContent>> {
    this.contentRefreshes.push(options?.refresh === true)
    this.contentNextChapterUrls.push(options?.nextChapterUrl)
    this.contentBooks.push(_book)
    if (options?.contentIdentity !== undefined) this.contentIdentities.push(options.contentIdentity)
    this.contentStoreAttached.push(options?.contentStore !== undefined)
    if (this.contentValue === undefined) return result<ChapterContent>('failed', null)
    return result('success', { ...this.contentValue, chapter })
  }
}

class PagingSession extends FakeSession {
  private readonly pages: BookCandidate[][]

  public constructor(pages: BookCandidate[][]) {
    super([])
    this.pages = pages
  }

  public override async search(_keyword: string, signal?: AbortSignal, _capture?: unknown, options?: ReaderSourceSearchOptions): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
    this.searchOptions.push(options ?? {})
    if (signal?.aborted === true) return result<WorkflowPage<BookCandidate>>('cancelled', null)
    const index = options?.cursor?.index ?? 1
    const items = this.pages[index - 1] ?? []
    return result('success', { items, cursor: { index }, ...(index < this.pages.length ? { nextCursor: { index: index + 1 } } : {}) })
  }
}

test('已知书源页面读取本地候选，不触发搜索', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-app-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source())
  const previousSourceEntry = entry(source('https://source.test/previous', '原书源'), 1)
  const catalog: SourceCatalogResult = { entries: [sourceEntry, previousSourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }
  const application = new ReaderApplication({ catalog, storage })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const edition = editionKey(sourceEntry.source.bookSourceUrl, 'https://source.test/book/1')
  const previousEdition = editionKey(previousSourceEntry.source.bookSourceUrl, 'https://source.test/previous/book/1')
  try {
    await storage.upsertBook({ bookId, name: '旧书名', activeEditionKey: previousEdition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [
      { editionKey: previousEdition, sourceId: previousSourceEntry.source.bookSourceUrl, sourceFingerprint: previousSourceEntry.fingerprint, bookUrl: 'https://source.test/previous/book/1', name: '旧书名', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'title-only' },
      { editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl: 'https://source.test/book/1', name: '测试书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' },
    ])
    const sources = await application.knownSources(bookId)
    assert.equal(sources.length, 2)
    assert.ok(sources.every((item) => item.state === 'available'))
    await storage.saveReadingPosition({ bookId, position: { editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/book/1', chapterUrl: 'https://source.test/book/1/c1', index: 0, title: '第一章', paragraphIndex: 2, offset: 3, lastReadAt: '2026-01-02T00:00:00.000Z' } })
    const opened = await application.openStoredBook(bookId)
    assert.equal(opened.reading?.positions[edition]?.chapterUrl, 'https://source.test/book/1/c1')
    assert.equal(opened.reading?.activeEditionKey, edition)
    assert.equal(typeof opened.reading?.lastOpenedAt, 'string')
    assert.equal(opened.book.activeEditionKey, edition)
    assert.equal(opened.book.name, '测试书')
    assert.equal(opened.source.source.bookSourceUrl, sourceEntry.source.bookSourceUrl)
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

test('已禁用或不支持的来源不会把缓存候选标成可用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-source-state-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/disabled'), 0)
  sourceEntry.state = 'disabled'
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  try {
    await storage.upsertBook({ bookId, name: '缓存书', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: editionKey(sourceEntry.source.bookSourceUrl, 'https://source.test/disabled/book'), sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl: 'https://source.test/disabled/book', name: '缓存书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const view = await application.knownSources(bookId)
    assert.equal(view[0]?.state, 'stale')
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

test('精准搜索把 Android 的名称、作者和分类包含过滤传到书源，并丢弃其他结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-precision-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/precision'), 0)
  const session = new FakeSession([
    { sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/precision/match', name: '目标书', author: '作者', rawFields: {}, traceRef: 'match' },
    { sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/precision/other', name: '无关书', author: '其他', kind: '其他', rawFields: {}, traceRef: 'other' },
  ])
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    const operation = await application.search('目标', undefined, undefined, undefined, undefined, { precision: true })
    assert.equal(operation.precision, true)
    assert.deepEqual(operation.results.map((item) => item.candidate.name), ['目标书'])
    assert.deepEqual(operation.groups.map((item) => item.candidate.name), ['目标书'])
    assert.equal(session.searchOptions[0]?.precision, true)
    assert.equal(session.searchOptions[0]?.budget?.timeoutMs, 30_000)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('搜索书籍变量按书源版本保存并在正文入口恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-variable-handoff-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/variable'), 0)
  const candidate: BookCandidate = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/variable/book', name: '变量书', variable: '{"token":"from-search"}', rawFields: {}, traceRef: 'variable' }
  const chapter: Chapter = { sourceId: candidate.sourceId, bookUrl: candidate.bookUrl, chapterUrl: `${candidate.bookUrl}/c1`, index: 0, title: '第一章', rawFields: {}, traceRef: 'chapter' }
  const session = new FakeSession([candidate], 0, false, { chapter, contentType: 'text', raw: '正文', cleaned: '正文', pages: ['正文'], resources: [] })
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    const operation = await application.search('变量书')
    const opened = await application.openSearchResult(operation.results[0]!)
    const edition = editionKey(sourceEntry.source.bookSourceUrl, candidate.bookUrl)
    assert.equal((await storage.listKnownSources(opened.book.bookId)).find((item) => item.editionKey === edition)?.variable, candidate.variable)
    await application.loadContent(opened.book.bookId, chapter, edition)
    assert.equal(session.contentBooks.at(-1)?.variable, candidate.variable)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('搜索续页复用同一 searchId，按书源游标追加结果并只保留一条历史', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-search-pagination-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/pagination'), 0)
  const session = new PagingSession([
    [{ sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/pagination/one', name: '页一', rawFields: {}, traceRef: 'page-1' }],
    [{ sourceId: sourceEntry.source.bookSourceUrl, bookUrl: 'https://source.test/pagination/two', name: '页二', rawFields: {}, traceRef: 'page-2' }],
  ])
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    const first = await application.search('页')
    assert.equal(first.page, 1)
    assert.equal(first.hasMore, true)
    assert.equal(first.sources[0]?.nextCursor?.index, 2)
    const second = await application.searchNext(first)
    assert.equal(second.searchId, first.searchId)
    assert.equal(second.page, 2)
    assert.equal(second.hasMore, false)
    assert.deepEqual(second.results.map((item) => item.candidate.name), ['页一', '页二'])
    assert.ok(second.results.every((item) => item.searchId === first.searchId))
    assert.deepEqual(session.searchOptions.map((item) => item.cursor?.index), [undefined, 2])
    const history = await storage.listSearchHistory()
    assert.equal(history.length, 1)
    assert.equal(history[0]?.summary.candidates, 2)
    assert.equal(await application.searchNext(second), second)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('单个书源搜索超时按失败记录，且不把超时误报为用户取消', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-search-timeout-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/timeout'), 0)
  const application = new ReaderApplication({
    catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false },
    storage,
    sourceSearchTimeoutMs: 10,
    sessionFactory: (value) => new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '慢书', rawFields: {}, traceRef: 'slow' }], 40),
  })
  try {
    const operation = await application.search('慢书')
    assert.equal(operation.cancelled, false)
    assert.equal(operation.sources[0]?.status, 'failed')
    assert.equal(operation.sources[0]?.message, '书源搜索超时')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('搜索并发设置按批次限制 worker，并可持久化更新', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-settings-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const entries = Array.from({ length: 4 }, (_, index) => entry(source(`https://source.test/settings-${index}`, `设置书源 ${index}`), index))
  let active = 0
  let maxActive = 0
  const application = new ReaderApplication({
    catalog: { entries, diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false },
    storage,
    settings: { searchConcurrency: 2, sourceSearchConcurrency: 1, sourceCheckConcurrency: 1 },
    sessionFactory: (value) => new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '测试书', rawFields: {}, traceRef: 'settings' }], 15, false, undefined, () => {
      active += 1
      maxActive = Math.max(maxActive, active)
    }, () => { active -= 1 }),
  })
  try {
    await application.search('测试书')
    assert.equal(maxActive, 2)
    await application.saveReaderSettings({ searchConcurrency: 1, sourceSearchConcurrency: 3, sourceCheckConcurrency: 5 })
    assert.deepEqual(application.readerSettings, { searchConcurrency: 1, sourceSearchConcurrency: 3, sourceCheckConcurrency: 5 })
    maxActive = 0
    await application.search('测试书')
    assert.equal(maxActive, 1)
    assert.deepEqual(await storage.getReaderSettings(), application.readerSettings)
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

test('刷新正文会把刷新选项传到当前书源并重新请求正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-refresh-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/refresh'), 0)
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const bookUrl = 'https://source.test/refresh/book'
  const edition = editionKey(sourceEntry.source.bookSourceUrl, bookUrl)
  const chapter: Chapter = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl, chapterUrl: `${bookUrl}/c1`, index: 0, title: '第一章', rawFields: {}, traceRef: 'fixture' }
  const session = new FakeSession([], 0, false, { chapter, contentType: 'text', raw: '正文', cleaned: '正文', pages: ['正文'], resources: [] })
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    await storage.upsertBook({ bookId, name: '刷新书', activeEditionKey: edition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl, name: '刷新书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    await application.loadContent(bookId, chapter, edition, undefined, { refresh: true })
    await application.loadContent(bookId, chapter, edition)
    assert.deepEqual(session.contentRefreshes, [true, false])
    assert.equal(session.contentStoreAttached.every(Boolean), true)
    assert.equal(session.contentIdentities[0]?.sourceRevision, sourceEntry.fingerprint)
    assert.equal(session.contentIdentities[0]?.chapterIndex, 0)
    await application.close()
    assert.equal(session.closed, true)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('正文入口未显式传下一章时从目录快照提供护栏并在末章回到首章', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-next-chapter-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/next-chapter'), 0)
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const bookUrl = 'https://source.test/next-chapter/book'
  const edition = editionKey(sourceEntry.source.bookSourceUrl, bookUrl)
  const first: Chapter = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl, url: '/c1', chapterUrl: `${bookUrl}/c1`, index: 0, title: '第一章', rawFields: {}, traceRef: 'fixture' }
  const second: Chapter = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl, url: '/c2', chapterUrl: `${bookUrl}/c2`, index: 1, title: '第二章', rawFields: {}, traceRef: 'fixture' }
  const session = new FakeSession([], 0, false, { chapter: first, contentType: 'text', raw: '正文', cleaned: '正文', pages: ['正文'], resources: [] })
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    await storage.upsertBook({ bookId, name: '下一章书', activeEditionKey: edition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl, name: '下一章书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    await storage.saveTocSnapshot(bookId, edition, { editionKey: edition, revision: 'toc-next', chapters: [first, second], bookPatch: { totalChapterNum: 2, lastCheckTime: 0 }, updatedAt: '2026-01-01T00:00:00.000Z' })
    await application.loadContent(bookId, first, edition)
    await application.loadContent(bookId, second, edition)
    await application.loadContent(bookId, first, edition, undefined, { nextChapterUrl: 'https://override.test/chapter' })
    assert.deepEqual(session.contentNextChapterUrls, [second.url, first.url, 'https://override.test/chapter'])
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('目录缓存命中且手动刷新仍通过 source-core reconcile 并持久化书源版本快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-toc-snapshot-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/toc-snapshot'), 0)
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const bookUrl = 'https://source.test/toc-snapshot/book'
  const edition = editionKey(sourceEntry.source.bookSourceUrl, bookUrl)
  const first: Chapter = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl, chapterUrl: `${bookUrl}/c1`, index: 0, title: '第一章', rawFields: {}, traceRef: 'fixture' }
  const session = new FakeSession([], 0, false, undefined, undefined, undefined, result('success', { items: [first], cursor: { index: 0 } }))
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    await storage.upsertBook({ bookId, name: '目录书', activeEditionKey: edition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl, name: '目录书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const firstLoad = await application.loadToc(bookId, edition)
    assert.equal(firstLoad.bookPatch.totalChapterNum, 1)
    assert.deepEqual(firstLoad.changes.map((item) => item.kind), ['added'])
    assert.equal((await storage.getTocSnapshot(bookId, edition))?.revision, firstLoad.revision)
    const secondLoad = await application.loadToc(bookId, edition)
    assert.deepEqual(secondLoad.changes, [])
    assert.equal(secondLoad.bookPatch.lastCheckCount, firstLoad.bookPatch.lastCheckCount)
    assert.deepEqual(session.tocRefreshes, [false])
    const refreshed = await application.loadToc(bookId, edition, undefined, { refresh: true })
    assert.deepEqual(refreshed.changes, [])
    assert.deepEqual(session.tocRefreshes, [false, true])
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('目录缓存只写入当前活动书源，其他书源仅临时预览', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-toc-active-source-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const currentEntry = entry(source('https://source.test/current'), 0)
  const previewEntry = entry(source('https://source.test/preview'), 1)
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const currentUrl = 'https://source.test/current/book'
  const previewUrl = 'https://source.test/preview/book'
  const currentEdition = editionKey(currentEntry.source.bookSourceUrl, currentUrl)
  const previewEdition = editionKey(previewEntry.source.bookSourceUrl, previewUrl)
  const currentChapter: Chapter = { sourceId: currentEntry.source.bookSourceUrl, bookUrl: currentUrl, chapterUrl: `${currentUrl}/c1`, index: 0, title: '当前章节', rawFields: {}, traceRef: 'fixture' }
  const previewChapter: Chapter = { sourceId: previewEntry.source.bookSourceUrl, bookUrl: previewUrl, chapterUrl: `${previewUrl}/c1`, index: 0, title: '预览章节', rawFields: {}, traceRef: 'fixture' }
  const currentSession = new FakeSession([], 0, false, undefined, undefined, undefined, result('success', { items: [currentChapter], cursor: { index: 0 } }))
  const previewSession = new FakeSession([], 0, false, undefined, undefined, undefined, result('success', { items: [previewChapter], cursor: { index: 0 } }))
  const application = new ReaderApplication({
    catalog: { entries: [currentEntry, previewEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false },
    storage,
    sessionFactory: (value) => value.bookSourceUrl === currentEntry.source.bookSourceUrl ? currentSession : previewSession,
  })
  try {
    await storage.upsertBook({ bookId, name: '当前书', activeEditionKey: currentEdition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [
      { editionKey: currentEdition, sourceId: currentEntry.source.bookSourceUrl, sourceFingerprint: currentEntry.fingerprint, bookUrl: currentUrl, name: '当前书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' },
      { editionKey: previewEdition, sourceId: previewEntry.source.bookSourceUrl, sourceFingerprint: previewEntry.fingerprint, bookUrl: previewUrl, name: '当前书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'title-author' },
    ])
    await application.loadToc(bookId, currentEdition)
    await application.loadToc(bookId, previewEdition)
    await application.loadToc(bookId, previewEdition)
    assert.equal((await storage.getTocSnapshot(bookId, currentEdition))?.sourceFingerprint, currentEntry.fingerprint)
    assert.equal(await storage.getTocSnapshot(bookId, previewEdition), undefined)
    assert.deepEqual(previewSession.tocRefreshes, [false, false])
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('目录刷新后的 bookAfter 按书源版本快照交给正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-book-after-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const sourceEntry = entry(source('https://source.test/book-after'), 0)
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const bookUrl = 'https://source.test/book-after/book'
  const effectiveBookUrl = 'https://source.test/book-after/new-book'
  const edition = editionKey(sourceEntry.source.bookSourceUrl, bookUrl)
  const chapter: Chapter = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl: effectiveBookUrl, chapterUrl: `${effectiveBookUrl}/c1`, index: 0, title: '第一章', rawFields: {}, traceRef: 'fixture' }
  const bookAfter: BookMetadata = { sourceId: sourceEntry.source.bookSourceUrl, bookUrl: effectiveBookUrl, tocUrl: `${effectiveBookUrl}/toc`, name: '更新书', variable: '{"chapterToken":"new"}', rawFields: { marker: 'new' }, traceRef: 'book-after', emptyFields: [], fieldErrors: {} }
  const session = new FakeSession([], 0, false, { chapter, contentType: 'text', raw: '正文', cleaned: '正文', pages: ['正文'], resources: [] }, undefined, undefined, result('success', { items: [chapter], cursor: { index: 0 }, bookAfter }))
  const application = new ReaderApplication({ catalog: { entries: [sourceEntry], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }, storage, sessionFactory: () => session })
  try {
    await storage.upsertBook({ bookId, name: '旧书', activeEditionKey: edition, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: edition, sourceId: sourceEntry.source.bookSourceUrl, sourceFingerprint: sourceEntry.fingerprint, bookUrl, name: '旧书', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const toc = await application.loadToc(bookId, edition)
    assert.equal(toc.bookAfter?.bookUrl, effectiveBookUrl)
    const snapshot = await storage.getTocSnapshot(bookId, edition)
    assert.equal(snapshot?.bookAfter?.variable, bookAfter.variable)
    const cached = await application.loadToc(bookId, edition)
    assert.equal(cached.bookAfter?.bookUrl, effectiveBookUrl)
    assert.equal(cached.bookAfter?.variable, bookAfter.variable)
    await application.loadContent(bookId, chapter, edition)
    await application.loadContent(bookId, chapter)
    assert.equal(session.contentBooks.at(-1)?.bookUrl, effectiveBookUrl)
    assert.equal(session.contentBooks.at(-1)?.variable, bookAfter.variable)
    assert.equal(session.contentIdentities.at(-1)?.bookUrl, effectiveBookUrl)
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

test('取消换源搜索仍保留已经返回的严格匹配书源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-source-cancel-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://source.test/one', '第一个书源'), 0)
  const second = entry(source('https://source.test/two', '第二个书源'), 1)
  const third = entry(source('https://source.test/three', '第三个书源'), 2)
  const catalog: SourceCatalogResult = { entries: [first, second, third], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }
  const controller = new AbortController()
  const application = new ReaderApplication({
    catalog,
    storage,
    maxConcurrentSources: 1,
    sessionFactory: (value) => value.bookSourceUrl.includes('/three')
      ? new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '其他书', author: '其他作者', rawFields: {}, traceRef: 'slow' }], 80, false, undefined, () => controller.abort())
      : new FakeSession([{ sourceId: value.bookSourceUrl, bookUrl: `${value.bookSourceUrl}/book`, name: '测试书', author: '作者', rawFields: {}, traceRef: 'match' }]),
  })
  const bookId = '2f1c6ad2-4ad7-4e0f-8b7d-0033cfb8c4d1'
  const firstUrl = 'https://source.test/one/book'
  try {
    await storage.upsertBook({ bookId, name: '测试书', author: '作者', activeEditionKey: editionKey(first.source.bookSourceUrl, firstUrl), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    await storage.mergeKnownSources(bookId, [{ editionKey: editionKey(first.source.bookSourceUrl, firstUrl), sourceId: first.source.bookSourceUrl, sourceFingerprint: first.fingerprint, bookUrl: firstUrl, name: '测试书', author: '作者', rawFields: {}, discoveredAt: '2026-01-01T00:00:00.000Z', matchKind: 'selected' }])
    const pending = application.searchMoreSources(bookId, controller.signal)
    const result = await pending
    assert.equal(result.cancelled, true)
    assert.equal(result.results.length, 1)
    assert.equal((await storage.listKnownSources(bookId)).length, 2)
    assert.equal((await storage.listKnownSources(bookId)).some((item) => item.sourceId === second.source.bookSourceUrl), true)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
