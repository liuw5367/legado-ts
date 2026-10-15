import { createHash, randomUUID } from 'node:crypto'
import { createBackupZip, jsonBytes, parseJson, readBackupZip, type BackupArchive, type BackupCategory, type BackupFile } from '@legado/reader-backup'
import { importSources, sourceDefinitionFingerprint, type NormalizedSource } from '@legado/source-core'
import type { BookCandidate, JsonObject } from '@legado/source-core'
import type { ReaderBackupSnapshot, ReaderRepository } from './db/repository.ts'
import type { ReaderSettings, StoredBook, StoredBookSourceCandidate, StoredEdition, SearchHistoryItem } from './domain/types.ts'

interface StoredSourceDefinition { sourceId: string; fingerprint: string; rawText: string; deleted?: boolean }
interface CliBookDocument { bookId: string; name: string; author?: string; intro?: string; coverUrl?: string; activeEditionKey?: string; createdAt: string; updatedAt: string }
interface CliKnownSource { editionKey: string; sourceId: string; sourceFingerprint: string; bookUrl: string; name?: string; author?: string; intro?: string; coverUrl?: string; tocUrl?: string; variable?: string; rawFields: JsonObject; discoveredAt: string; matchKind: 'selected' | 'title-author' | 'title-only' | 'user-confirmed' }
interface CliReadingPosition { editionKey: string; sourceId: string; bookUrl: string; chapterUrl: string; index: number; title: string; tocRevision?: string; paragraphIndex: number; offset: number; lastReadAt: string }
interface CliReadingRecord { bookId: string; activeEditionKey?: string; lastReadAt?: string; positions: Record<string, CliReadingPosition>; updatedAt: string }
interface CliSearchHistoryEntry { id: string; keyword: string; sourceScope: 'all' | string[]; startedAt: string; completedAt?: string; summary: { searched: number; success: number; empty: number; failed: number; capabilityMissing: number; candidates: number }; openedBookIds: string[] }

export class BackupValidationError extends Error {
  public constructor(message: string) { super(message); this.name = 'BackupValidationError' }
}

export async function createWebBackup(repository: ReaderRepository, userId: string): Promise<Uint8Array> {
  const snapshot = await repository.getBackupSnapshot(userId)
  return createBackupZip(snapshotToFiles(snapshot), { producer: { name: 'reader-web', version: '0.1.0' } })
}

export async function validateWebBackup(repository: ReaderRepository, userId: string, input: Uint8Array): Promise<BackupArchive> {
  const archive = await readValidatedBackup(input)
  try { await parseSnapshot(archive, userId, await repository.getSettings(userId)) } catch (error) { throw new BackupValidationError(error instanceof Error ? error.message : String(error)) }
  return archive
}

export async function restoreWebBackup(repository: ReaderRepository, userId: string, input: Uint8Array, categories: readonly BackupCategory[]): Promise<{ counts: Record<BackupCategory, number> }> {
  const archive = await readValidatedBackup(input)
  const currentSettings = await repository.getSettings(userId)
  let snapshot: ReaderBackupSnapshot
  try { snapshot = await parseSnapshot(archive, userId, currentSettings) } catch (error) { throw new BackupValidationError(error instanceof Error ? error.message : String(error)) }
  await repository.restoreBackupSnapshot(userId, snapshot, categories)
  return { counts: archive.manifest.counts }
}

async function readValidatedBackup(input: Uint8Array): Promise<BackupArchive> {
  try { return await readBackupZip(input) } catch (error) { throw new BackupValidationError(error instanceof Error ? error.message : String(error)) }
}

function snapshotToFiles(snapshot: ReaderBackupSnapshot): BackupFile[] {
  const files: BackupFile[] = []
  const add = (path: string, value: unknown): void => { files.push({ path, data: jsonBytes(envelope(value)), category: path.startsWith('books/') ? 'bookshelf' : path === 'bookshelf.json' ? 'bookshelf' : path === 'reading-history.json' ? 'reading' : path === 'search-history.json' ? 'search' : path === 'reader-settings.json' ? 'settings' : 'sources' }) }
  const definitions: StoredSourceDefinition[] = snapshot.sources.map((item) => ({ sourceId: item.source.sourceId, fingerprint: item.source.fingerprint, rawText: rawSourceText(item.source.rawSource, item.source.normalizedSource), ...(item.deleted === true ? { deleted: true } : {}) }))
  const sourceState = Object.fromEntries(snapshot.sources.map((item) => [item.source.sourceId, { fingerprint: item.source.fingerprint, enabled: item.source.enabled, ...(item.deleted === true ? { deleted: true } : {}), enabledExplore: sourceField(item.source.normalizedSource, 'enabledExplore') !== false, customOrder: readInteger(sourceField(item.source.normalizedSource, 'customOrder'), 0), weight: readInteger(sourceField(item.source.normalizedSource, 'weight'), 0), searchHealth: { fingerprint: item.source.fingerprint, consecutiveFailures: 0 } }]))
  add('bookshelf.json', snapshot.bookshelf.map((item) => ({ ...item, updatedAt: item.addedAt })))
  add('reading-history.json', readingRecords(snapshot))
  add('search-history.json', snapshot.searchHistory.map(toCliSearchHistory))
  add('reader-settings.json', { web: snapshot.settings })
  add('sources.json', definitions)
  add('source-state.json', sourceState)
  add('source-check-config.json', {})
  for (const item of snapshot.books) {
    add(`books/${item.book.id}/book.json`, toCliBook(item.book))
    add(`books/${item.book.id}/sources.json`, [...item.editions.map((edition) => toCliKnownSource(edition, item.book)), ...item.candidates.map((candidate) => toCliCandidate(candidate))])
  }
  return files
}

async function parseSnapshot(archive: BackupArchive, userId: string, currentSettings: ReaderSettings): Promise<ReaderBackupSnapshot> {
  const sourceDefinitions = readData<StoredSourceDefinition[]>(archive, 'sources.json', [])
  const sourceState = readData<Record<string, { fingerprint?: string; enabled?: boolean; deleted?: boolean; enabledExplore?: boolean; customOrder?: number; weight?: number }>>(archive, 'source-state.json', {})
  if (!Array.isArray(sourceDefinitions) || !isRecord(sourceState)) throw new Error('书源数据格式无效')
  const sources: ReaderBackupSnapshot['sources'] = []
  const seenSourceIds = new Set<string>()
  for (const definition of sourceDefinitions) {
    if (!isRecord(definition) || typeof definition.rawText !== 'string' || definition.rawText.length === 0 || typeof definition.sourceId !== 'string' || typeof definition.fingerprint !== 'string') throw new Error('书源定义无效')
    if (seenSourceIds.has(definition.sourceId)) throw new Error(`书源定义重复：${definition.sourceId}`)
    seenSourceIds.add(definition.sourceId)
    const candidates = await importSources({ kind: 'text', text: definition.rawText }, { limits: { maxCandidates: 1, maxBytes: 4 * 1024 * 1024 } })
    const candidate = candidates.find((item) => item.source?.bookSourceUrl === definition.sourceId)
    if (candidate?.source === undefined) throw new Error(`无法解析书源：${definition.sourceId}`)
    const state = sourceState[definition.sourceId]
    const normalized = { ...candidate.source, ...(state?.enabled === undefined ? {} : { enabled: state.enabled }), ...(state?.enabledExplore === undefined ? {} : { enabledExplore: state.enabledExplore }), ...(state?.customOrder === undefined ? {} : { customOrder: state.customOrder }), ...(state?.weight === undefined ? {} : { weight: state.weight }) }
    const fingerprint = definition.fingerprint || candidate.sourceFingerprint || sourceDefinitionFingerprint(normalized)
    const group = sourceField(normalized, 'bookSourceGroup')
    sources.push({ source: { sourceId: normalized.bookSourceUrl, name: normalized.bookSourceName, ...(typeof group === 'string' ? { group } : {}), fingerprint, enabled: normalized.enabled !== false, rawSource: definition.rawText, normalizedSource: normalized }, sourceRevision: randomUUID(), ...(definition.deleted === true || state?.deleted === true ? { deleted: true } : {}) })
  }
  const books = parseBooks(archive, userId)
  const editions = new Map(books.flatMap((item) => item.editions.map((edition) => [`${edition.bookId}:${edition.editionKey}`, edition])))
  const positions = readData<CliReadingRecord[]>(archive, 'reading-history.json', []).flatMap((record) => {
    if (!isUuid(record.bookId) || !isRecord(record.positions)) throw new Error(`阅读记录格式无效：${record.bookId}`)
    return Object.values(record.positions).map((position) => {
      if (typeof position.editionKey !== 'string' || typeof position.chapterUrl !== 'string' || typeof position.index !== 'number' || typeof position.title !== 'string' || typeof position.paragraphIndex !== 'number' || typeof position.offset !== 'number' || typeof position.lastReadAt !== 'string') throw new Error(`阅读位置格式无效：${record.bookId}`)
    const edition = editions.get(`${record.bookId}:${position.editionKey}`)
    if (edition === undefined) throw new Error(`阅读记录缺少书籍版本：${position.editionKey}`)
    return { userId, bookId: record.bookId, editionKey: position.editionKey, chapterId: chapterIdFor(position.chapterUrl, position.index), chapterUrl: position.chapterUrl, chapterIndex: position.index, title: position.title, ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }), paragraphIndex: position.paragraphIndex, offset: position.offset, version: 0, lastReadAt: position.lastReadAt }
    })
  })
  const searchHistory = readData<CliSearchHistoryEntry[]>(archive, 'search-history.json', []).map((entry) => toSearchHistory(entry))
  const webSettings = readData<Record<string, unknown>>(archive, 'reader-settings.json', {})
  const importedSettings = isRecord(webSettings.web) ? webSettings.web as unknown as ReaderSettings : currentSettings
  const bookshelf = readData<Array<{ bookId: string; addedAt: string }>>(archive, 'bookshelf.json', [])
  if (bookshelf.some((item) => !isUuid(item.bookId) || typeof item.addedAt !== 'string')) throw new Error('书架数据格式无效')
  return { sources, settings: { ...currentSettings, ...importedSettings, userId }, books, bookshelf: bookshelf.map((item) => ({ bookId: item.bookId, addedAt: item.addedAt })), positions, searchHistory }
}

function parseBooks(archive: BackupArchive, userId: string): ReaderBackupSnapshot['books'] {
  const bookPaths = archive.manifest.files.filter((file) => /^books\/[^/]+\/book\.json$/u.test(file.path))
  return bookPaths.map((file) => {
    const book = readData<CliBookDocument>(archive, file.path, {} as CliBookDocument)
    if (!isUuid(book.bookId) || file.path.split('/')[1] !== book.bookId || typeof book.name !== 'string' || typeof book.createdAt !== 'string' || typeof book.updatedAt !== 'string') throw new Error(`书籍数据无效：${file.path}`)
    const sourcePath = `books/${book.bookId}/sources.json`
    const sources = readData<CliKnownSource[]>(archive, sourcePath, [])
    const editions: StoredEdition[] = []
    const candidates: StoredBookSourceCandidate[] = []
    for (const item of sources) {
      if (!isUuid(book.bookId) || typeof item.editionKey !== 'string' || typeof item.sourceId !== 'string' || typeof item.sourceFingerprint !== 'string' || typeof item.bookUrl !== 'string' || typeof item.discoveredAt !== 'string' || !['selected', 'title-author', 'title-only', 'user-confirmed'].includes(item.matchKind)) throw new Error(`书籍书源记录无效：${book.bookId}`)
      const metadata = { name: item.name ?? book.name, ...(item.author === undefined ? {} : { author: item.author }), ...(item.intro === undefined ? {} : { intro: item.intro }), ...(item.coverUrl === undefined ? {} : { coverUrl: item.coverUrl }), bookUrl: item.bookUrl, ...(item.tocUrl === undefined ? {} : { tocUrl: item.tocUrl }), ...(item.variable === undefined ? {} : { variable: item.variable }), rawFields: item.rawFields ?? {} } as StoredEdition['metadata']
      if (item.matchKind === 'selected' || item.matchKind === 'user-confirmed') editions.push({ id: randomUUID(), userId, bookId: book.bookId, editionKey: item.editionKey, sourceId: item.sourceId, sourceFingerprint: item.sourceFingerprint, bookUrl: item.bookUrl, metadata, ...(item.variable === undefined ? {} : { variable: item.variable }) })
      else candidates.push({
        id: randomUUID(),
        userId,
        bookId: book.bookId,
        sourceId: item.sourceId,
        sourceFingerprint: item.sourceFingerprint,
        bookUrl: item.bookUrl,
        candidate: { sourceId: item.sourceId, sourceFingerprint: item.sourceFingerprint, candidate: { sourceId: item.sourceId, bookUrl: item.bookUrl, ...(item.name === undefined ? {} : { name: item.name }), ...(item.author === undefined ? {} : { author: item.author }), ...(item.intro === undefined ? {} : { intro: item.intro }), ...(item.coverUrl === undefined ? {} : { coverUrl: item.coverUrl }), rawFields: item.rawFields ?? {} } as BookCandidate },
        updatedAt: item.discoveredAt,
      })
    }
    const storedBook: StoredBook = { id: book.bookId, userId, name: book.name, ...(book.author === undefined ? {} : { author: book.author }), ...(book.intro === undefined ? {} : { intro: book.intro }), ...(book.coverUrl === undefined ? {} : { coverUrl: book.coverUrl }), ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey }), createdAt: book.createdAt, updatedAt: book.updatedAt }
    return { book: storedBook, editions, candidates }
  })
}

function readingRecords(snapshot: ReaderBackupSnapshot): CliReadingRecord[] {
  const editionByKey = new Map(snapshot.books.flatMap((item) => item.editions.map((edition) => [`${edition.bookId}:${edition.editionKey}`, edition])))
  const grouped = new Map<string, CliReadingRecord>()
  for (const position of snapshot.positions) {
    const edition = editionByKey.get(`${position.bookId}:${position.editionKey}`)
    if (edition === undefined) continue
    const current = grouped.get(position.bookId) ?? { bookId: position.bookId, positions: {}, updatedAt: position.lastReadAt }
    current.positions[position.editionKey] = { editionKey: position.editionKey, sourceId: edition.sourceId, bookUrl: edition.bookUrl, chapterUrl: position.chapterUrl, index: position.chapterIndex, title: position.title, ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }), paragraphIndex: position.paragraphIndex, offset: position.offset, lastReadAt: position.lastReadAt }
    current.activeEditionKey = position.editionKey
    current.lastReadAt = current.lastReadAt === undefined || current.lastReadAt < position.lastReadAt ? position.lastReadAt : current.lastReadAt
    current.updatedAt = current.lastReadAt ?? current.updatedAt
    grouped.set(position.bookId, current)
  }
  return [...grouped.values()]
}

function toCliBook(book: StoredBook): CliBookDocument { return { bookId: book.id, name: book.name, ...(book.author === undefined ? {} : { author: book.author }), ...(book.intro === undefined ? {} : { intro: book.intro }), ...(book.coverUrl === undefined ? {} : { coverUrl: book.coverUrl }), ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey }), createdAt: book.createdAt, updatedAt: book.updatedAt } }
function toCliKnownSource(edition: StoredEdition, book: StoredBook): CliKnownSource { return { editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, ...(edition.metadata.name === undefined ? { name: book.name } : { name: edition.metadata.name }), ...(edition.metadata.author === undefined ? {} : { author: edition.metadata.author }), ...(edition.metadata.intro === undefined ? {} : { intro: edition.metadata.intro }), ...(edition.metadata.coverUrl === undefined ? {} : { coverUrl: edition.metadata.coverUrl }), ...(edition.metadata.tocUrl === undefined ? {} : { tocUrl: edition.metadata.tocUrl }), ...(edition.variable === undefined ? {} : { variable: edition.variable }), rawFields: edition.metadata.rawFields ?? {}, discoveredAt: book.updatedAt, matchKind: 'selected' } }
function toCliCandidate(candidate: StoredBookSourceCandidate): CliKnownSource { const value = candidate.candidate.candidate; return { editionKey: `${candidate.sourceId}\u0000${candidate.bookUrl}`, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.bookUrl, ...(value.name === undefined ? {} : { name: value.name }), ...(value.author === undefined ? {} : { author: value.author }), ...(value.intro === undefined ? {} : { intro: value.intro }), ...(value.coverUrl === undefined ? {} : { coverUrl: value.coverUrl }), rawFields: value.rawFields ?? {}, discoveredAt: candidate.updatedAt, matchKind: 'title-author' } }
function toCliSearchHistory(item: SearchHistoryItem): CliSearchHistoryEntry { return { id: item.id, keyword: item.keyword, sourceScope: item.sourceIds.length === 0 ? 'all' : item.sourceIds, startedAt: item.createdAt, completedAt: item.updatedAt, summary: { searched: item.sourceIds.length, success: item.status === 'success' ? 1 : 0, empty: item.status === 'empty' ? 1 : 0, failed: item.status === 'failed' ? 1 : 0, capabilityMissing: item.status === 'capability-missing' ? 1 : 0, candidates: item.resultCount }, openedBookIds: [] } }
function toSearchHistory(item: CliSearchHistoryEntry): SearchHistoryItem { return { id: item.id, searchId: item.id, keyword: item.keyword, sourceIds: item.sourceScope === 'all' ? [] : item.sourceScope, status: item.summary.failed > 0 ? 'failed' : item.summary.empty > 0 ? 'empty' : 'success', resultCount: item.summary.candidates, createdAt: item.startedAt, updatedAt: item.completedAt ?? item.startedAt } }
function rawSourceText(rawSource: unknown, normalized: NormalizedSource): string { return typeof rawSource === 'string' ? rawSource : JSON.stringify(rawSource ?? normalized) }
function envelope(value: unknown): { schemaVersion: 1; revision: number; updatedAt: string; data: unknown } { return { schemaVersion: 1, revision: 1, updatedAt: new Date().toISOString(), data: value } }
function readData<T>(archive: BackupArchive, path: string, fallback: T): T { try { const value = parseJson<unknown>(archive, path); return unwrap(value) as T } catch (error) { if (error instanceof Error && error.message.startsWith('备份缺少文件')) return fallback; throw error } }
function unwrap(value: unknown): unknown { if (isRecord(value) && value.schemaVersion === 1 && 'data' in value) return value.data; return value }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) }
function readInteger(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback }
function sourceField(source: NormalizedSource, key: string): unknown { return (source as Record<string, unknown>)[key] }
function chapterIdFor(url: string, index: number): string { return createHash('sha256').update(`${url}\u0000${index}`).digest('hex') }
