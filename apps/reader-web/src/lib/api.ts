import { currentSession } from './auth.ts'

export interface ApiSource { sourceId: string; name: string; group?: string; fingerprint: string; enabled: boolean }
export type ApiThemeMode = 'system' | 'light' | 'dark'
export interface ApiSettings { userId: string; theme: ApiThemeMode; fontSize: number; lineHeight: number; updatedAt: string }
export interface ApiCandidate { sourceId: string; sourceFingerprint: string; candidate: { sourceId: string; bookUrl: string; name?: string; author?: string; intro?: string; coverUrl?: string; kind?: string; lastChapter?: string } }
export interface ApiSearch { id: string; keyword: string; sourceId: string; precision?: boolean; status: string; candidates: ApiCandidate[]; nextCursor?: { index: number; token?: string } }
export interface ApiBook { id: string; userId: string; name: string; author?: string; intro?: string; coverUrl?: string; activeEditionKey?: string; createdAt: string; updatedAt: string }
export interface ApiEdition { id: string; userId: string; bookId: string; editionKey: string; sourceId: string; sourceFingerprint: string; bookUrl: string; metadata: Record<string, unknown>; variable?: string }
export interface ApiPosition { userId: string; bookId: string; editionKey: string; chapterId: string; chapterUrl: string; chapterIndex: number; title: string; tocRevision?: string; paragraphIndex: number; offset: number; version: number; lastReadAt: string }
export interface ApiHistory { id: string; searchId: string; keyword: string; sourceIds: string[]; status: string; resultCount: number; summary?: string; createdAt: string; updatedAt: string }
export interface ApiHome { bookshelf: Array<{ book: ApiBook; edition: ApiEdition; position?: ApiPosition }>; reading: Array<{ book: ApiBook; edition: ApiEdition; position: ApiPosition }>; searchHistory: ApiHistory[] }
export interface ApiChapter { chapterId: string; sourceId: string; bookUrl: string; chapterUrl: string; index: number; title: string; url?: string; isVolume?: boolean; isVip?: boolean; isPay?: boolean }
export interface ApiToc { userId: string; bookId: string; editionKey: string; sourceFingerprint: string; revision: string; chapters: ApiChapter[]; bookPatch: Record<string, unknown>; bookAfter?: Record<string, unknown> }
export interface ApiContent { chapter: ApiChapter; contentType: 'text' | 'html'; raw: string; cleaned: string; pages: string[]; resources: Array<{ kind: 'image'; url: string }>; title?: string; imgUrl?: string }

export class ApiError extends Error {
  public readonly code: string
  public readonly status: number
  public constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status }
}

export interface StreamEvent { type: string; data: unknown }
export interface SearchStreamOptions { nextPage?: boolean; sourceIds?: string[] }
export interface SearchSourceEventData { source?: { candidates?: ApiCandidate[] }; search?: { candidates?: ApiCandidate[] } }

export function mergeSearchStreamCandidates(current: ApiCandidate[], event: SearchSourceEventData): ApiCandidate[] {
  if (event.search?.candidates !== undefined) return [...event.search.candidates]
  return [...current, ...(event.source?.candidates ?? [])]
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

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await currentSession()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (session?.access_token !== undefined) headers.set('Authorization', `Bearer ${session.access_token}`)
  const response = await fetch(path, { ...init, headers })
  const body = await readJson(response)
  if (!response.ok) {
    const error = isRecord(body)?.error
    const errorRecord = isRecord(error)
    throw new ApiError(typeof errorRecord?.code === 'string' ? errorRecord.code : 'request-failed', typeof errorRecord?.message === 'string' ? errorRecord.message : '请求失败', response.status)
  }
  return body as T
}

export async function streamSearch(searchId: string, onEvent: (event: { type: string; data: unknown }) => void, signal?: AbortSignal, options?: SearchStreamOptions): Promise<void> {
  const session = await currentSession()
  const request = createSearchStreamRequest(searchId, session, signal, options)
  const response = await fetch(request.path, request.init)
  if (!response.ok || response.body === null) {
    const body = await readJson(response)
    const error = isRecord(body)?.error
    const errorRecord = isRecord(error)
    throw new ApiError(typeof errorRecord?.code === 'string' ? errorRecord.code : 'stream-failed', typeof errorRecord?.message === 'string' ? errorRecord.message : '搜索流连接失败', response.status)
  }
  const reader = response.body.getReader()
  const decoder = new SseDecoder()
  const isAborted = () => signal?.aborted === true
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (isAborted()) { await reader.cancel().catch(() => undefined); return }
    for (const event of decoder.push(chunk.value)) {
      if (isAborted()) { await reader.cancel().catch(() => undefined); return }
      onEvent(event)
    }
  }
  if (isAborted()) { await reader.cancel().catch(() => undefined); return }
  for (const event of decoder.finish()) onEvent(event)
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return {}
  try { return JSON.parse(text) as unknown } catch { return { error: { code: 'invalid-response', message: text.slice(0, 200) } } }
}

function isRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
