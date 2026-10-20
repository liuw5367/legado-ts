import type { DiscoveryBook, DiscoveryBookResult, DiscoveryCategories, DiscoveryCategory, DiscoveryCursor, DiscoveryPage, DiscoveryPageInput, DiscoverySource } from '../../shared/discovery.ts'

export interface DiscoveryEntry { book: DiscoveryBook; cursor: DiscoveryCursor }
export interface DiscoveryState {
  sources: DiscoverySource[]
  source: DiscoverySource | null
  categories: DiscoveryCategory[]
  categoryId: string
  items: DiscoveryEntry[]
  nextCursor?: DiscoveryCursor | undefined
  loadedCursors: string[]
  loading: boolean
  loadingMore: boolean
  opening: string | null
  loaded: boolean
  error: string
  message: string
}
interface Choice { version: 1; sourceId: string; categoryId: string }
export type DiscoveryRequest = <T>(path: string, init?: RequestInit) => Promise<T>

const emptyState = (): DiscoveryState => ({ sources: [], source: null, categories: [], categoryId: '', items: [], loadedCursors: [], loading: false, loadingMore: false, opening: null, loaded: false, error: '', message: '' })
const cursorKey = (cursor: DiscoveryCursor) => JSON.stringify([cursor.index, cursor.token ?? null])
const storageKey = (userId: string) => `legado.discovery.v1:${userId}`

export function clearDiscoveryChoice(userId: string, storage?: Storage) {
  // 隐私模式及存储禁用不阻断找书。
  try { storage?.removeItem(storageKey(userId)) } catch { /* 本地偏好可丢弃。 */ }
}

/** 只缓存当前分类，避免浏览多个书源后无限累积列表；账号由 Provider 隔离。 */
export class DiscoveryStore {
  private state = emptyState()
  private listeners = new Set<() => void>()
  private controller: AbortController | undefined
  private choice: Choice | undefined
  private userId: string
  private request: DiscoveryRequest
  private storage: Storage | undefined
  public scrollY = 0
  public constructor(userId: string, request: DiscoveryRequest, storage?: Storage) {
    this.userId = userId; this.request = request; this.storage = storage
    try {
      const value: unknown = JSON.parse(storage?.getItem(storageKey(userId)) ?? 'null')
      if (value !== null && typeof value === 'object' && 'version' in value && value.version === 1 && 'sourceId' in value && typeof value.sourceId === 'string' && 'categoryId' in value && typeof value.categoryId === 'string') this.choice = { version: 1, sourceId: value.sourceId, categoryId: value.categoryId }
    } catch { /* 格式无效或存储不可用时采用首个可用源。 */ }
  }
  public subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  public getSnapshot = () => this.state
  private update(patch: Partial<DiscoveryState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private begin() { this.controller?.abort(); const controller = new AbortController(); this.controller = controller; return controller }
  public suspend() { this.controller?.abort(); this.controller = undefined; this.update({ loading: false, loadingMore: false, opening: null }) }
  private remember() {
    const source = this.state.source
    if (source === null) return
    this.choice = { version: 1, sourceId: source.sourceId, categoryId: this.state.categoryId }
    try { this.storage?.setItem(storageKey(this.userId), JSON.stringify(this.choice)) } catch { /* 保存偏好失败不影响浏览。 */ }
  }
  public async initialize(sourceId?: string, categoryId?: string, refresh = false): Promise<void> {
    const controller = this.begin()
    const previous = this.state
    this.update({ loading: true, loadingMore: false, opening: null, error: '' })
    try {
      const { sources } = await this.request<{ sources: DiscoverySource[] }>('/api/discovery/sources', { signal: controller.signal })
      if (controller.signal.aborted) return
      const wantedSource = sourceId ?? this.choice?.sourceId
      const source = sources.find((item) => item.sourceId === wantedSource) ?? sources[0] ?? null
      if (source === null) { this.update({ ...emptyState(), sources, loaded: true }); return }
      const sameSource = previous.source?.sourceId === source.sourceId && previous.source.fingerprint === source.fingerprint
      const wantedCategory = categoryId ?? (sourceId === undefined || sourceId === this.choice?.sourceId ? this.choice?.categoryId : undefined)
      if (!refresh && sameSource && previous.loaded && (wantedCategory === undefined || previous.categoryId === wantedCategory)) {
        this.update({ sources, loading: false }); return
      }
      this.scrollY = 0
      this.update({ source, sources, categories: sameSource ? previous.categories : [], categoryId: '', items: [], nextCursor: undefined, loadedCursors: [], loaded: false, message: '' })
      const data = await this.request<DiscoveryCategories>('/api/discovery/categories?sourceId=' + encodeURIComponent(source.sourceId), { signal: controller.signal })
      if (controller.signal.aborted) return
      const category = data.categories.find((item) => item.id === wantedCategory) ?? data.categories[0]
      this.update({ source: data.source, categories: data.categories, categoryId: category?.id ?? '', message: data.message ?? '' })
      this.remember()
      if (category === undefined) { this.update({ loading: false, loaded: true }); return }
      const page = await this.queryPage(undefined, controller.signal)
      if (!controller.signal.aborted) this.acceptPage(page, false)
    } catch (reason) { if (!controller.signal.aborted) this.update({ loading: false, error: reason instanceof Error ? reason.message : '发现加载失败' }) }
  }
  private pageInput(cursor?: DiscoveryCursor): DiscoveryPageInput {
    const source = this.state.source
    if (source === null) throw new Error('请先选择书源')
    return { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: this.state.categoryId, ...(cursor === undefined ? {} : { cursor }) }
  }
  private queryPage(cursor: DiscoveryCursor | undefined, signal: AbortSignal) {
    return this.request<DiscoveryPage>('/api/discovery/page', { method: 'POST', signal, body: JSON.stringify(this.pageInput(cursor)) })
  }
  private acceptPage(page: DiscoveryPage, append: boolean) {
    const items = append ? [...this.state.items] : []
    const identities = new Set(items.map(({ book }) => JSON.stringify([book.sourceId, book.bookUrl])))
    let added = 0
    for (const book of page.items) {
      const key = JSON.stringify([book.sourceId, book.bookUrl])
      if (identities.has(key)) continue
      identities.add(key); items.push({ book, cursor: page.cursor }); added++
    }
    const loadedCursors = [...(append ? this.state.loadedCursors : []), cursorKey(page.cursor)]
    const repeated = page.nextCursor !== undefined && loadedCursors.includes(cursorKey(page.nextCursor))
    const stopped = repeated || (append && added === 0)
    this.update({ items, loadedCursors, nextCursor: stopped ? undefined : page.nextCursor, loading: false, loadingMore: false, loaded: true, error: '', message: stopped ? '没有更多新书籍了。' : page.message ?? '' })
  }
  public async loadMore(): Promise<void> {
    const cursor = this.state.nextCursor
    if (cursor === undefined || this.state.loading || this.state.loadingMore || this.state.opening !== null) return
    const controller = this.begin()
    this.update({ loadingMore: true, error: '' })
    try { const page = await this.queryPage(cursor, controller.signal); if (!controller.signal.aborted) this.acceptPage(page, true) }
    catch (reason) { if (!controller.signal.aborted) this.update({ loadingMore: false, error: reason instanceof Error ? reason.message : '下一页加载失败' }) }
  }
  public async openBook(entry: DiscoveryEntry): Promise<DiscoveryBookResult | undefined> {
    if (this.state.loading || this.state.loadingMore || this.state.opening !== null) return
    const controller = this.begin()
    this.update({ opening: entry.book.bookUrl, error: '' })
    try {
      const result = await this.request<DiscoveryBookResult>('/api/discovery/books', { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...this.pageInput(entry.cursor), bookUrl: entry.book.bookUrl }) })
      if (!controller.signal.aborted) { this.update({ opening: null }); return result }
    } catch (reason) { if (!controller.signal.aborted) this.update({ opening: null, error: reason instanceof Error ? reason.message : '书籍详情加载失败' }) }
  }
}
