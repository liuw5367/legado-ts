import { apiFetch, type ApiContent, type ApiPosition, type ApiToc } from './api.ts'
import type { BookDetailsResponse } from '../../shared/book-details.ts'

export interface BookSnapshot { toc: ApiToc; details: BookDetailsResponse }
export type EditionOption = { editionKey: string; sourceId: string; sourceName: string }
type Loader = (signal: AbortSignal) => Promise<BookSnapshot>

/** 仅持有当前书籍；刷新代次和失效控制阻止旧响应回写新快照。 */
export class BookCache {
  private editionOptions: EditionOption[] | undefined
  private optionsRequest: { controller: AbortController; promise: Promise<EditionOption[]> } | undefined
  async loadEditionOptions(bookId: string, refresh = false): Promise<EditionOption[]> {
    this.select(bookId)
    if (!refresh && this.editionOptions) return this.editionOptions
    if (!refresh && this.optionsRequest) return this.optionsRequest.promise
    this.optionsRequest?.controller.abort()
    const controller = new AbortController()
    const promise = apiFetch<{ editions: EditionOption[] }>(`/api/books/${encodeURIComponent(bookId)}/edition-options`, { signal: controller.signal }).then(({ editions }) => {
      if (controller.signal.aborted || this.bookId !== bookId) throw new DOMException('版本请求已失效', 'AbortError')
      this.editionOptions = editions; return editions
    }).finally(() => { if (this.optionsRequest?.controller === controller) this.optionsRequest = undefined })
    this.optionsRequest = { controller, promise }
    return promise
  }
  private bookId = ''
  private snapshots = new Map<string, BookSnapshot>()
  private positions = new Map<string, ApiPosition | null>()
  private currentContent: { editionKey: string; chapterId: string; content: ApiContent } | undefined
  private requests = new Map<string, { controller: AbortController; promise: Promise<BookSnapshot> }>()
  private listeners = new Set<() => void>()
  private version = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  private notify() { this.version++; for (const listener of this.listeners) listener() }
  private select(bookId: string) { if (this.bookId !== bookId) { this.clear(); this.bookId = bookId } }
  get(bookId: string, editionKey: string) { return bookId === this.bookId ? this.snapshots.get(editionKey) : undefined }
  getContent(bookId: string, editionKey: string, chapterId: string) {
    const cached = this.currentContent
    return bookId === this.bookId && cached?.editionKey === editionKey && cached.chapterId === chapterId ? cached.content : undefined
  }
  setContent(bookId: string, editionKey: string, chapterId: string, content: ApiContent) {
    if (bookId !== this.bookId) return
    this.currentContent = { editionKey, chapterId, content }
    this.notify()
  }
  getPosition(bookId: string, editionKey: string) { return bookId === this.bookId ? this.positions.get(editionKey) : undefined }
  invalidateEditionOptions() {
    this.optionsRequest?.controller.abort(); this.optionsRequest = undefined; this.editionOptions = undefined
  }
  setPosition(bookId: string, editionKey: string, position: ApiPosition | null) {
    if (bookId !== this.bookId) return
    const current = this.positions.get(editionKey)
    if (current !== undefined && current !== null && (position === null || position.version < current.version)) return
    this.positions.set(editionKey, position); this.notify()
  }
  clear() {
    this.optionsRequest?.controller.abort(); this.optionsRequest = undefined; this.editionOptions = undefined
    for (const request of this.requests.values()) request.controller.abort()
    this.requests.clear(); this.snapshots.clear(); this.positions.clear(); this.currentContent = undefined; this.bookId = ''; this.notify()
  }
  async load(bookId: string, editionKey: string, loader: Loader, refresh = false): Promise<BookSnapshot> {
    this.select(bookId)
    const snapshot = this.snapshots.get(editionKey)
    if (!refresh && snapshot !== undefined) return snapshot
    const pending = this.requests.get(editionKey)
    if (!refresh && pending !== undefined) return pending.promise
    pending?.controller.abort()
    const controller = new AbortController()
    const promise = loader(controller.signal).then((value) => {
      if (controller.signal.aborted || bookId !== this.bookId) throw new DOMException('目录请求已失效', 'AbortError')
      this.snapshots.set(editionKey, value); this.notify()
      return value
    }).finally(() => { if (this.requests.get(editionKey)?.controller === controller) this.requests.delete(editionKey) })
    this.requests.set(editionKey, { controller, promise })
    return promise
  }
}

export function loadBookSnapshot(cache: BookCache, bookId: string, editionKey: string, refresh = false) {
  const path = '/api/books/' + encodeURIComponent(bookId)
  const query = '?editionKey=' + encodeURIComponent(editionKey)
  return cache.load(bookId, editionKey, async (signal) => {
    const [toc, details] = await Promise.all([
      apiFetch<{ toc: ApiToc }>(path + '/toc' + query + (refresh ? '&refresh=true' : ''), { signal }),
      apiFetch<BookDetailsResponse>(path + '/details' + query, { signal }),
    ])
    return { toc: toc.toc, details }
  }, refresh)
}
