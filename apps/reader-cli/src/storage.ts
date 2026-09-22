import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentCache } from '@legado/source-core'
import { CacheStore } from './cache-store.ts'
import { JsonStore } from './json-store.ts'
import {
  defaultStoragePaths,
  normalizeSearchName,
  type BookDocument,
  type BookshelfEntry,
  type HomeBookView,
  type KnownSource,
  type ReadingPosition,
  type ReadingRecord,
  type SearchHistoryEntry,
  type StorageOptions,
  type StoragePaths,
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
  SearchHistoryEntry,
  StorageOptions,
  StoragePaths,
} from './storage-model.ts'
export { chapterKey, defaultStoragePaths, editionKey, normalizeSearchName, sha256 } from './storage-model.ts'

interface Manifest {
  storageVersion: 1
  createdAt: string
  lastSuccessfulStartAt: string
}

const MAX_SEARCH_HISTORY = 100
const MAX_UNSHELVED_READING = 200
const MAX_CACHE_BYTES = 512 * 1024 * 1024

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

  public workflowCache(namespace = ''): ContentCache {
    return this.cacheStore.workflowCache(namespace)
  }

  public async getSourceInput(sourceUrl: string): Promise<string | undefined> {
    return this.cacheStore.getSourceInput(sourceUrl)
  }

  public async setSourceInput(sourceUrl: string, value: string): Promise<void> {
    await this.cacheStore.setSourceInput(sourceUrl, value)
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
}

function safeUuid(value: string): string {
  if (!isUuid(value)) throw new Error('bookId 必须是 UUID')
  return value
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function sourcePriority(source: KnownSource): number {
  return source.matchKind === 'user-confirmed' ? 3 : source.matchKind === 'selected' ? 2 : source.matchKind === 'title-author' ? 1 : 0
}
