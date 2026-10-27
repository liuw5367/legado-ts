import { SOURCE_EXECUTION_MS, SEARCH_BATCH_MS } from './source-execution.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_SEARCH_CONCURRENCY, searchConcurrencySchema } from '../../shared/search-settings.ts'
import { ReaderRuntimeError, requireSource, withPersistentSourceSession } from './source-session.ts'
import { bookIdentityKey, normalizeIdentity, sameBookIdentity } from '../../shared/book-identity.ts'
import type { BookCoverSelection, BookSourceItem, BookSourcesResponse, SourceCacheWarning } from '../../shared/book-sources.ts'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { editionKey as sharedEditionKey } from '@legado/reader-backup'
import { loadBookDetails, loadChapterContent, loadReviewDetail, loadReviewReplies, loadReviewSummary, loadTableOfContents, searchBooks } from '@legado/source-core'
import type { BookMetadata, Chapter, ChapterContent, NormalizedSource, ReviewDetailPage, ReviewSummaryItem, WorkflowStatus } from '@legado/source-core'
import { compareSourceListPriority, type SourceListRecord, type ReaderRepository, type StoredSourceRecord } from '../db/repository.ts'
import { configuredSecret } from '../db/runtime-state-crypto.ts'
import type { BookCreationInput, SearchBatchResult, SearchRunState, SourceSearchState, StoredBook, StoredCandidate, StoredContent, StoredEdition, StoredToc } from '../domain/types.ts'
import { acceptsPrecisionSearchFields, orderSearchCandidates } from './search-candidates.ts'

export { ReaderRuntimeError } from './source-session.ts'

const TRUNCATED_TOC_WARNING = '目录分页超过上限，已截断；请刷新重试或联系书源作者。'
const TRUNCATED_CONTENT_WARNING = '正文分页超过上限，已截断；请刷新重试。'

/** 缓存的正文记录本身带 truncated；命中缓存时也要提示，不能只在首次抓取时提示一次。 */
function withTruncatedContentWarning(content: StoredContent & { runtimeWarning?: string }): StoredContent & { runtimeWarning?: string } {
  if (content.content.truncated !== true || content.runtimeWarning !== undefined) return content
  return { ...content, runtimeWarning: TRUNCATED_CONTENT_WARNING }
}

/** 目录快照把抓取时的截断状态落库；缓存命中时据此继续提示。 */
function withTruncatedTocWarning(toc: StoredToc & { runtimeWarning?: string }): StoredToc & { runtimeWarning?: string } {
  if (toc.truncated !== true || toc.runtimeWarning !== undefined) return toc
  return { ...toc, runtimeWarning: TRUNCATED_TOC_WARNING }
}

export interface SearchCandidateIdentity { sourceId: string; sourceFingerprint: string; bookUrl: string }
export interface SearchBatchOptions { sourceIds?: string[]; nextPage?: boolean; signal?: AbortSignal; onProgress?: (progress: SearchRunState['progress']) => Promise<void> | void }
export type SearchSourceListener = (source: SourceSearchState, search: SearchRunState) => Promise<void> | void

export interface ReaderRuntime {
  listSources(userId: string): Promise<SourceListRecord[]>
  runSearchBatch(userId: string, searchId: string, options?: SearchBatchOptions): Promise<SearchBatchResult>
  runSearchBatchStream(userId: string, searchId: string, listener: SearchSourceListener, options?: SearchBatchOptions): Promise<SearchBatchResult>
  cancelSearch(userId: string, searchId: string): Promise<SearchRunState | null>
  createBookFromSearch(userId: string, searchId: string, candidateIndex: number, bookId?: string, addToBookshelf?: boolean, activateEdition?: boolean, candidateIdentity?: SearchCandidateIdentity): Promise<{ book: StoredBook; edition: StoredEdition; cacheWarning?: SourceCacheWarning }>
  listBookSources(userId: string, bookId: string): Promise<BookSourcesResponse>
  openBookSource(userId: string, bookId: string, candidateId: string, signal?: AbortSignal): Promise<StoredEdition>
  setBookCover(userId: string, bookId: string, selection: BookCoverSelection | null): Promise<StoredBook>
  getOrLoadToc(userId: string, bookId: string, editionKey: string, refresh?: boolean): Promise<StoredToc & { runtimeWarning?: string }>
  getOrLoadContent(userId: string, bookId: string, editionKey: string, chapterId: string, refresh?: boolean): Promise<StoredContent & { runtimeWarning?: string }>
  getReviewSummary(userId: string, bookId: string, editionKey: string, chapterId: string): Promise<ReviewSummaryItem[]>
  getReviewDetail(userId: string, bookId: string, editionKey: string, chapterId: string, paragraphIndex: number, paragraphData?: string, cursor?: { index: number; token?: string }): Promise<ReviewDetailPage>
  getReviewReplies(userId: string, bookId: string, editionKey: string, chapterId: string, paragraphIndex: number, reviewId: string, paragraphData?: string, cursor?: { index: number; token?: string }): Promise<ReviewDetailPage>
}

const activeSearches = new Map<string, { operationId: string; controller: AbortController }>()
type ReviewCursor = { index: number; token?: string }
type ReviewCursorScope = { kind: 'detail' | 'replies'; userId: string; bookId: string; editionKey: string; chapterId: string; sourceId: string; sourceFingerprint: string; paragraphIndex: number; paragraphData: string; reviewId: string | null }

export function createReaderRuntime(repository: ReaderRepository): ReaderRuntime {
  return {
    listSources: (userId) => repository.listSourceSummaries(userId),
    runSearchBatch: (userId, searchId, options) => runSearchBatch(repository, userId, searchId, options),
    runSearchBatchStream: (userId, searchId, listener, options) => runSearchBatchStream(repository, userId, searchId, listener, options),
    cancelSearch: (userId, searchId) => cancelSearch(repository, userId, searchId),
    createBookFromSearch: (userId, searchId, candidateIndex, bookId, addToBookshelf, activateEdition, candidateIdentity) => createBookFromSearch(repository, userId, searchId, candidateIndex, bookId, addToBookshelf, activateEdition, candidateIdentity),
    listBookSources: (userId, bookId) => listBookSources(repository, userId, bookId),
    openBookSource: (userId, bookId, candidateId, signal) => openBookSource(repository, userId, bookId, candidateId, signal),
    setBookCover: (userId, bookId, selection) => setBookCover(repository, userId, bookId, selection),
    getOrLoadToc: (userId, bookId, editionKey, refresh) => getOrLoadToc(repository, userId, bookId, editionKey, refresh),
    getOrLoadContent: (userId, bookId, editionKey, chapterId, refresh) => getOrLoadContent(repository, userId, bookId, editionKey, chapterId, refresh),
    getReviewSummary: (userId, bookId, editionKey, chapterId) => getReviewSummary(repository, userId, bookId, editionKey, chapterId),
    getReviewDetail: (userId, bookId, editionKey, chapterId, paragraphIndex, paragraphData, cursor) => getReviewDetail(repository, userId, bookId, editionKey, chapterId, paragraphIndex, paragraphData, cursor),
    getReviewReplies: (userId, bookId, editionKey, chapterId, paragraphIndex, reviewId, paragraphData, cursor) => getReviewReplies(repository, userId, bookId, editionKey, chapterId, paragraphIndex, reviewId, paragraphData, cursor),
  }
}

async function runSearchBatch(repository: ReaderRepository, userId: string, searchId: string, options?: SearchBatchOptions): Promise<SearchBatchResult> {
  return executeSearchBatch(repository, userId, searchId, undefined, options)
}

async function runSearchBatchStream(repository: ReaderRepository, userId: string, searchId: string, listener: SearchSourceListener, options?: SearchBatchOptions): Promise<SearchBatchResult> {
  return executeSearchBatch(repository, userId, searchId, listener, options)
}

async function executeSearchBatch(repository: ReaderRepository, userId: string, searchId: string, listener?: SearchSourceListener, options?: SearchBatchOptions): Promise<SearchBatchResult> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) throw new ReaderRuntimeError('not-found', '搜索任务不存在')
  const states = prepareSourceStates(run, options)
  if (run.status !== 'running' && options?.nextPage !== true) return { search: run, candidates: run.candidates, sourceResults: run.sourceStates, sourceStatus: toBatchStatus(run.status), progress: run.progress, diagnostics: [] }
  const preservedCandidates = preserveCandidates(run, states, options)
  if (activeSearches.has(searchId)) throw new ReaderRuntimeError('source-busy', '该搜索正在执行')
  const operationId = randomUUID()
  const controller = new AbortController()
  activeSearches.set(searchId, { operationId, controller })
  let operationReleased = false
  try {
    let current = await repository.claimSearch(userId, searchId, operationId, states, { completed: completedCount(states), total: states.length }, run.version, run)
    if (current === null) throw new ReaderRuntimeError('source-busy', '该搜索正在执行')
    const sourceRank = new Map(run.sourceIds.map((sourceId, index) => [sourceId, index]))
    const orderCandidates = () => orderSearchCandidates(run.keyword, [...preservedCandidates, ...states.flatMap((item) => item.candidates)], run.precision === true, sourceRank)
    const indices = new Map(states.map((state, index) => [state.sourceId, index]))
    const pending = states.filter((state) => state.status === 'pending')
    const concurrency = searchConcurrencySchema.catch(DEFAULT_SEARCH_CONCURRENCY).parse((await repository.getSettings(userId)).general.searchConcurrency)
    const started = Date.now()
    let nextIndex = 0
    let noCapacity = false
    let dirty = false
    let serialized = Promise.resolve()
    const events: SourceSearchState[] = []
    const activeSources = new Map<string, string>()
    const progress = () => ({ completed: completedCount(states), total: states.length, activeSources: [...activeSources.values()] })
    const disconnect = () => controller.abort()
    const waitForRefill = () => delay(1000, undefined, { signal: controller.signal }).catch((error: unknown) => { if (!controller.signal.aborted) throw error })
    options?.signal?.addEventListener('abort', disconnect, { once: true })
    if (options?.signal?.aborted) controller.abort()
    const flush = () => {
      serialized = serialized.then(async () => {
        if (!dirty) return
        dirty = false
        const completed = events.splice(0)
        const saved = await repository.updateSearch(userId, searchId, { knownRun: current!, sourceStates: states.map((state) => ({ ...state })), candidates: orderCandidates(), status: 'running', expectedOperationId: operationId, operationId, progress: { completed: completedCount(states), total: states.length } })
        if (!saved) { controller.abort(); const latest = await repository.getSearch(userId, searchId); if (latest?.cancelled) return; throw new ReaderRuntimeError('source-busy', '搜索操作已失效') }
        saved.progress = progress()
        current = saved
        for (const state of completed) await listener?.(state, saved)
      })
      return serialized
    }
    try {
      // 按冻结的优先级持续补位，不等待同批慢书源；请求预算到期后由客户端续接。
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        try {
        while (!controller.signal.aborted && Date.now() - started < SEARCH_BATCH_MS - SOURCE_EXECUTION_MS) {
          const state = pending[nextIndex++]
          if (!state) return
          let lease = await repository.acquireExecutionSlot(userId, operationId)
          if (!lease && !controller.signal.aborted) {
            await waitForRefill()
            if (controller.signal.aborted) return
            lease = await repository.acquireExecutionSlot(userId, operationId)
          }
          if (!lease) { noCapacity = true; return }
          try {
            if (controller.signal.aborted || Date.now() - started >= SEARCH_BATCH_MS - SOURCE_EXECUTION_MS) return
            const deadline = new AbortController()
            const timeout = setTimeout(() => deadline.abort(new DOMException('书源执行超时', 'TimeoutError')), SOURCE_EXECUTION_MS)
            const signal = AbortSignal.any([controller.signal, deadline.signal])
            let outcome: Awaited<ReturnType<typeof runOneSource>>
            try { outcome = await runOneSource(repository, current!, state, signal, async (name) => {
              activeSources.set(state.sourceId, name)
              await options?.onProgress?.(progress())
            }) } finally { clearTimeout(timeout); deadline.abort() }
            // 断线只暂停当前批次，显式 cancel 由持久化状态负责终止整次搜索。
            if (controller.signal.aborted && options?.signal?.aborted) continue
            states[indices.get(state.sourceId)!] = outcome.state
            activeSources.delete(state.sourceId)
            dirty = true; events.push(outcome.state)
            await flush()
          } finally { await repository.releaseExecutionSlot(userId, lease) }
          if (nextIndex < pending.length && !controller.signal.aborted) await waitForRefill()
        }
        } catch (error) { controller.abort(); throw error }
      }))
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      await flush()
    } finally {
      options?.signal?.removeEventListener('abort', disconnect)
    }
    const candidates = current.candidates
    const latestState = controller.signal.aborted ? await repository.getSearch(userId, searchId) : null
    const cancelled = latestState?.cancelled === true
    const hasPending = !cancelled && states.some((state) => state.status === 'pending')
    const aggregate = cancelled ? 'cancelled' : aggregateStatus(states, 'success', candidates.length)
    const finalStatus: SearchRunState['status'] = aggregate === 'capability-missing' ? 'failed' : aggregate === 'running' ? 'running' : aggregate
    current = await repository.updateSearch(userId, searchId, { knownRun: current, sourceStates: states, candidates, status: finalStatus, expectedOperationId: operationId, operationId: null, progress: { completed: completedCount(states), total: states.length }, cancelled: finalStatus === 'cancelled' })
    if (current === null) { const latest = await repository.getSearch(userId, searchId); if (latest !== null && latest.cancelled) { const warning = await cacheSearchSources(repository, userId, latest.candidates); return { search: latest, candidates: latest.candidates, sourceResults: latest.sourceStates, sourceStatus: 'cancelled', progress: latest.progress, diagnostics: [], ...warning } }; throw new ReaderRuntimeError('source-busy', '搜索操作已失效') }
    operationReleased = true
    current.progress = progress()
    return { search: current, candidates: current.candidates, sourceResults: states, sourceStatus: toBatchStatus(finalStatus), progress: current.progress, hasPending, ...(noCapacity ? { retryAfterMs: 1000 } : {}), diagnostics: states.flatMap((item) => item.diagnostics), ...(!hasPending ? await cacheSearchSources(repository, userId, current.candidates) : {}) }
  } finally {
    controller.abort()
    try { if (!operationReleased) await repository.updateSearch(userId, searchId, { knownRun: run, expectedOperationId: operationId, operationId: null }) }
    finally { activeSearches.delete(searchId) }
  }
}

async function runOneSource(repository: ReaderRepository, run: SearchRunState, state: SourceSearchState, signal: AbortSignal, onStart?: (name: string) => Promise<void>): Promise<{ state: SourceSearchState; additions: StoredCandidate[] }> {
  const startedAt = new Date().toISOString()
  let source: StoredSourceRecord
  try { source = await requireSource(repository, run.userId, state.sourceId) } catch (error) { return { additions: [], state: { ...state, status: 'failed', diagnostics: [{ message: error instanceof Error ? error.message : '书源不可用' }], startedAt, completedAt: new Date().toISOString() } } }
  if ((state.sourceRevision && source.sourceRevision !== state.sourceRevision) || (state.sourceFingerprint && source.fingerprint !== state.sourceFingerprint)) return { additions: [], state: { ...state, status: 'failed', diagnostics: [{ code: 'stale', message: '书源已变化，本次搜索跳过' }], startedAt, completedAt: new Date().toISOString() } }
  await onStart?.(source.name)
  try {
    const result = await withPersistentSourceSession(repository, run.userId, source, (session) => session.run((ports) => searchBooks(ports, { source: source.normalizedSource, keyword: run.keyword, ...(run.precision === true ? { acceptSearchFields: (fields) => acceptsPrecisionSearchFields(run.keyword, fields) } : {}), ...(state.cursor === undefined ? {} : { cursor: state.cursor }), signal, maxItems: 100 })))
    const searchDurationMs = Math.max(0, Date.now() - Date.parse(startedAt))
    const additions = (result.value?.items ?? []).map((candidate) => ({ sourceId: source.sourceId, sourceOrder: run.sourceIds.indexOf(source.sourceId), sourceFingerprint: source.fingerprint, searchDurationMs, candidate }))
    const timedOut = signal.aborted && signal.reason?.name === 'TimeoutError'
    const status = timedOut ? 'failed' : result.status === 'capability-missing' ? 'capability-missing' : result.status
    const nextState = { ...state }
    delete nextState.nextCursor
    return { additions, state: { ...nextState, sourceFingerprint: source.fingerprint, status, candidates: additions, ...(result.value?.cursor === undefined ? {} : { cursor: result.value.cursor }), ...(result.value?.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }), diagnostics: timedOut ? [...result.diagnostics, { code: 'source-timeout', message: '书源执行超时' }] : result.diagnostics, startedAt, completedAt: new Date().toISOString() } }
  } catch (error) {
    if (signal.aborted) return { additions: [], state: { ...state, status: signal.reason?.name === 'TimeoutError' ? 'failed' : 'cancelled', diagnostics: [{ message: signal.reason?.name === 'TimeoutError' ? '书源执行超时' : '搜索已取消' }], startedAt, completedAt: new Date().toISOString() } }
    return { additions: [], state: { ...state, sourceFingerprint: source.fingerprint, status: 'failed', diagnostics: [{ message: error instanceof Error ? error.message : '书源执行失败' }], startedAt, completedAt: new Date().toISOString() } }
  }
}

async function cancelSearch(repository: ReaderRepository, userId: string, searchId: string): Promise<SearchRunState | null> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) return null
  activeSearches.get(searchId)?.controller.abort()
  const states = run.sourceStates.map((state) => state.status === 'pending' || state.status === 'running' ? { ...state, status: 'cancelled' as const, completedAt: new Date().toISOString() } : state)
  return repository.updateSearch(userId, searchId, { knownRun: run, status: 'cancelled', sourceStates: states, operationId: null, cancelled: true, progress: { completed: completedCount(states), total: states.length } })
}

function prepareSourceStates(run: SearchRunState, options?: SearchBatchOptions): SourceSearchState[] {
  const states: SourceSearchState[] = run.sourceStates.length > 0 ? run.sourceStates.map((state) => ({ ...state })) : run.sourceIds.map((sourceId) => ({ sourceId, status: 'pending' as const, candidates: [], diagnostics: [] }))
  if (options?.nextPage !== true) return states
  const selected = options.sourceIds === undefined ? states : states.filter((state) => options.sourceIds?.includes(state.sourceId) === true)
  for (const state of selected) if (state.nextCursor !== undefined) {
    state.cursor = state.nextCursor
    delete state.nextCursor
    state.status = 'pending'
    state.candidates = []
    state.diagnostics = []
  }
  return states
}

function preserveCandidates(run: SearchRunState, states: SourceSearchState[], options?: SearchBatchOptions): StoredCandidate[] {
  if (options?.nextPage !== true) return []
  const resetSources = new Set(states.filter((state) => state.status === 'pending').map((state) => state.sourceId))
  return run.candidates.filter((candidate) => resetSources.has(candidate.sourceId))
}

function completedCount(states: SourceSearchState[]): number { return states.filter((state) => state.status !== 'pending' && state.status !== 'running').length }
function aggregateStatus(states: SourceSearchState[], fallback: SearchRunState['status'] | 'running', candidateCount = states.flatMap((state) => state.candidates).length): SearchRunState['status'] | 'running' | 'capability-missing' { if (states.some((state) => state.status === 'pending' || state.status === 'running')) return 'running'; if (states.every((state) => state.status === 'cancelled')) return 'cancelled'; const success = states.some((state) => state.status === 'success' || state.status === 'empty' || state.status === 'partial'); const failed = states.some((state) => state.status === 'failed' || state.status === 'capability-missing'); if (failed && success) return 'partial'; if (failed) return fallback === 'cancelled' ? 'cancelled' : states.some((state) => state.status === 'capability-missing') ? 'capability-missing' : 'failed'; if (candidateCount === 0) return 'empty'; return 'success' }
function toBatchStatus(status: SearchRunState['status'] | 'running' | 'capability-missing'): SearchBatchResult['sourceStatus'] { return status === 'running' ? 'partial' : status }

async function createBookFromSearch(repository: ReaderRepository, userId: string, searchId: string, candidateIndex: number, bookId?: string, addToBookshelf = true, activateEdition = true, candidateIdentity?: SearchCandidateIdentity): Promise<{ book: StoredBook; edition: StoredEdition; cacheWarning?: SourceCacheWarning }> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) throw new ReaderRuntimeError('not-found', '搜索任务不存在')
  const targetBook = bookId === undefined ? null : await repository.getBook(userId, bookId)
  if (bookId !== undefined && targetBook === null) throw new ReaderRuntimeError('not-found', '目标书籍不存在')
  // 流式排序会改变索引；新客户端以来源、版本和URL匹配服务端保存的候选。
  const stored = candidateIdentity === undefined ? run.candidates[candidateIndex] : run.candidates.find((item) => item.sourceId === candidateIdentity.sourceId && item.sourceFingerprint === candidateIdentity.sourceFingerprint && item.candidate.bookUrl === candidateIdentity.bookUrl)
  if (stored === undefined) throw new ReaderRuntimeError('invalid-input', '搜索结果索引无效')
  if (targetBook !== null && !matchesBookTarget(targetBook, stored.candidate)) throw new ReaderRuntimeError('invalid-input', '搜索结果与目标书籍不匹配')
  const source = await requireSource(repository, userId, stored.sourceId)
  if (source.fingerprint !== stored.sourceFingerprint) throw new ReaderRuntimeError('configuration', '书源定义已更新，请重新搜索')
  const created = await withPersistentSourceSession(repository, userId, source, async (session) => {
    const result = await session.run((ports) => loadBookDetails(ports, { source: source.normalizedSource, candidates: [stored.candidate], maxItems: 1 }))
    const metadata = result.value?.items[0]
    if (metadata === undefined) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '没有读取到书籍详情'))
    if (targetBook !== null && !matchesBookTarget(targetBook, metadata)) throw new ReaderRuntimeError('invalid-input', '来源详情与目标书籍不匹配')
    const candidate: BookCreationInput['candidate'] = stored
    const editionKey = sharedEditionKey(stored.sourceId, metadata.bookUrl)
    return repository.createBook(userId, { candidate, metadata: { ...metadata, ...(stored.searchDurationMs === undefined ? {} : { searchDurationMs: stored.searchDurationMs }) }, editionKey, sourceFingerprint: stored.sourceFingerprint, addToBookshelf, activateEdition, ...(bookId === undefined ? {} : { bookId }) })
  })
  // 重新读取已提交结果，与批次结束后的书架读取互补，覆盖两种完成顺序。
  return { ...created, ...(await cacheSearchSources(repository, userId, run.candidates, searchId)) }
}

/** 缺失作者只允许用户明确指定目标书籍的同名候选，自动缓存仍要求完整身份。 */
function matchesBookTarget(book: StoredBook, candidate: { name?: string; author?: string }): boolean {
  return bookIdentityKey(book.name, book.author) === undefined
    ? normalizeIdentity(book.name) === normalizeIdentity(candidate.name ?? '')
    : sameBookIdentity(book.name, book.author, candidate.name, candidate.author)
}

/** 缓存是附加结果，失败时主书架/搜索提交仍然有效。 */
async function cacheSearchSources(repository: ReaderRepository, userId: string, candidates: StoredCandidate[], searchId?: string): Promise<{ cacheWarning?: SourceCacheWarning }> {
  try {
    if (searchId !== undefined) candidates = (await repository.getSearch(userId, searchId))?.candidates ?? candidates
    const home = await repository.getHome(userId)
    const grouped = new Map<string, StoredCandidate[]>()
    for (const candidate of candidates) {
      const key = bookIdentityKey(candidate.candidate.name, candidate.candidate.author)
      if (key === undefined) continue
      const group = grouped.get(key) ?? []
      group.push(candidate); grouped.set(key, group)
    }
    for (const { book } of home.bookshelf) {
      const key = bookIdentityKey(book.name, book.author)
      if (key === undefined) continue
      const matches = grouped.get(key)
      if (matches !== undefined) await repository.saveBookSourceCandidates(userId, book.id, matches)
    }
    return {}
  } catch {
    console.warn('书籍来源缓存写入失败')
    return { cacheWarning: { code: 'source-cache-failed', message: '来源缓存失败，请再次搜索更新。' } }
  }
}

async function listBookSources(repository: ReaderRepository, userId: string, bookId: string): Promise<BookSourcesResponse> {
  const book = await repository.getBook(userId, bookId)
  if (book === null) throw new ReaderRuntimeError('not-found', '书籍不存在')
  const [editions, candidates] = await Promise.all([repository.listEditions(userId, bookId), repository.listBookSourceCandidates(userId, bookId)])
  const summaries = await repository.listSourceSummaries(userId, [...new Set([...editions, ...candidates].map((item) => item.sourceId))])
  const sources = new Map(summaries.map((source) => [source.sourceId, source]))
  const result = new Map<string, BookSourceItem>()
  for (const item of candidates) {
    const source = sources.get(item.sourceId)
    if (source?.fingerprint !== item.sourceFingerprint) continue
    result.set(JSON.stringify([item.sourceId, item.sourceFingerprint, item.bookUrl]), { sourceId: item.sourceId, sourceFingerprint: item.sourceFingerprint, name: source.name, bookUrl: item.bookUrl, sourceEnabled: source.enabled, status: 'discovered', candidateId: item.id, ...(item.candidate.searchDurationMs === undefined ? {} : { searchDurationMs: item.candidate.searchDurationMs }), ...(item.candidate.candidate.coverUrl ? { coverUrl: item.candidate.candidate.coverUrl } : {}), ...(item.candidate.candidate.lastChapter ? { lastChapter: item.candidate.candidate.lastChapter } : {}) })
  }
  for (const edition of editions) {
    const source = sources.get(edition.sourceId)
    if (source?.fingerprint !== edition.sourceFingerprint) continue
    const key = JSON.stringify([edition.sourceId, edition.sourceFingerprint, edition.bookUrl])
    const searchDurationMs = result.get(key)?.searchDurationMs ?? edition.metadata.searchDurationMs
    const lastChapter = result.get(key)?.lastChapter ?? edition.metadata.lastChapter
    result.set(key, { sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, name: source.name, bookUrl: edition.bookUrl, sourceEnabled: source.enabled, status: 'saved', editionKey: edition.editionKey, ...(typeof searchDurationMs === 'number' ? { searchDurationMs } : {}), ...(edition.metadata.coverUrl ? { coverUrl: edition.metadata.coverUrl } : {}), ...(lastChapter ? { lastChapter } : {}) })
  }
  const items = [...result.values()].sort((left, right) => compareSourceListPriority(sources.get(left.sourceId)!, sources.get(right.sourceId)!))
  return { sources: items, ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey }) }
}

async function setBookCover(repository: ReaderRepository, userId: string, bookId: string, selection: BookCoverSelection | null): Promise<StoredBook> {
  if (await repository.getBook(userId, bookId) === null) throw new ReaderRuntimeError('not-found', '书籍不存在')
  let coverUrl: string | null = null
  if (selection !== null) {
    // 仅解析服务端缓存的同书来源，客户端不能提交任意图片 URL。
    const sources = await listBookSources(repository, userId, bookId)
    const source = sources.sources.find((item) => item.sourceId === selection.sourceId && item.sourceFingerprint === selection.sourceFingerprint && item.bookUrl === selection.bookUrl)
    if (source === undefined) throw new ReaderRuntimeError('invalid-input', '来源已失效，请重新打开封面选择')
    coverUrl = source.coverUrl || null
    if (coverUrl === null) throw new ReaderRuntimeError('invalid-input', '该来源没有可用封面')
  }
  const book = await repository.setCustomCover(userId, bookId, coverUrl)
  if (book === null) throw new ReaderRuntimeError('not-found', '书籍不存在')
  return book
}

async function openBookSource(repository: ReaderRepository, userId: string, bookId: string, candidateId: string, signal?: AbortSignal): Promise<StoredEdition> {
  signal?.throwIfAborted()
  const book = await repository.getBook(userId, bookId)
  const cached = (await repository.listBookSourceCandidates(userId, bookId)).find((item) => item.id === candidateId)
  if (book === null || cached === undefined) throw new ReaderRuntimeError('not-found', '书籍来源不存在')
  const source = await requireSource(repository, userId, cached.sourceId)
  if (source.fingerprint !== cached.sourceFingerprint) throw new ReaderRuntimeError('configuration', '书源定义已更新，请重新搜索')
  const existing = (await repository.listEditions(userId, bookId)).find((item) => item.sourceId === cached.sourceId && item.sourceFingerprint === cached.sourceFingerprint && item.bookUrl === cached.bookUrl)
  if (existing !== undefined) return existing
  const lease = await repository.acquireExecutionSlot(userId, randomUUID())
  if (lease === null) throw new ReaderRuntimeError('source-busy', '服务器繁忙，请稍后重试')
  const executionSignal = signal === undefined ? AbortSignal.timeout(SOURCE_EXECUTION_MS) : AbortSignal.any([signal, AbortSignal.timeout(SOURCE_EXECUTION_MS)])
  try {
    return await withPersistentSourceSession(repository, userId, source, async (session) => {
      executionSignal.throwIfAborted()
      // 预览新来源时核验详情身份，不能让搜索字段掩盖详情中不同的书名作者。
      const result = await session.run((ports) => loadBookDetails(ports, { source: { ...source.normalizedSource, ruleBookInfo: { ...(typeof source.normalizedSource.ruleBookInfo === 'object' && source.normalizedSource.ruleBookInfo !== null ? source.normalizedSource.ruleBookInfo : {}), canReName: 'true' } }, candidates: [cached.candidate.candidate], maxItems: 1, signal: executionSignal }))
      executionSignal.throwIfAborted()
      const metadata = result.value?.items[0]
      if (metadata === undefined) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '没有读取到书籍详情'))
      if (!sameBookIdentity(book.name, book.author, metadata.name, metadata.author)) throw new ReaderRuntimeError('source-failed', '来源详情与书籍不匹配，请重新搜索')
      const editionKey = sharedEditionKey(cached.sourceId, metadata.bookUrl)
      executionSignal.throwIfAborted()
      return repository.saveEdition(userId, bookId, { candidate: cached.candidate, metadata: { ...metadata, ...(cached.candidate.searchDurationMs === undefined ? {} : { searchDurationMs: cached.candidate.searchDurationMs }) }, editionKey, sourceFingerprint: cached.sourceFingerprint })
    })
  } finally { await repository.releaseExecutionSlot(userId, lease) }
}

async function getOrLoadToc(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, refresh = false): Promise<StoredToc & { runtimeWarning?: string }> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, userId, edition.sourceId)
  if (!refresh) {
    const cached = await repository.getToc(userId, bookId, editionKey)
    if (cached !== null && cached.sourceFingerprint === source.fingerprint) return withTruncatedTocWarning(cached)
  }
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    const result = await session.run((ports) => loadTableOfContents(ports, { source: source.normalizedSource, book: edition.metadata, refresh, maxPages: 200 }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '目录读取失败'))
    const chapters = result.value.items
    const revision = digest(JSON.stringify(chapters))
    const bookAfter = result.value.bookAfter
    const bookPatch = createBookPatch(chapters)
    const saved = await repository.saveToc(userId, { userId, bookId, editionKey, sourceFingerprint: source.fingerprint, revision, chapters, bookPatch, truncated: result.value.truncated === true, ...(bookAfter === undefined ? {} : { bookAfter }) })
    // 截断的目录不能静默当成完整目录；保留已解析章节，同时把原因交给客户端。
    return result.value.truncated === true ? { ...saved, runtimeWarning: TRUNCATED_TOC_WARNING } : saved
  })
}

async function getOrLoadContent(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string, refresh = false): Promise<StoredContent & { runtimeWarning?: string }> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, userId, edition.sourceId)
  const toc = await repository.getChapterContext(userId, bookId, editionKey, chapterId)
  if (toc === null) throw new ReaderRuntimeError('not-found', '目录尚未加载')
  const chapter = toc.chapter
  if (chapter === undefined) throw new ReaderRuntimeError('not-found', '章节不存在')
  if (!refresh) {
    const cached = await repository.getContent(userId, editionKey, toc.revision, chapterId)
    if (cached !== null && cached.sourceFingerprint === source.fingerprint) return withTruncatedContentWarning(cached)
  }
  const nextChapterUrl = toc.nextChapterUrl
  let loaded: StoredContent | undefined
  try {
    return await withPersistentSourceSession(repository, userId, source, async (session) => {
      const result = await session.run((ports) => loadChapterContent(ports, {
        source: source.normalizedSource,
        book: edition.metadata,
        chapter,
        ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }),
        maxPages: 200,
        maxOutputBytes: 4 * 1024 * 1024,
      }))
      if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '正文读取失败'))
      loaded = await repository.saveContent(userId, { userId, bookId, editionKey, chapterId, tocRevision: toc.revision, sourceFingerprint: source.fingerprint, content: result.value })
      // 截断的正文保留已抓取内容，但必须让客户端知道这不是完整章节。
      return result.value.truncated === true ? { ...loaded, runtimeWarning: TRUNCATED_CONTENT_WARNING } : loaded
    })
  } catch (error) {
    // 仅保留本次请求已成功保存的正文，不能用旧缓存掩盖抓取或正文写入失败。
    if (loaded === undefined) throw error
    console.warn('[reader] source-session-finalization-failed', { bookId, chapterId, errorName: error instanceof Error ? error.name : 'UnknownError' })
    return { ...loaded, runtimeWarning: '正文已加载，但书源运行状态未能保存；后续章节如有异常，请重试。' }
  }
}

async function getReviewSummary(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string): Promise<ReviewSummaryItem[]> {
  const context = await getReviewContext(repository, userId, bookId, editionKey, chapterId)
  return withPersistentSourceSession(repository, userId, context.source, async (session) => {
    const result = await session.run((ports) => loadReviewSummary(ports, { source: context.source.normalizedSource, book: context.edition.metadata, chapter: context.chapter }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '段评统计读取失败'))
    return result.value
  })
}

async function getReviewDetail(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string, paragraphIndex: number, paragraphData?: string, cursor?: { index: number; token?: string }): Promise<ReviewDetailPage> {
  const context = await getReviewContext(repository, userId, bookId, editionKey, chapterId)
  const normalizedParagraphData = paragraphData?.trim() || String(paragraphIndex)
  const scope = reviewCursorScope('detail', userId, bookId, editionKey, chapterId, context.source, paragraphIndex, normalizedParagraphData)
  const verifiedCursor = isJavaScriptSource(context.source.normalizedSource) ? verifyJavaScriptReviewCursor(cursor) : verifyReviewCursor(scope, cursor)
  return withPersistentSourceSession(repository, userId, context.source, async (session) => {
    const result = await session.run((ports) => loadReviewDetail(ports, { source: context.source.normalizedSource, book: context.edition.metadata, chapter: context.chapter, paragraphIndex, paragraphData: normalizedParagraphData, ...(verifiedCursor === undefined ? {} : { cursor: verifiedCursor }) }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '段评详情读取失败'))
    return isJavaScriptSource(context.source.normalizedSource) ? result.value : signReviewPageCursor(result.value, scope)
  })
}

async function getReviewReplies(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string, paragraphIndex: number, reviewId: string, paragraphData?: string, cursor?: { index: number; token?: string }): Promise<ReviewDetailPage> {
  const context = await getReviewContext(repository, userId, bookId, editionKey, chapterId)
  const normalizedParagraphData = paragraphData?.trim() || String(paragraphIndex)
  if (cursor?.token !== undefined) throw new ReaderRuntimeError('invalid-input', '段评回复不接受分页游标')
  return withPersistentSourceSession(repository, userId, context.source, async (session) => {
    const result = await session.run((ports) => loadReviewReplies(ports, { source: context.source.normalizedSource, book: context.edition.metadata, chapter: context.chapter, paragraphIndex, reviewId, paragraphData: normalizedParagraphData, ...(cursor === undefined ? {} : { cursor }) }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '段评回复读取失败'))
    return result.value
  })
}

function reviewCursorScope(kind: ReviewCursorScope['kind'], userId: string, bookId: string, editionKey: string, chapterId: string, source: StoredSourceRecord, paragraphIndex: number, paragraphData: string, reviewId?: string): ReviewCursorScope {
  return { kind, userId, bookId, editionKey, chapterId, sourceId: source.sourceId, sourceFingerprint: source.fingerprint, paragraphIndex, paragraphData, reviewId: reviewId ?? null }
}

function signReviewPageCursor(page: ReviewDetailPage, scope: ReviewCursorScope): ReviewDetailPage {
  if (page.nextCursor === undefined || page.nextCursor.token === undefined) return page
  return { ...page, nextCursor: { index: page.nextCursor.index, token: signReviewCursor(scope, page.nextCursor) } }
}

function signReviewCursor(scope: ReviewCursorScope, cursor: ReviewCursor): string {
  const encoded = Buffer.from(JSON.stringify({ version: 1, scope, cursor }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', configuredSecret()).update(`review-v1.${encoded}`, 'utf8').digest('base64url')
  return `${encoded}.${signature}`
}

function verifyReviewCursor(scope: ReviewCursorScope, cursor: ReviewCursor | undefined): ReviewCursor | undefined {
  if (cursor === undefined) return undefined
  if (!Number.isSafeInteger(cursor.index) || cursor.index < 1) throw new ReaderRuntimeError('invalid-input', '段评分页信息无效，请刷新列表')
  if (cursor.index === 1 && cursor.token === undefined) return undefined
  if (cursor.index === 1) throw new ReaderRuntimeError('invalid-input', '首段评页不能使用分页游标')
  if (cursor.token === undefined) throw new ReaderRuntimeError('invalid-input', '段评分页信息无效，请刷新列表')
  const parts = cursor.token.split('.')
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) throw new ReaderRuntimeError('invalid-input', '段评分页信息无效，请刷新列表')
  const expected = createHmac('sha256', configuredSecret()).update(`review-v1.${parts[0]}`, 'utf8').digest('base64url')
  const received = Buffer.from(parts[1]!, 'base64url')
  const expectedBytes = Buffer.from(expected, 'base64url')
  if (received.length !== expectedBytes.length || !timingSafeEqual(received, expectedBytes)) throw new ReaderRuntimeError('invalid-input', '段评分页信息无效，请刷新列表')
  try {
    const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { version?: unknown; scope?: unknown; cursor?: unknown }
    if (payload.version !== 1 || JSON.stringify(payload.scope) !== JSON.stringify(scope) || typeof payload.cursor !== 'object' || payload.cursor === null || Array.isArray(payload.cursor)) throw new Error('scope mismatch')
    const signedCursor = payload.cursor as { index?: unknown; token?: unknown }
    if (signedCursor.index !== cursor.index || !Number.isSafeInteger(signedCursor.index) || (signedCursor.token !== undefined && typeof signedCursor.token !== 'string')) throw new Error('cursor mismatch')
    return { index: signedCursor.index as number, ...(signedCursor.token === undefined ? {} : { token: signedCursor.token }) }
  } catch {
    throw new ReaderRuntimeError('invalid-input', '段评分页信息无效，请刷新列表')
  }
}

function verifyJavaScriptReviewCursor(cursor: ReviewCursor | undefined): ReviewCursor | undefined {
  if (cursor !== undefined && (!Number.isSafeInteger(cursor.index) || cursor.index < 1)) throw new ReaderRuntimeError('invalid-input', '段评分页信息无效，请刷新列表')
  if (cursor?.token !== undefined) throw new ReaderRuntimeError('invalid-input', 'JavaScript 段评不接受分页游标')
  return cursor
}

function isJavaScriptSource(source: NormalizedSource): boolean { return typeof source.mainJs === 'string' && source.mainJs.trim().length > 0 }

async function getReviewContext(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string): Promise<{ source: StoredSourceRecord; edition: StoredEdition; chapter: Chapter }> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, userId, edition.sourceId)
  const toc = await repository.getChapterContext(userId, bookId, editionKey, chapterId)
  if (toc === null) throw new ReaderRuntimeError('not-found', '目录尚未加载')
  const chapter = toc.chapter
  if (chapter === undefined) throw new ReaderRuntimeError('not-found', '章节不存在')
  return { source, edition, chapter }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function chapterIdFor(chapter: Chapter): string { return digest(`${chapter.chapterUrl}\u0000${chapter.index}`) }
function createBookPatch(chapters: Chapter[]): { lastCheckTime: number; totalChapterNum: number; latestChapterTitle?: string } { const latest = chapters.at(-1); return { lastCheckTime: Date.now(), totalChapterNum: chapters.length, ...(latest === undefined ? {} : { latestChapterTitle: latest.title }) } }
function diagnosticsMessage(status: WorkflowStatus, fallback: string): string { return status === 'capability-missing' ? '当前书源需要服务器未启用的运行能力' : fallback }
export type ReaderRuntimeTypes = [BookMetadata, ChapterContent, NormalizedSource, SearchRunState]
