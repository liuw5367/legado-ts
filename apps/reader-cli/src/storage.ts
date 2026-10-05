import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentCacheRecord, ContentIdentity, ContentSaveToken, ContentStore, ContentWriteInput, StoreWriteResult } from '@legado/source-core'
import { CacheStore } from './cache-store.ts'
import type { WorkflowCache } from './cache-store.ts'
import { JsonStore } from './json-store.ts'
import { normalizeReaderSettings } from './reader-settings.ts'
import {
  defaultStoragePaths,
  normalizeSearchName,
  sha256,
  type BookDocument,
  type BookshelfEntry,
  type HomeBookView,
  type KnownSource,
  type ReadingPosition,
  type ReadingRecord,
  type ReaderSettings,
  type SearchHistoryEntry,
  type SourceCheckConfig,
  type SourceCheckRecord,
  type SourceStateRecord,
  type SourceStateFile,
  type StorageOptions,
  type StoragePaths,
  type TocSnapshot,
} from './storage-model.ts'

export type {
  BookDocument,
  BookshelfEntry,
  HomeBookView,
  KnownSource,
  KnownSourceMatch,
  KnownSourceView,
  ReadingPosition,
  ReadingRecord,
  ReaderSettings,
  SearchHistoryEntry,
  SourceCheckConfig,
  SourceCheckRecord,
  SourceCheckStageRecord,
  SourceStateFile,
  SourceStateRecord,
  StorageOptions,
  StoragePaths,
  TocSnapshot,
} from './storage-model.ts'
export { chapterKey, defaultStoragePaths, editionKey, normalizeSearchName, sha256 } from './storage-model.ts'

interface Manifest {
  storageVersion: 1
  createdAt: string
  lastSuccessfulStartAt: string
}

interface StoredContentState {
  identity: ContentIdentity
  record?: ContentCacheRecord
  writeVersion?: string
  operationId?: string
  expiresAt?: number
}

const MAX_SEARCH_HISTORY = 100
const MAX_UNSHELVED_READING = 200
const MAX_CACHE_BYTES = 512 * 1024 * 1024
const DEFAULT_SOURCE_CHECK_CONFIG: SourceCheckConfig = {
  timeoutMs: 180_000,
  checkDomain: false,
  checkSearch: true,
  checkDiscovery: true,
  checkInfo: true,
  checkCategory: true,
  checkContent: true,
  keyword: '我的',
}

function searchHistoryTime(entry: Pick<SearchHistoryEntry, 'startedAt' | 'completedAt'>): string {
  return entry.completedAt ?? entry.startedAt
}

function iso(now: () => Date): string {
  return now().toISOString()
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export class ReaderStorage {
  public readonly paths: StoragePaths
  private readonly now: () => Date
  private readonly jsonStore: JsonStore
  private readonly cacheStore: CacheStore
  private writeQueue: Promise<void> = Promise.resolve()
  private lockInstance: string | undefined

  public constructor(options: StorageOptions = {}) {
    this.paths = options.paths ?? defaultStoragePaths()
    this.now = options.now ?? (() => new Date())
    this.jsonStore = new JsonStore(this.now)
    this.cacheStore = new CacheStore({ paths: this.paths, now: this.now, maxCacheBytes: options.maxCacheBytes ?? MAX_CACHE_BYTES, json: this.jsonStore, withWriteLock: (task) => this.withWriteLock(task) })
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
      const current = await this.jsonStore.readFile<Manifest>(path, { storageVersion: 1, createdAt: iso(this.now), lastSuccessfulStartAt: iso(this.now) })
      await this.jsonStore.writeFile(path, { ...current, lastSuccessfulStartAt: iso(this.now) })
      await this.cacheStore.initialize()
    })
  }

  public async close(): Promise<void> {
    await this.writeQueue
    await this.cacheStore.flush()
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
    const value = await this.jsonStore.readFile<SearchHistoryEntry[]>(join(this.paths.dataRoot, 'search-history.json'), [])
    const latest = new Map<string, SearchHistoryEntry>()
    for (const item of value) {
      const key = normalizeSearchName(item.keyword)
      const current = latest.get(key)
      if (current === undefined || searchHistoryTime(item).localeCompare(searchHistoryTime(current)) > 0) latest.set(key, item)
    }
    return [...latest.values()].sort((left, right) => searchHistoryTime(right).localeCompare(searchHistoryTime(left))).slice(0, limit)
  }

  public async getReaderSettings(): Promise<ReaderSettings> {
    const value = await this.jsonStore.readFile<Partial<ReaderSettings>>(join(this.paths.dataRoot, 'reader-settings.json'), {})
    return normalizeReaderSettings(value)
  }

  public async saveReaderSettings(settings: ReaderSettings): Promise<void> {
    await this.withWriteLock(async () => this.jsonStore.writeFile(join(this.paths.dataRoot, 'reader-settings.json'), normalizeReaderSettings(settings)))
  }

  public async addSearchHistory(entry: Omit<SearchHistoryEntry, 'id'>): Promise<SearchHistoryEntry> {
    return this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'search-history.json')
      const records = await this.jsonStore.readFile<SearchHistoryEntry[]>(path, [])
      const saved: SearchHistoryEntry = { ...entry, id: randomUUID(), openedBookIds: [...entry.openedBookIds] }
      const name = normalizeSearchName(saved.keyword)
      const next = [saved, ...records.filter((item) => normalizeSearchName(item.keyword) !== name)]
      await this.jsonStore.writeFile(path, next.slice(0, MAX_SEARCH_HISTORY))
      return saved
    })
  }

  public async updateSearchHistory(searchId: string, patch: { summary: SearchHistoryEntry['summary']; completedAt?: string }): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'search-history.json')
      const records = await this.jsonStore.readFile<SearchHistoryEntry[]>(path, [])
      const record = records.find((item) => item.id === searchId)
      if (record === undefined) return
      record.summary = { ...patch.summary }
      if (patch.completedAt !== undefined) record.completedAt = patch.completedAt
      await this.jsonStore.writeFile(path, records)
    })
  }

  public async markSearchOpened(searchId: string, bookId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'search-history.json')
      const records = await this.jsonStore.readFile<SearchHistoryEntry[]>(path, [])
      const record = records.find((item) => item.id === searchId)
      if (record !== undefined && !record.openedBookIds.includes(bookId)) {
        record.openedBookIds.push(bookId)
        await this.jsonStore.writeFile(path, records)
      }
    })
  }

  public async getReadingRecords(): Promise<ReadingRecord[]> {
    const records = await this.jsonStore.readFile<ReadingRecord[]>(join(this.paths.dataRoot, 'reading-history.json'), [])
    return records.sort((left, right) => (right.lastReadAt ?? '').localeCompare(left.lastReadAt ?? ''))
  }

  public async getReadingRecord(bookId: string): Promise<ReadingRecord | undefined> {
    safeUuid(bookId)
    return (await this.getReadingRecords()).find((item) => item.bookId === bookId)
  }

  public async saveReadingPosition(input: { bookId: string; position: ReadingPosition; openedAt?: string }): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'reading-history.json')
      const records = await this.jsonStore.readFile<ReadingRecord[]>(path, [])
      const shelf = await this.jsonStore.readFile<BookshelfEntry[]>(join(this.paths.dataRoot, 'bookshelf.json'), [])
      const timestamp = input.position.lastReadAt
      const existing = records.find((item) => item.bookId === input.bookId)
      const record: ReadingRecord = existing ?? { bookId: input.bookId, positions: {}, updatedAt: timestamp }
      record.positions[input.position.editionKey] = input.position
      record.activeEditionKey = input.position.editionKey
      record.lastReadAt = timestamp
      if (input.openedAt !== undefined) record.lastOpenedAt = input.openedAt
      record.updatedAt = timestamp
      const next = [record, ...records.filter((item) => item.bookId !== input.bookId)]
      await this.jsonStore.writeFile(path, this.pruneReading(next, new Set(shelf.map((item) => item.bookId))))
    })
  }

  public async markReadingOpened(bookId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'reading-history.json')
      const records = await this.jsonStore.readFile<ReadingRecord[]>(path, [])
      const timestamp = iso(this.now)
      const existing = records.find((item) => item.bookId === bookId)
      if (existing === undefined) return
      existing.lastOpenedAt = timestamp
      existing.updatedAt = timestamp
      await this.jsonStore.writeFile(path, records)
    })
  }

  public async setReadingEdition(bookId: string, editionKey: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'reading-history.json')
      const records = await this.jsonStore.readFile<ReadingRecord[]>(path, [])
      const existing = records.find((item) => item.bookId === bookId)
      if (existing === undefined) return
      existing.activeEditionKey = editionKey
      existing.updatedAt = iso(this.now)
      await this.jsonStore.writeFile(path, records)
    })
  }

  public async getBookshelf(): Promise<BookshelfEntry[]> {
    return this.jsonStore.readFile<BookshelfEntry[]>(join(this.paths.dataRoot, 'bookshelf.json'), [])
  }

  public async isOnBookshelf(bookId: string): Promise<boolean> {
    return (await this.getBookshelf()).some((item) => item.bookId === bookId)
  }

  public async toggleBookshelf(bookId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'bookshelf.json')
      const records = await this.jsonStore.readFile<BookshelfEntry[]>(path, [])
      const index = records.findIndex((item) => item.bookId === bookId)
      if (index >= 0) {
        records.splice(index, 1)
        await this.jsonStore.writeFile(path, records)
        return false
      }
      const timestamp = iso(this.now)
      records.unshift({ bookId, addedAt: timestamp, updatedAt: timestamp })
      await this.jsonStore.writeFile(path, records)
      return true
    })
  }

  public async getBook(bookId: string): Promise<BookDocument | undefined> {
    return this.jsonStore.readOptional<BookDocument>(join(this.paths.dataRoot, 'books', safeUuid(bookId), 'book.json'))
  }

  public async listBooks(): Promise<BookDocument[]> {
    const directory = join(this.paths.dataRoot, 'books')
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const books: BookDocument[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue
      const book = await this.jsonStore.readOptional<BookDocument>(join(directory, entry.name, 'book.json'))
      if (book !== undefined) books.push(book)
    }
    return books
  }

  public async upsertBook(book: BookDocument): Promise<void> {
    await this.withWriteLock(async () => this.jsonStore.writeFile(join(this.paths.dataRoot, 'books', safeUuid(book.bookId), 'book.json'), book))
  }

  public async getTocSnapshot(bookId: string, edition: string): Promise<TocSnapshot | undefined> {
    return this.jsonStore.readOptional<TocSnapshot>(this.tocSnapshotPath(bookId, edition))
  }

  public async saveTocSnapshot(bookId: string, edition: string, snapshot: TocSnapshot): Promise<void> {
    await this.withWriteLock(async () => {
      await this.jsonStore.writeFile(this.tocSnapshotPath(bookId, edition), snapshot)
    })
  }

  /** 返回绑定到单本书的数据存储；章节正文不会进入 source-core 的原始页面缓存。 */
  public contentStore(bookId: string): ContentStore {
    const safeBookId = safeUuid(bookId)
    return {
      read: (identity, signal) => this.readContentRecord(safeBookId, identity, signal),
      reserve: (identity, operationId, signal) => this.reserveContentWrite(safeBookId, identity, operationId, signal),
      write: (input, signal) => this.writeContentRecord(safeBookId, input, signal),
    }
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
    return this.jsonStore.readFile<KnownSource[]>(join(this.paths.dataRoot, 'books', safeUuid(bookId), 'sources.json'), [])
  }

  public async mergeKnownSources(bookId: string, additions: readonly KnownSource[]): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'books', safeUuid(bookId), 'sources.json')
      const current = await this.jsonStore.readFile<KnownSource[]>(path, [])
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
      await this.jsonStore.writeFile(path, capped.sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt)).slice(0, 100))
    })
  }

  public async confirmKnownSource(bookId: string, edition: string): Promise<void> {
    await this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'books', safeUuid(bookId), 'sources.json')
      const current = await this.jsonStore.readFile<KnownSource[]>(path, [])
      const timestamp = iso(this.now)
      const next = current.map((item) => item.editionKey === edition ? { ...item, matchKind: 'user-confirmed' as const, confirmedAt: timestamp } : item)
      await this.jsonStore.writeFile(path, next)
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

  public workflowCache(namespace = ''): WorkflowCache {
    return this.cacheStore.workflowCache(namespace)
  }

  public async getSourceInput(sourceUrl: string): Promise<string | undefined> {
    return this.cacheStore.getSourceInput(sourceUrl)
  }

  public async setSourceInput(sourceUrl: string, value: string): Promise<void> {
    await this.cacheStore.setSourceInput(sourceUrl, value)
  }

  public async getSourceStates(): Promise<SourceStateFile> {
    return this.jsonStore.readFile<SourceStateFile>(join(this.paths.dataRoot, 'source-state.json'), {})
  }

  public async saveSourceStates(states: SourceStateFile): Promise<void> {
    await this.withWriteLock(async () => this.jsonStore.writeFile(join(this.paths.dataRoot, 'source-state.json'), states))
  }

  public async updateSourceStates(update: (states: SourceStateFile) => SourceStateFile): Promise<SourceStateFile> {
    return this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'source-state.json')
      const next = update(await this.jsonStore.readFile<SourceStateFile>(path, {}))
      await this.jsonStore.writeFile(path, next)
      return next
    })
  }

  public async getSourceCheckConfig(): Promise<SourceCheckConfig> {
    const value = await this.jsonStore.readFile<Partial<SourceCheckConfig>>(join(this.paths.dataRoot, 'source-check-config.json'), DEFAULT_SOURCE_CHECK_CONFIG)
    return normalizeSourceCheckConfig(value)
  }

  public async saveSourceCheckConfig(config: SourceCheckConfig): Promise<void> {
    await this.withWriteLock(async () => this.jsonStore.writeFile(join(this.paths.dataRoot, 'source-check-config.json'), normalizeSourceCheckConfig(config)))
  }

  public async saveSourceCheck(sourceId: string, record: SourceCheckRecord, defaults?: Pick<SourceStateRecord, 'enabled' | 'enabledExplore' | 'customOrder' | 'weight' | 'searchHealth'>): Promise<void> {
    await this.updateSourceStates((states) => {
      const current = states[sourceId]
      if (current === undefined) {
        return { ...states, [sourceId]: { fingerprint: record.fingerprint, enabled: defaults?.enabled ?? true, enabledExplore: defaults?.enabledExplore ?? true, customOrder: defaults?.customOrder ?? 0, weight: defaults?.weight ?? 0, searchHealth: defaults?.searchHealth ?? { fingerprint: record.fingerprint, consecutiveFailures: 0 }, check: record } }
      }
      if (current.fingerprint !== record.fingerprint) return states
      return { ...states, [sourceId]: { ...current, check: record } }
    })
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

  private async withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task)
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private tocSnapshotPath(bookId: string, edition: string): string {
    return join(this.paths.dataRoot, 'books', safeUuid(bookId), 'toc', `${safeDigest(edition)}.json`)
  }

  private contentPath(bookId: string, identity: ContentIdentity): string {
    return join(this.paths.dataRoot, 'books', safeUuid(bookId), 'content', `${sha256(contentIdentityKey(identity))}.json`)
  }

  private async readContentState(bookId: string, identity: ContentIdentity): Promise<StoredContentState | undefined> {
    const state = await this.jsonStore.readOptional<StoredContentState>(this.contentPath(bookId, identity))
    if (state === undefined || !sameContentIdentity(state.identity, identity)) return undefined
    return state
  }

  private async readContentRecord(bookId: string, identity: ContentIdentity, signal?: AbortSignal): Promise<ContentCacheRecord | undefined> {
    throwIfAborted(signal)
    const state = await this.readContentState(bookId, identity)
    throwIfAborted(signal)
    return state?.record
  }

  private async reserveContentWrite(bookId: string, identity: ContentIdentity, operationId: string, signal?: AbortSignal): Promise<ContentSaveToken> {
    throwIfAborted(signal)
    if (operationId.trim().length === 0) throw new Error('正文缓存操作身份不能为空')
    const token: ContentSaveToken = { operationId, writeVersion: randomUUID(), identity: { ...identity }, expiresAt: this.now().getTime() + 5 * 60_000 }
    await this.withWriteLock(async () => {
      throwIfAborted(signal)
      const path = this.contentPath(bookId, identity)
      const previous = await this.jsonStore.readOptional<StoredContentState>(path)
      const state: StoredContentState = {
        identity: { ...identity },
        ...(previous?.record === undefined ? {} : { record: previous.record }),
        writeVersion: token.writeVersion,
        operationId: token.operationId,
        ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
      }
      await this.jsonStore.writeFile(path, state)
    })
    return token
  }

  private async writeContentRecord(bookId: string, input: ContentWriteInput, signal?: AbortSignal): Promise<StoreWriteResult> {
    const resourceKey = sha256(contentIdentityKey(input.token.identity))
    if (input.token.expiresAt !== undefined && input.token.expiresAt <= this.now().getTime()) {
      return { status: 'stale', committed: false, operationId: input.token.operationId, resourceKey, reason: '正文缓存写入令牌已过期' }
    }
    try {
      throwIfAborted(signal)
      return await this.withWriteLock(async () => {
        throwIfAborted(signal)
        const path = this.contentPath(bookId, input.token.identity)
        const state = await this.jsonStore.readOptional<StoredContentState>(path)
        if (state === undefined || !sameContentIdentity(state.identity, input.token.identity) || state.writeVersion !== input.token.writeVersion || state.operationId !== input.token.operationId) {
          return { status: 'stale', committed: false, operationId: input.token.operationId, resourceKey, reason: '正文缓存写入版本已变化' }
        }
        if (state.expiresAt !== undefined && state.expiresAt <= this.now().getTime()) {
          return { status: 'stale', committed: false, operationId: input.token.operationId, resourceKey, reason: '正文缓存写入令牌已过期' }
        }
        const record = input.saveChapterMetadata ? input.record : { ...input.record, chapter: state.record?.chapter ?? input.record.chapter }
        const next: StoredContentState = { identity: { ...input.token.identity }, record }
        await this.jsonStore.writeFile(path, next)
        return { status: 'committed', committed: true, operationId: input.token.operationId, resourceKey } satisfies StoreWriteResult
      })
    } catch (error) {
      if (signal?.aborted === true) return { status: 'cancelled', committed: false, operationId: input.token.operationId, resourceKey, reason: '正文缓存写入已取消' }
      return { status: 'unknown', committed: false, operationId: input.token.operationId, resourceKey, reason: error instanceof Error ? error.message : '正文缓存写入结果未知' }
    }
  }
}

function safeUuid(value: string): string {
  if (!isUuid(value)) throw new Error('bookId 必须是 UUID')
  return value
}

function safeDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('无效的目录版本身份')
  return value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
}

function contentIdentityKey(identity: ContentIdentity): string {
  return [identity.sessionId, identity.sourceId, identity.bookUrl, identity.chapterKey, identity.tocRevision, String(identity.chapterIndex), identity.resourceKind, identity.sourceRevision, identity.semanticVersion].join('\u0000')
}

function sameContentIdentity(left: ContentIdentity | undefined, right: ContentIdentity): boolean {
  return left !== undefined && contentIdentityKey(left) === contentIdentityKey(right)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function sourcePriority(source: KnownSource): number {
  return source.matchKind === 'user-confirmed' ? 3 : source.matchKind === 'selected' ? 2 : source.matchKind === 'title-author' ? 1 : 0
}

function normalizeSourceCheckConfig(value: Partial<SourceCheckConfig>): SourceCheckConfig {
  const timeoutMs = typeof value.timeoutMs === 'number' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : DEFAULT_SOURCE_CHECK_CONFIG.timeoutMs
  return {
    timeoutMs,
    checkDomain: value.checkDomain === true,
    checkSearch: value.checkSearch !== false,
    checkDiscovery: value.checkDiscovery !== false,
    checkInfo: value.checkInfo !== false,
    checkCategory: value.checkCategory !== false && value.checkInfo !== false,
    checkContent: value.checkContent !== false && value.checkCategory !== false && value.checkInfo !== false,
    keyword: typeof value.keyword === 'string' && value.keyword.trim().length > 0 ? value.keyword.trim() : DEFAULT_SOURCE_CHECK_CONFIG.keyword,
  }
}
