import { randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BACKUP_CATEGORIES, validateBookOrganizationData, categoryForPath, createBackupZip, editionKey as backupEditionKey, isIsoDateString, jsonBytes, parseJson, readBackupZip, type BackupArchive, type BackupCategory, type BackupFile } from '@legado/reader-backup'
import { importSources, sourceDefinitionFingerprint } from '@legado/source-core'
import type { ContentCacheRecord, ContentIdentity, ContentSaveToken, ContentStore, ContentWriteInput, StoreWriteResult } from '@legado/source-core'
import { CacheStore } from './cache-store.ts'
import type { WorkflowCache } from './cache-store.ts'
import { JsonStore } from './json-store.ts'
import { isReaderHeaderSeparator, isReaderSettingValue, normalizeReaderSettings } from './reader-settings.ts'
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

export interface StoredSourceDefinition {
  sourceId: string
  fingerprint: string
  rawText: string
}

export type {
  BookDocument,
  BookshelfEntry,
  HomeBookView,
  KnownSource,
  KnownSourceMatch,
  KnownSourceView,
  ReadingPosition,
  ReadingRecord,
  ReaderHeaderSeparator,
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

function lockPayload(instance: string): string {
  return `${process.pid}\n${new Date().toISOString()}\n${instance}\n`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return true
    return false
  }
}

async function recoverDataRoot(dataRoot: string): Promise<void> {
  const parent = dirname(dataRoot)
  const prefix = `.${basename(dataRoot)}.rollback-`
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  const rollbackPaths = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map((entry) => join(parent, entry.name))
  const dataRootExists = await pathExists(dataRoot)
  if (!dataRootExists && rollbackPaths.length > 0) {
    const candidates = await Promise.all(rollbackPaths.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })))
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
    const recovery = candidates[0]
    if (recovery !== undefined) {
      await rename(recovery.path, dataRoot)
      rollbackPaths.splice(rollbackPaths.indexOf(recovery.path), 1)
    }
  }
  for (const path of rollbackPaths) await rm(path, { recursive: true, force: true })
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
    await recoverDataRoot(this.paths.dataRoot)
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

  /** 返回可跨端恢复的用户文件；正文和请求缓存永远不会进入备份。 */
  public async backupFiles(): Promise<BackupFile[]> {
    return this.withWriteLock(async () => {
      const files: BackupFile[] = []
      const addJson = async (path: string, fallback: unknown): Promise<void> => {
        const raw = await readFile(join(this.paths.dataRoot, path)).catch(() => undefined)
        files.push({ path, data: raw === undefined ? jsonBytes({ schemaVersion: 1, revision: 0, updatedAt: iso(this.now), data: fallback }) : Uint8Array.from(raw), category: categoryForPath(path) })
      }
      if (await readFile(join(this.paths.dataRoot, 'book-lists.json')).then(() => true, () => false)) await addJson('book-lists.json', { lists: [], items: [] })
      await addJson('bookshelf.json', [])
      await addJson('reading-history.json', [])
      await addJson('search-history.json', [])
      await addJson('reader-settings.json', normalizeReaderSettings(undefined))
      await addJson('source-state.json', {})
      await addJson('source-check-config.json', DEFAULT_SOURCE_CHECK_CONFIG)
      const definitions = await this.getSourceDefinitions()
      assertUniqueSourceIds(definitions)
      files.push({ path: 'sources.json', data: jsonBytes({ schemaVersion: 1, revision: 0, updatedAt: iso(this.now), data: definitions }), category: 'sources' })
      const booksRoot = join(this.paths.dataRoot, 'books')
      const bookDirectories = await readdir(booksRoot, { withFileTypes: true }).catch(() => [])
      for (const entry of bookDirectories) {
        if (!entry.isDirectory() || !isUuid(entry.name)) continue
        for (const name of ['book.json', 'sources.json']) {
          const relative = `books/${entry.name}/${name}`
          const raw = await readFile(join(this.paths.dataRoot, relative)).catch(() => undefined)
          if (raw !== undefined) files.push({ path: relative, data: Uint8Array.from(raw), category: 'bookshelf' })
        }
      }
      return files
    })
  }

  public async createBackupZip(producer: 'reader-cli' | 'reader-web' = 'reader-cli'): Promise<Uint8Array> {
    return createBackupZip(await this.backupFiles(), { producer: { name: producer, version: '0.1.0' }, now: this.now() })
  }

  /** 在写锁内按分类完整替换 JSON 文件，未选分类保持原样。 */
  public async restoreBackup(input: Uint8Array, categories: readonly BackupCategory[]): Promise<{ counts: Record<BackupCategory, number> }> {
    const archive = await validateReaderBackup(input, categories)
    const selected = new Set(categories)
    return this.withWriteLock(async () => {
      const readData = <T>(path: string, fallback: T): T => {
        try {
          const value = parseJson<unknown>(archive, path)
          return unwrapStoredValue(value) as T
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('备份缺少文件')) return fallback
          throw error
        }
      }
      const incomingReading = selected.has('reading') ? readData<ReadingRecord[]>('reading-history.json', []) : undefined
      if (incomingReading !== undefined && !selected.has('bookshelf')) {
        const bookIds = [...new Set(incomingReading.map((record) => record.bookId))]
        for (const bookId of bookIds) {
          const bookRoot = join(this.paths.dataRoot, 'books', safeUuid(bookId))
          try { await readFile(join(bookRoot, 'book.json')) } catch { throw new Error(`阅读记录依赖的书籍不存在：${bookId}，请同时选择书架`) }
          const knownSources = await this.jsonStore.readFile<KnownSource[]>(join(bookRoot, 'sources.json'), [])
          const editionKeys = new Set(knownSources.map((source) => source.editionKey))
          const record = incomingReading.find((item) => item.bookId === bookId)
          if (record !== undefined && Object.values(record.positions).some((position) => !editionKeys.has(position.editionKey))) throw new Error(`阅读记录依赖的书籍版本不存在：${bookId}，请同时选择书架`)
        }
      }
      if (selected.has('bookshelf') && !selected.has('reading')) {
        const currentReading = await this.jsonStore.readFile<ReadingRecord[]>(join(this.paths.dataRoot, 'reading-history.json'), [])
        validateReadingDependencies(currentReading, await readBackupBooks(archive))
      }
      const staging = join(dirname(this.paths.dataRoot), `.${basename(this.paths.dataRoot)}.restore-${randomUUID()}`)
      const rollback = join(dirname(this.paths.dataRoot), `.${basename(this.paths.dataRoot)}.rollback-${randomUUID()}`)
      let swapped = false
      try {
        await ensureDirectory(staging)
        await cp(this.paths.dataRoot, staging, { recursive: true, force: true, filter: (path) => basename(path) !== 'writer.lock' })
        await ensureDirectory(join(staging, 'books'))
        const writeStaged = async <T>(path: string, value: T): Promise<void> => this.jsonStore.writeFile(join(staging, path), value)
        if (selected.has('bookshelf')) {
          const preserved = archive.files.has('book-lists.json') ? [] : await this.jsonStore.readFile<{ items: Array<{ bookId: string }> }>(join(this.paths.dataRoot, 'book-lists.json'), { items: [] }).then((value) => value.items.map((row) => row.bookId))
          const incomingIds = new Set(archive.manifest.files.filter((file) => file.path.endsWith('/book.json')).map((file) => file.path.split('/')[1]))
          const retained = new Map<string, Uint8Array>()
          for (const bookId of new Set(preserved)) {
            safeUuid(bookId)
            if (incomingIds.has(bookId)) {
              const incoming = readData<{ name: string; author?: string }>(`books/${bookId}/book.json`, { name: '' })
              const current = await this.jsonStore.readFile<{ name: string; author?: string }>(join(this.paths.dataRoot, 'books', bookId, 'book.json'), { name: '' })
              if (current.name !== incoming.name || current.author !== incoming.author) throw new Error('导入书籍与本地书单引用的书籍 ID 冲突，请使用 Web 恢复以完成身份映射')
            } else for (const name of ['book.json', 'sources.json']) retained.set(`books/${bookId}/${name}`, await readFile(join(this.paths.dataRoot, 'books', bookId, name)))
          }
          await rm(join(staging, 'books'), { recursive: true, force: true })
          await ensureDirectory(join(staging, 'books'))
          for (const [path, bytes] of retained) { await ensureDirectory(dirname(join(staging, path))); await writeFile(join(staging, path), bytes) }
          if (archive.files.has('book-lists.json')) await writeStaged('book-lists.json', readData('book-lists.json', { lists: [], items: [] }))
          await writeStaged('bookshelf.json', readData('bookshelf.json', []))
          for (const file of archive.manifest.files.filter((item) => item.path.startsWith('books/'))) {
            await writeStaged(file.path, unwrapStoredValue(parseJson<unknown>(archive, file.path)))
          }
        }
        if (incomingReading !== undefined) await writeStaged('reading-history.json', incomingReading)
        if (selected.has('search')) await writeStaged('search-history.json', readData('search-history.json', []))
        if (selected.has('settings')) {
          const incoming = readData<unknown>('reader-settings.json', {})
          const settings = isRecord(incoming) && isRecord(incoming.web) && !isRecord(incoming.cli) ? await this.getReaderSettings() : normalizeReaderSettings((isRecord(incoming) && isRecord(incoming.cli) ? incoming.cli : incoming) as Partial<ReaderSettings>)
          await writeStaged('reader-settings.json', isRecord(incoming) && isRecord(incoming.web) ? { web: incoming.web, cli: settings } : settings)
        }
        if (selected.has('sources')) {
          await writeStaged('source-state.json', readData('source-state.json', {}))
          await writeStaged('source-check-config.json', readData('source-check-config.json', DEFAULT_SOURCE_CHECK_CONFIG))
          const definitions = readData<StoredSourceDefinition[]>('sources.json', [])
          assertUniqueSourceIds(definitions)
          await writeStaged('sources.json', definitions)
        }
        if (this.lockInstance === undefined) throw new Error('存储尚未初始化')
        await writeFile(join(staging, 'writer.lock'), lockPayload(this.lockInstance), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(this.paths.dataRoot, rollback)
        try {
          await rename(staging, this.paths.dataRoot)
          swapped = true
        } catch (error) {
          await rename(rollback, this.paths.dataRoot).catch(() => undefined)
          throw error
        }
        await rm(rollback, { recursive: true, force: true }).catch(() => undefined)
        return { counts: archive.manifest.counts }
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        if (!swapped && await pathExists(rollback) && !await pathExists(this.paths.dataRoot)) await rename(rollback, this.paths.dataRoot).catch(() => undefined)
        throw error
      }
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
    const value = await this.jsonStore.readFile<Partial<ReaderSettings> & { cli?: Partial<ReaderSettings> }>(join(this.paths.dataRoot, 'reader-settings.json'), {})
    return normalizeReaderSettings(isRecord(value) && isRecord(value.cli) ? value.cli : value)
  }

  public async saveReaderSettings(settings: ReaderSettings): Promise<void> {
    await this.withWriteLock(async () => { const path = join(this.paths.dataRoot, 'reader-settings.json'); const previous = await this.jsonStore.readFile<Record<string, unknown>>(path, {}); await this.jsonStore.writeFile(path, isRecord(previous.web) ? { web: previous.web, cli: normalizeReaderSettings(settings) } : normalizeReaderSettings(settings)) })
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

  public async deleteSearchHistory(searchId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const path = join(this.paths.dataRoot, 'search-history.json')
      const records = await this.jsonStore.readFile<SearchHistoryEntry[]>(path, [])
      const record = records.find((item) => item.id === searchId)
      if (record === undefined) return false
      await this.jsonStore.writeFile(path, records.filter((item) => item.id !== searchId))
      return true
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

  public async getSourceDefinitions(): Promise<StoredSourceDefinition[]> {
    return this.jsonStore.readFile<StoredSourceDefinition[]>(join(this.paths.dataRoot, 'sources.json'), [])
  }

  public async saveSourceDefinitions(definitions: readonly StoredSourceDefinition[]): Promise<void> {
    const unique = [...new Map(definitions.map((item) => [`${item.sourceId}\u0000${item.fingerprint}`, item])).values()]
    await this.withWriteLock(async () => this.jsonStore.writeFile(join(this.paths.dataRoot, 'sources.json'), unique))
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

function unwrapStoredValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.schemaVersion === 1 && 'data' in record) return record.data
  }
  return value
}

export async function validateReaderBackup(input: Uint8Array, categories: readonly BackupCategory[]): Promise<BackupArchive> {
  const archive = await readBackupZip(input)
  const selected = new Set(categories)
  if (selected.size === 0 || [...selected].some((category) => !(BACKUP_CATEGORIES as readonly string[]).includes(category))) throw new Error('至少选择一个有效的恢复分类')
  for (const path of ['bookshelf.json', 'reading-history.json', 'search-history.json', 'sources.json', 'source-state.json', 'source-check-config.json', 'reader-settings.json']) if (!archive.files.has(path)) throw new Error(`备份缺少文件：${path}`)
  const data = <T>(path: string): T => unwrapStoredValue(parseJson<unknown>(archive, path)) as T
  const shelf = data<unknown>('bookshelf.json')
  if (!Array.isArray(shelf) || shelf.some((item) => !isRecord(item) || typeof item.bookId !== 'string' || !isUuid(item.bookId) || !isIsoDateString(item.addedAt) || !isIsoDateString(item.updatedAt))) throw new Error('书架数据格式无效')
  const shelfIds = new Set(shelf.map((item) => (item as Record<string, unknown>).bookId as string))
  if (shelfIds.size !== shelf.length) throw new Error('书架包含重复书籍')
  const books = await readBackupBooks(archive)
  if (archive.files.has('book-lists.json')) validateBookOrganizationData(data('book-lists.json'), new Set(books.keys()), shelf as Array<{ bookId: string; groupId?: unknown }>)
  for (const bookId of shelfIds) if (!books.has(bookId)) throw new Error(`书架缺少书籍数据：${bookId}`)
  const reading = validateReadingRecords(data('reading-history.json'))
  validateReadingDependencies(reading, books)
  validateSearchHistory(data('search-history.json'))
  validateReaderSettings(data('reader-settings.json'))
  const definitions = data<unknown>('sources.json')
  if (!Array.isArray(definitions)) throw new Error('书源定义格式无效')
  await validateSourceDefinitions(definitions)
  validateSourceStates(data<unknown>('source-state.json'), definitions as StoredSourceDefinition[])
  validateSourceCheckConfig(data<unknown>('source-check-config.json'))
  return archive
}

async function readBackupBooks(archive: BackupArchive): Promise<Map<string, Set<string>>> {
  const books = new Map<string, Set<string>>()
  const documents = new Set<string>()
  const editionOwners = new Map<string, string>()
  const activeEditions = new Map<string, string | undefined>()
  for (const file of archive.manifest.files.filter((item) => item.path.startsWith('books/'))) {
    const value = unwrapStoredValue(parseJson<unknown>(archive, file.path))
    const parts = file.path.split('/')
    const bookId = parts[1]
    if (bookId === undefined || !isUuid(bookId)) throw new Error(`书籍路径无效：${file.path}`)
    if (file.path.endsWith('/book.json')) {
      if (!isRecord(value) || typeof value.bookId !== 'string' || value.bookId !== bookId || typeof value.name !== 'string' || (value.tocUrl !== undefined && typeof value.tocUrl !== 'string') || (value.activeEditionKey !== undefined && typeof value.activeEditionKey !== 'string') || (value.metadataEditionKey !== undefined && typeof value.metadataEditionKey !== 'string') || !isIsoDateString(value.createdAt) || !isIsoDateString(value.updatedAt)) throw new Error(`书籍数据格式无效：${file.path}`)
      if (documents.has(bookId)) throw new Error(`书籍数据重复：${bookId}`)
      books.set(bookId, books.get(bookId) ?? new Set())
      if (value.activeEditionKey !== undefined && typeof value.activeEditionKey !== 'string') throw new Error(`书籍数据格式无效：${file.path}`)
      activeEditions.set(bookId, value.activeEditionKey as string | undefined)
      documents.add(bookId)
    } else if (file.path.endsWith('/sources.json')) {
      if (!Array.isArray(value)) throw new Error(`书籍书源数据格式无效：${file.path}`)
      const editions = books.get(bookId) ?? new Set<string>()
      for (const source of value) {
        if (!isRecord(source) || typeof source.editionKey !== 'string' || typeof source.sourceId !== 'string' || typeof source.sourceFingerprint !== 'string' || typeof source.bookUrl !== 'string' || source.sourceFingerprint.length === 0 || source.editionKey !== backupEditionKey(source.sourceId, source.bookUrl) || !isIsoDateString(source.discoveredAt) || (source.searchId !== undefined && (typeof source.searchId !== 'string' || !isUuid(source.searchId))) || (source.confirmedAt !== undefined && !isIsoDateString(source.confirmedAt)) || (source.searchDurationMs !== undefined && (!isNonNegativeSafeInteger(source.searchDurationMs))) || typeof source.matchKind !== 'string' || !['selected', 'title-author', 'title-only', 'user-confirmed'].includes(source.matchKind) || (source.rawFields !== undefined && !isRecord(source.rawFields))) throw new Error(`书籍版本数据格式无效：${file.path}`)
        if (editions.has(source.editionKey)) throw new Error(`书籍版本重复：${source.editionKey}`)
        const owner = editionOwners.get(source.editionKey)
        if (owner !== undefined && owner !== bookId) throw new Error(`书籍版本重复：${source.editionKey}`)
        editions.add(source.editionKey)
        editionOwners.set(source.editionKey, bookId)
      }
      books.set(bookId, editions)
    }
  }
  for (const bookId of books.keys()) {
    if (!documents.has(bookId)) throw new Error(`书籍缺少 book.json：${bookId}`)
    if (books.get(bookId)?.size === 0) throw new Error(`书籍缺少版本：${bookId}`)
    const activeEditionKey = activeEditions.get(bookId)
    if (activeEditionKey !== undefined && !books.get(bookId)?.has(activeEditionKey)) throw new Error(`书籍活动版本不存在：${bookId}`)
    const metadataEditionKey = (unwrapStoredValue(parseJson<unknown>(archive, `books/${bookId}/book.json`)) as Record<string, unknown>).metadataEditionKey
    if (metadataEditionKey !== undefined && (typeof metadataEditionKey !== 'string' || !books.get(bookId)?.has(metadataEditionKey))) throw new Error(`书籍元数据版本不存在：${bookId}`)
  }
  return books
}

function validateReadingDependencies(records: readonly ReadingRecord[], books: Map<string, Set<string>>): void {
  for (const record of records) {
    const editions = books.get(record.bookId)
    if (editions === undefined) throw new Error(`阅读记录依赖的书籍不存在：${record.bookId}，请同时选择书架`)
    if (Object.values(record.positions).some((position) => !editions.has(position.editionKey))) throw new Error(`阅读记录依赖的书籍版本不存在：${record.bookId}，请同时选择书架`)
  }
}

async function validateSourceDefinitions(value: unknown[]): Promise<void> {
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item.sourceId !== 'string' || item.sourceId.length === 0 || typeof item.fingerprint !== 'string' || item.fingerprint.length === 0 || typeof item.rawText !== 'string' || item.rawText.length === 0) throw new Error('书源定义格式无效')
    if (seen.has(item.sourceId)) throw new Error(`第一版备份不支持同一 sourceId 的多个指纹：${item.sourceId}`)
    seen.add(item.sourceId)
    const candidates = await importSources({ kind: 'text', text: item.rawText }, { limits: { maxCandidates: 1000, maxBytes: 4 * 1024 * 1024 } })
    const candidate = candidates.find((entry) => entry.source?.bookSourceUrl === item.sourceId)
    const fingerprint = candidate?.sourceFingerprint ?? (candidate?.source === undefined ? undefined : sourceDefinitionFingerprint(candidate.source))
    if (candidate?.source === undefined || fingerprint !== item.fingerprint) throw new Error(`书源定义与 sourceId 或指纹不匹配：${item.sourceId}`)
  }
}

function validateSourceStates(value: unknown, definitions: readonly StoredSourceDefinition[]): void {
  if (!isRecord(value)) throw new Error('书源状态格式无效')
  const fingerprints = new Map(definitions.map((item) => [item.sourceId, item.fingerprint]))
  for (const [sourceId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0 || (fingerprints.has(sourceId) && raw.fingerprint !== fingerprints.get(sourceId)) || typeof raw.enabled !== 'boolean' || typeof raw.enabledExplore !== 'boolean' || !isSafeInteger(raw.customOrder) || !isSafeInteger(raw.weight) || !isRecord(raw.searchHealth) || typeof raw.searchHealth.fingerprint !== 'string' || raw.searchHealth.fingerprint.length === 0 || !isNonNegativeSafeInteger(raw.searchHealth.consecutiveFailures)) throw new Error(`书源状态格式无效：${sourceId}`)
    if (raw.check !== undefined && !isRecord(raw.check)) throw new Error(`书源检测状态格式无效：${sourceId}`)
  }
}

function validateSourceCheckConfig(value: unknown): void {
  if (!isRecord(value) || (value.timeoutMs !== undefined && (!isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0)) || ['checkDomain', 'checkSearch', 'checkDiscovery', 'checkInfo', 'checkCategory', 'checkContent'].some((key) => value[key] !== undefined && typeof value[key] !== 'boolean') || (value.keyword !== undefined && typeof value.keyword !== 'string')) throw new Error('书源检测配置格式无效')
}

function assertUniqueSourceIds(definitions: readonly StoredSourceDefinition[]): void {
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (typeof definition.sourceId !== 'string' || definition.sourceId.length === 0) throw new Error('书源定义缺少 sourceId')
    if (seen.has(definition.sourceId)) throw new Error(`第一版备份不支持同一 sourceId 的多个指纹：${definition.sourceId}`)
    seen.add(definition.sourceId)
  }
}

function validateReadingRecords(value: unknown): ReadingRecord[] {
  if (!Array.isArray(value)) throw new Error('阅读记录格式无效')
  const bookIds = new Set<string>()
  for (const record of value) {
    if (!isRecord(record) || typeof record.bookId !== 'string' || !isUuid(record.bookId) || bookIds.has(record.bookId) || !isIsoDateString(record.updatedAt) || (record.lastReadAt !== undefined && !isIsoDateString(record.lastReadAt)) || (record.lastOpenedAt !== undefined && !isIsoDateString(record.lastOpenedAt)) || !isRecord(record.positions)) throw new Error('阅读记录格式无效')
    bookIds.add(record.bookId)
    if (record.activeEditionKey !== undefined && typeof record.activeEditionKey !== 'string') throw new Error('阅读记录格式无效')
    for (const [key, position] of Object.entries(record.positions)) {
      if (!isRecord(position) || key !== position.editionKey || typeof position.editionKey !== 'string' || typeof position.sourceId !== 'string' || typeof position.bookUrl !== 'string' || position.editionKey !== backupEditionKey(position.sourceId, position.bookUrl) || typeof position.chapterUrl !== 'string' || typeof position.index !== 'number' || !Number.isSafeInteger(position.index) || position.index < 0 || typeof position.title !== 'string' || typeof position.paragraphIndex !== 'number' || !Number.isSafeInteger(position.paragraphIndex) || position.paragraphIndex < 0 || typeof position.offset !== 'number' || !Number.isSafeInteger(position.offset) || position.offset < 0 || !isIsoDateString(position.lastReadAt)) throw new Error('阅读位置格式无效')
    }
    if (record.activeEditionKey !== undefined && !(record.activeEditionKey in record.positions)) throw new Error('阅读记录当前版本不存在')
  }
  return value as ReadingRecord[]
}

function validateSearchHistory(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('搜索记录格式无效')
  const ids = new Set<string>()
  const searchIds = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) throw new Error('搜索记录格式无效')
    const id = raw.id
    const searchId = raw.searchId
    const summary = raw.summary
    if (typeof id !== 'string' || !isUuid(id) || ids.has(id) || (searchId !== undefined && (typeof searchId !== 'string' || !isUuid(searchId) || searchIds.has(searchId))) || typeof raw.keyword !== 'string' || (raw.sourceScope !== 'all' && (!Array.isArray(raw.sourceScope) || raw.sourceScope.some((sourceId) => typeof sourceId !== 'string'))) || !isIsoDateString(raw.startedAt) || (raw.completedAt !== undefined && !isIsoDateString(raw.completedAt)) || (raw.status !== undefined && typeof raw.status !== 'string') || !isRecord(summary) || !['searched', 'success', 'empty', 'failed', 'capabilityMissing', 'candidates'].every((key) => isNonNegativeSafeInteger(summary[key])) || !Array.isArray(raw.openedBookIds) || raw.openedBookIds.some((bookId) => typeof bookId !== 'string')) throw new Error('搜索记录格式无效')
    ids.add(id)
    if (searchId !== undefined) searchIds.add(searchId)
  }
}

function validateReaderSettings(value: unknown): void {
  if (!isRecord(value)) throw new Error('阅读设置格式无效')
  const namespace = 'cli' in value ? value.cli : 'web' in value ? undefined : value
  if (namespace === undefined) {
    if ('web' in value && !isRecord(value.web)) throw new Error('阅读设置格式无效')
    return
  }
  if (!isRecord(namespace)) throw new Error('阅读设置格式无效')
  for (const key of ['searchConcurrency', 'sourceSearchConcurrency', 'sourceCheckConcurrency']) if (key in namespace && !isReaderSettingValue(namespace[key] as number)) throw new Error('阅读设置格式无效')
  for (const key of ['showReaderBookTitle', 'showReaderChapterTitle', 'showReaderChapterIndex', 'showReaderPageProgress', 'showReaderWordCount', 'showReaderStatus']) if (key in namespace && typeof namespace[key] !== 'boolean') throw new Error('阅读设置格式无效')
  if ('readerHeaderSeparator' in namespace && !isReaderHeaderSeparator(namespace.readerHeaderSeparator)) throw new Error('阅读设置格式无效')
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isNonNegativeSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) }

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
