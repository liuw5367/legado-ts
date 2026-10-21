import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { editionKey } from '@legado/reader-backup'
import { discoverBooks, evaluateExploreViewName, executeExploreAction, loadBookDetails, parseExploreKinds, type BookCandidate, type ExploreKind, type PageCursor, type SourceSession } from '@legado/source-core'
import type { DiscoveryBookInput, DiscoveryCategories, DiscoveryCategory, DiscoveryControlInput, DiscoveryControlResult, DiscoveryCursor, DiscoveryPage, DiscoveryPageInput, DiscoverySource } from '../../shared/discovery.ts'
import { sameBookIdentity } from '../../shared/book-identity.ts'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import { configuredSecret } from '../db/runtime-state-crypto.ts'
import { ReaderRuntimeError, requireSource, withPersistentSourceSession, type PersistentSourceState } from './source-session.ts'

interface Category extends DiscoveryCategory { url?: string }

function available(source: StoredSourceRecord): boolean {
  return source.enabled && source.normalizedSource.enabledExplore !== false && typeof source.normalizedSource.exploreUrl === 'string' && source.normalizedSource.exploreUrl.trim().length > 0
}
function summary(source: StoredSourceRecord): DiscoverySource {
  return { sourceId: source.sourceId, name: source.name, fingerprint: source.fingerprint, ...(source.group === undefined ? {} : { group: source.group }) }
}

function dynamicExploreUrl(source: StoredSourceRecord): boolean {
  const value = String(source.normalizedSource.exploreUrl ?? '').trim()
  return /^@js:/iu.test(value) || /^<js>/iu.test(value)
}

function categoryId(source: StoredSourceRecord, index: number, category: Omit<Category, 'id'>): string {
  // 分类脚本可能在每次请求时生成不同 URL；把已解析的分类内容纳入 ID，
  // 这样旧页面不会把新的动态 URL 当成同一个分类继续执行。
  return createHash('sha256').update(JSON.stringify([source.fingerprint, index, category])).digest('hex').slice(0, 24)
}

function categoriesFromKinds(source: StoredSourceRecord, kinds: readonly ExploreKind[]): Category[] {
  const categories: Category[] = []
  let group = ''
  for (const [index, kind] of kinds.entries()) {
    const title = kind.title.trim()
    const type = kind.type ?? 'url'
    const url = kind.url?.trim() ?? ''
    if (title.length === 0) continue
    if (type === 'url' && url.length === 0) { group = title; continue }
    const category = { title, ...(group.length === 0 ? {} : { group }), ...(type === 'url' ? {} : { type }), ...(url.length === 0 ? {} : { url }), ...(kind.action === undefined ? {} : { action: kind.action }), ...(kind.chars === undefined ? {} : { chars: kind.chars }), ...(kind.default === undefined ? {} : { default: kind.default }), ...(kind.viewName === undefined ? {} : { viewName: kind.viewName }), ...(kind.style === undefined ? {} : { style: kind.style as Record<string, unknown> }) }
    categories.push({ id: categoryId(source, index, category), ...category })
  }
  return categories
}

function publicCategory(category: Category, state?: PersistentSourceState): DiscoveryCategory {
  const { url: _url, action: _action, viewName: _viewName, ...safe } = category
  const value = state === undefined || category.type === undefined || category.type === 'url' ? undefined : state.infoMap[category.title]
  return { ...safe, ...(value === undefined ? {} : { value }) }
}

function initializeControlValues(state: PersistentSourceState, categories: readonly Category[]): void {
  for (const category of categories) {
    if (category.type !== 'toggle' && category.type !== 'select') continue
    if (state.infoMap[category.title] !== undefined) continue
    const first = category.default ?? category.chars?.find((value): value is string => value !== null)
    if (first !== undefined) state.infoMap[category.title] = first
  }
}

async function resolveCategoryLabels(session: SourceSession, source: StoredSourceRecord, state: PersistentSourceState, categories: Category[], signal?: AbortSignal): Promise<void> {
  for (const category of categories) {
    const expression = category.viewName?.trim()
    if (expression === undefined || expression.length === 0) continue
    if (expression.length >= 3 && expression.length <= 19 && expression.startsWith("'") && expression.endsWith("'")) {
      category.label = expression.slice(1, -1)
      continue
    }
    const result = await session.run((ports) => evaluateExploreViewName(ports, source.normalizedSource, expression, { infoMap: state.infoMap, ...(signal === undefined ? {} : { signal }) }))
    state.replaceInfoMap(result.infoMap)
    category.label = result.value
  }
}

export async function listDiscoverySources(repository: ReaderRepository, userId: string): Promise<{ sources: DiscoverySource[] }> {
  // 仓储已按管理顺序排列并选出每个域名当前启用的版本。
  return { sources: (await repository.listSourcesForUser(userId)).filter(available).map(summary) }
}

async function discoverySource(repository: ReaderRepository, userId: string, sourceId: string) {
  const source = await requireSource(repository, userId, sourceId)
  if (!available(source)) throw new ReaderRuntimeError('not-found', '此书源未启用发现')
  return source
}

/** 分类地址只从已授权书源解析，返回给客户端的分类不包含可修改的请求 URL。 */
export function parseDiscoveryCategories(source: StoredSourceRecord): { categories: Category[]; message?: string } {
  const text = String(source.normalizedSource.exploreUrl ?? '').trim()
  const lower = text.toLowerCase()
  if (lower.startsWith('@js:') || lower.startsWith('<js>')) return { categories: [], message: '此书源使用动态发现分类，暂不支持，请切换书源或使用搜索。' }
  let rows: Array<{ title: string; url?: string; type?: string; action?: string; chars?: Array<string | null>; default?: string; viewName?: string; style?: Record<string, unknown> }> = []
  if (text.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(text)
      if (!Array.isArray(value)) throw new Error('invalid categories')
      rows = value.flatMap((item: unknown) => {
        if (item === null || typeof item !== 'object') return []
        const row = item as Record<string, unknown>
        return typeof row.title === 'string' ? [{ title: row.title, ...(typeof row.url === 'string' ? { url: row.url } : {}), ...(typeof row.type === 'string' ? { type: row.type } : {}), ...(typeof row.action === 'string' ? { action: row.action } : {}), ...(Array.isArray(row.chars) ? { chars: row.chars.map((value) => value === null || typeof value === 'string' ? value : String(value)) } : {}), ...(typeof row.default === 'string' ? { default: row.default } : {}), ...(typeof row.viewName === 'string' ? { viewName: row.viewName } : {}), ...(row.style !== null && typeof row.style === 'object' && !Array.isArray(row.style) ? { style: row.style as Record<string, unknown> } : {}) }] : []
      })
    } catch { return { categories: [], message: '发现分类配置无效，请切换书源或使用搜索。' } }
  } else if (text.length > 0) {
    // Android 文本分类以 && 或换行分隔，首个 :: 后的内容完整保留为地址。
    rows = text.split(/&&|\r?\n/u).map((item) => {
      const split = item.indexOf('::')
      if (split >= 0) return { title: item.slice(0, split), url: item.slice(split + 2) }
      // 单独的 HTTP 地址可作为只有一个“浏览”分类的源。
      return item.trim().startsWith('http://') || item.trim().startsWith('https://') ? { title: '浏览', url: item } : { title: item }
    })
  }
  const categories: Category[] = []
  let group = ''
  for (const [index, row] of rows.entries()) {
    const title = row.title.trim()
    const url = row.url?.trim() ?? ''
    const type = row.type ?? 'url'
    if (url.length === 0 && type === 'url') { if (title.length > 0) group = title; continue }
    if (title.length === 0) continue
    const category = { title, ...(group.length === 0 ? {} : { group }), ...(type === 'url' ? {} : { type }), ...(url.length === 0 ? {} : { url }), ...(row.action === undefined ? {} : { action: row.action }), ...(row.chars === undefined ? {} : { chars: row.chars }), ...(row.default === undefined ? {} : { default: row.default }), ...(row.viewName === undefined ? {} : { viewName: row.viewName }), ...(row.style === undefined ? {} : { style: row.style }) }
    categories.push({ id: categoryId(source, index, category), ...category })
  }
  return { categories, ...(categories.length > 0 ? {} : { message: '此书源没有可用的发现分类。' }) }
}

async function resolveDiscoveryCategories(source: StoredSourceRecord, session: SourceSession, state: PersistentSourceState, signal?: AbortSignal): Promise<{ categories: Category[]; message?: string }> {
  if (state.discovery !== undefined && state.discovery.fingerprint === source.fingerprint) {
    const categories = structuredClone(state.discovery.categories)
    initializeControlValues(state, categories)
    return { categories, ...(categories.length === 0 ? { message: '此书源没有可用的发现分类。' } : {}) }
  }
  let categories: Category[]
  if (!dynamicExploreUrl(source)) {
    const result = parseDiscoveryCategories(source)
    categories = result.categories
    if (result.message !== undefined) return result
  } else {
    const result = await session.run((ports) => parseExploreKinds(ports, source.normalizedSource, { infoMap: state.infoMap, ...(signal === undefined ? {} : { signal }) }))
    state.replaceInfoMap(result.infoMap)
    const diagnostic = result.diagnostics[0]
    if (diagnostic !== undefined) return { categories: [], message: diagnostic.message }
    categories = categoriesFromKinds(source, result.kinds)
  }
  initializeControlValues(state, categories)
  await resolveCategoryLabels(session, source, state, categories, signal)
  state.replaceDiscovery({ version: 1, fingerprint: source.fingerprint, categories: structuredClone(categories) })
  return { categories, ...(categories.length === 0 ? { message: '此书源没有可用的发现分类。' } : {}) }
}

export async function getDiscoveryCategories(repository: ReaderRepository, userId: string, sourceId: string): Promise<DiscoveryCategories> {
  const source = await discoverySource(repository, userId, sourceId)
  return withPersistentSourceSession(repository, userId, source, async (session, state) => {
    const result = await resolveDiscoveryCategories(source, session, state)
    return { source: summary(source), categories: result.categories.map((category) => publicCategory(category, state)), ...(result.message === undefined ? {} : { message: result.message }) }
  })
}

export async function updateDiscoveryControl(repository: ReaderRepository, userId: string, input: DiscoveryControlInput, signal?: AbortSignal): Promise<DiscoveryControlResult> {
  const { source } = await selection(repository, userId, input)
  return withPersistentSourceSession(repository, userId, source, async (session, state) => {
    const resolved = await resolveDiscoveryCategories(source, session, state, signal)
    const category = resolved.categories.find((item) => item.id === input.categoryId)
    if (category === undefined) throw new ReaderRuntimeError('invalid-input', resolved.message ?? '发现分类已失效，请重新选择')
    const type = category.type ?? 'url'
    if (type === 'url') throw new ReaderRuntimeError('invalid-input', '普通发现分类不需要控件操作')
    const chars = category.chars?.filter((value): value is string => value !== null) ?? []
    if (type === 'toggle' || type === 'select') {
      if (input.value === undefined || !chars.includes(input.value)) throw new ReaderRuntimeError('invalid-input', '控件选项无效，请刷新后重试')
      state.infoMap[category.title] = input.value
    } else if (type === 'text') {
      if (input.value === undefined) throw new ReaderRuntimeError('invalid-input', '文本控件缺少值')
      state.infoMap[category.title] = input.value
    } else if (type !== 'button') {
      throw new ReaderRuntimeError('invalid-input', '暂不支持的发现控件类型')
    }
    if (category.action !== undefined && category.action.trim().length > 0) {
      const action = await session.run((ports) => executeExploreAction(ports, source.normalizedSource, category.action!, { infoMap: state.infoMap, ...(signal === undefined ? {} : { signal }) }))
      state.replaceInfoMap(action.infoMap)
      const diagnostic = action.diagnostics[0]
      if (diagnostic !== undefined) throw new ReaderRuntimeError('source-failed', diagnostic.message)
      if (action.refreshRequested) state.discovery = undefined
    }
    if (state.discovery !== undefined) {
      await resolveCategoryLabels(session, source, state, resolved.categories, signal)
      state.replaceDiscovery({ version: 1, fingerprint: source.fingerprint, categories: structuredClone(resolved.categories) })
    }
    const next = state.discovery === undefined ? await resolveDiscoveryCategories(source, session, state, signal) : { categories: resolved.categories }
    const value = state.infoMap[category.title]
    return { categories: next.categories.map((item) => publicCategory(item, state)), categoryId: next.categories.find((item) => item.id === category.id)?.id ?? next.categories.find((item) => (item.type ?? 'url') === 'url')?.id ?? '', ...(value === undefined ? {} : { value }), refreshed: next.categories !== resolved.categories, ...(next.message === undefined ? {} : { message: next.message }) }
  })
}

function signature(userId: string, input: DiscoveryPageInput, cursor: { index: number; token?: string | undefined }): string {
  // nextPage 规则可返回完整 URL，因此必须验证游标签名，不能直接执行客户端提供的 token。
  return createHmac('sha256', configuredSecret()).update(JSON.stringify(['discovery-v1', userId, input.sourceId, input.fingerprint, input.categoryId, cursor.index, cursor.token ?? null])).digest('base64url')
}
function signCursor(userId: string, input: DiscoveryPageInput, cursor: PageCursor): DiscoveryCursor {
  return { index: cursor.index, ...(cursor.token === undefined ? {} : { token: cursor.token }), signature: signature(userId, input, cursor) }
}
function verifyCursor(userId: string, input: DiscoveryPageInput): void {
  if (input.cursor === undefined) return
  const expected = Buffer.from(signature(userId, input, input.cursor))
  const received = Buffer.from(input.cursor.signature)
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) throw new ReaderRuntimeError('invalid-input', '分页信息无效，请刷新列表')
}
async function selection(repository: ReaderRepository, userId: string, input: DiscoveryPageInput) {
  const source = await discoverySource(repository, userId, input.sourceId)
  if (source.fingerprint !== input.fingerprint) throw new ReaderRuntimeError('invalid-input', '书源已更新，请刷新发现页面')
  verifyCursor(userId, input)
  return { source }
}
async function queryPage(session: SourceSession, source: StoredSourceRecord, category: Category, input: DiscoveryPageInput, state: PersistentSourceState, signal?: AbortSignal) {
  const categoryUrl = category.url
  if (categoryUrl === undefined || categoryUrl.length === 0 || (category.type !== undefined && category.type !== 'url')) throw new ReaderRuntimeError('invalid-input', '此发现分类需要先完成控件操作')
  const result = await session.run((ports) => discoverBooks(ports, {
    source: { ...source.normalizedSource, exploreUrl: categoryUrl },
    infoMap: state.infoMap,
    ...(input.cursor === undefined ? {} : { cursor: { index: input.cursor.index, ...(input.cursor.token === undefined ? {} : { token: input.cursor.token }) } }),
    ...(signal === undefined ? {} : { signal }),
  }))
  if (signal?.aborted) throw new ReaderRuntimeError('source-failed', '发现请求已取消')
  if (result.value === null || result.status === 'failed' || result.status === 'cancelled' || result.status === 'capability-missing') throw new ReaderRuntimeError('source-failed', result.diagnostics[0]?.message ?? '发现列表加载失败')
  return { page: result.value, status: result.status, message: result.status === 'partial' ? '部分书籍解析失败，已保留可用结果。' : undefined }
}

export async function loadDiscoveryPage(repository: ReaderRepository, userId: string, input: DiscoveryPageInput, signal?: AbortSignal): Promise<DiscoveryPage> {
  const { source } = await selection(repository, userId, input)
  return withPersistentSourceSession(repository, userId, source, async (session, state) => {
    const resolved = await resolveDiscoveryCategories(source, session, state, signal)
    const category = resolved.categories.find((item) => item.id === input.categoryId)
    if (category === undefined) throw new ReaderRuntimeError('invalid-input', resolved.message ?? '发现分类已失效，请重新选择')
    const { page, status, message } = await queryPage(session, source, category, input, state, signal)
    return {
      // infoPage/rawFields 仅保留在执行器内部，不向浏览器泄漏源页面及脚本变量。
      items: page.items.map(({ sourceId, bookUrl, name, author, intro, coverUrl, kind, lastChapter, wordCount }) => ({ sourceId, bookUrl, ...(name === undefined ? {} : { name }), ...(author === undefined ? {} : { author }), ...(intro === undefined ? {} : { intro }), ...(coverUrl === undefined ? {} : { coverUrl }), ...(kind === undefined ? {} : { kind }), ...(lastChapter === undefined ? {} : { lastChapter }), ...(wordCount === undefined ? {} : { wordCount }) })),
      cursor: signCursor(userId, input, page.cursor),
      ...(page.nextCursor === undefined ? {} : { nextCursor: signCursor(userId, input, page.nextCursor) }),
      status,
      ...(message === undefined ? {} : { message }),
    }
  })
}

export async function openDiscoveryBook(repository: ReaderRepository, userId: string, input: DiscoveryBookInput, signal?: AbortSignal) {
  const { source } = await selection(repository, userId, input)
  return withPersistentSourceSession(repository, userId, source, async (session, state) => {
    const resolved = await resolveDiscoveryCategories(source, session, state, signal)
    const category = resolved.categories.find((item) => item.id === input.categoryId)
    if (category === undefined) throw new ReaderRuntimeError('invalid-input', resolved.message ?? '发现分类已失效，请重新选择')
    const { page } = await queryPage(session, source, category, input, state, signal)
    const candidate: BookCandidate | undefined = page.items.find((item) => item.bookUrl === input.bookUrl)
    if (candidate === undefined) throw new ReaderRuntimeError('invalid-input', '列表已更新，请刷新后重试')
    const details = await session.run((ports) => loadBookDetails(ports, { source: source.normalizedSource, candidates: [candidate], ...(signal === undefined ? {} : { signal }) }))
    if (signal?.aborted) throw new ReaderRuntimeError('source-failed', '详情请求已取消')
    const metadata = details.value?.items[0]
    if (metadata === undefined) throw new ReaderRuntimeError('source-failed', details.diagnostics[0]?.message ?? '书籍详情加载失败')
    const existing = (await repository.listBooks(userId)).find(({ book }) => sameBookIdentity(book.name, book.author, metadata.name ?? candidate.name, metadata.author ?? candidate.author))
    return repository.createBook(userId, {
      candidate: { sourceId: source.sourceId, sourceFingerprint: source.fingerprint, candidate }, metadata,
      editionKey: editionKey(source.sourceId, metadata.bookUrl), sourceFingerprint: source.fingerprint,
      addToBookshelf: false, activateEdition: false,
      ...(existing === undefined ? {} : { bookId: existing.book.id }),
    })
  })
}
