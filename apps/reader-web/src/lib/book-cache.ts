import { apiFetch, type ApiEdition, type ApiPosition, type ApiToc } from './api.ts'
import type { BookDetailsResponse } from '../../shared/book-details.ts'

export interface BookSnapshot { toc: ApiToc; details: BookDetailsResponse; editions: ApiEdition[] }
type Loader = (signal: AbortSignal) => Promise<BookSnapshot>

/** 仅持有当前书籍；刷新代次和失效控制阻止旧响应回写新快照。 */
export class BookCache {
  private bookId = ''
  private snapshots = new Map<string, BookSnapshot>()
  private positions = new Map<string, ApiPosition | null>()
  private requests = new Map<string, { controller: AbortController; promise: Promise<BookSnapshot> }>()
  private listeners = new Set<() => void>()
  private version = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  private notify() { this.version++; for (const listener of this.listeners) listener() }
  private select(bookId: string) { if (this.bookId !== bookId) { this.clear(); this.bookId = bookId } }
  get(bookId: string, editionKey: string) { return bookId === this.bookId ? this.snapshots.get(editionKey) : undefined }
  getPosition(bookId: string, editionKey: string) { return bookId === this.bookId ? this.positions.get(editionKey) : undefined }
  setPosition(bookId: string, editionKey: string, position: ApiPosition | null) {
    if (bookId !== this.bookId) return
    const current = this.positions.get(editionKey)
    if (current !== undefined && current !== null && (position === null || position.version < current.version)) return
    this.positions.set(editionKey, position); this.notify()
  }
  clear() {
    for (const request of this.requests.values()) request.controller.abort()
    this.requests.clear(); this.snapshots.clear(); this.positions.clear(); this.bookId = ''; this.notify()
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
    const [toc, details, editions] = await Promise.all([
      apiFetch<{ toc: ApiToc }>(path + '/toc' + query + (refresh ? '&refresh=true' : ''), { signal }),
      apiFetch<BookDetailsResponse>(path + '/details' + query, { signal }),
      apiFetch<{ editions: ApiEdition[] }>(path + '/editions', { signal }),
    ])
    return { toc: toc.toc, details, editions: editions.editions }
  }, refresh)
}
