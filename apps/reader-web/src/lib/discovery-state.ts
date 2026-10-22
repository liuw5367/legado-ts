import type { DiscoveryBook, DiscoveryBookResult, DiscoveryCategories, DiscoveryCategory, DiscoveryControlResult, DiscoveryCursor, DiscoveryPage, DiscoveryPageInput, DiscoverySource } from '../../shared/discovery.ts'

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
  controlPending: string | null
  opening: string | null
  loaded: boolean
  error: string
  message: string
}
interface Choice { version: 1; sourceId: string; categoryId: string }
export type DiscoveryRequest = <T>(path: string, init?: RequestInit) => Promise<T>

const emptyState = (): DiscoveryState => ({ sources: [], source: null, categories: [], categoryId: '', items: [], nextCursor: undefined, loadedCursors: [], loading: false, loadingMore: false, controlPending: null, opening: null, loaded: false, error: '', message: '' })
const cursorKey = (cursor: DiscoveryCursor) => JSON.stringify([cursor.index, cursor.token ?? null, cursor.generation ?? null, cursor.stateDigest ?? null])
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
  private retryOperation: (() => Promise<DiscoveryBookResult | void>) | undefined
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
  private begin() { this.controller?.abort(); this.retryOperation = undefined; const controller = new AbortController(); this.controller = controller; return controller }
  public suspend() { this.controller?.abort(); this.controller = undefined; this.update({ loading: false, loadingMore: false, controlPending: null, opening: null }) }
  private remember() {
    const source = this.state.source
    if (source === null) return
    this.choice = { version: 1, sourceId: source.sourceId, categoryId: this.state.categoryId }
    try { this.storage?.setItem(storageKey(this.userId), JSON.stringify(this.choice)) } catch { /* 保存偏好失败不影响浏览。 */ }
  }
  public async initialize(sourceId?: string, categoryId?: string, refresh = false, restore = false): Promise<void> {
    const previous = this.state
    if (restore && !refresh && previous.loaded && previous.error.length === 0 && (sourceId === undefined || sourceId === previous.source?.sourceId) && (categoryId === undefined || categoryId === previous.categoryId)) return
    const controller = this.begin()
    const wantedSourceId = sourceId ?? this.choice?.sourceId
    const wantedCategoryId = categoryId ?? (sourceId === undefined || sourceId === this.choice?.sourceId ? this.choice?.categoryId : undefined)
    const cachedCategory = previous.categories.find((category) => category.id === wantedCategoryId)
    const sameCachedSource = previous.source !== null && (wantedSourceId === undefined || wantedSourceId === previous.source.sourceId)
    // 分类切换复用已加载的分类栏，只清空旧书目并请求新分类，避免标签栏随请求卸载。
    if (!refresh && sameCachedSource && cachedCategory !== undefined && cachedCategory.id !== previous.categoryId) {
      this.scrollY = 0
      this.update({ source: previous.source, sources: previous.sources, categories: previous.categories, categoryId: cachedCategory.id, items: [], nextCursor: undefined, loadedCursors: [], loading: true, loadingMore: false, controlPending: null, opening: null, loaded: false, error: '', message: '' })
      this.remember()
      try {
        const page = await this.queryPage(undefined, controller.signal)
        if (!controller.signal.aborted) this.acceptPage(page, false)
      } catch (reason) {
        if (!controller.signal.aborted) {
          this.retryOperation = () => this.initialize(sourceId, categoryId, refresh)
          this.update({ loading: false, error: reason instanceof Error ? reason.message : '发现加载失败' })
        }
      }
      return
    }
    const changingSelection = previous.source !== null && ((sourceId !== undefined && sourceId !== previous.source.sourceId) || (categoryId !== undefined && categoryId !== previous.categoryId))
    // 显式切源/分类后，旧结果不能在源列表查询失败时重新变成可操作状态。
    if (changingSelection) { this.scrollY = 0; this.update({ ...emptyState(), sources: previous.sources, loading: true }) }
    else this.update({ loading: true, loadingMore: false, controlPending: null, opening: null, error: '' })
    try {
      const { sources } = await this.request<{ sources: DiscoverySource[] }>('/api/discovery/sources', { signal: controller.signal })
      if (controller.signal.aborted) return
      const wantedSource = sourceId ?? this.choice?.sourceId
      const source = sources.find((item) => item.sourceId === wantedSource) ?? sources[0] ?? null
      if (source === null) { this.update({ ...emptyState(), sources, loaded: true }); return }
      const sameSource = previous.source?.sourceId === source.sourceId && previous.source.fingerprint === source.fingerprint
      const wantedCategory = categoryId ?? (sourceId === undefined || sourceId === this.choice?.sourceId ? this.choice?.categoryId : undefined)
      if (!refresh && sameSource && previous.loaded && (wantedCategory === undefined || previous.categoryId === wantedCategory)) {
        this.update({ ...previous, sources, loading: false, loadingMore: false, opening: null, error: '' }); return
      }
      this.scrollY = 0
      this.update({ source, sources, categories: sameSource ? previous.categories : [], categoryId: '', items: [], nextCursor: undefined, loadedCursors: [], loaded: false, message: '' })
      const data = await this.request<DiscoveryCategories>('/api/discovery/categories?sourceId=' + encodeURIComponent(source.sourceId), { signal: controller.signal })
      if (controller.signal.aborted) return
      const category = data.categories.find((item) => item.id === wantedCategory && (item.type ?? 'url') === 'url') ?? data.categories.find((item) => (item.type ?? 'url') === 'url')
      this.update({ source: data.source, categories: data.categories, categoryId: category?.id ?? '', message: data.message ?? '' })
      this.remember()
      if (category === undefined) { this.update({ loading: false, loaded: true }); return }
      const page = await this.queryPage(undefined, controller.signal)
      if (!controller.signal.aborted) this.acceptPage(page, false)
    } catch (reason) {
      if (!controller.signal.aborted) {
        this.retryOperation = () => this.initialize(sourceId, categoryId, refresh)
        this.update({ loading: false, error: reason instanceof Error ? reason.message : '发现加载失败' })
      }
    }
  }
  private pageInput(cursor?: DiscoveryCursor): DiscoveryPageInput {
    const source = this.state.source
    if (source === null) throw new Error('请先选择书源')
    return { sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId: this.state.categoryId, ...(cursor === undefined ? {} : { cursor }) }
  }
  private queryPage(cursor: DiscoveryCursor | undefined, signal: AbortSignal) {
    return this.request<DiscoveryPage>('/api/discovery/page', { method: 'POST', signal, body: JSON.stringify(this.pageInput(cursor)) })
  }
  public async updateControl(categoryId: string, value?: string): Promise<void> {
    const source = this.state.source
    if (source === null || this.state.loading || this.state.loadingMore || this.state.opening !== null) return
    const controller = this.begin()
    this.update({ controlPending: categoryId, error: '' })
    try {
      const result = await this.request<DiscoveryControlResult>('/api/discovery/control', { method: 'POST', signal: controller.signal, body: JSON.stringify({ sourceId: source.sourceId, fingerprint: source.fingerprint, categoryId, ...(value === undefined ? {} : { value }) }) })
      if (controller.signal.aborted) return
      const nextCategoryId = result.categoryId.length > 0 ? result.categoryId : this.state.categoryId
      this.update({ categories: result.categories, categoryId: nextCategoryId, controlPending: null, message: result.message ?? '', ...(result.refreshed ? { items: [], nextCursor: undefined, loadedCursors: [], loaded: false, loading: true } : {}) })
      this.remember()
      if (result.refreshed && nextCategoryId.length > 0) {
        const page = await this.queryPage(undefined, controller.signal)
        if (!controller.signal.aborted) this.acceptPage(page, false)
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        this.retryOperation = () => this.updateControl(categoryId, value)
        this.update({ controlPending: null, error: reason instanceof Error ? reason.message : '发现控件操作失败' })
      }
    }
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
    catch (reason) {
      if (!controller.signal.aborted) {
        this.retryOperation = () => this.loadMore()
        this.update({ loadingMore: false, error: reason instanceof Error ? reason.message : '下一页加载失败' })
      }
    }
  }
  public async openBook(entry: DiscoveryEntry): Promise<DiscoveryBookResult | undefined> {
    if (this.state.loading || this.state.loadingMore || this.state.opening !== null) return
    const controller = this.begin()
    this.update({ opening: entry.book.bookUrl, error: '' })
    try {
      const result = await this.request<DiscoveryBookResult>('/api/discovery/books', { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...this.pageInput(entry.cursor), bookUrl: entry.book.bookUrl }) })
      if (!controller.signal.aborted) { this.update({ opening: null }); return result }
    } catch (reason) {
      if (!controller.signal.aborted) {
        this.retryOperation = () => this.openBook(entry)
        this.update({ opening: null, error: reason instanceof Error ? reason.message : '书籍详情加载失败' })
      }
    }
  }
  /** 重试具体失败的操作；详情成功返回导航目标，列表重试只更新当前状态。 */
  public async retry(): Promise<DiscoveryBookResult | void> { return this.retryOperation?.() }
}
