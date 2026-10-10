import { bookIdentityKey, normalizeIdentity, sameBookIdentity } from '../../shared/book-identity.ts'
import type { BookSourceItem, BookSourcesResponse, SourceCacheWarning } from '../../shared/book-sources.ts'
import { createHash, randomUUID } from 'node:crypto'
import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '@legado/source-core'
import type { BookMetadata, Chapter, ChapterContent, NormalizedSource, WorkflowStatus } from '@legado/source-core'
import { NodeCookieStore, createNodeSourceSession } from '@legado/source-node'
import type { SourceSession } from '@legado/source-core'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import type { BookCreationInput, RuntimeStateSnapshot, SearchBatchResult, SearchRunState, SourceSearchState, StoredBook, StoredCandidate, StoredContent, StoredEdition, StoredToc } from '../domain/types.ts'
import { acceptsPrecisionSearchFields, orderSearchCandidates } from './search-candidates.ts'

export class ReaderRuntimeError extends Error {
  public readonly code: 'not-found' | 'invalid-input' | 'source-failed' | 'configuration' | 'source-busy'
  public constructor(code: 'not-found' | 'invalid-input' | 'source-failed' | 'configuration' | 'source-busy', message: string) { super(message); this.code = code }
}

export interface SearchBatchOptions { sourceIds?: string[]; nextPage?: boolean }
export type SearchSourceListener = (source: SourceSearchState, search: SearchRunState) => Promise<void> | void

export interface ReaderRuntime {
  listSources(userId: string): Promise<StoredSourceRecord[]>
  runSearchBatch(userId: string, searchId: string, options?: SearchBatchOptions): Promise<SearchBatchResult>
  runSearchBatchStream(userId: string, searchId: string, listener: SearchSourceListener, options?: SearchBatchOptions): Promise<SearchBatchResult>
  cancelSearch(userId: string, searchId: string): Promise<SearchRunState | null>
  createBookFromSearch(userId: string, searchId: string, candidateIndex: number, bookId?: string, addToBookshelf?: boolean, activateEdition?: boolean): Promise<{ book: StoredBook; edition: StoredEdition; cacheWarning?: SourceCacheWarning }>
  listBookSources(userId: string, bookId: string): Promise<BookSourcesResponse>
  openBookSource(userId: string, bookId: string, candidateId: string): Promise<StoredEdition>
  getOrLoadToc(userId: string, bookId: string, editionKey: string, refresh?: boolean): Promise<StoredToc>
  getOrLoadContent(userId: string, bookId: string, editionKey: string, chapterId: string, refresh?: boolean): Promise<StoredContent>
}

const activeSearches = new Map<string, { operationId: string; controller: AbortController }>()
const SOURCE_RUNTIME_LEASE_MS = 5 * 60 * 1000

export function createReaderRuntime(repository: ReaderRepository): ReaderRuntime {
  return {
    listSources: (userId) => repository.listSourcesForUser(userId),
    runSearchBatch: (userId, searchId, options) => runSearchBatch(repository, userId, searchId, options),
    runSearchBatchStream: (userId, searchId, listener, options) => runSearchBatchStream(repository, userId, searchId, listener, options),
    cancelSearch: (userId, searchId) => cancelSearch(repository, userId, searchId),
    createBookFromSearch: (userId, searchId, candidateIndex, bookId, addToBookshelf, activateEdition) => createBookFromSearch(repository, userId, searchId, candidateIndex, bookId, addToBookshelf, activateEdition),
    listBookSources: (userId, bookId) => listBookSources(repository, userId, bookId),
    openBookSource: (userId, bookId, candidateId) => openBookSource(repository, userId, bookId, candidateId),
    getOrLoadToc: (userId, bookId, editionKey, refresh) => getOrLoadToc(repository, userId, bookId, editionKey, refresh),
    getOrLoadContent: (userId, bookId, editionKey, chapterId, refresh) => getOrLoadContent(repository, userId, bookId, editionKey, chapterId, refresh),
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
  try {
    let current = await repository.claimSearch(userId, searchId, operationId, states, { completed: completedCount(states), total: states.length })
    if (current === null) throw new ReaderRuntimeError('source-busy', '该搜索正在执行')
    const pending = states.filter((state) => state.status === 'pending')
    let serialized = Promise.resolve()
    const outcomes = pending.map((state) => runOneSource(repository, current!, state, controller.signal).then(async (outcome) => {
      serialized = serialized.then(async () => {
        const index = states.findIndex((item) => item.sourceId === outcome.state.sourceId)
        if (index >= 0) states[index] = outcome.state
        if (controller.signal.aborted) for (const state of states) if (state.status === 'pending' || state.status === 'running') { state.status = 'cancelled'; state.completedAt = new Date().toISOString() }
        const candidates = orderSearchCandidates(run.keyword, [...preservedCandidates, ...states.flatMap((item) => item.candidates)], run.precision === true)
        const aggregate = controller.signal.aborted ? 'cancelled' : aggregateStatus(states, 'running', candidates.length)
        const nextStatus: SearchRunState['status'] = aggregate === 'capability-missing' ? 'failed' : aggregate === 'running' ? 'running' : aggregate
        current = await repository.updateSearch(userId, searchId, { sourceStates: states, candidates, status: nextStatus, expectedOperationId: operationId, operationId, progress: { completed: completedCount(states), total: states.length }, cancelled: controller.signal.aborted })
        if (current === null) {
          if (controller.signal.aborted) return
          throw new ReaderRuntimeError('source-busy', '搜索操作已失效')
        }
        await listener?.(outcome.state, current)
      })
      await serialized
      return outcome
    }))
    await Promise.all(outcomes)
    const candidates = orderSearchCandidates(run.keyword, [...preservedCandidates, ...states.flatMap((item) => item.candidates)], run.precision === true)
    const aggregate = controller.signal.aborted ? 'cancelled' : aggregateStatus(states, 'success', candidates.length)
    const finalStatus: SearchRunState['status'] = aggregate === 'capability-missing' ? 'failed' : aggregate === 'running' ? 'partial' : aggregate
    current = await repository.updateSearch(userId, searchId, { sourceStates: states, candidates, status: finalStatus, expectedOperationId: operationId, operationId: null, progress: { completed: completedCount(states), total: states.length }, cancelled: finalStatus === 'cancelled' })
    if (current === null) { const latest = await repository.getSearch(userId, searchId); if (latest !== null && latest.cancelled) { const warning = await cacheSearchSources(repository, userId, latest.candidates); return { search: latest, candidates: latest.candidates, sourceResults: latest.sourceStates, sourceStatus: 'cancelled', progress: latest.progress, diagnostics: [], ...warning } }; throw new ReaderRuntimeError('source-busy', '搜索操作已失效') }
    return { search: current, candidates: current.candidates, sourceResults: states, sourceStatus: toBatchStatus(finalStatus), progress: current.progress, diagnostics: states.flatMap((item) => item.diagnostics), ...(await cacheSearchSources(repository, userId, current.candidates)) }
  } finally {
    activeSearches.delete(searchId)
  }
}

async function runOneSource(repository: ReaderRepository, run: SearchRunState, state: SourceSearchState, signal: AbortSignal): Promise<{ state: SourceSearchState; additions: StoredCandidate[] }> {
  const startedAt = new Date().toISOString()
  let source: StoredSourceRecord
  try { source = await requireSource(repository, run.userId, state.sourceId) } catch (error) { return { additions: [], state: { ...state, status: 'failed', diagnostics: [{ message: error instanceof Error ? error.message : '书源不可用' }], startedAt, completedAt: new Date().toISOString() } } }
  try {
    const result = await withPersistentSourceSession(repository, run.userId, source, (session) => session.run((ports) => searchBooks(ports, { source: source.normalizedSource, keyword: run.keyword, ...(run.precision === true ? { acceptSearchFields: (fields) => acceptsPrecisionSearchFields(run.keyword, fields) } : {}), ...(state.cursor === undefined ? {} : { cursor: state.cursor }), signal, maxItems: 100 })))
    const additions = (result.value?.items ?? []).map((candidate) => ({ sourceId: source.sourceId, sourceFingerprint: source.fingerprint, candidate }))
    const status = result.status === 'capability-missing' ? 'capability-missing' : result.status
    return { additions, state: { ...state, sourceFingerprint: source.fingerprint, status, candidates: additions, ...(result.value?.cursor === undefined ? {} : { cursor: result.value.cursor }), ...(result.value?.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }), diagnostics: result.diagnostics, startedAt, completedAt: new Date().toISOString() } }
  } catch (error) {
    if (signal.aborted) return { additions: [], state: { ...state, status: 'cancelled', diagnostics: [{ message: '搜索已取消' }], startedAt, completedAt: new Date().toISOString() } }
    return { additions: [], state: { ...state, sourceFingerprint: source.fingerprint, status: 'failed', diagnostics: [{ message: error instanceof Error ? error.message : '书源执行失败' }], startedAt, completedAt: new Date().toISOString() } }
  }
}

async function cancelSearch(repository: ReaderRepository, userId: string, searchId: string): Promise<SearchRunState | null> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) return null
  activeSearches.get(searchId)?.controller.abort()
  const states = run.sourceStates.map((state) => state.status === 'pending' || state.status === 'running' ? { ...state, status: 'cancelled' as const, completedAt: new Date().toISOString() } : state)
  return repository.updateSearch(userId, searchId, { status: 'cancelled', sourceStates: states, operationId: null, cancelled: true, progress: { completed: completedCount(states), total: states.length } })
}

function prepareSourceStates(run: SearchRunState, options?: SearchBatchOptions): SourceSearchState[] {
  const states: SourceSearchState[] = run.sourceStates.length > 0 ? run.sourceStates.map((state) => ({ ...state })) : run.sourceIds.map((sourceId) => ({ sourceId, status: 'pending' as const, candidates: [], diagnostics: [] }))
  if (options?.nextPage !== true) return states
  const selected = options.sourceIds === undefined ? states : states.filter((state) => options.sourceIds?.includes(state.sourceId) === true)
  for (const state of selected) if (state.nextCursor !== undefined) { state.cursor = state.nextCursor; state.status = 'pending'; state.candidates = []; state.diagnostics = [] }
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

async function createBookFromSearch(repository: ReaderRepository, userId: string, searchId: string, candidateIndex: number, bookId?: string, addToBookshelf = true, activateEdition = true): Promise<{ book: StoredBook; edition: StoredEdition; cacheWarning?: SourceCacheWarning }> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) throw new ReaderRuntimeError('not-found', '搜索任务不存在')
  const targetBook = bookId === undefined ? null : await repository.getBook(userId, bookId)
  if (bookId !== undefined && targetBook === null) throw new ReaderRuntimeError('not-found', '目标书籍不存在')
  const stored = run.candidates[candidateIndex]
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
    const editionKey = digest(`${stored.sourceId}\u0000${metadata.bookUrl}\u0000${stored.sourceFingerprint}`)
    return repository.createBook(userId, { candidate, metadata, editionKey, sourceFingerprint: stored.sourceFingerprint, addToBookshelf, activateEdition, ...(bookId === undefined ? {} : { bookId }) })
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
  const [editions, candidates, enabled] = await Promise.all([repository.listEditions(userId, bookId), repository.listBookSourceCandidates(userId, bookId), repository.listSourcesForUser(userId)])
  const sources = new Map(enabled.map((source) => [source.sourceId, source]))
  const result = new Map<string, BookSourceItem>()
  for (const item of candidates) {
    const source = sources.get(item.sourceId)
    if (source?.fingerprint !== item.sourceFingerprint) continue
    result.set(JSON.stringify([item.sourceId, item.sourceFingerprint, item.bookUrl]), { sourceId: item.sourceId, sourceFingerprint: item.sourceFingerprint, name: source.name, bookUrl: item.bookUrl, status: 'discovered', candidateId: item.id })
  }
  for (const edition of editions) {
    const source = sources.get(edition.sourceId)
    if (source?.fingerprint !== edition.sourceFingerprint) continue
    result.set(JSON.stringify([edition.sourceId, edition.sourceFingerprint, edition.bookUrl]), { sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, name: source.name, bookUrl: edition.bookUrl, status: 'saved', editionKey: edition.editionKey })
  }
  const items = [...result.values()].sort((left, right) => Number(right.status === 'saved' && right.editionKey === book.activeEditionKey) - Number(left.status === 'saved' && left.editionKey === book.activeEditionKey))
  return { sources: items, ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey }) }
}

async function openBookSource(repository: ReaderRepository, userId: string, bookId: string, candidateId: string): Promise<StoredEdition> {
  const book = await repository.getBook(userId, bookId)
  const cached = (await repository.listBookSourceCandidates(userId, bookId)).find((item) => item.id === candidateId)
  if (book === null || cached === undefined) throw new ReaderRuntimeError('not-found', '书籍来源不存在')
  const source = await requireSource(repository, userId, cached.sourceId)
  if (source.fingerprint !== cached.sourceFingerprint) throw new ReaderRuntimeError('configuration', '书源定义已更新，请重新搜索')
  const existing = (await repository.listEditions(userId, bookId)).find((item) => item.sourceId === cached.sourceId && item.sourceFingerprint === cached.sourceFingerprint && item.bookUrl === cached.bookUrl)
  if (existing !== undefined) return existing
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    // 预览新来源时核验详情身份，不能让搜索字段掩盖详情中不同的书名作者。
    const result = await session.run((ports) => loadBookDetails(ports, { source: { ...source.normalizedSource, ruleBookInfo: { ...(typeof source.normalizedSource.ruleBookInfo === 'object' && source.normalizedSource.ruleBookInfo !== null ? source.normalizedSource.ruleBookInfo : {}), canReName: 'true' } }, candidates: [cached.candidate.candidate], maxItems: 1 }))
    const metadata = result.value?.items[0]
    if (metadata === undefined) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '没有读取到书籍详情'))
    if (!sameBookIdentity(book.name, book.author, metadata.name, metadata.author)) throw new ReaderRuntimeError('source-failed', '来源详情与书籍不匹配，请重新搜索')
    const editionKey = digest(`${cached.sourceId}\u0000${metadata.bookUrl}\u0000${cached.sourceFingerprint}`)
    return repository.saveEdition(userId, bookId, { candidate: cached.candidate, metadata, editionKey, sourceFingerprint: cached.sourceFingerprint })
  })
}

async function getOrLoadToc(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, refresh = false): Promise<StoredToc> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, userId, edition.sourceId)
  if (!refresh) {
    const cached = await repository.getToc(userId, bookId, editionKey)
    if (cached !== null && cached.sourceFingerprint === source.fingerprint) return cached
  }
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    const result = await session.run((ports) => loadTableOfContents(ports, { source: source.normalizedSource, book: edition.metadata, refresh, maxPages: 32 }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '目录读取失败'))
    const chapters = result.value.items
    const revision = digest(JSON.stringify(chapters))
    const bookAfter = result.value.bookAfter
    const bookPatch = createBookPatch(chapters)
    return repository.saveToc(userId, { userId, bookId, editionKey, sourceFingerprint: source.fingerprint, revision, chapters, bookPatch, ...(bookAfter === undefined ? {} : { bookAfter }) })
  })
}

async function getOrLoadContent(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string, refresh = false): Promise<StoredContent> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, userId, edition.sourceId)
  const toc = await repository.getToc(userId, bookId, editionKey)
  if (toc === null) throw new ReaderRuntimeError('not-found', '目录尚未加载')
  const chapterIndex = toc.chapters.findIndex((chapter) => chapterIdFor(chapter) === chapterId)
  const chapter = chapterIndex < 0 ? undefined : toc.chapters[chapterIndex]
  if (chapter === undefined) throw new ReaderRuntimeError('not-found', '章节不存在')
  if (!refresh) {
    const cached = await repository.getContent(userId, editionKey, toc.revision, chapterId)
    if (cached !== null && cached.sourceFingerprint === source.fingerprint) return cached
  }
  const nextChapterUrl = toc.chapters[chapterIndex + 1]?.chapterUrl
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    const result = await session.run((ports) => loadChapterContent(ports, {
      source: source.normalizedSource,
      book: edition.metadata,
      chapter,
      ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }),
      maxPages: 32,
      maxOutputBytes: 4 * 1024 * 1024,
    }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '正文读取失败'))
    return repository.saveContent(userId, { userId, bookId, editionKey, chapterId, tocRevision: toc.revision, sourceFingerprint: source.fingerprint, content: result.value })
  })
}

async function requireSource(repository: ReaderRepository, userId: string, sourceId: string): Promise<StoredSourceRecord> {
  const source = await repository.getSourceForUser(userId, sourceId)
  if (source === null) throw new ReaderRuntimeError('configuration', `书源不可用：${sourceId}`)
  return source
}

async function withPersistentSourceSession<T>(repository: ReaderRepository, userId: string, source: StoredSourceRecord, operation: (session: SourceSession) => Promise<T>): Promise<T> {
  const leaseToken = randomUUID()
  const lease = await repository.acquireSourceRuntimeLease(userId, source.sourceId, source.fingerprint, leaseToken, SOURCE_RUNTIME_LEASE_MS)
  if (lease === null) throw new ReaderRuntimeError('source-busy', '该书源正在被其他请求使用，请稍后重试')
  let session: SourceSession | undefined
  let result!: T
  let primaryError: unknown
  let stateSaved = false
  try {
    const cookieStore = lease.snapshot.cookies === undefined ? new NodeCookieStore() : NodeCookieStore.fromSerialized(lease.snapshot.cookies)
    session = createNodeSourceSession(source.normalizedSource, { cookieStore, ...(lease.snapshot.variables === undefined ? {} : { initialVariables: lease.snapshot.variables }) })
    try {
      result = await operation(session)
    } catch (error) {
      primaryError = error
    }
    const snapshot = snapshotRuntimeState(session, cookieStore)
    const saved = await repository.saveSourceRuntimeState(userId, source.sourceId, source.fingerprint, lease.leaseToken, lease.version, snapshot)
    if (saved === null) throw new ReaderRuntimeError('source-busy', '书源运行状态已被其他请求更新，请稍后重试')
    stateSaved = true
  } catch (error) {
    if (primaryError === undefined) primaryError = error
  } finally {
    session?.close()
    if (!stateSaved) {
      try {
        await repository.releaseSourceRuntimeLease(userId, source.sourceId, source.fingerprint, lease.leaseToken)
      } catch (releaseError) {
        if (primaryError === undefined) primaryError = releaseError
      }
    }
  }
  if (primaryError !== undefined) throw primaryError
  return result
}

function snapshotRuntimeState(session: SourceSession, cookieStore: NodeCookieStore): RuntimeStateSnapshot {
  const variables = session.snapshotVariables()
  return { cookies: cookieStore.serialize(), ...(Object.keys(variables).length === 0 ? {} : { variables: { ...variables } }) }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function chapterIdFor(chapter: Chapter): string { return digest(`${chapter.chapterUrl}\u0000${chapter.index}`) }
function createBookPatch(chapters: Chapter[]): { lastCheckTime: number; totalChapterNum: number; latestChapterTitle?: string } { const latest = chapters.at(-1); return { lastCheckTime: Date.now(), totalChapterNum: chapters.length, ...(latest === undefined ? {} : { latestChapterTitle: latest.title }) } }
function diagnosticsMessage(status: WorkflowStatus, fallback: string): string { return status === 'capability-missing' ? '当前书源需要服务器未启用的运行能力' : fallback }
export type ReaderRuntimeTypes = [BookMetadata, ChapterContent, NormalizedSource, SearchRunState]
