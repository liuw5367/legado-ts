import type { ShelfChapterSummary } from '../../shared/shelf-chapters.ts'
import type { ReadingContent } from '../../shared/reading-content.ts'
import type { TocSummary, TocChapter } from '../../shared/toc.ts'
import type { ReadingSourceSummary } from '../../shared/source-management.ts'
import { orderSearchCandidates } from '../../shared/search-candidates.ts'
import type { BookListSummary, BookListMember, BookListDetails, BookListChoice } from '../../shared/book-lists.ts'
import { mutationDomains, publishPageMutation } from './page-data.ts'
import { currentSession, invalidateSession } from './auth.ts'

export interface ApiSource { sourceId: string; name: string; group?: string; fingerprint: string; enabled: boolean }
export type ApiThemeMode = 'system' | 'light' | 'dark'
export type ApiReadingMode = 'scroll' | 'paged'
export type ApiBookshelfSortMode = 'addedAt' | 'lastReadAt'
export type ApiPageTapAction = 'previous' | 'next'
export interface ApiGeneralSettings { searchConcurrency: number; bookshelfInitialGroup?: string; bookshelfSort: ApiBookshelfSortMode }
export interface ApiPageTapZones { leftWidthPercent: number; centerWidthPercent: number; centerTopHeightPercent: number; centerMiddleHeightPercent: number; centerTopAction: ApiPageTapAction; centerBottomAction: ApiPageTapAction }
export const DEFAULT_PAGE_TAP_ZONES: ApiPageTapZones = { leftWidthPercent: 33, centerWidthPercent: 34, centerTopHeightPercent: 33, centerMiddleHeightPercent: 34, centerTopAction: 'previous', centerBottomAction: 'next' }
export interface ApiSettings { userId: string; theme: ApiThemeMode; readingMode: ApiReadingMode; fontSize: number; lineHeight: number; marginTop: number; marginRight: number; marginBottom: number; marginLeft: number; general: ApiGeneralSettings; pageTapZones: ApiPageTapZones; updatedAt: string }
export interface ApiCandidate { sourceOrder?: number; sourceId: string; sourceFingerprint: string; searchDurationMs?: number; candidate: { sourceId: string; bookUrl: string; name?: string; author?: string; intro?: string; coverUrl?: string; kind?: string; lastChapter?: string; updateTime?: string; wordCount?: string } }
export interface ApiSearchProgress { completed: number; total: number; currentGroup?: string; activeSources?: string[] }
export interface ApiSearchSourceState { sourceId: string; status: string; nextCursor?: { index: number; token?: string } }
export interface ApiSearch { id: string; keyword: string; sourceId: string; precision?: boolean; status: string; candidates: ApiCandidate[]; sourceStates?: ApiSearchSourceState[]; progress?: ApiSearchProgress; cancelled?: boolean; nextCursor?: { index: number; token?: string } }
export interface ApiBook { id: string; userId: string; name: string; author?: string; intro?: string; coverUrl?: string; customCoverUrl?: string; activeEditionKey?: string; createdAt: string; updatedAt: string }
export interface ApiEdition { id: string; userId: string; bookId: string; editionKey: string; sourceId: string; sourceFingerprint: string; bookUrl: string; metadata: Record<string, unknown>; variable?: string }
export interface ApiPosition { userId: string; bookId: string; editionKey: string; chapterId: string; chapterUrl: string; chapterIndex: number; title: string; tocRevision?: string; paragraphIndex: number; offset: number; version: number; lastReadAt: string }
export interface ApiHistory { id: string; searchId: string; keyword: string; sourceIds: string[]; status: string; resultCount: number; summary?: string; createdAt: string; updatedAt: string }
export type ApiHomeBook = Pick<ApiBook, 'id' | 'name' | 'author' | 'coverUrl' | 'customCoverUrl'>
export type ApiHomePosition = Pick<ApiPosition, 'chapterId' | 'title' | 'lastReadAt'>
export type ApiHomeHistory = Pick<ApiHistory, 'id' | 'keyword' | 'status' | 'resultCount' | 'summary' | 'updatedAt'>
export interface ApiHome { bookshelf: Array<{ book: ApiHomeBook; edition: Pick<ApiEdition, 'editionKey'>; groupId?: string | null; chapters?: ShelfChapterSummary; position?: ApiHomePosition }>; reading: Array<{ book: ApiHomeBook; edition: Pick<ApiEdition, 'editionKey'>; position: ApiHomePosition }>; searchHistory: ApiHomeHistory[] }
export interface ApiChapter { chapterId: string; sourceId: string; bookUrl: string; chapterUrl: string; index: number; title: string; url?: string; isVolume?: boolean; isVip?: boolean; isPay?: boolean }
export type ApiTocChapter = TocChapter
export type ApiToc = TocSummary
export type ApiContent = ReadingContent

export class ApiError extends Error {
  public readonly code: string
  public readonly status: number
  public constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status }
}

export type BackupCategory = 'bookshelf' | 'reading' | 'search' | 'sources' | 'settings'
export interface BackupRecordCounts { bookshelf: number; reading: number; search: number; sources: number; settings: number }
export interface BackupPreview { manifest: { createdAt: string; producer: { name: string; version: string }; counts: Record<BackupCategory, number> }; preview: { recordCounts: BackupRecordCounts; fileCounts: Record<BackupCategory, number> }; currentCounts: BackupRecordCounts }

export interface StreamEvent { type: string; data: unknown }
export interface SearchStreamOptions { nextPage?: boolean; sourceIds?: string[] }
export interface SearchSourceEventData { sourceSummary?: ReadingSourceSummary; hasPending?: boolean; retryAfterMs?: number; source?: { status?: string; candidates?: ApiCandidate[] }; search?: { candidates?: ApiCandidate[]; sourceStates?: ApiSearchSourceState[]; progress?: ApiSearchProgress; cancelled?: boolean }; progress?: ApiSearchProgress; candidates?: ApiCandidate[]; searchId?: string }

export function mergeSearchStreamCandidates(current: ApiCandidate[], event: SearchSourceEventData, ordering?: { keyword: string; precision: boolean }): ApiCandidate[] {
  if (event.search?.candidates !== undefined) return [...event.search.candidates]
  if (event.candidates !== undefined) return [...event.candidates]
  const values = new Map(current.map((item) => [JSON.stringify([item.sourceId, item.sourceFingerprint, item.candidate.bookUrl]), item]))
  for (const item of event.source?.candidates ?? []) values.set(JSON.stringify([item.sourceId, item.sourceFingerprint, item.candidate.bookUrl]), item)
  const merged = [...values.values()]
  return ordering ? orderSearchCandidates(ordering.keyword, merged, ordering.precision) : merged
}

export function searchProgressFromEvent(event: SearchSourceEventData): ApiSearchProgress | undefined {
  return event.progress ?? event.search?.progress
}

export function createSearchStreamRequest(searchId: string, session: { access_token?: string } | null, signal?: AbortSignal, options?: SearchStreamOptions): { path: string; init: RequestInit } {
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (session?.access_token !== undefined) headers.set('Authorization', `Bearer ${session.access_token}`)
  const path = options === undefined ? `/api/searches/${encodeURIComponent(searchId)}/stream` : `/api/searches/${encodeURIComponent(searchId)}/batches`
  const init: RequestInit = options === undefined
    ? { headers }
    : { method: 'POST', headers: new Headers({ ...Object.fromEntries(headers.entries()), 'Content-Type': 'application/json' }), body: JSON.stringify(options) }
  if (signal !== undefined) init.signal = signal
  return { path, init }
}

export class SseDecoder {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private eventType = 'message'
  private dataLines: string[] = []

  public push(bytes: Uint8Array): StreamEvent[] { this.buffer += this.decoder.decode(bytes, { stream: true }); return this.consume(false) }
  public finish(): StreamEvent[] { this.buffer += this.decoder.decode(); return this.consume(true) }
  private consume(flushBuffer: boolean): StreamEvent[] {
    const events: StreamEvent[] = []
    const lines = this.buffer.split(/\r?\n/u)
    this.buffer = flushBuffer ? '' : lines.pop() ?? ''
    for (const line of lines) {
      if (line.length === 0) { const event = this.flushEvent(); if (event !== undefined) events.push(event); continue }
      if (line.startsWith('event:')) this.eventType = line.slice(6).trim()
      if (line.startsWith('data:')) this.dataLines.push(line.slice(5).trimStart())
    }
    if (flushBuffer && this.buffer.length > 0) { this.dataLines.push(this.buffer); this.buffer = ''; const event = this.flushEvent(); if (event !== undefined) events.push(event) }
    return events
  }
  private flushEvent(): StreamEvent | undefined { if (this.dataLines.length === 0) return undefined; const raw = this.dataLines.join('\n'); let data: unknown = raw; try { data = JSON.parse(raw) as unknown } catch { /* 保留文本事件 */ } const event = { type: this.eventType, data }; this.eventType = 'message'; this.dataLines = []; return event }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, expectedUserId?: string): Promise<T> {
  const session = await currentSession()
  if (expectedUserId !== undefined && session?.user.id !== expectedUserId) throw new Error('账号已切换，请重新操作')
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (session?.access_token !== undefined) headers.set('Authorization', `Bearer ${session.access_token}`)
  const method = (init.method ?? 'GET').toUpperCase()
  // 已提交的写入必须结算，隐藏页的 AbortSignal 只阻止后续 UI/导航；不能把取消等同于服务端回滚。
  const committedWrite = mutationDomains(path, method).length > 0
  if (init.signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
  const response = await fetch(path, { ...init, headers, ...(committedWrite ? { signal: null } : {}) })
  const body = await readJson(response)
  if (!response.ok) {
    const error = isRecord(body)?.error
    const errorRecord = isRecord(error)
    await handleExpiredSession(response, body, session?.access_token)
    throw new ApiError(typeof errorRecord?.code === 'string' ? errorRecord.code : 'request-failed', typeof errorRecord?.message === 'string' ? errorRecord.message : '请求失败', response.status)
  }
  if (method !== 'GET' && method !== 'HEAD' && session !== null) publishPageMutation({ userId: session.user.id, path, method })
  return body as T
}

export async function validateBackup(file: File): Promise<BackupPreview> {
  const headers = await binaryHeaders()
  const response = await fetch('/api/backup/validate', { method: 'POST', headers, body: file })
  const body = await readJson(response)
  if (!response.ok) { await handleExpiredSession(response, body, bearerToken(headers)); throw apiErrorFromResponse(response, body, '备份校验失败') }
  return body as BackupPreview
}

export async function importBackup(file: File, categories: readonly string[]): Promise<{ counts: BackupPreview['manifest']['counts'] }> {
  const query = encodeURIComponent(categories.join(','))
  const headers = await binaryHeaders()
  const response = await fetch(`/api/backup/import?categories=${query}`, { method: 'POST', headers, body: file })
  const body = await readJson(response)
  if (!response.ok) { await handleExpiredSession(response, body, bearerToken(headers)); throw apiErrorFromResponse(response, body, '备份导入失败') }
  return body as { counts: BackupPreview['manifest']['counts'] }
}

export async function downloadBackup(): Promise<Blob> {
  const headers = await binaryHeaders('application/zip')
  const response = await fetch('/api/backup/export', { headers })
  if (!response.ok) { const body = await readJson(response); await handleExpiredSession(response, body, bearerToken(headers)); throw apiErrorFromResponse(response, body, '备份导出失败') }
  const bytes = await response.arrayBuffer()
  const expectedBytes = Number(response.headers.get('X-Backup-Bytes') ?? '')
  if (Number.isSafeInteger(expectedBytes) && expectedBytes !== bytes.byteLength) throw new ApiError('backup-integrity', '下载的备份大小校验失败', 502)
  const expectedHash = response.headers.get('X-Backup-Sha256')
  if (expectedHash !== null && expectedHash !== await sha256ArrayBuffer(bytes)) throw new ApiError('backup-integrity', '下载的备份校验失败', 502)
  return new Blob([bytes], { type: 'application/zip' })
}

async function binaryHeaders(accept = 'application/json'): Promise<Headers> {
  const session = await currentSession()
  const headers = new Headers({ Accept: accept, 'Content-Type': 'application/zip' })
  if (session?.access_token !== undefined) headers.set('Authorization', `Bearer ${session.access_token}`)
  return headers
}

function bearerToken(headers: Headers): string | undefined {
  return headers.get('Authorization')?.slice(7)
}

async function handleExpiredSession(response: Response, body: unknown, token: string | undefined): Promise<void> {
  if (response.status !== 401 || isRecord(isRecord(body)?.error)?.code !== 'unauthenticated') return
  await invalidateSession(token).catch(() => undefined)
}

function apiErrorFromResponse(response: Response, body: unknown, fallback: string): ApiError {
  const error = isRecord(body)?.error
  const details = isRecord(error)
  return new ApiError(typeof details?.code === 'string' ? details.code : 'request-failed', typeof details?.message === 'string' ? details.message : fallback, response.status)
}

async function sha256ArrayBuffer(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('')
}

export async function streamSearch(searchId: string, onEvent: (event: { type: string; data: unknown }) => void, signal?: AbortSignal, options?: SearchStreamOptions): Promise<void> {
  const session = await currentSession()
  const request = createSearchStreamRequest(searchId, session, signal, options)
  let response: Response
  try { response = await fetch(request.path, request.init) } catch (reason) {
    if (signal?.aborted) throw reason
    throw new ApiError('search-paused', '连接已中断，可继续搜索', 0)
  }
  if (!response.ok || response.body === null) {
    const body = await readJson(response)
    const error = isRecord(body)?.error
    const errorRecord = isRecord(error)
    await handleExpiredSession(response, body, session?.access_token)
    throw new ApiError(errorRecord?.code === 'source-busy' ? 'search-paused' : typeof errorRecord?.code === 'string' ? errorRecord.code : 'stream-failed', typeof errorRecord?.message === 'string' ? errorRecord.message : '搜索流连接失败', response.status)
  }
  const reader = response.body.getReader()
  const decoder = new SseDecoder()
  const isAborted = () => signal?.aborted === true
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try { chunk = await reader.read() } catch (reason) {
      if (signal?.aborted) throw reason
      throw new ApiError('search-paused', '连接已中断，可继续搜索', 0)
    }
    if (chunk.done) break
    if (isAborted()) { await reader.cancel().catch(() => undefined); return }
    for (const event of decoder.push(chunk.value)) {
      if (isAborted()) { await reader.cancel().catch(() => undefined); return }
      onEvent(event)
      if (event.type === 'done') { await reader.cancel().catch(() => undefined); return }
    }
  }
  if (isAborted()) { await reader.cancel().catch(() => undefined); return }
  for (const event of decoder.finish()) onEvent(event)
}

/** 自动接续待执行书源批次；首轮完成即结束，避免游标翻页使进度满后仍持续请求。 */
export async function streamSearchAll(searchId: string, onEvent: (event: { type: string; data: unknown }) => void, signal?: AbortSignal): Promise<void> {
  let finalDone: { type: string; data: unknown } | undefined
  let hasPending = false
  let waitingSince = 0
  do {
    let retryAfterMs = 0
    hasPending = false
    let batchEndSeen = false
    await streamSearch(searchId, (event) => {
      if (event.type === 'done') { finalDone = event; return }
      onEvent(event)
      if (event.type === 'batch-end') {
        batchEndSeen = true
        const data = (event.data ?? {}) as SearchSourceEventData
        hasPending = data.hasPending === true
        retryAfterMs = data.retryAfterMs ?? 0
      }
    }, signal)
    if (!batchEndSeen && !signal?.aborted) throw new ApiError('search-paused', '连接已中断，可继续搜索', 0)
    if (hasPending && retryAfterMs > 0) {
      waitingSince ||= Date.now()
      if (Date.now() - waitingSince >= 30_000) throw new ApiError('search-paused', '服务器繁忙，搜索已暂停，可继续已有任务', 429)
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, retryAfterMs)
        signal?.addEventListener('abort', finish, { once: true })
      })
    } else waitingSince = 0
  } while (hasPending && signal?.aborted !== true)
  if (signal?.aborted !== true && finalDone !== undefined) onEvent(finalDone)
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return {}
  try { return JSON.parse(text) as unknown } catch { return { error: { code: 'invalid-response', message: text.slice(0, 200) } } }
}

function isRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export type ApiBookList = BookListSummary
export type ApiBookListItem = BookListMember
export type ApiBookListDetails = BookListDetails
export type ApiBookListChoice = BookListChoice
export interface ApiShelfGroup { id: string; name: string; bookCount: number }
export interface ApiShelfGroups { groups: ApiShelfGroup[]; ungroupedCount: number }
