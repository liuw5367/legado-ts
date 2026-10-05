import { randomUUID } from 'node:crypto'
import { reconcileTableOfContents } from '@legado/source-core'
import type { BookCandidate, BookMetadata, Chapter, ChapterContent, ContentIdentity } from '@legado/source-core'
import { KeyedConcurrencyHost } from '@legado/source-node'
import type { SourceEntry, SourceCatalogResult } from './source-catalog.ts'
import { chapterKey, editionKey, ReaderStorage } from './storage.ts'
import type { BookDocument, KnownSource, KnownSourceView, ReadingPosition, ReaderSettings, SearchHistoryEntry } from './storage.ts'
import type {
  OpenBookResult,
  ReaderApplicationOptions,
  ReaderSourceSession,
  SearchOptions,
  SearchOperationResult,
  SearchProgressListener,
  SearchResult,
  SearchUpdateListener,
  SourceSearchResult,
  TocResult,
  SourceCheckProgress,
  SourceCheckResult,
} from './application-model.ts'
import { SourceSession } from './source-session.ts'
import { filterSearchSnapshot, groupSearchResults, isAuthorMatch, isBookTitleMatch, normalizeAuthor } from './search-results.ts'
import { DebugCapture } from './debug-capture.ts'
import { DebugRunner } from './debug-runner.ts'
import { orderedSearchSources, nextSearchHealth } from './source-policy.ts'
import { checkSource } from './source-check.ts'
import type { SourceCheckConfig } from './storage.ts'
import { normalizeReaderSettings } from './reader-settings.ts'

export type {
  OpenBookResult,
  ReaderApplicationOptions,
  ReaderSourceSession,
  ReaderSourceSearchOptions,
  SearchMatchRank,
  SearchOptions,
  SearchOperationResult,
  SearchProgress,
  SearchProgressListener,
  SearchResult,
  SearchResultGroup,
  SearchUpdateListener,
  SourceSearchResult,
  TocResult,
  SourceCheckProgress,
  SourceCheckResult,
} from './application-model.ts'
export { groupSearchResults, searchMatchRank, searchMatchRankLabel } from './search-results.ts'
export { DebugCapture } from './debug-capture.ts'
export { DebugRunner } from './debug-runner.ts'

interface TrackedOperation {
  controller: AbortController
  promise: Promise<unknown>
}

interface SearchContinuation {
  previous: SearchOperationResult
  searchId: string
  page: number
}

export class ReaderApplication {
  private readonly catalog: SourceCatalogResult
  private readonly storage: ReaderStorage
  private readonly sessions = new Map<string, ReaderSourceSession>()
  private readonly concurrency: KeyedConcurrencyHost
  private readonly sourceSearchTimeoutMs: number
  private latestSearchId: string | undefined
  private settings: ReaderSettings
  private readonly activeOperations = new Set<TrackedOperation>()
  private readonly evidence = new Map<string, DebugCapture>()
  private closed = false
  private closePromise?: Promise<void>

  public constructor(options: ReaderApplicationOptions) {
    this.catalog = options.catalog
    this.storage = options.storage
    const fallback = options.maxConcurrentSources ?? 4
    this.sourceSearchTimeoutMs = normalizeSourceSearchTimeout(options.sourceSearchTimeoutMs)
    this.settings = normalizeReaderSettings(options.settings ?? { searchConcurrency: fallback, sourceSearchConcurrency: fallback, sourceCheckConcurrency: fallback })
    this.concurrency = new KeyedConcurrencyHost({ maxConcurrent: Math.max(this.settings.searchConcurrency, this.settings.sourceSearchConcurrency, this.settings.sourceCheckConcurrency), maxConcurrentPerKey: 1 })
    for (const entry of this.catalog.entries.filter((item) => item.state === 'available' || item.state === 'disabled')) {
      const session = options.sessionFactory?.(entry.source) ?? new SourceSession(entry.source, this.concurrency)
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
      for (const session of this.sessions.values()) session.close?.()
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

  public get sourceCatalog(): SourceCatalogResult {
    return this.catalog
  }

  public get readerSettings(): ReaderSettings {
    return { ...this.settings }
  }

  public async saveReaderSettings(settings: ReaderSettings): Promise<void> {
    if (this.activeOperations.size > 0) throw new Error('当前仍有操作进行中，完成后才能应用设置')
    const normalized = normalizeReaderSettings(settings)
    await this.storage.saveReaderSettings(normalized)
    this.settings = normalized
    this.concurrency.setMaxConcurrent(Math.max(this.settings.searchConcurrency, this.settings.sourceSearchConcurrency, this.settings.sourceCheckConcurrency))
  }

  public evidenceFor(context: string): DebugCapture | undefined {
    return this.evidence.get(context)
  }

  public createDebugRunner(sourceId: string): DebugRunner | undefined {
    const entry = this.catalog.entries.find((item) => item.id === sourceId || item.source.bookSourceUrl === sourceId)
    if (entry === undefined || !['available', 'disabled'].includes(entry.state)) return undefined
    const session = this.sessions.get(entry.id)
    return session === undefined ? undefined : new DebugRunner(entry, session)
  }

  public async home(): Promise<Awaited<ReturnType<ReaderStorage['homeViews']>>> {
    return this.storage.homeViews()
  }

  public async searchHistory(limit = 20): Promise<SearchHistoryEntry[]> {
    return this.storage.listSearchHistory(limit)
  }

  public search(keyword: string, sourceIds?: readonly string[], signal?: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener, options: SearchOptions = {}): Promise<SearchOperationResult> {
    return this.trackOperation(signal, (operationSignal) => this.searchInternal(keyword, sourceIds, operationSignal, onProgress, onUpdate, this.settings.searchConcurrency, options))
  }

  public searchNext(previous: SearchOperationResult, signal?: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener): Promise<SearchOperationResult> {
    if (this.closed) return Promise.reject(new Error('阅读器应用已关闭'))
    if (previous.hasMore !== true) return Promise.resolve(previous)
    if (previous.searchId !== this.latestSearchId) return Promise.reject(new Error('搜索结果已过期'))
    const continuation: SearchContinuation = { previous, searchId: previous.searchId, page: (previous.page ?? 1) + 1 }
    return this.trackOperation(signal, (operationSignal) => this.searchInternal(previous.keyword, undefined, operationSignal, onProgress, onUpdate, this.settings.searchConcurrency, { precision: previous.precision === true }, continuation))
  }

  private async searchInternal(keyword: string, sourceIds: readonly string[] | undefined, signal: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener, maxConcurrentSources = this.settings.searchConcurrency, options: SearchOptions = {}, continuation?: SearchContinuation): Promise<SearchOperationResult> {
    const trimmed = keyword.trim()
    const searchId = continuation?.searchId ?? randomUUID()
    if (continuation === undefined) this.latestSearchId = searchId
    const startedAt = continuation?.previous.startedAt ?? new Date().toISOString()
    const startedClock = Date.now() - (continuation?.previous.elapsedMs ?? 0)
    const entries = continuation === undefined
      ? orderedSearchSources(this.catalog.entries, sourceIds)
      : continuation.previous.sources.filter((item) => item.nextCursor !== undefined).map((item) => item.source)
    const historySourceIds = continuation === undefined
      ? sourceIds
      : continuation.previous.sources.map((item) => item.source.id)
    const capture = new DebugCapture({ sourceId: 'multi', sourceName: '搜索', mode: 'light' })
    const results: SourceSearchResult[] = continuation === undefined
      ? []
      : continuation.previous.sources.map((item) => ({
        ...item,
        candidates: item.candidates.map((candidate) => ({ ...candidate, candidate: { ...candidate.candidate, rawFields: { ...candidate.candidate.rawFields } } })),
        ...(item.cursor === undefined ? {} : { cursor: { ...item.cursor } }),
        ...(item.nextCursor === undefined ? {} : { nextCursor: { ...item.nextCursor } }),
      }))
    const pageResults: SourceSearchResult[] = []
    const activeSources = new Map<string, number>()
    let completed = 0
    let progressCandidates = 0
    let arrivalIndex = results.reduce((maximum, item) => item.candidates.reduce((innerMaximum, candidate) => Math.max(innerMaximum, candidate.arrivalIndex + 1), maximum), 0)
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
        page: continuation?.page ?? 1,
        hasMore: results.some((item) => item.nextCursor !== undefined),
        results: flattened,
        sources: results.map((item) => ({ ...item, candidates: item.candidates.map((candidate) => clones.get(candidate)!) })),
        groups: groupSearchResults(trimmed, flattened, options.precision === true),
        ...(options.precision === true ? { precision: true } : {}),
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
        if (session === undefined) {
          const pageResult: SourceSearchResult = { source, status: 'failed', candidates: [], page: continuation?.page ?? 1, durationMs: 0, message: '书源会话不可用' }
          const previous = results.find((item) => item.source.id === source.id)
          if (previous === undefined) results.push(pageResult)
            else {
            previous.status = pageResult.status
            if (pageResult.page === undefined) delete previous.page
            else previous.page = pageResult.page
            delete previous.cursor
            delete previous.nextCursor
            if (pageResult.message === undefined) delete previous.message
            else previous.message = pageResult.message
          }
          pageResults.push(pageResult)
          progressCounts.failed += 1
          completed += 1
          emitProgress()
          emitUpdate(signal.aborted)
          continue
        }
        const continuationCursor = continuation?.previous.sources.find((item) => item.source.id === source.id)?.nextCursor
        activeSources.set(source.source.bookSourceName, (activeSources.get(source.source.bookSourceName) ?? 0) + 1)
        emitProgress()
        let sourceStartedClock = Date.now()
        try {
          const response = await this.concurrency.run(source.id, async (innerSignal) => {
            // 并发宿主可能先排队；耗时从真正进入书源会话开始计算，不包含队列等待。
            sourceStartedClock = Date.now()
            const deadline = sourceSearchDeadline(innerSignal, this.sourceSearchTimeoutMs)
            try {
              const response = await session.search(trimmed, deadline.signal, capture, {
                ...(options.precision === true ? { precision: true } : {}),
                ...(continuationCursor === undefined ? {} : { cursor: continuationCursor }),
                budget: { timeoutMs: this.sourceSearchTimeoutMs, deadlineMs: Date.now() + this.sourceSearchTimeoutMs },
              })
              if (deadline.timedOut()) throw new Error('书源搜索超时')
              return response
            } catch (error) {
              if (deadline.timedOut()) throw new Error('书源搜索超时')
              throw error
            } finally {
              deadline.dispose()
            }
          }, signal)
          const found = response.value?.items ?? []
          const durationMs = Date.now() - sourceStartedClock
          const candidates = found.map((candidate) => ({ candidate, source, searchId, arrivalIndex: arrivalIndex++, searchDurationMs: durationMs }))
          const pageResult: SourceSearchResult = {
            source,
            status: response.status,
            candidates,
            page: continuation?.page ?? 1,
            ...(response.value?.cursor === undefined ? {} : { cursor: { ...response.value.cursor } }),
            ...(response.value?.nextCursor === undefined ? {} : { nextCursor: { ...response.value.nextCursor } }),
            durationMs,
            ...(response.diagnostics[0] === undefined ? {} : { message: response.diagnostics[0].message }),
          }
          const previous = results.find((item) => item.source.id === source.id)
          if (previous === undefined) results.push(pageResult)
          else {
            previous.candidates.push(...candidates)
            previous.status = response.status
            if (pageResult.page === undefined) delete previous.page
            else previous.page = pageResult.page
            if (pageResult.cursor === undefined) delete previous.cursor
            else previous.cursor = pageResult.cursor
            if (pageResult.nextCursor === undefined) delete previous.nextCursor
            else previous.nextCursor = pageResult.nextCursor
            previous.durationMs += durationMs
            if (pageResult.message === undefined) delete previous.message
            else previous.message = pageResult.message
          }
          pageResults.push(pageResult)
          progressCandidates += found.length
          if (response.status === 'success') progressCounts.success += 1
          else if (response.status === 'partial') progressCounts.partial += 1
          else if (response.status === 'empty') progressCounts.empty += 1
          else if (response.status === 'capability-missing') progressCounts.capabilityMissing += 1
          else if (response.status === 'cancelled') progressCounts.cancelled += 1
          else if (response.status === 'failed') progressCounts.failed += 1
        } catch (error) {
          const pageResult: SourceSearchResult = { source, status: signal?.aborted ? 'cancelled' : 'failed', candidates: [], page: continuation?.page ?? 1, durationMs: Date.now() - sourceStartedClock, message: errorMessage(error) }
          const previous = results.find((item) => item.source.id === source.id)
          if (previous === undefined) results.push(pageResult)
          else {
            previous.status = pageResult.status
            if (pageResult.page === undefined) delete previous.page
            else previous.page = pageResult.page
            delete previous.cursor
            delete previous.nextCursor
            previous.durationMs += pageResult.durationMs
            if (pageResult.message === undefined) delete previous.message
            else previous.message = pageResult.message
          }
          pageResults.push(pageResult)
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
    await Promise.all(Array.from({ length: Math.min(maxConcurrentSources, Math.max(1, entries.length)) }, () => worker()))
    const cancelled = signal?.aborted === true
    const sourceSummary: SearchHistoryEntry['summary'] = {
      searched: continuation === undefined ? entries.length : results.length,
      success: results.filter((item) => item.status === 'success' || item.status === 'partial').length,
      empty: results.filter((item) => item.status === 'empty').length,
      failed: results.filter((item) => item.status === 'failed').length,
      capabilityMissing: results.filter((item) => item.status === 'capability-missing').length,
      candidates: results.reduce((sum, item) => sum + item.candidates.length, 0),
    }
    const completedAt = new Date().toISOString()
    const historyId = continuation === undefined
      ? (await this.storage.addSearchHistory({ keyword: trimmed, sourceScope: historySourceIds === undefined ? 'all' : [...historySourceIds], startedAt, completedAt, summary: sourceSummary, openedBookIds: [] })).id
      : continuation.searchId
    if (continuation !== undefined) await this.storage.updateSearchHistory(historyId, { completedAt, summary: sourceSummary })
    for (const source of results) {
      for (const candidate of source.candidates) candidate.searchId = historyId
    }
    results.sort((left, right) => left.source.source.bookSourceName.localeCompare(right.source.source.bookSourceName, 'zh-Hans'))
    const operation: SearchOperationResult = { ...snapshot(cancelled, completedAt), searchId: historyId, completedAt }
    if (!cancelled) {
      await this.updateSearchHealth(pageResults)
      this.latestSearchId = historyId
    }
    emitUpdate(cancelled)
    this.rememberEvidence('search', capture)
    return operation
  }

  public async setSourcesEnabled(sourceIds: readonly string[], enabled: boolean): Promise<void> {
    const selected = new Set(sourceIds)
    await this.storage.updateSourceStates((states) => {
      const next = { ...states }
      for (const entry of this.catalog.entries) {
        if (!selected.has(entry.id) && !selected.has(entry.source.bookSourceUrl) || entry.state === 'unsupported' || entry.state === 'conflict') continue
        const current = next[entry.source.bookSourceUrl] ?? { fingerprint: entry.fingerprint, enabled: entry.source.enabled !== false, enabledExplore: entry.source.enabledExplore !== false, customOrder: entry.customOrder ?? 0, weight: typeof entry.source.weight === 'number' ? entry.source.weight : 0, searchHealth: entry.searchHealth ?? { fingerprint: entry.fingerprint, consecutiveFailures: 0 } }
        next[entry.source.bookSourceUrl] = { ...current, fingerprint: entry.fingerprint, enabled }
      }
      return next
    })
    for (const entry of this.catalog.entries) {
      if (!selected.has(entry.id) && !selected.has(entry.source.bookSourceUrl) || entry.state === 'unsupported' || entry.state === 'conflict') continue
      entry.source = { ...entry.source, enabled }
      entry.state = enabled ? 'available' : 'disabled'
      if (enabled) delete entry.reason
      else entry.reason = '书源已禁用'
    }
  }

  public async setSourceOrder(sourceId: string, customOrder: number): Promise<void> {
    if (!Number.isSafeInteger(customOrder)) throw new Error('优先级必须是整数')
    const entry = this.catalog.entries.find((item) => item.id === sourceId || item.source.bookSourceUrl === sourceId)
    if (entry === undefined) throw new Error('书源不存在')
    await this.storage.updateSourceStates((states) => {
      const current = states[entry.source.bookSourceUrl] ?? { fingerprint: entry.fingerprint, enabled: entry.source.enabled !== false, enabledExplore: entry.source.enabledExplore !== false, customOrder: entry.customOrder ?? 0, weight: typeof entry.source.weight === 'number' ? entry.source.weight : 0, searchHealth: entry.searchHealth ?? { fingerprint: entry.fingerprint, consecutiveFailures: 0 } }
      return { ...states, [entry.source.bookSourceUrl]: { ...current, customOrder } }
    })
    entry.customOrder = customOrder
    entry.source = { ...entry.source, customOrder }
  }

  public async resetSourceSearchHealth(sourceId: string): Promise<void> {
    const entry = this.catalog.entries.find((item) => item.id === sourceId || item.source.bookSourceUrl === sourceId)
    if (entry === undefined) throw new Error('书源不存在')
    const health = { fingerprint: entry.fingerprint, consecutiveFailures: 0 }
    await this.storage.updateSourceStates((states) => {
      const current = states[entry.source.bookSourceUrl]
      if (current === undefined) return states
      return { ...states, [entry.source.bookSourceUrl]: { ...current, searchHealth: health } }
    })
    entry.searchHealth = health
  }

  public async getSourceCheckConfig(): Promise<SourceCheckConfig> {
    return this.storage.getSourceCheckConfig()
  }

  public saveSourceCheckConfig(config: SourceCheckConfig): Promise<void> {
    return this.storage.saveSourceCheckConfig(config)
  }

  public checkSources(sourceIds: readonly string[], keyword?: string, signal?: AbortSignal, onProgress?: (progress: SourceCheckProgress) => void): Promise<SourceCheckResult[]> {
    return this.trackOperation(signal, (operationSignal) => this.checkSourcesInternal(sourceIds, keyword, operationSignal, onProgress))
  }

  private async checkSourcesInternal(sourceIds: readonly string[], keyword: string | undefined, signal: AbortSignal, onProgress?: (progress: SourceCheckProgress) => void): Promise<SourceCheckResult[]> {
    const selected = new Set(sourceIds)
    const entries = this.catalog.entries.filter((entry) => selected.has(entry.id) || selected.has(entry.source.bookSourceUrl))
    const config = await this.storage.getSourceCheckConfig()
    const results: SourceCheckResult[] = []
    let next = 0
    let completed = 0
    const active = new Set<string>()
    const progress = (currentStage?: string): void => onProgress?.({ total: entries.length, completed, passed: results.filter((item) => item.status === 'passed').length, failed: results.filter((item) => item.status === 'failed').length, cancelled: results.filter((item) => item.status === 'cancelled').length, activeSources: [...active], ...(currentStage === undefined ? {} : { currentStage }) })
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = next++
        const entry = entries[index]
        if (entry === undefined) return
        active.add(entry.source.bookSourceName)
        progress('准备')
        const result = await checkSource({ entry, session: this.sessions.get(entry.id), config, ...(keyword === undefined ? {} : { keyword }), signal, onStage: (stage) => progress(stage) })
        active.delete(entry.source.bookSourceName)
        results.push(result)
        completed += 1
        await this.storage.saveSourceCheck(entry.source.bookSourceUrl, result, {
          enabled: entry.source.enabled !== false,
          enabledExplore: entry.source.enabledExplore !== false,
          customOrder: entry.customOrder ?? 0,
          weight: typeof entry.source.weight === 'number' ? entry.source.weight : 0,
          searchHealth: entry.searchHealth ?? { fingerprint: entry.fingerprint, consecutiveFailures: 0 },
        })
        entry.check = result
        progress()
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.settings.sourceCheckConcurrency, Math.max(1, entries.length)) }, () => worker()))
    if (signal.aborted) for (const entry of entries.filter((item) => !results.some((result) => result.sourceId === item.source.bookSourceUrl))) {
      const cancelled: SourceCheckResult = { sourceId: entry.source.bookSourceUrl, sourceName: entry.source.bookSourceName, fingerprint: entry.fingerprint, sessionId: randomUUID(), status: 'cancelled', startedAt: new Date().toISOString(), detail: '校验已取消', failedStages: [], stages: [] }
      results.push(cancelled)
      entry.check = cancelled
    }
    return results
  }

  private async updateSearchHealth(results: readonly SourceSearchResult[]): Promise<void> {
    await this.storage.updateSourceStates((states) => {
      const next = { ...states }
      for (const item of results) {
        const entry = item.source
        const outcome = item.status === 'success' || item.status === 'partial' || item.status === 'empty' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'capability-missing' ? item.status : 'failed'
        const current = next[entry.source.bookSourceUrl]
        const health = nextSearchHealth(current?.searchHealth ?? entry.searchHealth ?? { fingerprint: entry.fingerprint, consecutiveFailures: 0 }, entry.fingerprint, outcome)
        next[entry.source.bookSourceUrl] = current === undefined ? { fingerprint: entry.fingerprint, enabled: entry.source.enabled !== false, enabledExplore: entry.source.enabledExplore !== false, customOrder: entry.customOrder ?? 0, weight: typeof entry.source.weight === 'number' ? entry.source.weight : 0, searchHealth: health } : { ...current, fingerprint: entry.fingerprint, searchHealth: health }
        entry.searchHealth = health
      }
      return next
    })
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
    const capture = new DebugCapture({ sourceId: selected.source.id, sourceName: selected.source.source.bookSourceName, mode: 'light' })
    const details = await session.detail(selected.candidate, signal, capture).finally(() => this.rememberEvidence('detail', capture))
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
      let book = await this.storage.getBook(bookId)
      if (book === undefined) throw new Error('书籍记录不存在')
      const savedBookActiveEditionKey = book.activeEditionKey
      const known = await this.storage.listKnownSources(bookId)
      const storedReading = await this.storage.getReadingRecord(bookId)
      const edition = known.find((item) => item.editionKey === storedReading?.activeEditionKey) ?? known.find((item) => item.editionKey === savedBookActiveEditionKey) ?? known[0]
      if (edition === undefined) throw new Error('书籍没有已知书源')
      if (storedReading?.activeEditionKey === edition.editionKey && book.activeEditionKey !== edition.editionKey) {
        book = {
          ...book,
          ...(edition.name === undefined ? {} : { name: edition.name }),
          ...(edition.author === undefined ? {} : { author: edition.author }),
          ...(edition.intro === undefined ? {} : { intro: edition.intro }),
          ...(edition.coverUrl === undefined ? {} : { coverUrl: edition.coverUrl }),
          ...(edition.tocUrl === undefined ? {} : { tocUrl: edition.tocUrl }),
          activeEditionKey: edition.editionKey,
          metadataEditionKey: edition.editionKey,
          updatedAt: new Date().toISOString(),
        }
        await this.storage.upsertBook(book)
      }
      const source = this.requireSource(edition)
      await this.storage.markReadingOpened(bookId)
      const reading = await this.storage.getReadingRecord(bookId)
      return { book, source, sources: known, onBookshelf: await this.storage.isOnBookshelf(bookId), ...(reading === undefined ? {} : { reading }) }
    })
  }

  public searchMoreSources(bookId: string, signal?: AbortSignal, onProgress?: SearchProgressListener, onUpdate?: SearchUpdateListener, options: SearchOptions = {}): Promise<SearchOperationResult> {
    return this.trackOperation(signal, async (operationSignal) => {
      throwIfAborted(operationSignal)
      const book = await this.storage.getBook(bookId)
      if (book === undefined) throw new Error('书籍记录不存在')
      const known = await this.storage.listKnownSources(bookId)
      const valid = new Set(known.filter((item) => this.catalog.entries.some((entry) => entry.source.bookSourceUrl === item.sourceId && entry.fingerprint === item.sourceFingerprint && entry.state === 'available')).map((item) => item.sourceId))
      const sourceIds = orderedSearchSources(this.catalog.entries).filter((entry) => !valid.has(entry.source.bookSourceUrl)).map((entry) => entry.id)
      const update = onUpdate === undefined ? undefined : (snapshot: SearchOperationResult): void => onUpdate(filterSearchSnapshot(snapshot, book.name, book.author))
      const result = await this.searchInternal(book.name, sourceIds, operationSignal, onProgress, update, this.settings.sourceSearchConcurrency, options)
      const searchEvidence = this.evidence.get('search')
      if (searchEvidence !== undefined) this.rememberEvidence('sources', searchEvidence)
      // searchInternal 在取消后仍会返回已完成书源的快照；先持久化其中的
      // 严格匹配候选，再把 cancelled 结果交给 UI，避免 ⎋ 丢失已返回书源。
      const matching = result.results.filter((item) => isBookTitleMatch(item.candidate.name, book.name) && isAuthorMatch(item.candidate.author, book.author))
      if (matching.length > 0) {
        const selected = matching[0]!
        await this.storage.mergeKnownSources(bookId, matching.map((item) => toKnownSource(item, selected, false)))
      }
      return filterSearchSnapshot(result, book.name, book.author)
    })
  }

  public loadToc(bookId: string, requestedEdition?: string, signal?: AbortSignal, options: { refresh?: boolean } = {}): Promise<TocResult> {
    return this.trackOperation(signal, (operationSignal) => this.loadTocInternal(bookId, requestedEdition, operationSignal, options))
  }

  private async loadTocInternal(bookId: string, requestedEdition: string | undefined, signal: AbortSignal, options: { refresh?: boolean }): Promise<TocResult> {
    throwIfAborted(signal)
    const book = await this.storage.getBook(bookId)
    if (book === undefined) throw new Error('书籍记录不存在')
    const known = await this.storage.listKnownSources(bookId)
    const edition = known.find((item) => item.editionKey === requestedEdition) ?? known.find((item) => item.editionKey === book.activeEditionKey) ?? known[0]
    if (edition === undefined) throw new Error('书籍没有已知书源')
    const source = this.requireSource(edition)
    const session = this.requireSession(source)
    const previousSnapshot = await this.storage.getTocSnapshot(bookId, edition.editionKey)
    const reading = await this.storage.getReadingRecord(bookId)
    const metadata: BookMetadata = previousSnapshot?.bookAfter === undefined
      ? { sourceId: edition.sourceId, bookUrl: edition.bookUrl, ...(edition.name === undefined ? {} : { name: edition.name }), ...(edition.author === undefined ? {} : { author: edition.author }), ...(edition.intro === undefined ? {} : { intro: edition.intro }), ...(edition.coverUrl === undefined ? {} : { coverUrl: edition.coverUrl }), ...(edition.tocUrl === undefined ? {} : { tocUrl: edition.tocUrl }), ...(edition.lastChapter === undefined ? {} : { lastChapter: edition.lastChapter }), ...(edition.updateTime === undefined ? {} : { updateTime: edition.updateTime }), ...(edition.variable === undefined ? {} : { variable: edition.variable }), rawFields: edition.rawFields, traceRef: `stored:${edition.editionKey}`, emptyFields: [], fieldErrors: {} }
      : { ...previousSnapshot.bookAfter, sourceId: edition.sourceId, rawFields: { ...edition.rawFields, ...previousSnapshot.bookAfter.rawFields }, traceRef: `stored:${edition.editionKey}`, emptyFields: [...previousSnapshot.bookAfter.emptyFields], fieldErrors: { ...previousSnapshot.bookAfter.fieldErrors } }
    const capture = new DebugCapture({ sourceId: source.id, sourceName: source.source.bookSourceName, mode: 'light' })
    const result = await session.toc(metadata, signal, options, capture).finally(() => {
      this.rememberEvidence('toc', capture)
      this.rememberEvidence(`toc:${bookId}:${edition.editionKey}`, capture)
    })
    throwIfAborted(signal)
    if (result.value === null) throw new Error(result.diagnostics[0]?.message ?? '目录加载失败')
    const reconciled = reconcileTableOfContents({
      chapters: result.value.items,
      ...(previousSnapshot === undefined ? {} : { previousChapters: previousSnapshot.chapters }),
      book: {
        totalChapterNum: previousSnapshot?.bookPatch.totalChapterNum ?? 0,
        durChapterIndex: reading?.positions[edition.editionKey]?.index ?? 0,
      },
      now: Date.now(),
      carryMetadata: true,
    })
    const revision = sha256(JSON.stringify(reconciled.chapters.map((item) => ({ url: item.url ?? item.chapterUrl, baseUrl: item.baseUrl, chapterUrl: item.chapterUrl, title: item.title }))))
    const bookAfter = result.value.bookAfter
    await this.storage.saveTocSnapshot(bookId, edition.editionKey, { editionKey: edition.editionKey, revision, chapters: reconciled.chapters, bookPatch: reconciled.bookPatch, ...(bookAfter === undefined ? {} : { bookAfter }), updatedAt: new Date().toISOString() })
    return { chapters: reconciled.chapters, revision, bookPatch: reconciled.bookPatch, changes: reconciled.changes, ...(bookAfter === undefined ? {} : { bookAfter }), source, edition }
  }

  public loadContent(bookId: string, chapter: Chapter, editionId?: string, signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string }): Promise<{ content: ChapterContent; source: SourceEntry; edition: KnownSource }> {
    return this.trackOperation(signal, (operationSignal) => this.loadContentInternal(bookId, chapter, editionId, operationSignal, options))
  }

  private async loadContentInternal(bookId: string, chapter: Chapter, editionId: string | undefined, signal: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string }): Promise<{ content: ChapterContent; source: SourceEntry; edition: KnownSource }> {
    throwIfAborted(signal)
    const book = await this.storage.getBook(bookId)
    if (book === undefined) throw new Error('书籍记录不存在')
    const known = await this.storage.listKnownSources(bookId)
    let edition = known.find((item) => item.editionKey === editionId) ?? known.find((item) => item.sourceId === chapter.sourceId && item.bookUrl === chapter.bookUrl)
    if (edition === undefined) {
      const candidates = known.filter((item) => item.sourceId === chapter.sourceId)
      for (const candidate of candidates) {
        const snapshot = await this.storage.getTocSnapshot(bookId, candidate.editionKey)
        if (snapshot?.bookAfter?.bookUrl === chapter.bookUrl) {
          edition = candidate
          break
        }
      }
    }
    if (edition === undefined) throw new Error('正文来源未记录')
    const source = this.requireSource(edition)
    const session = this.requireSession(source)
    const tocSnapshot = await this.storage.getTocSnapshot(bookId, edition.editionKey)
    const reading = await this.storage.getReadingRecord(bookId)
    const tocRevision = tocSnapshot?.revision ?? reading?.positions[edition.editionKey]?.tocRevision ?? ''
    const snapshotBook = tocSnapshot?.bookAfter
    const effectiveBookUrl = snapshotBook?.bookUrl ?? edition.bookUrl
    const contentIdentity: ContentIdentity = {
      sessionId: bookId,
      sourceId: edition.sourceId,
      bookUrl: effectiveBookUrl,
      chapterKey: chapterKey({ editionKey: edition.editionKey, tocRevision, chapterUrl: chapter.chapterUrl, index: chapter.index }),
      tocRevision,
      chapterIndex: chapter.index,
      resourceKind: 'text',
      sourceRevision: edition.sourceFingerprint,
      semanticVersion: 'source-core-content-v1',
    }
    const nextChapterUrl = options?.nextChapterUrl ?? nextChapterUrlFromSnapshot(tocSnapshot?.chapters, chapter)
    const metadata: BookMetadata = snapshotBook === undefined
      ? { sourceId: edition.sourceId, bookUrl: edition.bookUrl, ...(edition.name === undefined ? {} : { name: edition.name }), ...(edition.author === undefined ? {} : { author: edition.author }), ...(edition.intro === undefined ? {} : { intro: edition.intro }), ...(edition.coverUrl === undefined ? {} : { coverUrl: edition.coverUrl }), ...(edition.tocUrl === undefined ? {} : { tocUrl: edition.tocUrl }), ...(edition.lastChapter === undefined ? {} : { lastChapter: edition.lastChapter }), ...(edition.updateTime === undefined ? {} : { updateTime: edition.updateTime }), ...(edition.variable === undefined ? {} : { variable: edition.variable }), rawFields: edition.rawFields, traceRef: `stored:${edition.editionKey}`, emptyFields: [], fieldErrors: {} }
      : { ...snapshotBook, sourceId: edition.sourceId, rawFields: { ...edition.rawFields, ...snapshotBook.rawFields }, traceRef: `stored:${edition.editionKey}`, emptyFields: [...snapshotBook.emptyFields], fieldErrors: { ...snapshotBook.fieldErrors } }
    const capture = new DebugCapture({ sourceId: source.id, sourceName: source.source.bookSourceName, mode: 'light' })
    const contentChapter = metadata.bookUrl === chapter.bookUrl ? chapter : { ...chapter, bookUrl: metadata.bookUrl }
    const contentOptions = { ...(options ?? {}), ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }), contentStore: this.storage.contentStore(bookId), contentIdentity, operationId: randomUUID() }
    const result = await session.content(contentChapter, metadata, signal, contentOptions, capture).finally(() => {
      this.rememberEvidence('content', capture)
      this.rememberEvidence(`content:${bookId}:${edition.editionKey}`, capture)
    })
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
    const candidate: BookCandidate = { sourceId: target.sourceId, bookUrl: target.bookUrl, ...(target.name === undefined ? {} : { name: target.name }), ...(target.author === undefined ? {} : { author: target.author }), ...(target.intro === undefined ? {} : { intro: target.intro }), ...(target.coverUrl === undefined ? {} : { coverUrl: target.coverUrl }), ...(target.lastChapter === undefined ? {} : { lastChapter: target.lastChapter }), ...(target.updateTime === undefined ? {} : { updateTime: target.updateTime }), ...(target.variable === undefined ? {} : { variable: target.variable }), rawFields: target.rawFields, traceRef: `stored:${target.editionKey}` }
    const capture = new DebugCapture({ sourceId: source.id, sourceName: source.source.bookSourceName, mode: 'light' })
    const details = await session.detail(candidate, signal, capture).finally(() => {
      this.rememberEvidence('sources', capture)
      this.rememberEvidence('detail', capture)
    })
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

  private rememberEvidence(context: string, capture: DebugCapture): void {
    const separator = context.indexOf(':')
    if (separator > 0) {
      const prefix = `${context.slice(0, separator)}:`
      for (const key of this.evidence.keys()) if (key.startsWith(prefix) && key !== context) this.evidence.delete(key)
    }
    this.evidence.delete(context)
    this.evidence.set(context, capture)
    while (this.evidence.size > 16) this.evidence.delete(this.evidence.keys().next().value as string)
  }

  private requireSession(source: SourceEntry): ReaderSourceSession {
    const session = this.sessions.get(source.id)
    if (session === undefined) throw new Error('书源当前不可用')
    return session
  }
}

function toKnownSource(result: SearchResult, selected: SearchResult, isSelected: boolean): KnownSource {
  const candidate = result.candidate
  return { editionKey: editionKey(candidate.sourceId, candidate.bookUrl), sourceId: candidate.sourceId, sourceFingerprint: result.source.fingerprint, bookUrl: candidate.bookUrl, ...(candidate.name === undefined ? {} : { name: candidate.name }), ...(candidate.author === undefined ? {} : { author: candidate.author }), ...(candidate.intro === undefined ? {} : { intro: candidate.intro }), ...(candidate.coverUrl === undefined ? {} : { coverUrl: candidate.coverUrl }), ...(candidate.lastChapter === undefined ? {} : { lastChapter: candidate.lastChapter }), ...(candidate.updateTime === undefined ? {} : { updateTime: candidate.updateTime }), ...(candidate.variable === undefined ? {} : { variable: candidate.variable }), ...(result.searchDurationMs === undefined ? {} : { searchDurationMs: result.searchDurationMs }), rawFields: candidate.rawFields, discoveredAt: new Date().toISOString(), searchId: result.searchId, matchKind: isSelected ? 'selected' : normalizeAuthor(candidate.author) !== '' && normalizeAuthor(candidate.author) === normalizeAuthor(selected.candidate.author) ? 'title-author' : 'title-only' }
}

function updateBook(book: BookDocument, metadata: BookMetadata, activeEditionKey: string, timestamp: string): BookDocument {
  return { ...book, name: metadata.name ?? book.name, ...(metadata.author === undefined ? {} : { author: metadata.author }), ...(metadata.intro === undefined ? {} : { intro: metadata.intro }), ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }), ...(metadata.tocUrl === undefined ? {} : { tocUrl: metadata.tocUrl }), activeEditionKey, metadataEditionKey: activeEditionKey, updatedAt: timestamp }
}

function mergeMetadataIntoSource(source: KnownSource, metadata: BookMetadata): KnownSource {
  return { ...source, ...(metadata.name === undefined ? {} : { name: metadata.name }), ...(metadata.author === undefined ? {} : { author: metadata.author }), ...(metadata.intro === undefined ? {} : { intro: metadata.intro }), ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }), ...(metadata.tocUrl === undefined ? {} : { tocUrl: metadata.tocUrl }), ...(metadata.lastChapter === undefined ? {} : { lastChapter: metadata.lastChapter }), ...(metadata.updateTime === undefined ? {} : { updateTime: metadata.updateTime }), ...(metadata.variable === undefined ? {} : { variable: metadata.variable }), rawFields: { ...source.rawFields, ...metadata.rawFields } }
}

function nextChapterUrlFromSnapshot(chapters: readonly Chapter[] | undefined, current: Chapter): string | undefined {
  if (chapters === undefined || chapters.length === 0) return undefined
  const currentIndex = Number.isInteger(current.index) && current.index >= 0 && chapters[current.index]?.chapterUrl === current.chapterUrl
    ? current.index
    : chapters.findIndex((item) => item.chapterUrl === current.chapterUrl)
  if (currentIndex < 0) return undefined
  const next = chapters[(currentIndex + 1) % chapters.length]
  if (next === undefined || next.chapterUrl.length === 0) return undefined
  return next.url?.trim() || next.chapterUrl
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeSourceSearchTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error('书源搜索超时必须是正整数毫秒数')
  return timeout
}

function sourceSearchDeadline(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const relay = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', relay, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', relay) },
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
}

function sha256(value: string): string {
  let hash = 0n
  for (const character of value) hash = (hash * 131n + BigInt(character.codePointAt(0) ?? 0)) % 0xffffffffffffffffn
  return hash.toString(16).padStart(16, '0')
}
