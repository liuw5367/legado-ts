import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { editionKey } from '@legado/reader-backup'
import { discoverBooks, loadBookDetails, type BookCandidate, type PageCursor, type SourceSession } from '@legado/source-core'
import type { DiscoveryBookInput, DiscoveryCategories, DiscoveryCategory, DiscoveryCursor, DiscoveryPage, DiscoveryPageInput, DiscoverySource } from '../../shared/discovery.ts'
import { sameBookIdentity } from '../../shared/book-identity.ts'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import { configuredSecret } from '../db/runtime-state-crypto.ts'
import { ReaderRuntimeError, requireSource, withPersistentSourceSession } from './source-session.ts'

interface Category extends DiscoveryCategory { url: string }

function available(source: StoredSourceRecord): boolean {
  return source.enabled && source.normalizedSource.enabledExplore !== false && typeof source.normalizedSource.exploreUrl === 'string' && source.normalizedSource.exploreUrl.trim().length > 0
}
function summary(source: StoredSourceRecord): DiscoverySource {
  return { sourceId: source.sourceId, name: source.name, fingerprint: source.fingerprint, ...(source.group === undefined ? {} : { group: source.group }) }
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
  let rows: Array<{ title: string; url?: string }> = []
  if (text.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(text)
      if (!Array.isArray(value)) throw new Error('invalid categories')
      rows = value.flatMap((item: unknown) => {
        if (item === null || typeof item !== 'object') return []
        const row = item as Record<string, unknown>
        return typeof row.title === 'string' ? [{ title: row.title, ...(typeof row.url === 'string' ? { url: row.url } : {}) }] : []
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
    if (url.length === 0) { if (title.length > 0) group = title; continue }
    if (title.length === 0) continue
    const id = createHash('sha256').update(JSON.stringify([source.fingerprint, index])).digest('hex').slice(0, 24)
    categories.push({ id, title, url, ...(group.length === 0 ? {} : { group }) })
  }
  return { categories, ...(categories.length > 0 ? {} : { message: '此书源没有可用的发现分类。' }) }
}

export async function getDiscoveryCategories(repository: ReaderRepository, userId: string, sourceId: string): Promise<DiscoveryCategories> {
  const source = await discoverySource(repository, userId, sourceId)
  const result = parseDiscoveryCategories(source)
  return { source: summary(source), categories: result.categories.map(({ url: _url, ...category }) => category), ...(result.message === undefined ? {} : { message: result.message }) }
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
  const category = parseDiscoveryCategories(source).categories.find((item) => item.id === input.categoryId)
  if (category === undefined) throw new ReaderRuntimeError('invalid-input', '发现分类已失效，请重新选择')
  verifyCursor(userId, input)
  return { source, category }
}
async function queryPage(session: SourceSession, source: StoredSourceRecord, category: Category, input: DiscoveryPageInput, signal?: AbortSignal) {
  const result = await session.run((ports) => discoverBooks(ports, {
    source: { ...source.normalizedSource, exploreUrl: category.url },
    ...(input.cursor === undefined ? {} : { cursor: { index: input.cursor.index, ...(input.cursor.token === undefined ? {} : { token: input.cursor.token }) } }),
    ...(signal === undefined ? {} : { signal }),
  }))
  if (signal?.aborted) throw new ReaderRuntimeError('source-failed', '发现请求已取消')
  if (result.value === null || result.status === 'failed' || result.status === 'cancelled' || result.status === 'capability-missing') throw new ReaderRuntimeError('source-failed', result.diagnostics[0]?.message ?? '发现列表加载失败')
  return { page: result.value, status: result.status, message: result.status === 'partial' ? '部分书籍解析失败，已保留可用结果。' : undefined }
}

export async function loadDiscoveryPage(repository: ReaderRepository, userId: string, input: DiscoveryPageInput, signal?: AbortSignal): Promise<DiscoveryPage> {
  const { source, category } = await selection(repository, userId, input)
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    const { page, status, message } = await queryPage(session, source, category, input, signal)
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
  const { source, category } = await selection(repository, userId, input)
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    const { page } = await queryPage(session, source, category, input, signal)
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
