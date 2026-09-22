import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { ContentCache, JsonObject } from '@legado/source-core'

export interface SearchHistoryEntry {
  id: string
  keyword: string
  sourceScope: 'all' | string[]
  startedAt: string
  completedAt?: string
  summary: {
    searched: number
    success: number
    empty: number
    failed: number
    capabilityMissing: number
    candidates: number
  }
  openedBookIds: string[]
}

export interface ReadingPosition {
  editionKey: string
  sourceId: string
  bookUrl: string
  chapterUrl: string
  index: number
  title: string
  tocRevision?: string
  paragraphIndex: number
  offset: number
  lastReadAt: string
}

export interface ReadingRecord {
  bookId: string
  activeEditionKey?: string
  lastReadAt?: string
  lastOpenedAt?: string
  positions: Record<string, ReadingPosition>
  updatedAt: string
}

export interface BookshelfEntry {
  bookId: string
  addedAt: string
  updatedAt: string
}

export interface BookDocument {
  bookId: string
  name: string
  author?: string
  intro?: string
  coverUrl?: string
  tocUrl?: string
  activeEditionKey?: string
  metadataEditionKey?: string
  createdAt: string
  updatedAt: string
}

export type KnownSourceMatch = 'selected' | 'title-author' | 'title-only' | 'user-confirmed'

export interface KnownSource {
  editionKey: string
  sourceId: string
  sourceFingerprint: string
  bookUrl: string
  name?: string
  author?: string
  intro?: string
  coverUrl?: string
  tocUrl?: string
  lastChapter?: string
  updateTime?: string
  /** 本次搜索从书源请求真正开始到返回终态的耗时，单位毫秒。 */
  searchDurationMs?: number
  rawFields: JsonObject
  discoveredAt: string
  searchId?: string
  matchKind: KnownSourceMatch
  confirmedAt?: string
}

interface FileEnvelope<T> {
  schemaVersion: 1
  revision: number
  updatedAt: string
  data: T
}

interface Manifest {
  storageVersion: 1
  createdAt: string
  lastSuccessfulStartAt: string
}

interface CacheIndexEntry {
  relativePath: string
  category: 'source-input' | 'toc' | 'content'
  bytes: number
  lastAccessedAt: string
}

interface CacheIndex {
  entries: CacheIndexEntry[]
}

interface CacheRecord {
  value: string
  category: CacheIndexEntry['category']
  key: string
  storedAt: string
}

export interface StoragePaths {
  dataRoot: string
  cacheRoot: string
}

export interface HomeBookView {
  book: BookDocument
  reading?: ReadingRecord
  isOnBookshelf: boolean
  lastReadAt?: string
  currentChapter?: string
}

export interface KnownSourceView extends KnownSource {
  state: 'available' | 'removed' | 'stale' | 'conflict'
  sourceName?: string
}

export interface StorageOptions {
  paths?: StoragePaths
  now?: () => Date
  maxCacheBytes?: number
}

const MAX_SEARCH_HISTORY = 100
const MAX_UNSHELVED_READING = 200
const MAX_CACHE_BYTES = 512 * 1024 * 1024

export function defaultStoragePaths(_platform = process.platform, environment: NodeJS.ProcessEnv = process.env): StoragePaths {
  const home = environment.HOME ?? homedir()
  const root = join(home, '.config', 'reader-cli')
  const dataRoot = join(root, 'data-v1')
  const cacheRoot = join(root, 'cache-v1')
  return { dataRoot, cacheRoot }
}

export function editionKey(sourceId: string, bookUrl: string): string {
  return sha256(`${sourceId}\u0000${bookUrl}`)
}

export function chapterKey(input: { editionKey: string; tocRevision?: string; chapterUrl: string; index: number }): string {
  return sha256(`${input.editionKey}\u0000${input.tocRevision ?? ''}\u0000${input.chapterUrl}\u0000${input.index}`)
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 搜索历史的去重键只代表搜索框名称，不代表某本书的永久身份。 */
export function normalizeSearchName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-Hans')
}

function searchHistoryTime(entry: Pick<SearchHistoryEntry, 'startedAt' | 'completedAt'>): string {
  return entry.completedAt ?? entry.startedAt
}

function iso(now: () => Date): string {
  return now().toISOString()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeFilePart(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('缓存键必须是 SHA-256 摘要')
  return value
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export class ReaderStorage {
  public readonly paths: StoragePaths
  private readonly now: () => Date
  private readonly maxCacheBytes: number
  private writeQueue: Promise<void> = Promise.resolve()
  private lockInstance: string | undefined
  private cacheIndex: CacheIndex = { entries: [] }
  private cacheIndexDirty = false

  public constructor(options: StorageOptions = {}) {
    this.paths = options.paths ?? defaultStoragePaths()
    this.now = options.now ?? (() => new Date())
    this.maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES
  }

  public async initialize(): Promise<void> {
    if (this.lockInstance !== undefined) return
    await ensureDirectory(this.paths.dataRoot)
    await ensureDirectory(join(this.paths.dataRoot, 'books'))
    await ensureDirectory(this.paths.cacheRoot)
    await ensureDirectory(join(this.paths.cacheRoot, 'source-input'))
    await ensureDirectory(join(this.paths.cacheRoot, 'toc'))
    await ensureDirectory(join(this.paths.cacheRoot, 'content'))
    await ensureDirectory(join(this.paths.cacheRoot, 'tmp'))
    await this.acquireProcessLock()
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'manifest.json')
      const current = await this.readFile<Manifest>(path, { storageVersion: 1, createdAt: iso(this.now), lastSuccessfulStartAt: iso(this.now) })
      await this.writeFile(path, { ...current, lastSuccessfulStartAt: iso(this.now) })
      let index: CacheIndex | undefined
      try {
        index = await this.readOptional<CacheIndex>(join(this.paths.cacheRoot, 'index.json'))
      } catch {
        index = undefined
      }
      const normalized = index === undefined ? await this.rebuildCacheIndex() : this.normalizeCacheIndex(index)
      this.cacheIndex = normalized
      this.cacheIndexDirty = index === undefined || !isObject(index) || !Array.isArray(index.entries) || index.entries.length !== normalized.entries.length
    })
  }

  public async close(): Promise<void> {
    await this.writeQueue
    await this.flushCacheIndex()
    if (this.lockInstance !== undefined) {
      const lockPath = join(this.paths.dataRoot, 'writer.lock')
      try {
        const raw = await readFile(lockPath, 'utf8')
        if (raw.includes(this.lockInstance)) await rm(lockPath)
      } catch {
        // 进程退出时锁已被清理或目录不可访问，不覆盖原始错误。
      }
      this.lockInstance = undefined
    }
  }

  public async listSearchHistory(limit = 20): Promise<SearchHistoryEntry[]> {
    const value = await this.readFile<SearchHistoryEntry[]>(join(this.paths.dataRoot, 'search-history.json'), [])
    const latest = new Map<string, SearchHistoryEntry>()
    for (const item of value) {
      const key = normalizeSearchName(item.keyword)
      const current = latest.get(key)
      if (current === undefined || searchHistoryTime(item).localeCompare(searchHistoryTime(current)) > 0) latest.set(key, item)
    }
    return [...latest.values()].sort((left, right) => searchHistoryTime(right).localeCompare(searchHistoryTime(left))).slice(0, limit)
  }

  public async addSearchHistory(entry: Omit<SearchHistoryEntry, 'id'>): Promise<SearchHistoryEntry> {
    return this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'search-history.json')
      const records = await this.readFile<SearchHistoryEntry[]>(path, [])
      const saved: SearchHistoryEntry = { ...entry, id: randomUUID(), openedBookIds: [...entry.openedBookIds] }
      const name = normalizeSearchName(saved.keyword)
      const next = [saved, ...records.filter((item) => normalizeSearchName(item.keyword) !== name)]
      await this.writeFile(path, next.slice(0, MAX_SEARCH_HISTORY))
      return saved
    })
  }

  public async markSearchOpened(searchId: string, bookId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'search-history.json')
      const records = await this.readFile<SearchHistoryEntry[]>(path, [])
      const record = records.find((item) => item.id === searchId)
      if (record !== undefined && !record.openedBookIds.includes(bookId)) {
        record.openedBookIds.push(bookId)
        await this.writeFile(path, records)
      }
    })
  }

  public async getReadingRecords(): Promise<ReadingRecord[]> {
    const records = await this.readFile<ReadingRecord[]>(join(this.paths.dataRoot, 'reading-history.json'), [])
    return records.sort((left, right) => (right.lastReadAt ?? '').localeCompare(left.lastReadAt ?? ''))
  }

  public async getReadingRecord(bookId: string): Promise<ReadingRecord | undefined> {
    safeUuid(bookId)
    return (await this.getReadingRecords()).find((item) => item.bookId === bookId)
  }

  public async saveReadingPosition(input: { bookId: string; position: ReadingPosition; openedAt?: string }): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'reading-history.json')
      const records = await this.readFile<ReadingRecord[]>(path, [])
      const shelf = await this.readFile<BookshelfEntry[]>(join(this.paths.dataRoot, 'bookshelf.json'), [])
      const timestamp = input.position.lastReadAt
      const existing = records.find((item) => item.bookId === input.bookId)
      const record: ReadingRecord = existing ?? { bookId: input.bookId, positions: {}, updatedAt: timestamp }
      record.positions[input.position.editionKey] = input.position
      record.activeEditionKey = input.position.editionKey
      record.lastReadAt = timestamp
      if (input.openedAt !== undefined) record.lastOpenedAt = input.openedAt
      record.updatedAt = timestamp
      const next = [record, ...records.filter((item) => item.bookId !== input.bookId)]
      await this.writeFile(path, this.pruneReading(next, new Set(shelf.map((item) => item.bookId))))
    })
  }

  public async markReadingOpened(bookId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'reading-history.json')
      const records = await this.readFile<ReadingRecord[]>(path, [])
      const timestamp = iso(this.now)
      const existing = records.find((item) => item.bookId === bookId)
      if (existing === undefined) return
      existing.lastOpenedAt = timestamp
      existing.updatedAt = timestamp
      await this.writeFile(path, records)
    })
  }

  public async setReadingEdition(bookId: string, editionKey: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'reading-history.json')
      const records = await this.readFile<ReadingRecord[]>(path, [])
      const existing = records.find((item) => item.bookId === bookId)
      if (existing === undefined) return
      existing.activeEditionKey = editionKey
      existing.updatedAt = iso(this.now)
      await this.writeFile(path, records)
    })
  }

  public async getBookshelf(): Promise<BookshelfEntry[]> {
    return this.readFile<BookshelfEntry[]>(join(this.paths.dataRoot, 'bookshelf.json'), [])
  }

  public async isOnBookshelf(bookId: string): Promise<boolean> {
    return (await this.getBookshelf()).some((item) => item.bookId === bookId)
  }

  public async toggleBookshelf(bookId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'bookshelf.json')
      const records = await this.readFile<BookshelfEntry[]>(path, [])
      const index = records.findIndex((item) => item.bookId === bookId)
      if (index >= 0) {
        records.splice(index, 1)
        await this.writeFile(path, records)
        return false
      }
      const timestamp = iso(this.now)
      records.unshift({ bookId, addedAt: timestamp, updatedAt: timestamp })
      await this.writeFile(path, records)
      return true
    })
  }

  public async getBook(bookId: string): Promise<BookDocument | undefined> {
    return this.readOptional<BookDocument>(join(this.paths.dataRoot, 'books', safeUuid(bookId), 'book.json'))
  }

  public async listBooks(): Promise<BookDocument[]> {
    const directory = join(this.paths.dataRoot, 'books')
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const books: BookDocument[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue
      const book = await this.readOptional<BookDocument>(join(directory, entry.name, 'book.json'))
      if (book !== undefined) books.push(book)
    }
    return books
  }

  public async upsertBook(book: BookDocument): Promise<void> {
    await this.withWriteLock(async () => this.writeFile(join(this.paths.dataRoot, 'books', safeUuid(book.bookId), 'book.json'), book))
  }

  public async findBookIdByEdition(sourceId: string, bookUrl: string): Promise<string | undefined> {
    const books = await this.listBooks()
    for (const book of books) {
      const sources = await this.listKnownSources(book.bookId)
      if (sources.some((source) => source.sourceId === sourceId && source.bookUrl === bookUrl)) return book.bookId
    }
    return undefined
  }

  public async listKnownSources(bookId: string): Promise<KnownSource[]> {
    return this.readFile<KnownSource[]>(join(this.paths.dataRoot, 'books', safeUuid(bookId), 'sources.json'), [])
  }

  public async mergeKnownSources(bookId: string, additions: readonly KnownSource[]): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'books', safeUuid(bookId), 'sources.json')
      const current = await this.readFile<KnownSource[]>(path, [])
      const byEdition = new Map(current.map((item) => [item.editionKey, item]))
      for (const addition of additions) {
        const old = byEdition.get(addition.editionKey)
        if (old === undefined) byEdition.set(addition.editionKey, addition)
        else byEdition.set(addition.editionKey, { ...old, ...addition, ...(old.confirmedAt === undefined && addition.confirmedAt === undefined ? {} : { confirmedAt: old.confirmedAt ?? addition.confirmedAt }) })
      }
      const grouped = new Map<string, KnownSource[]>()
      for (const item of byEdition.values()) grouped.set(item.sourceId, [...(grouped.get(item.sourceId) ?? []), item])
      const capped: KnownSource[] = []
      for (const values of grouped.values()) capped.push(...values.sort((left, right) => sourcePriority(right) - sourcePriority(left) || right.discoveredAt.localeCompare(left.discoveredAt)).slice(0, 5))
      await this.writeFile(path, capped.sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt)).slice(0, 100))
    })
  }

  public async confirmKnownSource(bookId: string, edition: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'books', safeUuid(bookId), 'sources.json')
      const current = await this.readFile<KnownSource[]>(path, [])
      const timestamp = iso(this.now)
      const next = current.map((item) => item.editionKey === edition ? { ...item, matchKind: 'user-confirmed' as const, confirmedAt: timestamp } : item)
      await this.writeFile(path, next)
    })
  }

  public async homeViews(): Promise<HomeBookView[]> {
    const [books, shelf, readings] = await Promise.all([this.listBooks(), this.getBookshelf(), this.getReadingRecords()])
    const shelfIds = new Set(shelf.map((item) => item.bookId))
    const readingMap = new Map(readings.map((item) => [item.bookId, item]))
    return books.map((book) => {
      const reading = readingMap.get(book.bookId)
      const currentEdition = reading?.activeEditionKey ?? book.activeEditionKey
      const currentChapter = currentEdition === undefined ? undefined : reading?.positions[currentEdition]?.title
      return { book, ...(reading === undefined ? {} : { reading }), isOnBookshelf: shelfIds.has(book.bookId), ...(reading?.lastReadAt === undefined ? {} : { lastReadAt: reading.lastReadAt }), ...(currentChapter === undefined ? {} : { currentChapter }) }
    }).sort((left, right) => (right.lastReadAt ?? right.book.updatedAt).localeCompare(left.lastReadAt ?? left.book.updatedAt))
  }

  public workflowCache(namespace = ''): ContentCache {
    return {
      get: async (key, signal) => this.getWorkflowCache(key, signal, namespace),
      set: async (key, value, signal) => this.setWorkflowCache(key, value, signal, namespace),
    }
  }

  public async getSourceInput(sourceUrl: string): Promise<string | undefined> {
    return this.getCacheValue('source-input', sha256(sourceUrl))
  }

  public async setSourceInput(sourceUrl: string, value: string): Promise<void> {
    await this.setCacheValue('source-input', sha256(sourceUrl), value)
  }

  private async getWorkflowCache(key: string, signal?: AbortSignal, namespace = ''): Promise<string | undefined> {
    throwIfAborted(signal)
    const parts = key.split('\u0000')
    const category = parts[1] === 'content' ? 'content' : parts[1] === 'toc' ? 'toc' : undefined
    if (category === undefined) return undefined
    return this.getCacheValue(category, sha256(namespace.length === 0 ? key : `${namespace}\u0000${key}`), signal)
  }

  private async setWorkflowCache(key: string, value: string, signal?: AbortSignal, namespace = ''): Promise<void> {
    throwIfAborted(signal)
    const parts = key.split('\u0000')
    const category = parts[1] === 'content' ? 'content' : parts[1] === 'toc' ? 'toc' : undefined
    if (category === undefined) return
    await this.setCacheValue(category, sha256(namespace.length === 0 ? key : `${namespace}\u0000${key}`), value, signal)
  }

  private async getCacheValue(category: CacheIndexEntry['category'], key: string, signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal)
    const path = cachePath(this.paths.cacheRoot, category, safeFilePart(key))
    const value = await this.readOptional<CacheRecord>(path)
    if (value === undefined) return undefined
    const entry = this.cacheIndex.entries.find((item) => item.relativePath === normalizeCacheRelativePath(relative(this.paths.cacheRoot, path)))
    if (entry !== undefined) entry.lastAccessedAt = iso(this.now)
    this.cacheIndexDirty = true
    return value.value
  }

  private async setCacheValue(category: CacheIndexEntry['category'], key: string, value: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const path = cachePath(this.paths.cacheRoot, category, safeFilePart(key))
    await this.withWriteLock(async () => {
      await this.writeFile(path, { value, category, key, storedAt: iso(this.now) } satisfies CacheRecord)
      const relativePath = normalizeCacheRelativePath(relative(this.paths.cacheRoot, path))
      const bytes = new TextEncoder().encode(value).byteLength
      if (relativePath === undefined) throw new Error('缓存路径不在缓存目录内')
      const existing = this.cacheIndex.entries.find((item) => item.relativePath === relativePath)
      const item: CacheIndexEntry = { relativePath, category, bytes, lastAccessedAt: iso(this.now) }
      if (existing === undefined) this.cacheIndex.entries.push(item)
      else Object.assign(existing, item)
      this.cacheIndexDirty = true
      await this.evictCacheIfNeeded()
    })
  }

  private async evictCacheIfNeeded(): Promise<void> {
    let total = this.cacheIndex.entries.reduce((sum, item) => sum + item.bytes, 0)
    if (total <= this.maxCacheBytes) return
    const sorted = [...this.cacheIndex.entries].sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt))
    for (const entry of sorted) {
      if (total <= this.maxCacheBytes) break
      const entryPath = cacheEntryPath(this.paths.cacheRoot, entry)
      if (entryPath === undefined) {
        this.cacheIndex.entries = this.cacheIndex.entries.filter((item) => item.relativePath !== entry.relativePath)
        continue
      }
      await rm(entryPath, { force: true })
      this.cacheIndex.entries = this.cacheIndex.entries.filter((item) => item.relativePath !== entry.relativePath)
      total -= entry.bytes
    }
    await this.flushCacheIndex()
  }

  private normalizeCacheIndex(value: CacheIndex): CacheIndex {
    if (!isObject(value) || !Array.isArray(value.entries)) return { entries: [] }
    const entries: CacheIndexEntry[] = []
    for (const item of value.entries) {
      if (!isObject(item) || typeof item.relativePath !== 'string' || typeof item.bytes !== 'number' || !Number.isFinite(item.bytes) || item.bytes < 0 || typeof item.lastAccessedAt !== 'string') continue
      const category = cacheCategory(item.category)
      const relativePath = normalizeCacheRelativePath(item.relativePath)
      if (category === undefined || relativePath === undefined || cacheEntryPath(this.paths.cacheRoot, { relativePath, category, bytes: item.bytes, lastAccessedAt: item.lastAccessedAt }) === undefined) continue
      entries.push({ relativePath, category, bytes: item.bytes, lastAccessedAt: item.lastAccessedAt })
    }
    return { entries }
  }

  private async rebuildCacheIndex(): Promise<CacheIndex> {
    const entries: CacheIndexEntry[] = []
    for (const category of ['source-input', 'toc', 'content'] as const) {
      const directory = join(this.paths.cacheRoot, category)
      const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        const path = join(directory, file.name)
        const metadata = await stat(path).catch(() => undefined)
        if (metadata === undefined) continue
        const relativePath = normalizeCacheRelativePath(relative(this.paths.cacheRoot, path))
        if (relativePath !== undefined) entries.push({ relativePath, category, bytes: metadata.size, lastAccessedAt: metadata.mtime.toISOString() })
      }
    }
    return { entries }
  }

  private async flushCacheIndex(): Promise<void> {
    if (!this.cacheIndexDirty) return
    await this.writeFile(join(this.paths.cacheRoot, 'index.json'), this.cacheIndex)
    this.cacheIndexDirty = false
  }

  private pruneReading(records: ReadingRecord[], shelfIds: ReadonlySet<string>): ReadingRecord[] {
    const kept = records.filter((item) => shelfIds.has(item.bookId) || item.lastReadAt !== undefined)
    const unshelved = kept.filter((item) => !shelfIds.has(item.bookId)).sort((left, right) => (right.lastReadAt ?? '').localeCompare(left.lastReadAt ?? ''))
    const allowed = new Set(unshelved.slice(0, MAX_UNSHELVED_READING).map((item) => item.bookId))
    return kept.filter((item) => shelfIds.has(item.bookId) || allowed.has(item.bookId))
  }

  private async acquireProcessLock(): Promise<void> {
    const path = join(this.paths.dataRoot, 'writer.lock')
    const instance = randomUUID()
    const payload = `${process.pid}\n${new Date().toISOString()}\n${instance}\n`
    try {
      await writeFile(path, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      this.lockInstance = instance
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let existing: string
    try {
      existing = await readFile(path, 'utf8')
    } catch {
      return this.acquireProcessLock()
    }
    const pid = Number.parseInt(existing.split('\n')[0] ?? '', 10)
    let active = false
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        active = true
      } catch (error) {
        active = (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    if (active) throw new Error('已有另一个 legado-reader 实例正在写入状态目录')
    await rm(path, { force: true })
    await writeFile(path, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    this.lockInstance = instance
  }

  private async readOptional<T>(path: string): Promise<T | undefined> {
    try {
      return await this.readFile<T>(path, undefined)
    } catch (error) {
      if (error instanceof Error && ['missing-file', 'corrupt-file', 'unsupported-schema'].includes(error.message)) return undefined
      throw error
    }
  }

  private async readFile<T>(path: string, fallback: T | undefined): Promise<T> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('missing-file')
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      const backup = `${path}.corrupt-${this.now().toISOString().replaceAll(':', '')}.json`
      await rename(path, backup)
      if (fallback !== undefined) {
        await this.writeFile(path, fallback)
        return fallback
      }
      throw new Error('corrupt-file')
    }
    if (isEnvelope(parsed)) return parsed.data as T
    if (isUnsupportedEnvelope(parsed)) {
      const backup = `${path}.unsupported-${this.now().toISOString().replaceAll(':', '')}.json`
      await rename(path, backup)
      if (fallback !== undefined) {
        await this.writeFile(path, fallback)
        return fallback
      }
      throw new Error('unsupported-schema')
    }
    return parsed as T
  }

  private async writeFile<T>(path: string, value: T): Promise<void> {
    await ensureDirectory(dirname(path))
    const existing = await this.readEnvelopeRevision(path)
    const envelope: FileEnvelope<T> = { schemaVersion: 1, revision: existing + 1, updatedAt: iso(this.now), data: value }
    const temporary = join(dirname(path), `.${basename(path) || 'state'}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 })
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  }

  private async readEnvelopeRevision(path: string): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      return isEnvelope(parsed) ? parsed.revision : 0
    } catch {
      return 0
    }
  }

  private async withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task)
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }
}

function isEnvelope(value: unknown): value is FileEnvelope<unknown> {
  return isObject(value) && value.schemaVersion === 1 && typeof value.revision === 'number' && typeof value.updatedAt === 'string' && 'data' in value
}

function isUnsupportedEnvelope(value: unknown): boolean {
  return isObject(value) && typeof value.schemaVersion === 'number' && value.schemaVersion !== 1 && 'data' in value
}

function cacheCategory(value: unknown): CacheIndexEntry['category'] | undefined {
  return value === 'source-input' || value === 'toc' || value === 'content' ? value : undefined
}

function normalizeCacheRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/')
  // 索引只能引用三个缓存分类下的 SHA-256 文件，拒绝绝对路径、父目录和其他文件名。
  return /^(?:source-input|toc|content)\/[a-f0-9]{64}\.json$/u.test(normalized) ? normalized : undefined
}

function cacheEntryPath(root: string, entry: CacheIndexEntry): string | undefined {
  const normalized = normalizeCacheRelativePath(entry.relativePath)
  if (normalized === undefined || !normalized.startsWith(`${entry.category}/`)) return undefined
  const key = normalized.slice(entry.category.length + 1, -'.json'.length)
  // 重新校验文件名，避免未来调用方绕过相对路径校验后形成删除路径。
  if (!/^[a-f0-9]{64}$/u.test(key)) return undefined
  return cachePath(root, entry.category, key)
}

function cachePath(root: string, category: CacheIndexEntry['category'], key: string): string {
  return join(root, category, `${key}.json`)
}

function safeUuid(value: string): string {
  if (!isUuid(value)) throw new Error('bookId 必须是 UUID')
  return value
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
}

function sourcePriority(source: KnownSource): number {
  return source.matchKind === 'user-confirmed' ? 3 : source.matchKind === 'selected' ? 2 : source.matchKind === 'title-author' ? 1 : 0
}
