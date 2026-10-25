import { validateMarkCollection, readingMarkSchema, type ReadingMark } from '../shared/reading-annotations.ts'
import { bookOrganizationBackupSchema } from '../shared/book-lists.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createBackupZip, validateBookOrganizationData, editionKey as sharedEditionKey, isIsoDateString, jsonBytes, parseJson, readBackupZip, type BackupArchive, type BackupCategory, type BackupFile, type BackupRecordCounts } from '@legado/reader-backup'
import { importSources, sourceDefinitionFingerprint, type NormalizedSource } from '@legado/source-core'
import type { BookCandidate, JsonObject } from '@legado/source-core'
import type { ReaderBackupSnapshot, ReaderRepository } from './db/repository.ts'
import { DEFAULT_READER_SETTINGS, type ReaderSettings, type StoredBook, type StoredBookSourceCandidate, type StoredEdition, type SearchHistoryItem } from './domain/types.ts'

interface StoredSourceDefinition { sourceId: string; fingerprint: string; rawText: string; deleted?: boolean }
interface CliBookDocument { bookId: string; name: string; author?: string; intro?: string; coverUrl?: string; customCoverUrl?: string; tocUrl?: string; activeEditionKey?: string; metadataEditionKey?: string; createdAt: string; updatedAt: string }
interface CliKnownSource { editionKey: string; sourceId: string; sourceFingerprint: string; bookUrl: string; name?: string; author?: string; intro?: string; coverUrl?: string; tocUrl?: string; lastChapter?: string; updateTime?: string; wordCount?: string; kind?: string; searchDurationMs?: number; variable?: string; rawFields: JsonObject; discoveredAt: string; searchId?: string; confirmedAt?: string; matchKind: 'selected' | 'title-author' | 'title-only' | 'user-confirmed' }
interface CliReadingPosition { editionKey: string; sourceId: string; bookUrl: string; chapterUrl: string; index: number; title: string; tocRevision?: string; paragraphIndex: number; offset: number; lastReadAt: string }
interface CliReadingRecord { bookId: string; activeEditionKey?: string; lastReadAt?: string; lastOpenedAt?: string; positions: Record<string, CliReadingPosition>; updatedAt: string }
interface CliSearchHistoryEntry { id: string; searchId?: string; keyword: string; sourceScope: 'all' | string[]; startedAt: string; completedAt?: string; status?: string; summary: { searched: number; success: number; empty: number; failed: number; capabilityMissing: number; candidates: number }; openedBookIds: string[] }

export class BackupValidationError extends Error {
  public constructor(message: string) { super(message); this.name = 'BackupValidationError' }
}

export async function createWebBackup(repository: ReaderRepository, userId: string): Promise<Uint8Array> {
  const snapshot = await repository.getBackupSnapshot(userId)
  try { validateSnapshotForExport(snapshot, userId) } catch (error) { throw new BackupValidationError(error instanceof Error ? error.message : String(error)) }
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

export function countBackupSnapshot(snapshot: ReaderBackupSnapshot): BackupRecordCounts {
  return { bookshelf: snapshot.bookshelf.length, reading: snapshot.positions.length, search: snapshot.searchHistory.length, sources: snapshot.sources.length, settings: 1 }
}

function validateSnapshotForExport(snapshot: ReaderBackupSnapshot, userId: string): void {
  const sourceIds = new Set<string>()
  for (const item of snapshot.sources) {
    if (sourceIds.has(item.source.sourceId)) throw new Error(`书源定义重复：${item.source.sourceId}`)
    sourceIds.add(item.source.sourceId)
  }
  const books = new Map<string, Set<string>>()
  const editionOwners = new Map<string, string>()
  for (const item of snapshot.books) {
    if (item.book.userId !== userId || !isUuid(item.book.id) || !isIsoDateString(item.book.createdAt) || !isIsoDateString(item.book.updatedAt)) throw new Error(`书籍数据无效：${item.book.id}`)
    const editions = new Set<string>()
    if (item.editions.length === 0) throw new Error(`书籍缺少版本：${item.book.id}`)
    for (const edition of item.editions) {
      if (edition.editionKey !== sharedEditionKey(edition.sourceId, edition.bookUrl) || edition.sourceFingerprint.length === 0 || editions.has(edition.editionKey)) throw new Error(`书籍版本数据无效：${item.book.id}`)
      const owner = editionOwners.get(edition.editionKey)
      if (owner !== undefined && owner !== item.book.id) throw new Error(`书籍版本重复：${edition.editionKey}`)
      editions.add(edition.editionKey)
      editionOwners.set(edition.editionKey, item.book.id)
    }
    for (const candidate of item.candidates) {
      if (candidate.sourceFingerprint.length === 0 || candidate.candidate.sourceId !== candidate.sourceId || candidate.candidate.candidate.bookUrl !== candidate.bookUrl) throw new Error(`书籍候选数据无效：${item.book.id}`)
      const candidateKey = sharedEditionKey(candidate.sourceId, candidate.bookUrl)
      if (editionOwners.has(candidateKey)) throw new Error(`书籍候选版本重复：${candidateKey}`)
      editionOwners.set(candidateKey, item.book.id)
    }
    if (item.book.activeEditionKey !== undefined && !editions.has(item.book.activeEditionKey)) throw new Error(`书籍活动版本不存在：${item.book.id}`)
    books.set(item.book.id, editions)
  }
  for (const item of snapshot.bookshelf) if (!books.has(item.bookId) || !isIsoDateString(item.addedAt)) throw new Error(`书架数据无效：${item.bookId}`)
  for (const position of snapshot.positions) {
    if (position.userId !== userId || !books.get(position.bookId)?.has(position.editionKey) || !isIsoDateString(position.lastReadAt)) throw new Error(`阅读记录数据无效：${position.bookId}`)
  }
  for (const item of snapshot.searchHistory) if (!isUuid(item.id) || !isUuid(item.searchId) || !isIsoDateString(item.createdAt) || !isIsoDateString(item.updatedAt)) throw new Error(`搜索记录数据无效：${item.id}`)
  for (const kind of ['bookmarks', 'annotations'] as const) {
    const rows = snapshot[kind] ?? []
    for (const row of rows) { readingMarkSchema.parse(row); if (row.userId !== userId || !books.get(row.bookId)?.has(row.editionKey)) throw new Error('批注缺少书籍版本') }
    validateMarkCollection(rows, kind)
  }
  validateWebSettings(snapshot.settings as unknown as Record<string, unknown>, userId)
}

async function readValidatedBackup(input: Uint8Array): Promise<BackupArchive> {
  try { return await readBackupZip(input) } catch (error) { throw new BackupValidationError(error instanceof Error ? error.message : String(error)) }
}

function snapshotToFiles(snapshot: ReaderBackupSnapshot): BackupFile[] {
  const files: BackupFile[] = []
  const add = (path: string, value: unknown): void => { files.push({ path, data: jsonBytes(envelope(value)), category: path.startsWith('books/') ? 'bookshelf' : (path === 'bookshelf.json' || path === 'book-lists.json') ? 'bookshelf' : (path === 'reading-history.json' || path.startsWith('reading/')) ? 'reading' : path === 'search-history.json' ? 'search' : path === 'reader-settings.json' ? 'settings' : 'sources' }) }
  const definitions: StoredSourceDefinition[] = snapshot.sources.map((item) => ({ sourceId: item.source.sourceId, fingerprint: item.source.fingerprint, rawText: rawSourceText(item.source.rawSource, item.source.normalizedSource), ...(item.deleted === true ? { deleted: true } : {}) }))
  const sourceState = Object.fromEntries(snapshot.sources.map((item) => [item.source.sourceId, { fingerprint: item.source.fingerprint, enabled: item.source.enabled, ...(item.deleted === true ? { deleted: true } : {}), enabledExplore: sourceField(item.source.normalizedSource, 'enabledExplore') !== false, customOrder: readInteger(sourceField(item.source.normalizedSource, 'customOrder'), 0), weight: readInteger(sourceField(item.source.normalizedSource, 'weight'), 0), searchHealth: { fingerprint: item.source.fingerprint, consecutiveFailures: 0 } }]))
  if (snapshot.organization !== undefined) add('book-lists.json', snapshot.organization)
  add('bookshelf.json', snapshot.bookshelf.map((item) => ({ ...item, updatedAt: item.addedAt })))
  add('reading-history.json', readingRecords(snapshot))
  add('reading/bookmarks.json', snapshot.bookmarks ?? [])
  add('reading/annotations.json', snapshot.annotations ?? [])
  add('search-history.json', snapshot.searchHistory.map(toCliSearchHistory))
  add('reader-settings.json', { web: snapshot.settings })
  add('sources.json', definitions)
  add('source-state.json', sourceState)
  add('source-check-config.json', {})
  for (const item of snapshot.books) {
    add(`books/${item.book.id}/book.json`, toCliBook(item.book, item.editions))
    add(`books/${item.book.id}/sources.json`, [...item.editions.map((edition) => toCliKnownSource(edition, item.book)), ...item.candidates.map((candidate) => toCliCandidate(candidate))])
  }
  return files
}

async function parseSnapshot(archive: BackupArchive, userId: string, currentSettings: ReaderSettings): Promise<ReaderBackupSnapshot> {
  for (const path of ['bookshelf.json', 'reading-history.json', 'search-history.json', 'sources.json', 'source-state.json', 'source-check-config.json', 'reader-settings.json']) if (!archive.files.has(path)) throw new Error(`备份缺少文件：${path}`)
  const sourceDefinitions = readData<StoredSourceDefinition[]>(archive, 'sources.json', [])
  const sourceState = readData<unknown>(archive, 'source-state.json', {})
  if (!Array.isArray(sourceDefinitions) || !isRecord(sourceState)) throw new Error('书源数据格式无效')
  const sources: ReaderBackupSnapshot['sources'] = []
  const seenSourceIds = new Set<string>()
  for (const definition of sourceDefinitions) {
    if (!isRecord(definition) || typeof definition.rawText !== 'string' || definition.rawText.length === 0 || typeof definition.sourceId !== 'string' || typeof definition.fingerprint !== 'string' || definition.fingerprint.length === 0 || (definition.deleted !== undefined && typeof definition.deleted !== 'boolean')) throw new Error('书源定义无效')
    if (seenSourceIds.has(definition.sourceId)) throw new Error(`书源定义重复：${definition.sourceId}`)
    seenSourceIds.add(definition.sourceId)
    const candidates = await importSources({ kind: 'text', text: definition.rawText }, { limits: { maxCandidates: 1000, maxBytes: 4 * 1024 * 1024 } })
    const candidate = candidates.find((item) => item.source?.bookSourceUrl === definition.sourceId)
    const fingerprint = candidate?.sourceFingerprint ?? (candidate?.source === undefined ? undefined : sourceDefinitionFingerprint(candidate.source))
    if (candidate?.source === undefined || fingerprint !== definition.fingerprint) throw new Error(`书源定义与 sourceId 或指纹不匹配：${definition.sourceId}`)
    const state = sourceState[definition.sourceId]
    validateSourceState(definition.sourceId, definition.fingerprint, state)
    const normalized = { ...candidate.source, ...(state?.enabled === undefined ? {} : { enabled: state.enabled }), ...(state?.enabledExplore === undefined ? {} : { enabledExplore: state.enabledExplore }), ...(state?.customOrder === undefined ? {} : { customOrder: state.customOrder }), ...(state?.weight === undefined ? {} : { weight: state.weight }) }
    const group = sourceField(normalized, 'bookSourceGroup')
    sources.push({ source: { sourceId: normalized.bookSourceUrl, name: normalized.bookSourceName, ...(typeof group === 'string' ? { group } : {}), fingerprint, enabled: normalized.enabled !== false, rawSource: definition.rawText, normalizedSource: normalized }, sourceRevision: randomUUID(), ...(definition.deleted === true || state?.deleted === true ? { deleted: true } : {}) })
  }
  for (const [sourceId, state] of Object.entries(sourceState)) if (!seenSourceIds.has(sourceId)) validateSourceState(sourceId, undefined, state)
  validateSourceCheckConfig(readData<unknown>(archive, 'source-check-config.json', {}))
  const books = parseBooks(archive, userId)
  const bookIds = new Set(books.map((item) => item.book.id))
  const editions = new Map(books.flatMap((item) => item.editions.map((edition) => [`${edition.bookId}:${edition.editionKey}`, edition])))
  const readingRecords = readData<unknown>(archive, 'reading-history.json', [])
  if (!Array.isArray(readingRecords)) throw new Error('阅读记录格式无效')
  const seenReadingBooks = new Set<string>()
  const positions = (readingRecords as CliReadingRecord[]).flatMap((record) => {
    if (!isUuid(record.bookId) || seenReadingBooks.has(record.bookId) || !isIsoDateString(record.updatedAt) || (record.lastReadAt !== undefined && !isIsoDateString(record.lastReadAt)) || (record.lastOpenedAt !== undefined && !isIsoDateString(record.lastOpenedAt)) || !isRecord(record.positions)) throw new Error(`阅读记录格式无效：${record.bookId}`)
    seenReadingBooks.add(record.bookId)
    if (record.activeEditionKey !== undefined && typeof record.activeEditionKey !== 'string') throw new Error(`阅读记录格式无效：${record.bookId}`)
    const positionKeys = new Set(Object.keys(record.positions))
    if (record.activeEditionKey !== undefined && !positionKeys.has(record.activeEditionKey)) throw new Error(`阅读记录当前版本不存在：${record.bookId}`)
    return Object.entries(record.positions).map(([positionKey, position]) => {
      if (!isRecord(position) || positionKey !== position.editionKey || typeof position.editionKey !== 'string' || typeof position.sourceId !== 'string' || typeof position.bookUrl !== 'string' || position.editionKey !== sharedEditionKey(position.sourceId, position.bookUrl) || typeof position.chapterUrl !== 'string' || typeof position.index !== 'number' || !Number.isSafeInteger(position.index) || position.index < 0 || typeof position.title !== 'string' || typeof position.paragraphIndex !== 'number' || !Number.isSafeInteger(position.paragraphIndex) || position.paragraphIndex < 0 || typeof position.offset !== 'number' || !Number.isSafeInteger(position.offset) || position.offset < 0 || !isIsoDateString(position.lastReadAt)) throw new Error(`阅读位置格式无效：${record.bookId}`)
    const edition = editions.get(`${record.bookId}:${position.editionKey}`)
    if (edition === undefined) throw new Error(`阅读记录缺少书籍版本：${position.editionKey}`)
    return { userId, bookId: record.bookId, editionKey: position.editionKey, chapterId: chapterIdFor(position.chapterUrl, position.index), chapterUrl: position.chapterUrl, chapterIndex: position.index, title: position.title, ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }), paragraphIndex: position.paragraphIndex, offset: position.offset, version: 0, lastReadAt: position.lastReadAt }
    })
  })
  const searchData = readData<unknown>(archive, 'search-history.json', [])
  if (!isSearchHistoryData(searchData)) throw new Error('搜索记录格式无效')
  const searchHistory = (searchData as CliSearchHistoryEntry[]).map((entry) => toSearchHistory(entry))
  const webSettings = readData<Record<string, unknown>>(archive, 'reader-settings.json', {})
  const importedSettings = isRecord(webSettings.web) ? validateWebSettings(webSettings.web, userId) : currentSettings
  const bookshelf = readData<Array<{ bookId: string; addedAt: string; groupId?: string | null }>>(archive, 'bookshelf.json', [])
  if (!Array.isArray(bookshelf) || bookshelf.some((item) => !isRecord(item) || !isUuid(item.bookId) || !isIsoDateString(item.addedAt)) || new Set(bookshelf.map((item) => item.bookId)).size !== bookshelf.length || bookshelf.some((item) => !bookIds.has(item.bookId))) throw new Error('书架数据格式无效')
  const rawOrganization = archive.files.has('book-lists.json') ? readData<unknown>(archive, 'book-lists.json', {}) : undefined
  if (isRecord(rawOrganization) && Array.isArray(rawOrganization.lists)) { let index = 0; for (const row of rawOrganization.lists) if (isRecord(row) && row.type === 'shelf_group') { if (row.customOrder === undefined) row.customOrder = index; index++ } }
  const organization = rawOrganization === undefined ? undefined : bookOrganizationBackupSchema.parse(rawOrganization)
  if (organization) validateBookOrganizationData(organization, bookIds, bookshelf)
  if (organization) { for (const row of organization.lists) row.userId = userId; for (const row of organization.items) row.userId = userId }
  const marks: { bookmarks?: ReadingMark[]; annotations?: ReadingMark[] } = {}
  for (const kind of ['bookmarks', 'annotations'] as const) {
    const path = 'reading/' + kind + '.json'
    if (!archive.files.has(path)) continue
    const rows = readingMarkSchema.array().parse(readData<unknown>(archive, path, []))
    if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('批注记录重复')
    for (const row of rows) { if (!editions.has(row.bookId + ':' + row.editionKey)) throw new Error('批注缺少书籍版本'); row.userId = userId }
    validateMarkCollection(rows, kind)
    marks[kind] = rows
  }
  return { ...marks, ...(organization === undefined ? {} : { organization }), sources, settings: { ...currentSettings, ...importedSettings, userId }, books, bookshelf: bookshelf.map((item) => ({ bookId: item.bookId, addedAt: item.addedAt, groupId: item.groupId ?? null })), positions, searchHistory }
}

function parseBooks(archive: BackupArchive, userId: string): ReaderBackupSnapshot['books'] {
  const bookPaths = archive.manifest.files.filter((file) => /^books\/[^/]+\/book\.json$/u.test(file.path))
  const seenBookIds = new Set<string>()
  const editionOwners = new Map<string, string>()
  const books = bookPaths.map((file) => {
    const book = readData<CliBookDocument>(archive, file.path, {} as CliBookDocument)
    if (!isUuid(book.bookId) || file.path.split('/')[1] !== book.bookId || typeof book.name !== 'string' || (book.customCoverUrl !== undefined && typeof book.customCoverUrl !== 'string') || !isIsoDateString(book.createdAt) || !isIsoDateString(book.updatedAt) || (book.tocUrl !== undefined && typeof book.tocUrl !== 'string') || (book.activeEditionKey !== undefined && typeof book.activeEditionKey !== 'string') || (book.metadataEditionKey !== undefined && typeof book.metadataEditionKey !== 'string')) throw new Error(`书籍数据无效：${file.path}`)
    if (seenBookIds.has(book.bookId)) throw new Error(`书籍数据重复：${book.bookId}`)
    seenBookIds.add(book.bookId)
    const sourcePath = `books/${book.bookId}/sources.json`
    if (!archive.files.has(sourcePath)) throw new Error(`书籍缺少书源数据：${book.bookId}`)
    const sources = readData<CliKnownSource[]>(archive, sourcePath, [])
    if (!Array.isArray(sources)) throw new Error(`书籍书源数据无效：${book.bookId}`)
    const editions: StoredEdition[] = []
    const candidates: StoredBookSourceCandidate[] = []
    const seenEditions = new Set<string>()
    for (const item of sources) {
      if (!isRecord(item) || !isUuid(book.bookId) || typeof item.editionKey !== 'string' || typeof item.sourceId !== 'string' || typeof item.sourceFingerprint !== 'string' || item.sourceFingerprint.length === 0 || typeof item.bookUrl !== 'string' || item.editionKey !== sharedEditionKey(item.sourceId, item.bookUrl) || !isIsoDateString(item.discoveredAt) || (item.searchId !== undefined && !isUuid(item.searchId)) || (item.confirmedAt !== undefined && !isIsoDateString(item.confirmedAt)) || (item.searchDurationMs !== undefined && (!Number.isSafeInteger(item.searchDurationMs) || item.searchDurationMs < 0)) || !['selected', 'title-author', 'title-only', 'user-confirmed'].includes(item.matchKind)) throw new Error(`书籍书源记录无效：${book.bookId}`)
      if (seenEditions.has(item.editionKey)) throw new Error(`书籍版本重复：${item.editionKey}`)
      const owner = editionOwners.get(item.editionKey)
      if (owner !== undefined && owner !== book.bookId) throw new Error(`书籍版本重复：${item.editionKey}`)
      seenEditions.add(item.editionKey)
      editionOwners.set(item.editionKey, book.bookId)
      if (item.rawFields !== undefined && !isRecord(item.rawFields)) throw new Error(`书籍书源字段无效：${book.bookId}`)
      const metadata = { name: item.name ?? book.name, ...(item.author === undefined ? {} : { author: item.author }), ...(item.intro === undefined ? {} : { intro: item.intro }), ...(item.coverUrl === undefined ? {} : { coverUrl: item.coverUrl }), ...(item.kind === undefined ? {} : { kind: item.kind }), ...(item.wordCount === undefined ? {} : { wordCount: item.wordCount }), ...(item.lastChapter === undefined ? {} : { lastChapter: item.lastChapter }), ...(item.updateTime === undefined ? {} : { updateTime: item.updateTime }), bookUrl: item.bookUrl, ...(item.tocUrl === undefined ? {} : { tocUrl: item.tocUrl }), ...(item.variable === undefined ? {} : { variable: item.variable }), ...(item.searchDurationMs === undefined ? {} : { searchDurationMs: item.searchDurationMs }), rawFields: item.rawFields ?? {}, traceRef: `backup:${item.editionKey}` } as StoredEdition['metadata']
      if (item.matchKind === 'selected' || item.matchKind === 'user-confirmed') editions.push({ id: randomUUID(), userId, bookId: book.bookId, editionKey: item.editionKey, sourceId: item.sourceId, sourceFingerprint: item.sourceFingerprint, bookUrl: item.bookUrl, metadata, ...(item.variable === undefined ? {} : { variable: item.variable }) })
      else candidates.push({
        id: randomUUID(),
        userId,
        bookId: book.bookId,
        sourceId: item.sourceId,
        sourceFingerprint: item.sourceFingerprint,
        bookUrl: item.bookUrl,
        candidate: { sourceId: item.sourceId, sourceFingerprint: item.sourceFingerprint, ...(item.searchDurationMs === undefined ? {} : { searchDurationMs: item.searchDurationMs }), candidate: { sourceId: item.sourceId, bookUrl: item.bookUrl, ...(item.name === undefined ? {} : { name: item.name }), ...(item.author === undefined ? {} : { author: item.author }), ...(item.intro === undefined ? {} : { intro: item.intro }), ...(item.coverUrl === undefined ? {} : { coverUrl: item.coverUrl }), ...(item.kind === undefined ? {} : { kind: item.kind }), ...(item.wordCount === undefined ? {} : { wordCount: item.wordCount }), ...(item.lastChapter === undefined ? {} : { lastChapter: item.lastChapter }), ...(item.updateTime === undefined ? {} : { updateTime: item.updateTime }), ...(item.tocUrl === undefined ? {} : { tocUrl: item.tocUrl }), ...(item.variable === undefined ? {} : { variable: item.variable }), rawFields: item.rawFields ?? {}, traceRef: `backup:${item.editionKey}` } as BookCandidate },
        updatedAt: item.discoveredAt,
      })
    }
    if (editions.length === 0) throw new Error(`书籍缺少版本：${book.bookId}`)
    const metadataEditionKey = book.metadataEditionKey ?? book.activeEditionKey
    if (metadataEditionKey !== undefined && !editions.some((edition) => edition.editionKey === metadataEditionKey)) throw new Error(`书籍元数据版本不存在：${book.bookId}`)
    if (book.tocUrl !== undefined && metadataEditionKey !== undefined) {
      const metadataEdition = editions.find((edition) => edition.editionKey === metadataEditionKey)
      if (metadataEdition !== undefined && metadataEdition.metadata.tocUrl === undefined) metadataEdition.metadata = { ...metadataEdition.metadata, tocUrl: book.tocUrl }
    }
    const storedBook: StoredBook = { id: book.bookId, userId, name: book.name, ...(book.author === undefined ? {} : { author: book.author }), ...(book.intro === undefined ? {} : { intro: book.intro }), ...(book.coverUrl === undefined ? {} : { coverUrl: book.coverUrl }), ...(book.customCoverUrl === undefined ? {} : { customCoverUrl: book.customCoverUrl }), ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey }), createdAt: book.createdAt, updatedAt: book.updatedAt }
    if (storedBook.activeEditionKey !== undefined && !editions.some((edition) => edition.editionKey === storedBook.activeEditionKey)) throw new Error(`书籍活动版本不存在：${book.bookId}`)
    return { book: storedBook, editions, candidates }
  })
  for (const file of archive.manifest.files.filter((item) => item.path.startsWith('books/'))) {
    const bookId = file.path.split('/')[1]
    if (bookId === undefined || !seenBookIds.has(bookId)) throw new Error(`书籍缺少 book.json：${bookId ?? file.path}`)
  }
  return books
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

function toCliBook(book: StoredBook, editions: readonly StoredEdition[]): CliBookDocument {
  const activeEdition = editions.find((edition) => edition.editionKey === book.activeEditionKey)
  return { bookId: book.id, name: book.name, ...(book.author === undefined ? {} : { author: book.author }), ...(book.intro === undefined ? {} : { intro: book.intro }), ...(book.coverUrl === undefined ? {} : { coverUrl: book.coverUrl }), ...(book.customCoverUrl === undefined ? {} : { customCoverUrl: book.customCoverUrl }), ...(activeEdition?.metadata.tocUrl === undefined ? {} : { tocUrl: activeEdition.metadata.tocUrl }), ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey, metadataEditionKey: book.activeEditionKey }), createdAt: book.createdAt, updatedAt: book.updatedAt }
}
function toCliKnownSource(edition: StoredEdition, book: StoredBook): CliKnownSource {
  const metadata = edition.metadata
  return { editionKey: sharedEditionKey(edition.sourceId, edition.bookUrl), sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, ...(metadata.name === undefined ? { name: book.name } : { name: metadata.name }), ...(metadata.author === undefined ? {} : { author: metadata.author }), ...(metadata.intro === undefined ? {} : { intro: metadata.intro }), ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }), ...(metadata.tocUrl === undefined ? {} : { tocUrl: metadata.tocUrl }), ...(metadata.lastChapter === undefined ? {} : { lastChapter: metadata.lastChapter }), ...(metadata.updateTime === undefined ? {} : { updateTime: metadata.updateTime }), ...(metadata.wordCount === undefined ? {} : { wordCount: metadata.wordCount }), ...(metadata.kind === undefined ? {} : { kind: metadata.kind }), ...(metadata.searchDurationMs === undefined ? {} : { searchDurationMs: metadata.searchDurationMs }), ...(edition.variable === undefined ? {} : { variable: edition.variable }), rawFields: metadata.rawFields ?? {}, discoveredAt: book.updatedAt, matchKind: 'selected' }
}
function toCliCandidate(candidate: StoredBookSourceCandidate): CliKnownSource { const value = candidate.candidate.candidate; return { editionKey: sharedEditionKey(candidate.sourceId, candidate.bookUrl), sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.bookUrl, ...(value.name === undefined ? {} : { name: value.name }), ...(value.author === undefined ? {} : { author: value.author }), ...(value.intro === undefined ? {} : { intro: value.intro }), ...(value.coverUrl === undefined ? {} : { coverUrl: value.coverUrl }), ...(value.tocUrl === undefined ? {} : { tocUrl: value.tocUrl }), ...(value.lastChapter === undefined ? {} : { lastChapter: value.lastChapter }), ...(value.updateTime === undefined ? {} : { updateTime: value.updateTime }), ...(value.wordCount === undefined ? {} : { wordCount: value.wordCount }), ...(value.kind === undefined ? {} : { kind: value.kind }), ...(candidate.candidate.searchDurationMs === undefined ? {} : { searchDurationMs: candidate.candidate.searchDurationMs }), ...(value.variable === undefined ? {} : { variable: value.variable }), rawFields: value.rawFields ?? {}, discoveredAt: candidate.updatedAt, matchKind: 'title-author' } }
function toCliSearchHistory(item: SearchHistoryItem): CliSearchHistoryEntry { return { id: item.id, searchId: item.searchId, keyword: item.keyword, sourceScope: item.sourceIds.length === 0 ? 'all' : item.sourceIds, startedAt: item.createdAt, completedAt: item.updatedAt, status: item.status, summary: { searched: item.sourceIds.length, success: item.status === 'success' ? 1 : 0, empty: item.status === 'empty' ? 1 : 0, failed: item.status === 'failed' || item.status === 'partial' ? 1 : 0, capabilityMissing: item.status === 'capability-missing' ? 1 : 0, candidates: item.resultCount }, openedBookIds: [] } }
function toSearchHistory(item: CliSearchHistoryEntry): SearchHistoryItem { return { id: item.id, searchId: item.searchId ?? item.id, keyword: item.keyword, sourceIds: item.sourceScope === 'all' ? [] : item.sourceScope, status: item.status ?? (item.summary.failed > 0 ? 'failed' : item.summary.empty > 0 ? 'empty' : 'success'), resultCount: item.summary.candidates, createdAt: item.startedAt, updatedAt: item.completedAt ?? item.startedAt } }
function isSearchHistoryData(value: unknown): value is CliSearchHistoryEntry[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  const searchIds = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return false
    const id = raw.id
    const searchId = raw.searchId
    const summary = raw.summary
    if (typeof id !== 'string' || !isUuid(id) || ids.has(id) || (searchId !== undefined && (typeof searchId !== 'string' || !isUuid(searchId) || searchIds.has(searchId))) || typeof raw.keyword !== 'string' || (raw.sourceScope !== 'all' && (!Array.isArray(raw.sourceScope) || raw.sourceScope.some((sourceId) => typeof sourceId !== 'string'))) || !isIsoDateString(raw.startedAt) || (raw.completedAt !== undefined && !isIsoDateString(raw.completedAt)) || (raw.status !== undefined && typeof raw.status !== 'string') || !isRecord(summary) || !['searched', 'success', 'empty', 'failed', 'capabilityMissing', 'candidates'].every((key) => isNonNegativeSafeInteger(summary[key])) || !Array.isArray(raw.openedBookIds) || raw.openedBookIds.some((bookId) => typeof bookId !== 'string')) return false
    ids.add(id)
    if (searchId !== undefined) searchIds.add(searchId)
  }
  return true
}
function validateSourceState(sourceId: string, expectedFingerprint: string | undefined, value: unknown): asserts value is { fingerprint?: string; enabled?: boolean; deleted?: boolean; enabledExplore?: boolean; customOrder?: number; weight?: number } | undefined {
  if (value === undefined) return
  if (!isRecord(value) || (value.fingerprint !== undefined && (typeof value.fingerprint !== 'string' || value.fingerprint.length === 0)) || (expectedFingerprint !== undefined && value.fingerprint !== undefined && value.fingerprint !== expectedFingerprint) || (value.enabled !== undefined && typeof value.enabled !== 'boolean') || (value.deleted !== undefined && typeof value.deleted !== 'boolean') || (value.enabledExplore !== undefined && typeof value.enabledExplore !== 'boolean') || (value.customOrder !== undefined && !isSafeInteger(value.customOrder)) || (value.weight !== undefined && !isSafeInteger(value.weight))) throw new Error(`书源状态格式无效：${sourceId}`)
  if (value.searchHealth !== undefined && (!isRecord(value.searchHealth) || typeof value.searchHealth.fingerprint !== 'string' || value.searchHealth.fingerprint.length === 0 || !isNonNegativeSafeInteger(value.searchHealth.consecutiveFailures))) throw new Error(`书源状态格式无效：${sourceId}`)
}
function validateSourceCheckConfig(value: unknown): void {
  if (!isRecord(value) || (value.timeoutMs !== undefined && (!isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0)) || ['checkDomain', 'checkSearch', 'checkDiscovery', 'checkInfo', 'checkCategory', 'checkContent'].some((key) => value[key] !== undefined && typeof value[key] !== 'boolean') || (value.keyword !== undefined && typeof value.keyword !== 'string')) throw new Error('书源检测配置格式无效')
}
function isNonNegativeSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) }
function validateWebSettings(value: Record<string, unknown>, userId: string): ReaderSettings {
  const theme = value.theme
  const readingMode = value.readingMode
  const fontSize = value.fontSize
  const lineHeight = value.lineHeight
  const marginTop = value.marginTop
  const marginRight = value.marginRight
  const marginBottom = value.marginBottom
  const marginLeft = value.marginLeft
  const general = value.general === undefined ? DEFAULT_READER_SETTINGS.general : value.general
  if (!isRecord(general) || (general.bookshelfSort !== undefined && general.bookshelfSort !== 'addedAt' && general.bookshelfSort !== 'lastReadAt')) throw new Error('通用设置格式无效')
  const pageTapZones = readPageTapZones(value.pageTapZones)
  if ((theme !== 'system' && theme !== 'light' && theme !== 'dark') || (readingMode !== 'scroll' && readingMode !== 'paged') || !isIntegerInRange(fontSize, 15, 28) || typeof lineHeight !== 'number' || lineHeight < 1.4 || lineHeight > 2.6 || !isIntegerInRange(marginTop, 0, 64) || !isIntegerInRange(marginRight, 0, 64) || !isIntegerInRange(marginBottom, 0, 64) || !isIntegerInRange(marginLeft, 0, 64) || !isIsoDateString(value.updatedAt)) throw new Error('阅读设置格式无效')
  return { userId, theme, readingMode, fontSize, lineHeight, marginTop, marginRight, marginBottom, marginLeft, general: { bookshelfSort: general.bookshelfSort === 'lastReadAt' ? 'lastReadAt' : DEFAULT_READER_SETTINGS.general.bookshelfSort, bookshelfInitialGroup: typeof general.bookshelfInitialGroup === 'string' ? general.bookshelfInitialGroup : 'all' }, pageTapZones, updatedAt: value.updatedAt }
}
function readPageTapZones(value: unknown): ReaderSettings['pageTapZones'] {
  if (value === undefined) return DEFAULT_READER_SETTINGS.pageTapZones
  if (!isRecord(value)) throw new Error('翻页区域设置格式无效')
  const { leftWidthPercent, centerWidthPercent, centerTopHeightPercent, centerMiddleHeightPercent, centerTopAction, centerBottomAction } = value
  if (!isIntegerInRange(leftWidthPercent, 18, 64) || !isIntegerInRange(centerWidthPercent, 18, 64) || !isIntegerInRange(centerTopHeightPercent, 18, 64) || !isIntegerInRange(centerMiddleHeightPercent, 18, 64) || leftWidthPercent + centerWidthPercent > 82 || centerTopHeightPercent + centerMiddleHeightPercent > 82 || (centerTopAction !== 'previous' && centerTopAction !== 'next') || (centerBottomAction !== 'previous' && centerBottomAction !== 'next')) throw new Error('翻页区域设置格式无效')
  return { leftWidthPercent, centerWidthPercent, centerTopHeightPercent, centerMiddleHeightPercent, centerTopAction, centerBottomAction }
}
function isIntegerInRange(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max }
function rawSourceText(rawSource: unknown, normalized: NormalizedSource): string { return typeof rawSource === 'string' ? rawSource : JSON.stringify(rawSource ?? normalized) }
function envelope(value: unknown): { schemaVersion: 1; revision: number; updatedAt: string; data: unknown } { return { schemaVersion: 1, revision: 1, updatedAt: new Date().toISOString(), data: value } }
function readData<T>(archive: BackupArchive, path: string, fallback: T): T { try { const value = parseJson<unknown>(archive, path); return unwrap(value) as T } catch (error) { if (error instanceof Error && error.message.startsWith('备份缺少文件')) return fallback; throw error } }
function unwrap(value: unknown): unknown { if (isRecord(value) && value.schemaVersion === 1 && 'data' in value) return value.data; return value }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) }
function readInteger(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback }
function sourceField(source: NormalizedSource, key: string): unknown { return (source as Record<string, unknown>)[key] }
function chapterIdFor(url: string, index: number): string { return createHash('sha256').update(`${url}\u0000${index}`).digest('hex') }
