import { randomUUID } from 'node:crypto'
import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks, sourceDefinitionFingerprint } from '@legado/source-core'
import type { BookCandidate, BookMetadata, Chapter, ChapterContent, ContentCache, NormalizedSource, WorkflowPorts, WorkflowStatus } from '@legado/source-core'
import { KeyedConcurrencyHost, NodeCookieStore, NodeNetworkHost, SourceRequestHost, SourceRuleHost } from '@legado/source-node'
import type { SourceEntry, SourceCatalogResult } from './source-catalog.ts'
import { usableSources } from './source-catalog.ts'
import { editionKey, ReaderStorage } from './storage.ts'
import type { BookDocument, KnownSource, KnownSourceView, ReadingPosition, ReadingRecord, SearchHistoryEntry } from './storage.ts'

export interface SearchResult {
  candidate: BookCandidate
  source: SourceEntry
  searchId: string
  /** 全局搜索返回顺序，用于同一匹配等级下保持稳定排序。 */
  arrivalIndex: number
  /** 候选所属书源本次搜索耗时，单位毫秒。 */
  searchDurationMs?: number
}

export interface SourceSearchResult {
  source: SourceEntry
  status: WorkflowStatus
  candidates: SearchResult[]
  /** 从该书源真正开始执行请求到返回终态的耗时，单位毫秒。 */
  durationMs: number
  message?: string
}

export type SearchMatchRank = 'exact' | 'contains' | 'other'

export interface SearchResultGroup {
  key: string
  candidate: BookCandidate
  source: SourceEntry
  candidates: SearchResult[]
  rank: SearchMatchRank
  firstArrivalIndex: number
}

export interface SearchOperationResult {
  searchId: string
  keyword: string
  results: SearchResult[]
  sources: SourceSearchResult[]
  groups: SearchResultGroup[]
  elapsedMs: number
  startedAt: string
  completedAt: string
  cancelled: boolean
}

export type SearchUpdateListener = (snapshot: SearchOperationResult) => void

export interface SearchProgress {
  total: number
  completed: number
  activeSources: string[]
  candidates: number
  elapsedMs: number
  success: number
  partial: number
  empty: number
  failed: number
  capabilityMissing: number
  cancelled: number
}

export type SearchProgressListener = (progress: SearchProgress) => void

export interface OpenBookResult {
  book: BookDocument
  source: SourceEntry
  metadata?: BookMetadata
  sources: KnownSource[]
  onBookshelf: boolean
  reading?: ReadingRecord
}

export interface TocResult {
  chapters: Chapter[]
  revision: string
  source: SourceEntry
  edition: KnownSource
}

export interface ReaderApplicationOptions {
  catalog: SourceCatalogResult
  storage: ReaderStorage
  maxConcurrentSources?: number
  sessionFactory?: (source: NormalizedSource) => ReaderSourceSession
}

export interface ReaderSourceSession {
  search(keyword: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof searchBooks>>>
  detail(candidate: BookCandidate, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadBookDetails>>>
  toc(book: BookMetadata, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadTableOfContents>>>
  content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean }): Promise<Awaited<ReturnType<typeof loadChapterContent>>>
  attachCache(storage: ReaderStorage): void
}

interface TrackedOperation {
  controller: AbortController
  promise: Promise<unknown>
}

class SourceSession implements ReaderSourceSession {
  private readonly source: NormalizedSource
  private readonly cookieStore: NodeCookieStore
  private readonly network: NodeNetworkHost

  public constructor(source: NormalizedSource) {
    this.source = source
    this.cookieStore = new NodeCookieStore()
    this.network = new NodeNetworkHost({ cookieStore: this.cookieStore })
  }

  public async search(keyword: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof searchBooks>>> {
    const operation = this.createOperation()
    operation.rules.setBindings({ key: keyword })
    return searchBooks(operation.ports, { source: this.source, keyword, ...(signal === undefined ? {} : { signal }), maxItems: 100 })
  }

  public async detail(candidate: BookCandidate, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadBookDetails>>> {
    this.tocPage = undefined
    const operation = this.createOperation()
    operation.rules.setBindings({ key: candidate.name ?? '', book: candidate })
    const result = await loadBookDetails(operation.ports, { source: this.source, candidates: [candidate], ...(signal === undefined ? {} : { signal }) })
    const metadata = result.value?.items[0]
    if (metadata?.tocHtml !== undefined && metadata.tocUrl !== undefined) this.tocPage = { bookUrl: candidate.bookUrl, url: metadata.tocUrl, html: metadata.tocHtml }
    return result
  }

  public async toc(book: BookMetadata, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadTableOfContents>>> {
    const operation = this.createOperation()
    operation.rules.setBindings({ key: book.name ?? '', book })
    const cachedPage = this.tocPage?.bookUrl === book.bookUrl ? this.tocPage : undefined
    const inputBook = cachedPage !== undefined && cachedPage.url === book.tocUrl ? { ...book, tocHtml: cachedPage.html } : book
    return loadTableOfContents({ ...operation.ports, cache: this.cache }, { source: this.source, book: inputBook, ...(signal === undefined ? {} : { signal }), maxPages: 32 })
  }

  public async content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean }): Promise<Awaited<ReturnType<typeof loadChapterContent>>> {
    const operation = this.createOperation()
    operation.rules.setBindings({ key: book.name ?? '', book, chapter })
    const cache: ContentCache = options?.refresh === true ? { get: async () => undefined, set: (key, value, cacheSignal) => this.cache.set(key, value, cacheSignal) } : this.cache
    return loadChapterContent({ ...operation.ports, cache }, { source: this.source, chapter, ...(signal === undefined ? {} : { signal }), maxPages: 32, maxOutputBytes: 4 * 1024 * 1024 })
  }

  public readonly cache = {
    get: async (key: string, signal?: AbortSignal): Promise<string | undefined> => this.cacheStore?.get(key, signal),
    set: async (key: string, value: string, signal?: AbortSignal): Promise<void> => this.cacheStore?.set(key, value, signal),
  }

  private cacheStore?: ReturnType<ReaderStorage['workflowCache']>
  private tocPage?: { bookUrl: string; url: string; html: string }

  public attachCache(storage: ReaderStorage): void {
    this.cacheStore = storage.workflowCache(sourceDefinitionFingerprint(this.source))
  }

  private createOperation(): { rules: SourceRuleHost; ports: WorkflowPorts } {
    const request = new SourceRequestHost({ network: this.network, cookieStore: this.cookieStore })
    const rules = new SourceRuleHost({ request: (input, signal) => request.requestFromBridge(input, signal) })
    request.attachRuleHost(rules)
    return {
      rules,
      ports: {
        network: this.network,
        rules,
        request: (input) => request.request(input),
        decodeResponse: (response) => request.decodeResponse(response),
      },
    }
  }
}

export class ReaderApplication {
  private readonly catalog: SourceCatalogResult
  private readonly storage: ReaderStorage
  private readonly sessions = new Map<string, ReaderSourceSession>()
  private readonly concurrency: KeyedConcurrencyHost
  private readonly maxConcurrentSources: number
  private readonly activeOperations = new Set<TrackedOperation>()
  private closed = false
  private closePromise?: Promise<void>

  public constructor(options: ReaderApplicationOptions) {
    this.catalog = options.catalog
    this.storage = options.storage
    this.maxConcurrentSources = options.maxConcurrentSources ?? 4
    this.concurrency = new KeyedConcurrencyHost({ maxConcurrent: this.maxConcurrentSources, maxConcurrentPerKey: 1 })
    for (const entry of usableSources(this.catalog)) {
      const session = options.sessionFactory?.(entry.source) ?? new SourceSession(entry.source)
      session.attachCache(this.storage)
      this.sessions.set(entry.id, session)
    }
  }

  public async initialize(): Promise<void> {
    if (this.closed) throw new Error('阅读器应用已关闭')
    await this.storage.initialize()
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closed = true
    const pending = [...this.activeOperations]
    for (const operation of pending) operation.controller.abort()
    this.concurrency.clear()
    this.closePromise = Promise.allSettled(pending.map((operation) => operation.promise)).then(async () => {
      await this.storage.close()
    })
    return this.closePromise
  }

  public get sourceEntries(): readonly SourceEntry[] {
    return this.catalog.entries
  }

  public get diagnostics(): readonly string[] {
    return this.catalog.diagnostics
  }

  public get sourceLocation(): string {
    return this.catalog.sourceLocation
  }

  public async home(): Promise<Awaited<ReturnType<ReaderStorage['homeViews']>>> {
    return this.storage.homeViews()
  }

  public async searchHistory(limit = 20): Promise<SearchHistoryEntry[]> {
    return this.storage.listSearchHistory(limit)
  }

  public search(keyword: string, sourceIds?: readonly string[], signal?: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener): Promise<SearchOperationResult> {
    return this.trackOperation(signal, (operationSignal) => this.searchInternal(keyword, sourceIds, operationSignal, onProgress, onUpdate))
  }

  private async searchInternal(keyword: string, sourceIds: readonly string[] | undefined, signal: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener): Promise<SearchOperationResult> {
    const trimmed = keyword.trim()
    const searchId = randomUUID()
    const startedAt = new Date().toISOString()
    const startedClock = Date.now()
    const entries = usableSources(this.catalog).filter((entry) => sourceIds === undefined || sourceIds.includes(entry.id) || sourceIds.includes(entry.source.bookSourceUrl))
    const results: SourceSearchResult[] = []
    const activeSources = new Map<string, number>()
    let completed = 0
    let progressCandidates = 0
    let arrivalIndex = 0
    const progressCounts = { success: 0, partial: 0, empty: 0, failed: 0, capabilityMissing: 0, cancelled: 0 }
    const emitProgress = (): void => {
      if (onProgress === undefined) return
      try {
        onProgress({ total: entries.length, completed, activeSources: [...activeSources.keys()], candidates: progressCandidates, elapsedMs: Date.now() - startedClock, ...progressCounts })
      } catch {
        // UI progress callbacks must not alter the search result.
      }
    }
    const snapshot = (cancelled = false, completedAt = new Date().toISOString()): SearchOperationResult => {
      const clones = new Map<SearchResult, SearchResult>()
      for (const item of results) {
        for (const candidate of item.candidates) {
          clones.set(candidate, { ...candidate, candidate: { ...candidate.candidate, rawFields: { ...candidate.candidate.rawFields } } })
        }
      }
      const flattened = results.flatMap((item) => item.candidates.map((candidate) => clones.get(candidate)!))
      return {
        searchId,
        keyword: trimmed,
        results: flattened,
        sources: results.map((item) => ({ ...item, candidates: item.candidates.map((candidate) => clones.get(candidate)!) })),
        groups: groupSearchResults(trimmed, flattened),
        elapsedMs: Date.now() - startedClock,
        startedAt,
        completedAt,
        cancelled,
      }
    }
    const emitUpdate = (cancelled = false): void => {
      if (onUpdate === undefined) return
      try {
        onUpdate(snapshot(cancelled))
      } catch {
        // UI snapshots must not alter the search result or worker lifecycle.
      }
    }
    emitProgress()
    emitUpdate()
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal.aborted) return
        const index = nextIndex
        nextIndex += 1
        const source = entries[index]
        if (source === undefined) return
        const session = this.sessions.get(source.id)
        if (session === undefined) continue
        activeSources.set(source.source.bookSourceName, (activeSources.get(source.source.bookSourceName) ?? 0) + 1)
        emitProgress()
        let sourceStartedClock = Date.now()
        try {
          const response = await this.concurrency.run(source.id, (innerSignal) => {
            // 并发宿主可能先排队；耗时从真正进入书源会话开始计算，不包含队列等待。
            sourceStartedClock = Date.now()
            return session.search(trimmed, innerSignal)
          }, signal)
          const found = response.value?.items ?? []
          const durationMs = Date.now() - sourceStartedClock
          const candidates = found.map((candidate) => ({ candidate, source, searchId, arrivalIndex: arrivalIndex++, searchDurationMs: durationMs }))
          results.push({ source, status: response.status, candidates, durationMs, ...(response.diagnostics[0] === undefined ? {} : { message: response.diagnostics[0].message }) })
          progressCandidates += found.length
          if (response.status === 'success') progressCounts.success += 1
          else if (response.status === 'partial') progressCounts.partial += 1
          else if (response.status === 'empty') progressCounts.empty += 1
          else if (response.status === 'capability-missing') progressCounts.capabilityMissing += 1
          else if (response.status === 'cancelled') progressCounts.cancelled += 1
          else if (response.status === 'failed') progressCounts.failed += 1
        } catch (error) {
          results.push({ source, status: signal?.aborted ? 'cancelled' : 'failed', candidates: [], durationMs: Date.now() - sourceStartedClock, message: errorMessage(error) })
          if (signal.aborted) progressCounts.cancelled += 1
          else progressCounts.failed += 1
        } finally {
          const activeCount = activeSources.get(source.source.bookSourceName) ?? 0
          if (activeCount <= 1) activeSources.delete(source.source.bookSourceName)
          else activeSources.set(source.source.bookSourceName, activeCount - 1)
          completed += 1
          emitProgress()
          emitUpdate(signal.aborted)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrentSources, Math.max(1, entries.length)) }, () => worker()))
    const cancelled = signal?.aborted === true
    const sourceSummary: SearchHistoryEntry['summary'] = {
      searched: entries.length,
      success: results.filter((item) => item.status === 'success' || item.status === 'partial').length,
      empty: results.filter((item) => item.status === 'empty').length,
      failed: results.filter((item) => item.status === 'failed').length,
      capabilityMissing: results.filter((item) => item.status === 'capability-missing').length,
      candidates: results.reduce((sum, item) => sum + item.candidates.length, 0),
    }
    const history = await this.storage.addSearchHistory({ keyword: trimmed, sourceScope: sourceIds === undefined ? 'all' : [...sourceIds], startedAt, completedAt: new Date().toISOString(), summary: sourceSummary, openedBookIds: [] })
    for (const source of results) {
      for (const candidate of source.candidates) candidate.searchId = history.id
    }
    results.sort((left, right) => left.source.source.bookSourceName.localeCompare(right.source.source.bookSourceName, 'zh-Hans'))
    const completedAt = new Date().toISOString()
    const operation: SearchOperationResult = { ...snapshot(cancelled, completedAt), searchId: history.id, completedAt }
    emitUpdate(cancelled)
    return operation
  }

  public openSearchResult(selected: SearchResult, related: readonly SearchResult[] = [], signal?: AbortSignal): Promise<OpenBookResult> {
    return this.trackOperation(signal, (operationSignal) => this.openSearchResultInternal(selected, related, operationSignal))
  }

  private async openSearchResultInternal(selected: SearchResult, related: readonly SearchResult[], signal: AbortSignal): Promise<OpenBookResult> {
    throwIfAborted(signal)
    const sameTitle = related.filter((item) => isBookTitleMatch(item.candidate.name, selected.candidate.name) && isAuthorMatch(item.candidate.author, selected.candidate.author))
    const candidates = [selected, ...sameTitle.filter((item) => item !== selected)]
    let bookId = await this.storage.findBookIdByEdition(selected.candidate.sourceId, selected.candidate.bookUrl)
    const timestamp = new Date().toISOString()
    if (bookId === undefined) bookId = randomUUID()
    const existing = await this.storage.getBook(bookId)
    const selectedEdition = editionKey(selected.candidate.sourceId, selected.candidate.bookUrl)
    const base: BookDocument = existing === undefined
      ? { bookId, name: selected.candidate.name ?? selected.candidate.bookUrl, ...(selected.candidate.author === undefined ? {} : { author: selected.candidate.author }), ...(selected.candidate.intro === undefined ? {} : { intro: selected.candidate.intro }), ...(selected.candidate.coverUrl === undefined ? {} : { coverUrl: selected.candidate.coverUrl }), activeEditionKey: selectedEdition, metadataEditionKey: selectedEdition, createdAt: timestamp, updatedAt: timestamp }
      : { ...existing, activeEditionKey: selectedEdition, updatedAt: timestamp }
    const session = this.sessions.get(selected.source.id)
    if (session === undefined) throw new Error('所选书源当前不可用')
    const details = await session.detail(selected.candidate, signal)
    throwIfAborted(signal)
    const metadata = details.value?.items[0]
    const book = metadata === undefined ? base : updateBook(base, metadata, selectedEdition, timestamp)
    await this.storage.upsertBook(book)
    await this.storage.mergeKnownSources(bookId, candidates.map((item, index) => toKnownSource(item, selected, index === 0)))
    if (metadata !== undefined) await this.storage.mergeKnownSources(bookId, [mergeMetadataIntoSource(toKnownSource(selected, selected, true), metadata)])
    await this.storage.markSearchOpened(selected.searchId, bookId)
    const sources = await this.storage.listKnownSources(bookId)
    const reading = await this.storage.getReadingRecord(bookId)
    return { book, source: selected.source, ...(metadata === undefined ? {} : { metadata }), sources, onBookshelf: await this.storage.isOnBookshelf(bookId), ...(reading === undefined ? {} : { reading }) }
  }

  public async knownSources(bookId: string): Promise<KnownSourceView[]> {
    const known = await this.storage.listKnownSources(bookId)
    const entries = new Map<string, SourceEntry[]>()
    for (const entry of this.catalog.entries) entries.set(entry.source.bookSourceUrl, [...(entries.get(entry.source.bookSourceUrl) ?? []), entry])
    return known.map((item) => {
      const matches = entries.get(item.sourceId) ?? []
      const entry = matches.find((candidate) => candidate.fingerprint === item.sourceFingerprint)
      const sourceName = entry?.source.bookSourceName ?? matches[0]?.source.bookSourceName
      if (matches.length === 0) return { ...item, state: 'removed' as const }
      if (matches.some((candidate) => candidate.state === 'conflict')) return { ...item, state: 'conflict' as const, ...(sourceName === undefined ? {} : { sourceName }) }
      if (entry === undefined) return { ...item, state: 'stale' as const, ...(sourceName === undefined ? {} : { sourceName }) }
      if (entry.state !== 'available') return { ...item, state: 'stale' as const, ...(sourceName === undefined ? {} : { sourceName }) }
      return { ...item, state: 'available' as const, ...(sourceName === undefined ? {} : { sourceName }) }
    })
  }

  public openStoredBook(bookId: string, signal?: AbortSignal): Promise<OpenBookResult> {
    return this.trackOperation(signal, async (operationSignal) => {
      throwIfAborted(operationSignal)
      const book = await this.storage.getBook(bookId)
      if (book === undefined) throw new Error('书籍记录不存在')
      const known = await this.storage.listKnownSources(bookId)
      const storedReading = await this.storage.getReadingRecord(bookId)
      const edition = known.find((item) => item.editionKey === storedReading?.activeEditionKey) ?? known.find((item) => item.editionKey === book.activeEditionKey) ?? known[0]
      if (edition === undefined) throw new Error('书籍没有已知书源')
      const source = this.requireSource(edition)
      await this.storage.markReadingOpened(bookId)
      const reading = await this.storage.getReadingRecord(bookId)
      return { book, source, sources: known, onBookshelf: await this.storage.isOnBookshelf(bookId), ...(reading === undefined ? {} : { reading }) }
    })
  }

  public searchMoreSources(bookId: string, signal?: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener): Promise<SearchOperationResult> {
    return this.trackOperation(signal, async (operationSignal) => {
      throwIfAborted(operationSignal)
      const book = await this.storage.getBook(bookId)
      if (book === undefined) throw new Error('书籍记录不存在')
      const known = await this.storage.listKnownSources(bookId)
      const valid = new Set(known.filter((item) => this.catalog.entries.some((entry) => entry.source.bookSourceUrl === item.sourceId && entry.fingerprint === item.sourceFingerprint && entry.state === 'available')).map((item) => item.sourceId))
      const sourceIds = usableSources(this.catalog).filter((entry) => !valid.has(entry.source.bookSourceUrl)).map((entry) => entry.id)
      const update = onUpdate === undefined ? undefined : (snapshot: SearchOperationResult): void => onUpdate(filterSearchSnapshot(snapshot, book.name, book.author))
      const result = await this.searchInternal(book.name, sourceIds, operationSignal, onProgress, update)
      // searchInternal 在取消后仍会返回已完成书源的快照；先持久化其中的
      // 严格匹配候选，再把 cancelled 结果交给 UI，避免 Esc 丢失已返回书源。
      const matching = result.results.filter((item) => isBookTitleMatch(item.candidate.name, book.name) && isAuthorMatch(item.candidate.author, book.author))
      if (matching.length > 0) {
        const selected = matching[0]!
        await this.storage.mergeKnownSources(bookId, matching.map((item) => toKnownSource(item, selected, false)))
      }
      return filterSearchSnapshot(result, book.name, book.author)
    })
  }

  public loadToc(bookId: string, requestedEdition?: string, signal?: AbortSignal): Promise<TocResult> {
    return this.trackOperation(signal, (operationSignal) => this.loadTocInternal(bookId, requestedEdition, operationSignal))
  }

  private async loadTocInternal(bookId: string, requestedEdition: string | undefined, signal: AbortSignal): Promise<TocResult> {
    throwIfAborted(signal)
    const book = await this.storage.getBook(bookId)
    if (book === undefined) throw new Error('书籍记录不存在')
    const known = await this.storage.listKnownSources(bookId)
    const edition = known.find((item) => item.editionKey === requestedEdition) ?? known.find((item) => item.editionKey === book.activeEditionKey) ?? known[0]
    if (edition === undefined) throw new Error('书籍没有已知书源')
    const source = this.requireSource(edition)
    const session = this.requireSession(source)
    const metadata: BookMetadata = { sourceId: edition.sourceId, bookUrl: edition.bookUrl, ...(edition.name === undefined ? {} : { name: edition.name }), ...(edition.author === undefined ? {} : { author: edition.author }), ...(edition.intro === undefined ? {} : { intro: edition.intro }), ...(edition.coverUrl === undefined ? {} : { coverUrl: edition.coverUrl }), ...(edition.tocUrl === undefined ? {} : { tocUrl: edition.tocUrl }), ...(edition.lastChapter === undefined ? {} : { lastChapter: edition.lastChapter }), ...(edition.updateTime === undefined ? {} : { updateTime: edition.updateTime }), rawFields: edition.rawFields, traceRef: `stored:${edition.editionKey}`, emptyFields: [], fieldErrors: {} }
    const result = await session.toc(metadata, signal)
    throwIfAborted(signal)
    if (result.value === null) throw new Error(result.diagnostics[0]?.message ?? '目录加载失败')
    const revision = sha256(JSON.stringify(result.value.items.map((item) => ({ url: item.chapterUrl, title: item.title }))))
    return { chapters: result.value.items, revision, source, edition }
  }

  public loadContent(bookId: string, chapter: Chapter, editionId?: string, signal?: AbortSignal, options?: { refresh?: boolean }): Promise<{ content: ChapterContent; source: SourceEntry; edition: KnownSource }> {
    return this.trackOperation(signal, (operationSignal) => this.loadContentInternal(bookId, chapter, editionId, operationSignal, options))
  }

  private async loadContentInternal(bookId: string, chapter: Chapter, editionId: string | undefined, signal: AbortSignal, options?: { refresh?: boolean }): Promise<{ content: ChapterContent; source: SourceEntry; edition: KnownSource }> {
    throwIfAborted(signal)
    const book = await this.storage.getBook(bookId)
    if (book === undefined) throw new Error('书籍记录不存在')
    const known = await this.storage.listKnownSources(bookId)
    const edition = known.find((item) => item.editionKey === editionId) ?? known.find((item) => item.sourceId === chapter.sourceId && item.bookUrl === chapter.bookUrl)
    if (edition === undefined) throw new Error('正文来源未记录')
    const source = this.requireSource(edition)
    const session = this.requireSession(source)
    const metadata: BookMetadata = { sourceId: edition.sourceId, bookUrl: edition.bookUrl, ...(edition.name === undefined ? {} : { name: edition.name }), ...(edition.author === undefined ? {} : { author: edition.author }), ...(edition.intro === undefined ? {} : { intro: edition.intro }), ...(edition.coverUrl === undefined ? {} : { coverUrl: edition.coverUrl }), ...(edition.tocUrl === undefined ? {} : { tocUrl: edition.tocUrl }), ...(edition.lastChapter === undefined ? {} : { lastChapter: edition.lastChapter }), ...(edition.updateTime === undefined ? {} : { updateTime: edition.updateTime }), rawFields: edition.rawFields, traceRef: `stored:${edition.editionKey}`, emptyFields: [], fieldErrors: {} }
    const result = await session.content(chapter, metadata, signal, options)
    throwIfAborted(signal)
    if (result.value === null) throw new Error(result.diagnostics[0]?.message ?? '正文加载失败')
    return { content: result.value, source, edition }
  }

  public toggleBookshelf(bookId: string): Promise<boolean> {
    return this.trackOperation(undefined, () => this.storage.toggleBookshelf(bookId))
  }

  public saveReadingPosition(bookId: string, chapter: Chapter, edition: KnownSource, paragraphIndex: number, offset: number, tocRevision?: string): Promise<void> {
    return this.trackOperation(undefined, async () => {
      const timestamp = new Date().toISOString()
      const position: ReadingPosition = { editionKey: edition.editionKey, sourceId: chapter.sourceId, bookUrl: chapter.bookUrl, chapterUrl: chapter.chapterUrl, index: chapter.index, title: chapter.title, ...(tocRevision === undefined ? {} : { tocRevision }), paragraphIndex, offset, lastReadAt: timestamp }
      await this.storage.saveReadingPosition({ bookId, position, openedAt: timestamp })
    })
  }

  public switchSource(bookId: string, targetEdition: string, signal?: AbortSignal): Promise<OpenBookResult> {
    return this.trackOperation(signal, (operationSignal) => this.switchSourceInternal(bookId, targetEdition, operationSignal))
  }

  private async switchSourceInternal(bookId: string, targetEdition: string, signal: AbortSignal): Promise<OpenBookResult> {
    throwIfAborted(signal)
    const book = await this.storage.getBook(bookId)
    if (book === undefined) throw new Error('书籍记录不存在')
    const known = await this.storage.listKnownSources(bookId)
    const target = known.find((item) => item.editionKey === targetEdition)
    if (target === undefined) throw new Error('目标书源未记录')
    const view = await this.knownSources(bookId)
    const state = view.find((item) => item.editionKey === targetEdition)?.state
    if (state !== 'available') throw new Error('目标书源需要重新搜索或已被移除')
    const source = this.requireSource(target)
    const session = this.requireSession(source)
    const candidate: BookCandidate = { sourceId: target.sourceId, bookUrl: target.bookUrl, ...(target.name === undefined ? {} : { name: target.name }), ...(target.author === undefined ? {} : { author: target.author }), ...(target.intro === undefined ? {} : { intro: target.intro }), ...(target.coverUrl === undefined ? {} : { coverUrl: target.coverUrl }), ...(target.lastChapter === undefined ? {} : { lastChapter: target.lastChapter }), ...(target.updateTime === undefined ? {} : { updateTime: target.updateTime }), rawFields: target.rawFields, traceRef: `stored:${target.editionKey}` }
    const details = await session.detail(candidate, signal)
    throwIfAborted(signal)
    if (details.value === null) throw new Error(details.diagnostics[0]?.message ?? '目标书源详情加载失败')
    const metadata = details.value?.items[0]
    const next = metadata === undefined ? { ...book, activeEditionKey: target.editionKey, updatedAt: new Date().toISOString() } : updateBook(book, metadata, target.editionKey, new Date().toISOString())
    if (metadata !== undefined) await this.storage.mergeKnownSources(bookId, [mergeMetadataIntoSource(target, metadata)])
    await this.storage.upsertBook(next)
    throwIfAborted(signal)
    await this.storage.confirmKnownSource(bookId, target.editionKey)
    await this.storage.setReadingEdition(bookId, target.editionKey)
    const reading = await this.storage.getReadingRecord(bookId)
    return { book: next, source, ...(metadata === undefined ? {} : { metadata }), sources: await this.storage.listKnownSources(bookId), onBookshelf: await this.storage.isOnBookshelf(bookId), ...(reading === undefined ? {} : { reading }) }
  }

  private trackOperation<T>(externalSignal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('阅读器应用已关闭'))
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    if (externalSignal?.aborted === true) controller.abort()
    else externalSignal?.addEventListener('abort', relay, { once: true })
    const operation: TrackedOperation = { controller, promise: Promise.resolve().then(() => task(controller.signal)) as Promise<unknown> }
    this.activeOperations.add(operation)
    const tracked = operation.promise.finally(() => {
      this.activeOperations.delete(operation)
      externalSignal?.removeEventListener('abort', relay)
    })
    operation.promise = tracked
    return tracked as Promise<T>
  }

  private requireSource(edition: KnownSource): SourceEntry {
    const source = this.catalog.entries.find((entry) => entry.source.bookSourceUrl === edition.sourceId && entry.fingerprint === edition.sourceFingerprint)
    if (source === undefined) throw new Error('书源定义已变化')
    return source
  }

  private requireSession(source: SourceEntry): ReaderSourceSession {
    const session = this.sessions.get(source.id)
    if (session === undefined) throw new Error('书源当前不可用')
    return session
  }
}

function toKnownSource(result: SearchResult, selected: SearchResult, isSelected: boolean): KnownSource {
  const candidate = result.candidate
  return { editionKey: editionKey(candidate.sourceId, candidate.bookUrl), sourceId: candidate.sourceId, sourceFingerprint: result.source.fingerprint, bookUrl: candidate.bookUrl, ...(candidate.name === undefined ? {} : { name: candidate.name }), ...(candidate.author === undefined ? {} : { author: candidate.author }), ...(candidate.intro === undefined ? {} : { intro: candidate.intro }), ...(candidate.coverUrl === undefined ? {} : { coverUrl: candidate.coverUrl }), ...(candidate.lastChapter === undefined ? {} : { lastChapter: candidate.lastChapter }), ...(candidate.updateTime === undefined ? {} : { updateTime: candidate.updateTime }), ...(result.searchDurationMs === undefined ? {} : { searchDurationMs: result.searchDurationMs }), rawFields: candidate.rawFields, discoveredAt: new Date().toISOString(), searchId: result.searchId, matchKind: isSelected ? 'selected' : normalizeAuthor(candidate.author) !== '' && normalizeAuthor(candidate.author) === normalizeAuthor(selected.candidate.author) ? 'title-author' : 'title-only' }
}

function updateBook(book: BookDocument, metadata: BookMetadata, activeEditionKey: string, timestamp: string): BookDocument {
  return { ...book, name: metadata.name ?? book.name, ...(metadata.author === undefined ? {} : { author: metadata.author }), ...(metadata.intro === undefined ? {} : { intro: metadata.intro }), ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }), ...(metadata.tocUrl === undefined ? {} : { tocUrl: metadata.tocUrl }), activeEditionKey, metadataEditionKey: activeEditionKey, updatedAt: timestamp }
}

function mergeMetadataIntoSource(source: KnownSource, metadata: BookMetadata): KnownSource {
  return { ...source, ...(metadata.name === undefined ? {} : { name: metadata.name }), ...(metadata.author === undefined ? {} : { author: metadata.author }), ...(metadata.intro === undefined ? {} : { intro: metadata.intro }), ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }), ...(metadata.tocUrl === undefined ? {} : { tocUrl: metadata.tocUrl }), ...(metadata.lastChapter === undefined ? {} : { lastChapter: metadata.lastChapter }), ...(metadata.updateTime === undefined ? {} : { updateTime: metadata.updateTime }), rawFields: { ...source.rawFields, ...metadata.rawFields } }
}

export function groupSearchResults(keyword: string, results: readonly SearchResult[]): SearchResultGroup[] {
  const groups = new Map<string, SearchResultGroup>()
  for (const result of [...results].sort((left, right) => left.arrivalIndex - right.arrivalIndex)) {
    const title = normalizeTitle(result.candidate.name)
    const author = normalizeAuthor(result.candidate.author)
    // 作者缺失时只在同一书源同一 URL 内折叠，避免同名书被错误合并。
    const key = title.length > 0 && author.length > 0 ? `title-author:${title}\u0000${author}` : `edition:${result.candidate.sourceId}\u0000${result.candidate.bookUrl}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        candidate: result.candidate,
        source: result.source,
        candidates: [result],
        rank: searchMatchRank(keyword, result.candidate.name),
        firstArrivalIndex: result.arrivalIndex,
      })
      continue
    }
    existing.candidates.push(result)
  }
  return [...groups.values()].sort((left, right) => matchRankValue(left.rank) - matchRankValue(right.rank) || left.firstArrivalIndex - right.firstArrivalIndex)
}

export function searchMatchRank(keyword: string, name: string | undefined): SearchMatchRank {
  const expected = normalizeTitle(keyword)
  const actual = normalizeTitle(name)
  if (expected.length > 0 && actual === expected) return 'exact'
  if (expected.length > 0 && actual.includes(expected)) return 'contains'
  return 'other'
}

export function searchMatchRankLabel(rank: SearchMatchRank): string {
  return rank === 'exact' ? '完全匹配' : rank === 'contains' ? '包含关键词' : '其他'
}

function filterSearchSnapshot(snapshot: SearchOperationResult, expectedTitle: string, expectedAuthor: string | undefined): SearchOperationResult {
  const results = snapshot.results.filter((item) => isBookTitleMatch(item.candidate.name, expectedTitle) && isAuthorMatch(item.candidate.author, expectedAuthor))
  const allowed = new Set(results)
  const sources = snapshot.sources.map((item) => ({ ...item, candidates: item.candidates.filter((candidate) => allowed.has(candidate)) }))
  return { ...snapshot, results, sources, groups: groupSearchResults(expectedTitle, results) }
}

function matchRankValue(rank: SearchMatchRank): number {
  return rank === 'exact' ? 0 : rank === 'contains' ? 1 : 2
}

function normalizeTitle(value: string | undefined): string {
  // Search identity ignores punctuation and spacing so full-width and half-width
  // forms can contribute candidates to one logical book without merging books.
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/[\s\p{P}\p{S}]+/gu, '')
}

function isBookTitleMatch(candidate: string | undefined, expected: string | undefined): boolean {
  const left = normalizeTitle(candidate)
  const right = normalizeTitle(expected)
  return left.length > 0 && right.length > 0 && left === right
}

function isAuthorMatch(candidate: string | undefined, expected: string | undefined): boolean {
  const left = normalizeAuthor(candidate)
  const right = normalizeAuthor(expected)
  return left.length > 0 && right.length > 0 && left === right
}

function normalizeAuthor(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/\s+/gu, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
}

function sha256(value: string): string {
  let hash = 0n
  for (const character of value) hash = (hash * 131n + BigInt(character.codePointAt(0) ?? 0)) % 0xffffffffffffffffn
  return hash.toString(16).padStart(16, '0')
}
