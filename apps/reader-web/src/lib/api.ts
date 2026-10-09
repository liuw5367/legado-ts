import { currentSession } from './auth.ts'

export interface ApiSource { sourceId: string; name: string; group?: string; fingerprint: string; enabled: boolean }
export interface ApiCandidate { sourceId: string; sourceFingerprint: string; candidate: { sourceId: string; bookUrl: string; name?: string; author?: string; intro?: string; coverUrl?: string; kind?: string; lastChapter?: string } }
export interface ApiSearch { id: string; keyword: string; sourceId: string; status: string; candidates: ApiCandidate[]; nextCursor?: { index: number; token?: string } }

export class ApiError extends Error {
  public constructor(public readonly code: string, message: string, public readonly status: number) { super(message) }
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

export async function streamSearch(searchId: string, onEvent: (event: { type: string; data: unknown }) => void, signal?: AbortSignal): Promise<void> {
  const session = await currentSession()
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (session?.access_token !== undefined) headers.set('Authorization', `Bearer ${session.access_token}`)
  const response = await fetch(`/api/searches/${encodeURIComponent(searchId)}/stream`, { headers, ...(signal === undefined ? {} : { signal }) })
  if (!response.ok || response.body === null) {
    const body = await readJson(response)
    const error = isRecord(body)?.error
    const errorRecord = isRecord(error)
    throw new ApiError(typeof errorRecord?.code === 'string' ? errorRecord.code : 'stream-failed', typeof errorRecord?.message === 'string' ? errorRecord.message : '搜索流连接失败', response.status)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = 'message'
  let dataLines: string[] = []
  const flush = () => {
    if (dataLines.length === 0) return
    const raw = dataLines.join('\n')
    let data: unknown = raw
    try { data = JSON.parse(raw) } catch { /* 保留文本事件 */ }
    onEvent({ type: eventType, data })
    eventType = 'message'
    dataLines = []
  }
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split(/\r?\n/u)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length === 0) { flush(); continue }
      if (line.startsWith('event:')) eventType = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
  }
  buffer += decoder.decode()
  if (buffer.length > 0) dataLines.push(buffer)
  flush()
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return {}
  try { return JSON.parse(text) as unknown } catch { return { error: { code: 'invalid-response', message: text.slice(0, 200) } } }
}

function isRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
