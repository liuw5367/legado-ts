import { readingContent, type CachedReadingContent } from '../../shared/reading-content.ts'
import type { CachedTocSummary } from '../../shared/toc.ts'
import type { BookDetailsResponse, BookReadingInfo } from '../../shared/book-details.ts'
import type { BookDisplay, BookListChoice, BookListDetails } from '../../shared/book-lists.ts'
import { readReaderMarks, readMarks, writeMark, lockMarks, purgeMark, restoreMarks } from './reading-marks.ts'
import { markListItem, readerMark, type ReaderMark, validateMarkCollection, readingMarkSchema, changeMark, markPage, MarkError, type MarkKind, type MarkQuery, type MarkCommand, type MarkPage, type MarkSummaryPage, type CachedChapter, type ReadingMark } from '../../shared/reading-annotations.ts'
import { DEFAULT_SEARCH_CONCURRENCY, searchConcurrencySchema } from '../../shared/search-settings.ts'
import { acquireExecutionSlot, releaseExecutionSlot, acquireMemoryExecutionSlot, releaseMemoryExecutionSlot, type ExecutionLease } from '../runtime/source-execution.ts'
import * as importHistory from './source-import-history.ts'
import { MemoryImportHistory } from './memory-import-history.ts'
import type { ImportConfirmResult, ImportHistoryQuery, ImportLinksResponse, ImportHistoryPage, ImportItemsPage, UndoImportInput, UndoImportResult, UndoPreview } from '../../shared/source-management.ts'
import type { BookListOrganizationSnapshot } from '../../shared/book-lists.ts'
import { OrganizationError, type OrganizationCommand, applyOrganizationCommand } from '../domain/book-organization.ts'
import { latestSearchHistory } from '../../shared/search-history.ts'
import { normalizeIdentity } from '../../shared/book-identity.ts'
import { compareSourceManagementOrder, compareSourceVersions, selectOneSourcePerDomain, sourceDomainInfo } from '../../shared/source-domain.ts'
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, max, or, sql } from 'drizzle-orm'
import { editionKey as backupEditionKey, isIsoDateString, type BackupCategory } from '@legado/reader-backup'
import type { Chapter, NormalizedSource, PageCursor } from '@legado/source-core'
import { withUser, type ReaderTransaction } from './client.ts'
import { readingAnnotations, bookLists, bookListItems, bookSourceCandidates, bookEditions, books, bookshelf, chapterContents, readerSettings, readingRecords, searchHistory, searchRuns, sourceImportBatches, sourceImportLinks, sourceImportItems, sourceImportPreviews, sourceRuntimeState, tocSnapshots, userSources, type BookEditionRow, type BookRow, type ChapterContentRow, type ReaderSettingsRow, type SearchHistoryRow, type SearchRunRow, type SourceRuntimeRow, type TocSnapshotRow, type UserSourceRow } from './schema.ts'
import type { ImportPreview, ImportPreviewCandidate, ManagedSourceSummary, SourceActionItem, SourceManagementPage, SourceManagementStats, SourceManagementStatus, SourceOrderItem } from '../../shared/source-management.ts'
import { DEFAULT_READER_SETTINGS, type BookCreationInput, type HomeSnapshot, type HomeSearchHistory, type ReaderSettings, type ReaderSettingsPatch, type ReaderSettingsPreferences, type RuntimeStateSnapshot, type SearchHistoryItem, type SearchInput, type SearchRunState, type SourceSearchState, type SourceSummary, type StoredBookSourceCandidate, type StoredBook, type StoredCandidate, type StoredContent, type StoredEdition, type StoredPosition, type StoredToc } from '../domain/types.ts'
import { decryptRuntimeState, encryptRuntimeState } from './runtime-state-crypto.ts'

export interface StoredSourceRecord extends SourceSummary {
  sourceUuid?: string
  importLinkId?: string
  currentImportItemId?: string
  sourceRevision?: string
  priority?: number
  rawSource: unknown
  normalizedSource: NormalizedSource
}

export interface SourceListRecord extends SourceSummary {
  sourceUuid?: string
  importLinkId?: string
  sourceRevision?: string
  priority?: number
  customOrder: number
  canExplore: boolean
}

export interface ChapterContext {
  revision: string
  sourceFingerprint: string
  chapter?: Chapter
  nextChapterUrl?: string
}

export interface SourceRuntimeStateRecord {
  sourceId: string
  sourceFingerprint: string
  snapshot: RuntimeStateSnapshot
  version: number
}

export interface SourceRuntimeLease extends SourceRuntimeStateRecord {
  leaseToken: string
}

export interface ReaderBackupBook {
  book: StoredBook
  editions: StoredEdition[]
  candidates: StoredBookSourceCandidate[]
}

export interface ReaderBackupSnapshot {
  bookmarks?: ReadingMark[]
  annotations?: ReadingMark[]
  sources: Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>
  settings: ReaderSettings
  books: ReaderBackupBook[]
  organization?: BookListOrganizationSnapshot
  bookshelf: Array<{ bookId: string; addedAt: string; groupId?: string | null }>
  positions: StoredPosition[]
  searchHistory: SearchHistoryItem[]
}

export class SourceManagementError extends Error {
  public readonly code: 'source-conflict' | 'source-not-found' | 'preview-expired' | 'preview-invalid' | 'source-busy'
  public constructor(code: SourceManagementError['code'], message: string) { super(message); this.code = code }
}

export class BackupRestoreError extends Error {
  public constructor(message: string) { super(message); this.name = 'BackupRestoreError' }
}

export interface ReaderRepository {
  listBookListSummaries(userId: string, query?: string, bookId?: string, picker?: boolean): Promise<Array<BookListChoice & { createdAt?: string; updatedAt?: string; coverBooks?: BookDisplay[] }>>
  getBookListDetails(userId: string, listId: string): Promise<BookListDetails | null>
  getShelfGroups(userId: string, bookId?: string): Promise<{ groups: Array<{ id: string; name: string; bookCount: number }>; ungroupedCount: number; onBookshelf?: boolean; currentGroupId?: string | null }>
  listBookIdentities(userId: string): Promise<Array<{ id: string; name: string; author?: string; onBookshelf: boolean }>>
  getBookReadingInfo(userId: string, bookId: string, editionKey?: string): Promise<BookReadingInfo | null>
  getReadingEntry(userId: string, bookId: string): Promise<{ activeEditionKey: string | null } | null>
  listEditionOptions(userId: string, bookId: string): Promise<Array<{ editionKey: string; sourceId: string; sourceName: string }>>
  getDisplayEdition(userId: string, bookId: string, editionKey?: string): Promise<BookDetailsResponse['edition'] | null>
  getDisplayPosition(userId: string, bookId: string, editionKey: string): Promise<{ title: string; lastReadAt: string } | null>
  listReadingMarkBooks(userId: string): Promise<Array<{ id: string; name: string; author: string | null; activeEditionKey: string | null }>>
  listReadingMarks(userId: string, query: MarkQuery): Promise<MarkPage>
  listReaderMarks(userId: string, query: MarkQuery): Promise<ReaderMark[]>
  listReadingMarkSummaries(userId: string, query: MarkQuery): Promise<MarkSummaryPage>
  getCachedMarkChapter(userId: string, bookId: string, id: string): Promise<{ cachedChapter: CachedChapter | null } | null>
  mutateReadingMark(userId: string, command: MarkCommand): Promise<ReadingMark>
  purgeReadingMark(userId: string, kind: MarkKind, bookId: string, id: string, expectedVersion: number): Promise<void>
  getOrganizationLibrary(userId: string, bookIds?: string[], includePositions?: boolean): Promise<{ books: Array<{ book: StoredBook; editions: StoredEdition[] }>; positions: StoredPosition[]; bookshelf: Array<{ bookId: string; groupId: string | null }> }>
  getBookOrganization(userId: string, listId?: string, includeItems?: boolean): Promise<BookListOrganizationSnapshot>
  mutateBookOrganization(userId: string, command: OrganizationCommand): Promise<BookListOrganizationSnapshot>

  listSourceSummaries(userId: string, sourceIds?: string[]): Promise<SourceListRecord[]>
  listSourcesForUser(userId: string): Promise<StoredSourceRecord[]>
  listAllSourcesForUser(userId: string): Promise<StoredSourceRecord[]>
  listSourceStatesForUser(userId: string): Promise<Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>>
  getSourceForUser(userId: string, sourceId: string): Promise<StoredSourceRecord | null>
  getSourceDisplayName(userId: string, sourceId: string): Promise<string | undefined>
  getSourceManagementStats(userId: string): Promise<SourceManagementStats>
  listManagedSources(userId: string, params: { page: number; pageSize: number; query: string; status: SourceManagementStatus; all?: boolean; domain?: string | undefined; sourceIds?: string[] }): Promise<SourceManagementPage>
  applySourceActions(userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }>
  applySourceOrder(userId: string, items: SourceOrderItem[]): Promise<{ affected: number }>
  saveImportPreview(userId: string, preview: ImportPreview, sourceUrl: string): Promise<void>
  getImportPreview(userId: string, previewId: string): Promise<ImportPreview | null>
  commitImportPreview(userId: string, previewId: string, candidateIds: string[]): Promise<ImportConfirmResult>
  listImportLinks(userId: string): Promise<ImportLinksResponse>
  orderImportLinks(userId: string, orderedIds: string[], expectedRevision: string): Promise<ImportLinksResponse>
  listImportHistory(userId: string, query: ImportHistoryQuery): Promise<ImportHistoryPage>
  listImportItems(userId: string, batchId: string, query: ImportHistoryQuery): Promise<ImportItemsPage>
  previewImportUndo(userId: string, batchId: string, itemIds?: string[]): Promise<UndoPreview>
  undoImport(userId: string, batchId: string, input: UndoImportInput): Promise<UndoImportResult>
  acquireExecutionSlot(userId: string, operationId: string): Promise<ExecutionLease | null>
  releaseExecutionSlot(userId: string, lease: ExecutionLease): Promise<void>
  acquireSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, leaseMs: number): Promise<SourceRuntimeLease | null>
  saveSourceRuntimeState(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, expectedVersion: number, snapshot: RuntimeStateSnapshot): Promise<SourceRuntimeStateRecord | null>
  releaseSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string): Promise<void>
  getSettings(userId: string): Promise<ReaderSettings>
  saveSettings(userId: string, patch: ReaderSettingsPatch): Promise<ReaderSettings>
  createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState>
  getSearch(userId: string, searchId: string): Promise<SearchRunState | null>
  claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }, expectedVersion?: number, knownRun?: SearchRunState): Promise<SearchRunState | null>
  updateSearch(userId: string, searchId: string, patch: { knownRun?: SearchRunState; status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null>
  createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }>
  listBookSourceCandidates(userId: string, bookId: string): Promise<StoredBookSourceCandidate[]>
  saveBookSourceCandidates(userId: string, bookId: string, candidates: StoredCandidate[]): Promise<void>
  /** 保存版本用于目录预览，不修改书籍元数据、活动来源或书架关系。 */
  saveEdition(userId: string, bookId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<StoredEdition>
  addToBookshelf(userId: string, bookId: string): Promise<void>
  removeFromBookshelf(userId: string, bookId: string): Promise<void>
  isOnBookshelf(userId: string, bookId: string): Promise<boolean>
  getHome(userId: string): Promise<HomeSnapshot>
  getBackupSnapshot(userId: string): Promise<ReaderBackupSnapshot>
  restoreBackupSnapshot(userId: string, snapshot: ReaderBackupSnapshot, categories: readonly BackupCategory[]): Promise<void>
  deleteSearchHistory(userId: string, historyId: string): Promise<boolean>
  listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>>
  getBook(userId: string, bookId: string): Promise<StoredBook | null>
  setCustomCover(userId: string, bookId: string, coverUrl: string | null): Promise<StoredBook | null>
  listEditions(userId: string, bookId: string): Promise<StoredEdition[]>
  activateEdition(userId: string, bookId: string, editionKey: string): Promise<{ editionKey: string } | null>
  getEditionSource(userId: string, bookId: string, editionKey: string): Promise<{ sourceId: string; sourceFingerprint: string } | null>
  getContentDisplay(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<CachedReadingContent | null>
  setActiveEdition(userId: string, bookId: string, editionKey: string): Promise<StoredEdition | null>
  getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null>
  getChapterContext(userId: string, bookId: string, editionKey: string, chapterId: string, display?: boolean): Promise<ChapterContext | null>
  getTocSummary(userId: string, bookId: string, editionKey: string): Promise<CachedTocSummary | null>
  getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null>
  saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc>
  getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null>
  saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent>
  getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null>
  savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition>
}

export class PostgresReaderRepository implements ReaderRepository {
  public async listBookListSummaries(userId: string, query = '', bookId?: string, picker = false) {
    return withUser(userId, async (tx) => {
      const keyword = query.trim().toLocaleLowerCase()
      // 沿用 JavaScript 的 Unicode 大小写匹配，不依赖数据库 locale 的 lower 行为。
      const matchingIds = keyword ? (await tx.select({ id: bookLists.id, name: bookLists.name }).from(bookLists).where(and(eq(bookLists.userId, userId), eq(bookLists.type, 'booklist')))).filter((row) => row.name.toLocaleLowerCase().includes(keyword)).map((row) => row.id) : undefined
      if (matchingIds?.length === 0) return []
      const rows = await tx.select({ id: bookLists.id, name: bookLists.name, description: bookLists.description,
        ...(picker ? {} : { createdAt: bookLists.createdAt, updatedAt: bookLists.updatedAt }),
        bookCount: sql<number>`(select count(*)::int from reader.book_list_items i where i.user_id = ${userId} and i.book_list_id = ${bookLists.id})`,
        containsBook: bookId ? sql<boolean>`exists (select 1 from reader.book_list_items i where i.user_id = ${userId} and i.book_list_id = ${bookLists.id} and i.book_id = ${bookId}::uuid)` : sql<boolean>`false`,
        ...(picker ? {} : { coverBooks: sql<BookDisplay[]>`(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', b.id, 'name', b.name, 'coverUrl', b.cover_url, 'customCoverUrl', b.custom_cover_url)) order by chosen.added_at desc, chosen.book_id desc), '[]'::jsonb) from (select i.book_id, i.added_at from reader.book_list_items i where i.user_id = ${userId} and i.book_list_id = ${bookLists.id} order by i.added_at desc, i.book_id desc limit 4) chosen join reader.books b on b.user_id = ${userId} and b.id = chosen.book_id)` }),
      }).from(bookLists).where(and(eq(bookLists.userId, userId), eq(bookLists.type, 'booklist'), matchingIds ? inArray(bookLists.id, matchingIds) : undefined)).orderBy(desc(bookLists.updatedAt), desc(bookLists.id))
      return rows.map(({ createdAt, updatedAt, ...row }) => ({ ...row, ...(createdAt ? { createdAt: createdAt.toISOString() } : {}), ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}) }))
    })
  }
  public async getBookListDetails(userId: string, listId: string): Promise<BookListDetails | null> {
    return withUser(userId, async (tx) => {
      const [list] = await tx.select(bookListDisplayColumns).from(bookLists).where(and(eq(bookLists.userId, userId), eq(bookLists.id, listId), eq(bookLists.type, 'booklist')))
      if (!list) return null
      const rows = await tx.select({ bookId: bookListItems.bookId, description: bookListItems.description, addedAt: bookListItems.addedAt, book: bookDisplayColumns }).from(bookListItems).innerJoin(books, and(eq(books.userId, userId), eq(books.id, bookListItems.bookId))).where(and(eq(bookListItems.userId, userId), eq(bookListItems.bookListId, listId))).orderBy(desc(bookListItems.addedAt), desc(bookListItems.bookId))
      return { list: { ...list, createdAt: list.createdAt.toISOString(), updatedAt: list.updatedAt.toISOString() }, items: rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString(), book: displayBook(row.book) })) }
    })
  }
  public async getShelfGroups(userId: string, bookId?: string) {
    return withUser(userId, async (tx) => {
      const groups = await tx.select({ id: bookLists.id, name: bookLists.name, bookCount: sql<number>`(select count(*)::int from reader.bookshelf s where s.user_id = ${userId} and s.group_id = ${bookLists.id})` }).from(bookLists).where(and(eq(bookLists.userId, userId), eq(bookLists.type, 'shelf_group'))).orderBy(asc(bookLists.customOrder), asc(bookLists.createdAt), asc(bookLists.id))
      const [ungrouped] = await tx.select({ value: sql<number>`count(*)::int` }).from(bookshelf).where(and(eq(bookshelf.userId, userId), isNull(bookshelf.groupId)))
      const [current] = bookId ? await tx.select({ groupId: bookshelf.groupId }).from(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, bookId))) : []
      return { groups, ungroupedCount: ungrouped?.value ?? 0, ...(bookId ? { onBookshelf: current !== undefined, currentGroupId: current?.groupId ?? null } : {}) }
    })
  }
  public async listBookIdentities(userId: string) {
    return withUser(userId, async (tx) => {
      const rows = await tx.select({ id: books.id, name: books.name, author: books.author, onBookshelf: sql<boolean>`exists (select 1 from reader.bookshelf s where s.user_id = ${userId} and s.book_id = ${books.id})` }).from(books).where(eq(books.userId, userId)).orderBy(desc(books.updatedAt))
      return rows.map(({ author, ...row }) => ({ ...row, ...(author === null ? {} : { author }) }))
    })
  }
  public async getBookReadingInfo(userId: string, bookId: string, editionKey?: string): Promise<BookReadingInfo | null> {
    return withUser(userId, async (tx) => {
      const [row] = await tx.select({ id: books.id, name: books.name, author: books.author, activeEditionKey: books.activeEditionKey,
        editionKey: bookEditions.editionKey, editionName: sql<unknown>`${bookEditions.metadata}->'name'`,
      }).from(books).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id),
        editionKey ? eq(bookEditions.editionKey, editionKey) : or(eq(bookEditions.editionKey, books.activeEditionKey), isNull(books.activeEditionKey)),
      )).where(and(eq(books.userId, userId), eq(books.id, bookId))).orderBy(desc(bookEditions.updatedAt)).limit(1)
      return row === undefined ? null : { book: { id: row.id, name: row.name, ...(row.author === null ? {} : { author: row.author }), ...(row.activeEditionKey === null ? {} : { activeEditionKey: row.activeEditionKey }) },
        edition: { editionKey: row.editionKey, ...(typeof row.editionName === 'string' ? { name: row.editionName } : {}) } }
    })
  }
  public async getReadingEntry(userId: string, bookId: string) {
    return withUser(userId, async (tx) => { const [row] = await tx.select({ activeEditionKey: books.activeEditionKey }).from(books).where(and(eq(books.userId, userId), eq(books.id, bookId))); return row ?? null })
  }
  public async listEditionOptions(userId: string, bookId: string) {
    return withUser(userId, async (tx) => {
      const rows = await tx.select({ editionKey: bookEditions.editionKey, sourceId: bookEditions.sourceId, name: sql<unknown>`${userSources.normalizedSource}->'bookSourceName'` }).from(bookEditions).leftJoin(userSources, and(eq(userSources.userId, userId), eq(userSources.sourceId, bookEditions.sourceId), eq(userSources.deleted, false))).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId))).orderBy(desc(bookEditions.updatedAt), asc(bookEditions.createdAt))
      return rows.map(({ name, ...row }) => ({ ...row, sourceName: typeof name === 'string' ? name : row.sourceId }))
    })
  }
  public async getDisplayEdition(userId: string, bookId: string, editionKey?: string) {
    return withUser(userId, async (tx) => {
      const [row] = await tx.select({ editionKey: bookEditions.editionKey, sourceId: bookEditions.sourceId, sourceFingerprint: bookEditions.sourceFingerprint, bookUrl: bookEditions.bookUrl, metadata: sql<BookDetailsResponse['edition']['metadata']>`(select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(${bookEditions.metadata}) where key in ('name', 'author', 'intro', 'coverUrl', 'kind', 'lastChapter', 'updateTime', 'wordCount', 'searchDurationMs'))` }).from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), editionKey ? eq(bookEditions.editionKey, editionKey) : undefined)).orderBy(desc(bookEditions.updatedAt)).limit(1)
      return row ?? null
    })
  }
  public async getDisplayPosition(userId: string, bookId: string, editionKey: string) {
    return withUser(userId, async (tx) => { const [row] = await tx.select({ title: readingRecords.title, lastReadAt: readingRecords.lastReadAt }).from(readingRecords).where(and(eq(readingRecords.userId, userId), eq(readingRecords.bookId, bookId), eq(readingRecords.editionKey, editionKey))).limit(1); return row ? { title: row.title, lastReadAt: row.lastReadAt.toISOString() } : null })
  }
  public listReadingMarkBooks(userId: string) { return withUser(userId, (tx) => tx.selectDistinct({ id: books.id, name: books.name, author: books.author, activeEditionKey: books.activeEditionKey }).from(readingAnnotations).innerJoin(books, and(eq(books.userId, userId), eq(books.id, readingAnnotations.bookId))).where(eq(readingAnnotations.userId, userId)).orderBy(books.name, books.id)) }
  public listReadingMarks(userId: string, query: MarkQuery) { return withUser(userId, (tx) => readMarks(tx, userId, query)) }
  public listReaderMarks(userId: string, query: MarkQuery) { return withUser(userId, (tx) => readReaderMarks(tx, userId, query)) }
  public listReadingMarkSummaries(userId: string, query: MarkQuery) { return withUser(userId, (tx) => readMarks(tx, userId, query, true)) }
  public getCachedMarkChapter(userId: string, bookId: string, id: string) {
    return withUser(userId, async (tx) => {
      const [row] = await tx.select({ cachedChapter: sql<CachedChapter | null>`${readingAnnotations.data}->'cachedChapter'` }).from(readingAnnotations).where(and(eq(readingAnnotations.userId, userId), eq(readingAnnotations.bookId, bookId), eq(readingAnnotations.id, id))).limit(1)
      return row ?? null
    })
  }
  public mutateReadingMark(userId: string, command: MarkCommand) { return withUser(userId, (tx) => writeMark(tx, userId, command)) }
  public purgeReadingMark(userId: string, kind: MarkKind, bookId: string, id: string, expectedVersion: number) { return withUser(userId, (tx) => purgeMark(tx, userId, kind, bookId, id, expectedVersion)) }
  public acquireExecutionSlot(userId: string, operationId: string) { return acquireExecutionSlot(userId, operationId) }
  public releaseExecutionSlot(userId: string, lease: ExecutionLease) { return releaseExecutionSlot(userId, lease) }
  public listImportLinks(userId: string) { return withUser(userId, (tx) => importHistory.readImportLinks(tx, userId)) }
  public orderImportLinks(userId: string, ids: string[], revision: string) { return withUser(userId, (tx) => importHistory.orderImportLinks(tx, userId, ids, revision)) }
  public listImportHistory(userId: string, query: ImportHistoryQuery) { return withUser(userId, (tx) => importHistory.readImportHistory(tx, userId, query)) }
  public listImportItems(userId: string, batchId: string, query: ImportHistoryQuery) { return withUser(userId, (tx) => importHistory.readImportItems(tx, userId, batchId, query)) }
  public previewImportUndo(userId: string, batchId: string, ids?: string[]) { return withUser(userId, (tx) => importHistory.previewUndo(tx, userId, batchId, ids)) }
  public undoImport(userId: string, batchId: string, input: UndoImportInput) { return withUser(userId, (tx) => importHistory.undoImport(tx, userId, batchId, input)) }

  public async getOrganizationLibrary(userId: string, bookIds?: string[], includePositions?: boolean) {
    return withUser(userId, async (tx) => {
      const [bookRows, editions, positions, shelf] = await Promise.all([tx.select().from(books).where(and(eq(books.userId, userId), bookIds ? inArray(books.id, bookIds) : undefined)), tx.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), bookIds ? inArray(bookEditions.bookId, bookIds) : undefined)), includePositions === false ? Promise.resolve([]) : tx.select().from(readingRecords).where(and(eq(readingRecords.userId, userId), bookIds ? inArray(readingRecords.bookId, bookIds) : undefined)), tx.select({ bookId: bookshelf.bookId, groupId: bookshelf.groupId }).from(bookshelf).where(eq(bookshelf.userId, userId))])
      const byBook = new Map<string, StoredEdition[]>()
      for (const edition of editions) { const values = byBook.get(edition.bookId) ?? []; values.push(toEdition(edition)); byBook.set(edition.bookId, values) }
      return { books: bookRows.map((row) => ({ book: toBook(row), editions: byBook.get(row.id) ?? [] })), positions: positions.map(toPosition), bookshelf: shelf }
    })
  }

  public async getBookOrganization(userId: string, listId?: string, includeItems = true): Promise<BookListOrganizationSnapshot> {
    return withUser(userId, async (tx) => readOrganization(tx, userId, listId, includeItems))
  }

  public async mutateBookOrganization(userId: string, command: OrganizationCommand): Promise<BookListOrganizationSnapshot> {
    return withUser(userId, async (tx) => {
      // 同账号的分组删除、归属修改及排序共用锁，防止产生悬空关系。
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId + ':book-organization'}, 0))`)
      const before = await readOrganization(tx, userId)
      const shelfRows = await tx.select().from(bookshelf).where(eq(bookshelf.userId, userId))
      const bookRows = await tx.select({ id: books.id }).from(books).where(eq(books.userId, userId))
      const state = { ...structuredClone(before), shelf: new Map(shelfRows.map((row) => [row.bookId, row.groupId])), bookIds: new Set(bookRows.map((row) => row.id)) }
      applyOrganizationCommand(state, userId, command)
      const memberKey = (row: { bookListId: string; bookId: string }) => row.bookListId + ':' + row.bookId
      const previousLists = new Map(before.lists.map((row) => [row.id, row]))
      const previousItems = new Map(before.items.map((row) => [memberKey(row), row]))
      const nextLists = new Set(state.lists.map((row) => row.id))
      const nextItems = new Set(state.items.map(memberKey))
      for (const row of before.items) if (!nextItems.has(memberKey(row))) await tx.delete(bookListItems).where(and(eq(bookListItems.userId, userId), eq(bookListItems.bookListId, row.bookListId), eq(bookListItems.bookId, row.bookId)))
      for (const row of before.lists) if (!nextLists.has(row.id)) await tx.delete(bookLists).where(and(eq(bookLists.userId, userId), eq(bookLists.id, row.id)))
      for (const row of state.lists) {
        if (JSON.stringify(previousLists.get(row.id)) === JSON.stringify(row)) continue
        const values = { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) }
        await tx.insert(bookLists).values(values).onConflictDoUpdate({ target: bookLists.id, set: { name: row.name, description: row.description, customOrder: row.customOrder, updatedAt: values.updatedAt } })
      }
      for (const row of state.items) {
        if (JSON.stringify(previousItems.get(memberKey(row))) === JSON.stringify(row)) continue
        const values = { ...row, addedAt: new Date(row.addedAt), updatedAt: new Date(row.updatedAt) }
        await tx.insert(bookListItems).values(values).onConflictDoUpdate({ target: [bookListItems.userId, bookListItems.bookListId, bookListItems.bookId], set: { description: row.description, updatedAt: values.updatedAt } })
      }
      for (const row of shelfRows) {
        if (!state.shelf.has(row.bookId)) await tx.delete(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, row.bookId)))
        else if (state.shelf.get(row.bookId) !== row.groupId) await tx.update(bookshelf).set({ groupId: state.shelf.get(row.bookId) ?? null }).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, row.bookId)))
      }
      if (command.kind === 'delete' && command.type === 'shelf_group') {
        const [settings] = await tx.select().from(readerSettings).where(eq(readerSettings.userId, userId)).for('update')
        if (settings?.preferences.general.bookshelfInitialGroup === command.id) await tx.update(readerSettings).set({ preferences: { ...settings.preferences, general: { ...settings.preferences.general, bookshelfInitialGroup: 'all' } }, updatedAt: new Date() }).where(eq(readerSettings.userId, userId))
      }
      return { lists: state.lists, items: state.items }
    })
  }

  public async listSourceSummaries(userId: string, sourceIds?: string[]): Promise<SourceListRecord[]> {
    if (sourceIds?.length === 0) return []
    return withUser(userId, async (tx) => {
      const rows = await tx.select({ ...sourceListColumns, priority: sourceImportLinks.sortOrder }).from(userSources)
        .leftJoin(sourceImportLinks, and(eq(sourceImportLinks.userId, userId), eq(sourceImportLinks.id, userSources.importLinkId)))
        .where(and(eq(userSources.userId, userId), eq(userSources.deleted, false), sourceIds === undefined ? eq(userSources.enabled, true) : inArray(userSources.sourceId, sourceIds)))
      // 展示与搜索入口沿用仓储的同域选择顺序；指定来源时保留停用版本。
      return (sourceIds === undefined ? selectOneSourcePerDomain(rows, compareSourceManagementOrder) : rows).map(sourceListRecord).sort(compareSourceListPriority)
    })
  }

  public async listSourcesForUser(userId: string): Promise<StoredSourceRecord[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.enabled, true), eq(userSources.deleted, false))).orderBy(asc(userSources.customOrder), asc(userSources.sourceId))
      const priorities = new Map((await importHistory.readImportLinks(transaction, userId)).links.map((link) => [link.id, link.sortOrder]))
      return selectOneSourcePerDomain(rows, compareSourceManagementOrder).map((row) => ({ ...toUserSource(row), priority: priorities.get(row.importLinkId ?? '') ?? Number.MAX_SAFE_INTEGER })).sort(compareSourcePriority)
    })
  }

  public async listAllSourcesForUser(userId: string): Promise<StoredSourceRecord[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false))).orderBy(asc(userSources.customOrder), asc(userSources.sourceId))
      const priorities = new Map((await importHistory.readImportLinks(transaction, userId)).links.map((link) => [link.id, link.sortOrder]))
      return rows.map((row) => ({ ...toUserSource(row), priority: priorities.get(row.importLinkId ?? '') ?? Number.MAX_SAFE_INTEGER })).sort(compareSourcePriority)
    })
  }

  public async listSourceStatesForUser(userId: string): Promise<Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(eq(userSources.userId, userId))
      return rows.map((row) => ({ source: toUserSource(row), sourceRevision: row.revision, ...(row.deleted ? { deleted: true } : {}) }))
    })
  }

  public async getSourceForUser(userId: string, sourceId: string): Promise<StoredSourceRecord | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId), eq(userSources.enabled, true), eq(userSources.deleted, false))).limit(1)
      return row === undefined ? null : toUserSource(row)
    })
  }

  public async getSourceDisplayName(userId: string, sourceId: string): Promise<string | undefined> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select({ name: sql<unknown>`${userSources.normalizedSource}->'bookSourceName'` }).from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId), eq(userSources.deleted, false))).limit(1)
      return typeof row?.name === 'string' ? row.name : undefined
    })
  }

  public async getSourceManagementStats(userId: string): Promise<SourceManagementStats> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select({ sourceId: userSources.sourceId, enabled: userSources.enabled }).from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false)))
      return sourceManagementStats(rows)
    })
  }

  public async listManagedSources(userId: string, params: { page: number; pageSize: number; query: string; status: SourceManagementStatus; all?: boolean; domain?: string | undefined; sourceIds?: string[] }): Promise<SourceManagementPage> {
    return withUser(userId, async (transaction) => {
      const sourceRows = await transaction.select({ source: { ...sourceListColumns, revision: userSources.revision, author: sql<unknown>`${userSources.normalizedSource}->'author'`, bookSourceAuthor: sql<unknown>`${userSources.normalizedSource}->'bookSourceAuthor'`, lastUpdateTime: sql<unknown>`${userSources.normalizedSource}->'lastUpdateTime'` }, displayUrl: sourceImportLinks.displayUrl, priority: sourceImportLinks.sortOrder, importedAt: sourceImportBatches.importedAt }).from(userSources).leftJoin(sourceImportLinks, and(eq(sourceImportLinks.userId, userId), eq(sourceImportLinks.id, userSources.importLinkId))).leftJoin(sourceImportItems, and(eq(sourceImportItems.userId, userId), eq(sourceImportItems.id, userSources.currentImportItemId))).leftJoin(sourceImportBatches, and(eq(sourceImportBatches.userId, userId), eq(sourceImportBatches.id, sourceImportItems.batchId))).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false), params.sourceIds === undefined ? undefined : inArray(userSources.sourceId, params.sourceIds)))
      const allRows = sourceRows.map(({ source: row, displayUrl, priority, importedAt }) => ({ ...managedListSummary(row), ...(displayUrl ? { importDisplayUrl: displayUrl } : {}), ...(priority === null ? {} : { importPriority: priority }), ...(importedAt ? { importedAt: importedAt.toISOString() } : {}) }))
      const enabledCount = allRows.filter((source) => source.enabled).length
      const rows = allRows
        .filter((source) => {
          const query = params.query.toLocaleLowerCase()
          const matchesQuery = query.length === 0 || `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(query)
          return matchesQuery && (params.domain === undefined || sourceDomainInfo(source.sourceId).key === sourceDomainInfo(params.domain).key) && (params.sourceIds === undefined || params.sourceIds.includes(source.sourceId)) && (params.status === 'all' || (params.status === 'enabled' ? source.enabled : !source.enabled))
        })
        .sort((a, b) => a.customOrder - b.customOrder || a.name.localeCompare(b.name, 'zh-Hans') || a.sourceId.localeCompare(b.sourceId))
      const offset = (params.page - 1) * params.pageSize
      const page = params.all === true ? rows : rows.slice(offset, offset + params.pageSize)
      return { sources: page, page: params.all === true ? 1 : params.page, pageSize: params.all === true ? Math.max(1, rows.length) : params.pageSize, total: rows.length, enabledCount }
    })
  }

  public async applySourceActions(userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }> {
    return withUser(userId, async (transaction) => {
      await lockUserSourceMutations(transaction, userId)
      const overrides = await transaction.select().from(userSources).where(eq(userSources.userId, userId)).for('update')
      const overrideById = new Map(overrides.map((row) => [row.sourceId, row]))
      const seen = new Set<string>()
      const enabledDomains = new Set<string>()
      for (const item of items) {
        if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '操作列表包含重复书源')
        seen.add(item.sourceId)
        const domainKey = sourceDomainInfo(item.sourceId).key
        if (action === 'enable') {
          if (enabledDomains.has(domainKey)) throw new SourceManagementError('source-conflict', '同一域名只能启用一个书源版本')
          enabledDomains.add(domainKey)
        }
        const override = overrideById.get(item.sourceId)
        if (override === undefined || override.deleted) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
        const current = toUserSource(override)
        if (override.revision !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
        const nextEnabled = action === 'enable'
        if (action === 'delete') {
          const runtimeRows = await transaction.select().from(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, current.sourceId))).for('update')
          if (runtimeRows.some((row) => row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${item.sourceId}`)
          await transaction.delete(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, current.sourceId)))
        }
        if (action === 'enable') {
          const selectedIds = new Set(items.map((entry) => entry.sourceId))
          for (const sibling of overrides) {
            if (sibling.deleted || !sibling.enabled || selectedIds.has(sibling.sourceId) || sourceDomainInfo(sibling.sourceId).key !== domainKey) continue
            const updated = await transaction.update(userSources).set({ enabled: false, revision: randomUUID(), updatedAt: new Date() }).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sibling.sourceId), eq(userSources.revision, sibling.revision))).returning({ sourceId: userSources.sourceId })
            if (updated.length === 0) throw new SourceManagementError('source-conflict', `同域书源已更新，请刷新后重试：${sibling.sourceId}`)
          }
        }
        await transaction.insert(userSources).values({
          userId,
          sourceId: current.sourceId,
          fingerprint: current.fingerprint,
          rawSource: current.rawSource,
          normalizedSource: current.normalizedSource,
          enabled: action === 'delete' ? current.enabled : nextEnabled,
          customOrder: readInteger(current.normalizedSource.customOrder, 0),
          deleted: action === 'delete',
          revision: randomUUID(),
          updatedAt: new Date(),
        }).onConflictDoUpdate({ target: [userSources.userId, userSources.sourceId], set: { fingerprint: sql.raw('excluded."fingerprint"'), rawSource: sql.raw('excluded."raw_source"'), normalizedSource: sql.raw('excluded."normalized_source"'), enabled: sql.raw('excluded."enabled"'), customOrder: sql.raw('excluded."custom_order"'), deleted: sql.raw('excluded."deleted"'), revision: sql.raw('excluded."revision"'), updatedAt: new Date() } })
      }
      return { affected: items.length }
    })
  }

  public async applySourceOrder(userId: string, items: SourceOrderItem[]): Promise<{ affected: number }> {
    return withUser(userId, async (transaction) => {
      await lockUserSourceMutations(transaction, userId)
      const rows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false))).for('update')
      const byId = new Map(rows.map((row) => [row.sourceId, row]))
      const seen = new Set<string>()
      for (const item of items) {
        if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '排序列表包含重复书源')
        seen.add(item.sourceId)
        const current = byId.get(item.sourceId)
        if (current === undefined) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
        if (current.revision !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
        const normalizedSource = { ...current.normalizedSource, customOrder: item.customOrder }
        await transaction.update(userSources).set({ customOrder: item.customOrder, normalizedSource, revision: randomUUID(), updatedAt: new Date() }).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, item.sourceId), eq(userSources.revision, item.expectedSourceRevision)))
      }
      return { affected: items.length }
    })
  }

  public async saveImportPreview(userId: string, preview: ImportPreview, sourceUrl: string): Promise<void> {
    await withUser(userId, async (transaction) => {
      await transaction.delete(sourceImportPreviews).where(and(eq(sourceImportPreviews.userId, userId), lt(sourceImportPreviews.expiresAt, new Date())))
      await transaction.insert(sourceImportPreviews).values({ id: preview.previewId, userId, sourceUrl, candidates: preview.candidates, expiresAt: new Date(preview.expiresAt) })
    })
  }

  public async getImportPreview(userId: string, previewId: string): Promise<ImportPreview | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(sourceImportPreviews).where(and(eq(sourceImportPreviews.userId, userId), eq(sourceImportPreviews.id, previewId))).limit(1)
      if (row === undefined || row.expiresAt.getTime() <= Date.now()) return null
      return { previewId: row.id, expiresAt: row.expiresAt.toISOString(), candidates: row.candidates as ImportPreviewCandidate[], writableCount: (row.candidates as ImportPreviewCandidate[]).filter((candidate) => candidate.disposition !== undefined).length }
    })
  }

  public async commitImportPreview(userId: string, previewId: string, candidateIds: string[]): Promise<ImportConfirmResult> {
    return withUser(userId, async (transaction) => {
      await lockUserSourceMutations(transaction, userId)
      const committed = await importHistory.committedImport(transaction, userId, previewId, candidateIds)
      if (committed) return committed
      const [previewRow] = await transaction.select().from(sourceImportPreviews).where(and(eq(sourceImportPreviews.userId, userId), eq(sourceImportPreviews.id, previewId))).limit(1).for('update')
      if (previewRow === undefined || previewRow.expiresAt.getTime() <= Date.now()) throw new SourceManagementError('preview-expired', '导入预览已过期，请重新获取')
      const previousIds = previewRow.consumedCandidateIds
      if (previousIds.length > 0) {
        if (sameStringSet(previousIds, candidateIds)) throw new SourceManagementError('preview-invalid', '旧版预览已确认，请查看书源列表')
        throw new SourceManagementError('preview-invalid', '导入预览已经确认过')
      }
      const candidates = (previewRow.candidates as ImportPreviewCandidate[]).filter((candidate) => candidateIds.includes(candidate.id))
      if (candidates.length !== candidateIds.length || candidates.some((candidate) => candidate.disposition === undefined)) throw new SourceManagementError('preview-invalid', '确认列表包含不可导入的书源')
      const overrides = await transaction.select().from(userSources).where(eq(userSources.userId, userId)).for('update')
      const overrideById = new Map(overrides.map((row) => [row.sourceId, row]))
      const importEnabled = decideImportedSourceEnabled(candidates, new Map(overrides.map((row) => [row.sourceId, { enabled: row.enabled, deleted: row.deleted }])))
      const history = await importHistory.recordImport(transaction, userId, previewId, previewRow.sourceUrl, { previewId, expiresAt: previewRow.expiresAt.toISOString(), candidates: previewRow.candidates as ImportPreviewCandidate[], writableCount: candidates.length }, candidateIds, overrides)
      for (const candidate of candidates) {
        const current = overrideById.get(candidate.sourceId)
        const currentRevision = current?.revision
        if (candidate.sourceRevision === undefined ? currentRevision !== undefined : currentRevision !== candidate.sourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请重新获取预览：${candidate.name}`)
        const currentSource = current === undefined ? undefined : toUserSource(current)
        const normalizedSource = mergeImportedSource(currentSource, candidate.normalizedSource as NormalizedSource)
        const runtimeRows = await transaction.select().from(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, candidate.sourceId))).for('update')
        if (runtimeRows.some((row) => row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${candidate.name}`)
        if (currentSource !== undefined && currentSource.fingerprint !== candidate.fingerprint) await transaction.delete(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, candidate.sourceId)))
        await transaction.insert(userSources).values({ userId, sourceId: candidate.sourceId, fingerprint: candidate.fingerprint, rawSource: candidate.rawSource, sourceUuid: history.changes.get(candidate.id)!.sourceUuid, importLinkId: history.linkId, currentImportItemId: history.changes.get(candidate.id)!.itemId, normalizedSource, enabled: importEnabled.get(candidate.id) ?? false, customOrder: readInteger(currentSource?.normalizedSource.customOrder, 0), deleted: false, revision: history.changes.get(candidate.id)!.revision, updatedAt: new Date() }).onConflictDoUpdate({ target: [userSources.userId, userSources.sourceId], set: { importLinkId: history.linkId, currentImportItemId: sql.raw('excluded."current_import_item_id"'), fingerprint: sql.raw('excluded."fingerprint"'), rawSource: sql.raw('excluded."raw_source"'), normalizedSource: sql.raw('excluded."normalized_source"'), enabled: sql.raw('excluded."enabled"'), customOrder: sql.raw('excluded."custom_order"'), deleted: false, revision: sql.raw('excluded."revision"'), updatedAt: new Date() } })
      }
      const result = history.result
      await transaction.update(sourceImportPreviews).set({ consumedCandidateIds: candidateIds, consumedResult: result }).where(and(eq(sourceImportPreviews.userId, userId), eq(sourceImportPreviews.id, previewId)))
      return result
    })
  }

  public async acquireSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, leaseMs: number): Promise<SourceRuntimeLease | null> {
    return withUser(userId, async (transaction) => {
      const identity = and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, sourceId), eq(sourceRuntimeState.sourceFingerprint, sourceFingerprint))
      const now = new Date()
      const leaseUntil = new Date(now.getTime() + Math.max(1_000, leaseMs))
      const [existing] = await transaction.select().from(sourceRuntimeState).where(identity).limit(1)
      if (existing === undefined) {
        const [created] = await transaction.insert(sourceRuntimeState).values({ userId, sourceId, sourceFingerprint, encryptedState: encryptRuntimeState({}), leaseToken, leaseUntil, updatedAt: now }).onConflictDoNothing().returning()
        if (created !== undefined) return toRuntimeLease(created, leaseToken)
      }
      const [leased] = await transaction.update(sourceRuntimeState).set({ leaseToken, leaseUntil, updatedAt: now }).where(and(identity, or(isNull(sourceRuntimeState.leaseToken), isNull(sourceRuntimeState.leaseUntil), lt(sourceRuntimeState.leaseUntil, now)))).returning()
      return leased === undefined ? null : toRuntimeLease(leased, leaseToken)
    })
  }

  public async saveSourceRuntimeState(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, expectedVersion: number, snapshot: RuntimeStateSnapshot): Promise<SourceRuntimeStateRecord | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(sourceRuntimeState).set({ encryptedState: encryptRuntimeState(snapshot), version: sql`${sourceRuntimeState.version} + 1`, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, sourceId), eq(sourceRuntimeState.sourceFingerprint, sourceFingerprint), eq(sourceRuntimeState.leaseToken, leaseToken), eq(sourceRuntimeState.version, expectedVersion))).returning()
      return row === undefined ? null : toRuntimeState(row)
    })
  }

  public async releaseSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string): Promise<void> {
    await withUser(userId, async (transaction) => {
      await transaction.update(sourceRuntimeState).set({ leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, sourceId), eq(sourceRuntimeState.sourceFingerprint, sourceFingerprint), eq(sourceRuntimeState.leaseToken, leaseToken)))
    })
  }

  public async getSettings(userId: string): Promise<ReaderSettings> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      return row === undefined ? defaultReaderSettings(userId) : toSettings(row)
    })
  }

  public async saveSettings(userId: string, patch: ReaderSettingsPatch): Promise<ReaderSettings> {
    return withUser(userId, async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId + ':book-organization'}, 0))`)
      const target = patch.general?.bookshelfInitialGroup
      if (target !== undefined && target !== 'all' && target !== 'ungrouped') {
        const [group] = await transaction.select().from(bookLists).where(and(eq(bookLists.userId, userId), eq(bookLists.id, target), eq(bookLists.type, 'shelf_group')))
        if (!group) throw new OrganizationError(404, '启动分组不存在')
      }
      const [currentRow] = await transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      const current = currentRow === undefined ? defaultReaderSettings(userId) : toSettings(currentRow)
      const next = mergeReaderSettings(current, patch, new Date().toISOString())
      const values = readerSettingsValues(userId, next, new Date(next.updatedAt))
      const [row] = await transaction.insert(readerSettings).values(values).onConflictDoUpdate({ target: readerSettings.userId, set: { preferences: values.preferences, updatedAt: values.updatedAt } }).returning()
      if (row === undefined) throw new Error('保存设置失败')
      return toSettings(row)
    })
  }

  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> {
    return withUser(userId, async (transaction) => {
      const sourceIds = input.sourceIds === undefined || input.sourceIds.length === 0 ? [input.sourceId] : [...new Set(input.sourceIds)]
      const sourceStates: SourceSearchState[] = sourceIds.map((sourceId) => ({ sourceId, ...input.sourceSnapshots?.find((item) => item.sourceId === sourceId), status: 'pending', candidates: [], diagnostics: [] }))
      const [row] = await transaction.insert(searchRuns).values({
        userId,
        keyword: input.keyword,
        sourceId: input.sourceId,
        sourceIds,
        precision: input.precision === true,
        ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
        status: 'running',
        sourceStates,
        progressTotal: sourceIds.length,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }).returning()
      if (row === undefined) throw new Error('创建搜索任务失败')
      await transaction.insert(searchHistory).values({ userId, searchId: row.id, keyword: input.keyword, sourceIds, status: 'running', resultCount: 0 })
      return toSearch(row)
    })
  }

  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(searchRuns).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId))).limit(1)
      return row === undefined ? null : toSearch(row)
    })
  }

  public async claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }, expectedVersion?: number, knownRun?: SearchRunState): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({ operationId, operationLeaseUntil: sql`now() + interval '30 seconds'`, sourceStates: compactSearchStates(sourceStates), progressCompleted: progress.completed, progressTotal: progress.total, status: 'running', cancelled: false, version: sql`${searchRuns.version} + 1`, updatedAt: new Date() }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId), eq(searchRuns.cancelled, false), expectedVersion === undefined ? undefined : eq(searchRuns.version, expectedVersion), or(isNull(searchRuns.operationId), sql`${searchRuns.operationLeaseUntil} < now()`))).returning({ ...getTableColumns(searchRuns), ...(knownRun ? { candidates: sql<StoredCandidate[]>`'[]'::jsonb`, sourceStates: sql<SourceSearchState[]>`'[]'::jsonb` } : {}) })
      return row === undefined ? null : toSearch(knownRun ? { ...row, candidates: knownRun.candidates, sourceStates } : row)
    })
  }

  public async updateSearch(userId: string, searchId: string, patch: { knownRun?: SearchRunState; status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }),
        ...(patch.sourceStates === undefined ? {} : { sourceStates: compactSearchStates(patch.sourceStates) }),
        ...(patch.sourceIds === undefined ? {} : { sourceIds: patch.sourceIds }),
        ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }),
        ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }),
        ...(patch.operationId === undefined ? {} : { operationId: patch.operationId, operationLeaseUntil: patch.operationId === null ? null : sql`now() + interval '30 seconds'` }),
        ...(patch.progress === undefined ? {} : { progressCompleted: patch.progress.completed, progressTotal: patch.progress.total }),
        ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }),
        updatedAt: new Date(),
        version: sql`${searchRuns.version} + 1`,
      }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId), ...(patch.expectedOperationId === undefined ? [] : [eq(searchRuns.operationId, patch.expectedOperationId)]))).returning({ ...getTableColumns(searchRuns), ...(patch.knownRun ? { candidates: sql<StoredCandidate[]>`'[]'::jsonb`, sourceStates: sql<SourceSearchState[]>`'[]'::jsonb` } : {}) })
      // 已有快照经过 operationId 条件校验，复用应用持有的数据，避免数据库重复返回整份大结果。
      if (row !== undefined && patch.knownRun) {
        row.candidates = patch.candidates ?? patch.knownRun.candidates
        row.sourceStates = patch.sourceStates ?? patch.knownRun.sourceStates
      }
      if (row !== undefined) {
        const historyStatus = row.status === 'capability-missing' ? 'failed' : row.status
        await transaction.update(searchHistory).set({ status: historyStatus, resultCount: row.candidates.length, summary: searchSummary(historyStatus, row.candidates.length), updatedAt: new Date() }).where(and(eq(searchHistory.userId, userId), eq(searchHistory.searchId, searchId), isNull(searchHistory.deletedAt)))
      }
      return row === undefined ? null : toSearch(row)
    })
  }

  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> {
    return withUser(userId, async (transaction) => {
      const [existingEdition] = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.editionKey, input.editionKey))).limit(1)
      if (existingEdition !== undefined && input.bookId !== undefined && existingEdition.bookId !== input.bookId) throw new Error('书籍版本已经属于其他书籍')
      const now = new Date()
      const targetBookId = existingEdition?.bookId ?? input.bookId
      let book: BookRow | undefined
      if (targetBookId !== undefined) {
        // 预览其他来源不能改写书架展示；新来源元数据保存在 edition 中。
        const [updatedBook] = input.activateEdition === false
          ? await transaction.select().from(books).where(and(eq(books.userId, userId), eq(books.id, targetBookId))).limit(1)
          : await transaction.update(books).set({
            name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍',
            ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
            ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }),
            ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }),
            activeEditionKey: input.editionKey,
            updatedAt: now,
          }).where(and(eq(books.userId, userId), eq(books.id, targetBookId))).returning()
        book = updatedBook
      } else {
        const [createdBook] = await transaction.insert(books).values({
          userId,
          name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍',
          ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
          ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }),
          ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }),
          activeEditionKey: input.editionKey,
        }).returning()
        book = createdBook
      }
      if (book === undefined) throw new Error('创建书籍失败')
      const editionValues = {
        userId,
        bookId: book.id,
        editionKey: input.editionKey,
        sourceId: input.candidate.sourceId,
        sourceFingerprint: input.sourceFingerprint,
        bookUrl: input.metadata.bookUrl,
        metadata: input.metadata,
        ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }),
        updatedAt: now,
      }
      const [edition] = existingEdition === undefined
        ? await transaction.insert(bookEditions).values(editionValues).returning()
        : await transaction.update(bookEditions).set({ sourceId: editionValues.sourceId, sourceFingerprint: editionValues.sourceFingerprint, bookUrl: editionValues.bookUrl, metadata: editionValues.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }), updatedAt: now }).where(and(eq(bookEditions.userId, userId), eq(bookEditions.editionKey, input.editionKey))).returning()
      if (edition === undefined) throw new Error('创建书籍版本失败')
      if (input.addToBookshelf !== false) await transaction.insert(bookshelf).values({ userId, bookId: book.id }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] })
      return { book: toBook(book), edition: toEdition(edition) }
    })
  }

  public async setCustomCover(userId: string, bookId: string, coverUrl: string | null): Promise<StoredBook | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(books).set({ customCoverUrl: coverUrl }).where(and(eq(books.userId, userId), eq(books.id, bookId))).returning()
      return row === undefined ? null : toBook(row)
    })
  }

  public async listBookSourceCandidates(userId: string, bookId: string): Promise<StoredBookSourceCandidate[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(bookSourceCandidates).where(and(eq(bookSourceCandidates.userId, userId), eq(bookSourceCandidates.bookId, bookId))).orderBy(desc(bookSourceCandidates.updatedAt), asc(bookSourceCandidates.id))
      return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
    })
  }

  public async saveBookSourceCandidates(userId: string, bookId: string, candidates: StoredCandidate[]): Promise<void> {
    if (candidates.length === 0) return
    await withUser(userId, async (transaction) => {
      const [book] = await transaction.select({ id: books.id }).from(books).where(and(eq(books.userId, userId), eq(books.id, bookId)))
      if (book === undefined) throw new Error('书籍不存在')
      const unique = new Map(candidates.map((candidate) => [JSON.stringify([candidate.sourceId, candidate.sourceFingerprint, candidate.candidate.bookUrl]), candidate]))
      // 分块避免大型搜索超过Postgres参数上限；旧版本缓存保留，但读取时验证fingerprint。
      const values = [...unique.values()]
      for (let offset = 0; offset < values.length; offset += 100) {
        await transaction.insert(bookSourceCandidates).values(values.slice(offset, offset + 100).map((candidate) => ({ userId, bookId, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.candidate.bookUrl, candidate: cacheableCandidate(candidate) }))).onConflictDoUpdate({ target: [bookSourceCandidates.userId, bookSourceCandidates.bookId, bookSourceCandidates.sourceId, bookSourceCandidates.sourceFingerprint, bookSourceCandidates.bookUrl], set: { candidate: sql`excluded.candidate`, updatedAt: new Date() } })
      }
    })
  }

  public async saveEdition(userId: string, bookId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<StoredEdition> {
    return withUser(userId, async (transaction) => {
      const [book] = await transaction.select({ id: books.id }).from(books).where(and(eq(books.userId, userId), eq(books.id, bookId)))
      if (book === undefined) throw new Error('书籍不存在')
      await transaction.insert(bookEditions).values({ userId, bookId, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }).onConflictDoNothing({ target: [bookEditions.userId, bookEditions.editionKey] })
      const [edition] = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), eq(bookEditions.editionKey, input.editionKey)))
      if (edition === undefined) throw new Error('书籍版本已经属于其他书籍')
      return toEdition(edition)
    })
  }

  public async addToBookshelf(userId: string, bookId: string): Promise<void> {
    await withUser(userId, async (transaction) => { await transaction.insert(bookshelf).values({ userId, bookId }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] }) })
  }

  public async removeFromBookshelf(userId: string, bookId: string): Promise<void> {
    await withUser(userId, async (transaction) => { await transaction.delete(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, bookId))) })
  }

  public async isOnBookshelf(userId: string, bookId: string): Promise<boolean> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select({ bookId: bookshelf.bookId }).from(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, bookId))).limit(1)
      return rows.length > 0
    })
  }

  public async getHome(userId: string): Promise<HomeSnapshot> {
    return withUser(userId, async (transaction) => {
      const [settingsRow] = await transaction.select({ sort: sql<unknown>`${readerSettings.preferences}->'general'->>'bookshelfSort'` }).from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      const sortByReading = settingsRow?.sort === 'lastReadAt'
      const shelfRows = await transaction.select({ book: bookDisplayColumns, edition: { editionKey: bookEditions.editionKey }, addedAt: bookshelf.addedAt, groupId: bookshelf.groupId }).from(bookshelf).innerJoin(books, and(eq(books.userId, userId), eq(books.id, bookshelf.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(bookshelf.userId, userId)).orderBy(desc(bookshelf.addedAt))
      let sortedShelfRows = shelfRows
      if (sortByReading && shelfRows.length > 0) {
        const lastReadRows = await transaction.select({ bookId: readingRecords.bookId, lastReadAt: max(readingRecords.lastReadAt) }).from(readingRecords).where(and(eq(readingRecords.userId, userId), inArray(readingRecords.bookId, shelfRows.map((row) => row.book.id)))).groupBy(readingRecords.bookId)
        const lastReadByBookId = new Map<string, Date>()
        for (const row of lastReadRows) if (row.lastReadAt !== null) lastReadByBookId.set(row.bookId, row.lastReadAt)
        sortedShelfRows = [...shelfRows].sort((left, right) => {
          const leftReadAt = lastReadByBookId.get(left.book.id)
          const rightReadAt = lastReadByBookId.get(right.book.id)
          if (leftReadAt === undefined && rightReadAt !== undefined) return 1
          if (rightReadAt === undefined && leftReadAt !== undefined) return -1
          if (leftReadAt !== undefined && rightReadAt !== undefined && leftReadAt.getTime() !== rightReadAt.getTime()) return rightReadAt.getTime() - leftReadAt.getTime()
          return right.addedAt.getTime() - left.addedAt.getTime() || left.book.id.localeCompare(right.book.id)
        })
      }
      const readingRows = await transaction.select({ book: bookDisplayColumns, edition: { editionKey: bookEditions.editionKey }, position: { chapterId: readingRecords.chapterId, title: readingRecords.title, lastReadAt: readingRecords.lastReadAt } }).from(readingRecords).innerJoin(books, and(eq(books.userId, userId), eq(books.id, readingRecords.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, readingRecords.bookId), eq(bookEditions.editionKey, readingRecords.editionKey))).where(eq(readingRecords.userId, userId)).orderBy(desc(readingRecords.lastReadAt)).limit(50)
      const historyIdentityRows = await transaction.select({ id: searchHistory.id, keyword: searchHistory.keyword, createdAt: searchHistory.createdAt }).from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt))).orderBy(desc(searchHistory.createdAt), desc(searchHistory.id))
      const latestHistory = latestSearchHistory(historyIdentityRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))).slice(0, 50)
      const historyDetails = latestHistory.length === 0 ? [] : await transaction.select({ id: searchHistory.id, searchId: searchHistory.searchId, status: searchHistory.status, resultCount: searchHistory.resultCount, summary: searchHistory.summary, updatedAt: searchHistory.updatedAt }).from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt), inArray(searchHistory.id, latestHistory.map((row) => row.id))))
      const historyDetailsById = new Map(historyDetails.map((row) => [row.id, row]))
      const positions = new Map(readingRows.map((row) => [`${row.book.id}:${row.edition.editionKey}`, displayPosition(row.position)]))
      const shelf = sortedShelfRows.map((row) => { const book = displayBook(row.book); const edition = row.edition; const position = positions.get(`${row.book.id}:${edition.editionKey}`); return position === undefined ? { book, edition, groupId: row.groupId } : { book, edition, groupId: row.groupId, position } })
      const seenReadingBooks = new Set<string>()
      const reading = readingRows.filter((row) => { if (seenReadingBooks.has(row.book.id)) return false; seenReadingBooks.add(row.book.id); return true }).map((row) => ({ book: displayBook(row.book), edition: row.edition, position: displayPosition(row.position) }))
      const visibleHistory: HomeSearchHistory[] = latestHistory.flatMap((row) => {
        const details = historyDetailsById.get(row.id)
        return details === undefined ? [] : [{ ...row, searchId: details.searchId, status: details.status, resultCount: details.resultCount, ...(details.summary === null ? {} : { summary: details.summary }), updatedAt: details.updatedAt.toISOString() }]
      })
      return { bookshelf: shelf, reading, searchHistory: visibleHistory }
    })
  }

  public async getBackupSnapshot(userId: string): Promise<ReaderBackupSnapshot> {
    return withUser(userId, async (transaction) => readBackupSnapshot(transaction, userId))
  }

  public async restoreBackupSnapshot(userId: string, snapshot: ReaderBackupSnapshot, categories: readonly BackupCategory[]): Promise<void> {
    const selected = new Set(categories)
    assertBackupSnapshotClosed(snapshot, userId)
    if (selected.size === 0) throw new BackupRestoreError('至少选择一个恢复分类')
    await withUser(userId, async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId + ':book-organization'}, 0))`)
      await lockMarks(transaction, userId)
      snapshot = prepareOrganizationRestore(await readBackupSnapshot(transaction, userId), snapshot, selected)
      if (selected.has('sources')) await lockUserSourceMutations(transaction, userId)
      const bookIdMap = new Map<string, string>()
      const currentBookRows = selected.has('bookshelf') || selected.has('reading') ? await transaction.select({ id: books.id, userId: books.userId }).from(books).where(eq(books.userId, userId)) : []
      const existingBookIds = new Set(currentBookRows.map((row) => row.id))
      if (selected.has('bookshelf') && !selected.has('reading')) {
        const currentPositions = await transaction.select({ bookId: readingRecords.bookId, editionKey: readingRecords.editionKey }).from(readingRecords).where(eq(readingRecords.userId, userId))
        const incomingEditions = new Set(snapshot.books.flatMap((item) => item.editions.map((edition) => `${item.book.id}\u0000${edition.editionKey}`)))
        const missing = currentPositions.filter((position) => !incomingEditions.has(`${position.bookId}\u0000${position.editionKey}`))
        if (missing.length > 0) throw new BackupRestoreError(`未选择阅读记录，但书架替换会使现有阅读记录失去依赖：${missing[0]?.bookId ?? ''}`)
      }
      if (selected.has('bookshelf')) {
        const incomingIds = snapshot.books.map((item) => item.book.id)
        const occupiedRows = incomingIds.length === 0 ? [] : await transaction.select({ id: books.id, userId: books.userId }).from(books).where(inArray(books.id, incomingIds))
        const occupiedById = new Map(occupiedRows.map((row) => [row.id, row.userId]))
        for (const item of snapshot.books) bookIdMap.set(item.book.id, occupiedById.get(item.book.id) === undefined || occupiedById.get(item.book.id) === userId ? item.book.id : randomUUID())
      } else if (selected.has('reading')) {
        for (const item of snapshot.books) if (existingBookIds.has(item.book.id)) bookIdMap.set(item.book.id, item.book.id)
      }
      if (selected.has('bookshelf')) {
        if (selected.has('reading')) await transaction.delete(readingRecords).where(eq(readingRecords.userId, userId))
        await transaction.delete(chapterContents).where(eq(chapterContents.userId, userId))
        await transaction.delete(tocSnapshots).where(eq(tocSnapshots.userId, userId))
        await transaction.delete(bookSourceCandidates).where(eq(bookSourceCandidates.userId, userId))
        await transaction.delete(bookEditions).where(eq(bookEditions.userId, userId))
        await transaction.delete(bookshelf).where(eq(bookshelf.userId, userId))
        await transaction.delete(books).where(eq(books.userId, userId))
        for (const item of snapshot.books) {
          const targetBookId = bookIdMap.get(item.book.id)
          if (targetBookId === undefined) throw new BackupRestoreError(`书籍映射失败：${item.book.id}`)
          await transaction.insert(books).values({ id: targetBookId, userId, name: item.book.name, ...(item.book.author === undefined ? {} : { author: item.book.author }), ...(item.book.intro === undefined ? {} : { intro: item.book.intro }), ...(item.book.coverUrl === undefined ? {} : { coverUrl: item.book.coverUrl }), ...(item.book.customCoverUrl === undefined ? {} : { customCoverUrl: item.book.customCoverUrl }), ...(item.book.activeEditionKey === undefined ? {} : { activeEditionKey: item.book.activeEditionKey }), createdAt: new Date(item.book.createdAt), updatedAt: new Date(item.book.updatedAt) })
          for (const edition of item.editions) await transaction.insert(bookEditions).values({ id: randomUUID(), userId, bookId: targetBookId, editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, metadata: edition.metadata, ...(edition.variable === undefined ? {} : { variable: edition.variable }), createdAt: new Date(item.book.createdAt), updatedAt: new Date(item.book.updatedAt) })
          for (const candidate of item.candidates) await transaction.insert(bookSourceCandidates).values({ id: randomUUID(), userId, bookId: targetBookId, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.bookUrl, candidate: candidate.candidate, updatedAt: new Date(candidate.updatedAt) })
        }
      }
      if (selected.has('bookshelf')) {
        for (const item of snapshot.bookshelf) {
          const bookId = bookIdMap.get(item.bookId)
          if (bookId === undefined) throw new BackupRestoreError(`书架缺少书籍：${item.bookId}`)
          await transaction.insert(bookshelf).values({ userId, bookId, addedAt: new Date(item.addedAt), groupId: item.groupId ?? null }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] })
        }
      }
      if (selected.has('reading')) {
        const missingBooks = [...new Set([...snapshot.positions, ...(snapshot.bookmarks ?? []), ...(snapshot.annotations ?? [])].map((position) => position.bookId))].filter((bookId) => !bookIdMap.has(bookId))
        if (missingBooks.length > 0) throw new BackupRestoreError(`阅读记录依赖的书籍不存在，请同时选择书架：${missingBooks.join('、')}`)
        if (!selected.has('bookshelf')) {
          const existingEditions = await transaction.select({ bookId: bookEditions.bookId, editionKey: bookEditions.editionKey }).from(bookEditions).where(eq(bookEditions.userId, userId))
          const available = new Set(existingEditions.map((item) => `${item.bookId}\u0000${item.editionKey}`))
          const unavailable = [...new Set([...snapshot.positions, ...(snapshot.bookmarks ?? []), ...(snapshot.annotations ?? [])].map((position) => `${bookIdMap.get(position.bookId)}\u0000${position.editionKey}`))].filter((key) => !available.has(key))
          if (unavailable.length > 0) throw new BackupRestoreError('阅读记录依赖的书籍版本不存在，请同时选择书架')
        }
        if (!selected.has('bookshelf')) await transaction.delete(readingRecords).where(eq(readingRecords.userId, userId))
        for (const position of snapshot.positions) {
          const bookId = bookIdMap.get(position.bookId)
          if (bookId === undefined) continue
          await transaction.insert(readingRecords).values({ id: randomUUID(), userId, bookId, editionKey: position.editionKey, chapterId: position.chapterId, chapterUrl: position.chapterUrl, chapterIndex: position.chapterIndex, title: position.title, ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }), paragraphIndex: position.paragraphIndex, offset: position.offset, version: position.version, lastReadAt: new Date(position.lastReadAt) }).onConflictDoUpdate({ target: [readingRecords.userId, readingRecords.bookId, readingRecords.editionKey], set: { chapterId: position.chapterId, chapterUrl: position.chapterUrl, chapterIndex: position.chapterIndex, title: position.title, tocRevision: position.tocRevision ?? null, paragraphIndex: position.paragraphIndex, offset: position.offset, version: position.version, lastReadAt: new Date(position.lastReadAt) } })
        }
      }
      if (selected.has('reading')) {
        for (const kind of ['bookmarks', 'annotations'] as const) if (snapshot[kind] !== undefined) await restoreMarks(transaction, userId, kind, snapshot[kind]!.map((row) => ({ ...row, userId, bookId: bookIdMap.get(row.bookId) ?? row.bookId })))
      }
      if (selected.has('search')) {
        await transaction.delete(searchHistory).where(eq(searchHistory.userId, userId))
        for (const item of snapshot.searchHistory) {
          await transaction.insert(searchHistory).values({ id: isUuid(item.id) ? item.id : randomUUID(), userId, searchId: isUuid(item.searchId) ? item.searchId : randomUUID(), keyword: item.keyword, sourceIds: item.sourceIds, status: item.status, resultCount: item.resultCount, ...(item.summary === undefined ? {} : { summary: item.summary }), createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) })
        }
      }
      if (selected.has('sources')) {
        await importHistory.lockSourceMutations(transaction, userId)
        const identities = new Map((await transaction.select({ sourceId: userSources.sourceId, sourceUuid: userSources.sourceUuid }).from(userSources).where(eq(userSources.userId, userId))).map((row) => [row.sourceId, row.sourceUuid]))
        await transaction.update(sourceImportBatches).set({ invalidatedAt: new Date(), invalidatedReason: '备份恢复后不可撤销' }).where(eq(sourceImportBatches.userId, userId))
        await transaction.delete(userSources).where(eq(userSources.userId, userId))
        await transaction.delete(sourceRuntimeState).where(eq(sourceRuntimeState.userId, userId))
        for (const item of snapshot.sources) {
          const normalized = { ...item.source.normalizedSource, enabled: item.source.enabled }
          await transaction.insert(userSources).values({ userId, sourceUuid: identities.get(item.source.sourceId) ?? randomUUID(), sourceId: item.source.sourceId, fingerprint: item.source.fingerprint, rawSource: item.source.rawSource, normalizedSource: normalized, enabled: item.source.enabled, customOrder: readInteger((normalized as Record<string, unknown>).customOrder, 0), deleted: item.deleted === true, revision: randomUUID(), updatedAt: new Date() })
        }
      }
      if (selected.has('bookshelf') && snapshot.organization) {
        await transaction.delete(bookListItems).where(eq(bookListItems.userId, userId))
        await transaction.delete(bookLists).where(eq(bookLists.userId, userId))
        for (const row of snapshot.organization.lists) await transaction.insert(bookLists).values({ ...row, userId, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) })
        for (const row of snapshot.organization.items) await transaction.insert(bookListItems).values({ ...row, userId, bookId: bookIdMap.get(row.bookId) ?? row.bookId, addedAt: new Date(row.addedAt), updatedAt: new Date(row.updatedAt) })
      }
      if (selected.has('settings') || selected.has('bookshelf')) {
        const values = readerSettingsValues(userId, snapshot.settings, new Date(snapshot.settings.updatedAt))
        await transaction.insert(readerSettings).values(values).onConflictDoUpdate({ target: readerSettings.userId, set: { preferences: values.preferences, updatedAt: values.updatedAt } })
      }
    })
  }

  public async deleteSearchHistory(userId: string, historyId: string): Promise<boolean> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt)))
      const target = rows.find((row) => row.id === historyId)
      if (target === undefined) return false
      const ids = rows.filter((row) => normalizeIdentity(row.keyword) === normalizeIdentity(target.keyword)).map((row) => row.id)
      // 删除整组展示历史，避免旧请求记录在去重后重新出现；搜索任务仍保留。
      await transaction.update(searchHistory).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(searchHistory.userId, userId), inArray(searchHistory.id, ids)))
      return true
    })
  }

  public async listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select({ book: books, edition: bookEditions }).from(books).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(books.userId, userId)).orderBy(desc(books.updatedAt))
      return rows.map((row) => ({ book: toBook(row.book), edition: toEdition(row.edition) }))
    })
  }

  public async getBook(userId: string, bookId: string): Promise<StoredBook | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(books).where(and(eq(books.userId, userId), eq(books.id, bookId))).limit(1)
      return row === undefined ? null : toBook(row)
    })
  }

  public async listEditions(userId: string, bookId: string): Promise<StoredEdition[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId))).orderBy(desc(bookEditions.updatedAt), asc(bookEditions.createdAt))
      return rows.map(toEdition)
    })
  }

  public async activateEdition(userId: string, bookId: string, editionKey: string) {
    return withUser(userId, async (tx) => {
      const [row] = await tx.update(books).set({ activeEditionKey: editionKey, updatedAt: new Date() }).where(and(eq(books.userId, userId), eq(books.id, bookId), sql`exists (select 1 from ${bookEditions} where ${bookEditions.userId} = ${userId} and ${bookEditions.bookId} = ${bookId} and ${bookEditions.editionKey} = ${editionKey})`)).returning({ editionKey: books.activeEditionKey })
      return row?.editionKey ? { editionKey: row.editionKey } : null
    })
  }
  public async getEditionSource(userId: string, bookId: string, editionKey: string) {
    return withUser(userId, async (tx) => {
      const [row] = await tx.select({ sourceId: bookEditions.sourceId, sourceFingerprint: bookEditions.sourceFingerprint }).from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), eq(bookEditions.editionKey, editionKey))).limit(1)
      return row ?? null
    })
  }
  public async getContentDisplay(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<CachedReadingContent | null> {
    return withUser(userId, async (tx) => {
      const [row] = await tx.select({ sourceFingerprint: chapterContents.sourceFingerprint, tocRevision: chapterContents.tocRevision,
        content: sql<CachedReadingContent['content']>`jsonb_strip_nulls(jsonb_build_object(
          'chapter', jsonb_build_object('chapterId', ${chapterId}, 'chapterUrl', ${chapterContents.content}->'chapter'->'chapterUrl', 'index', ${chapterContents.content}->'chapter'->'index', 'title', ${chapterContents.content}->'chapter'->'title'),
          'contentType', ${chapterContents.content}->'contentType', 'cleaned', ${chapterContents.content}->'cleaned', 'resources', ${chapterContents.content}->'resources', 'finalUrl', ${chapterContents.content}->'finalUrl'
        ))`, truncated: sql<boolean>`${chapterContents.content}->'truncated' = 'true'::jsonb`,
      }).from(chapterContents).where(and(eq(chapterContents.userId, userId), eq(chapterContents.editionKey, editionKey), eq(chapterContents.tocRevision, tocRevision), eq(chapterContents.chapterId, chapterId))).limit(1)
      return row === undefined ? null : { ...row, truncated: row.truncated === true }
    })
  }

  public async setActiveEdition(userId: string, bookId: string, editionKey: string): Promise<StoredEdition | null> {
    return withUser(userId, async (transaction) => {
      const [edition] = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), eq(bookEditions.editionKey, editionKey))).limit(1)
      if (edition === undefined) return null
      await transaction.update(books).set({ activeEditionKey: editionKey, updatedAt: new Date() }).where(and(eq(books.userId, userId), eq(books.id, bookId)))
      return toEdition(edition)
    })
  }

  public async getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null> {
    return withUser(userId, async (transaction) => {
      const conditions = [eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), ...(editionKey === undefined ? [] : [eq(bookEditions.editionKey, editionKey)])]
      const [row] = await transaction.select().from(bookEditions).where(and(...conditions)).orderBy(desc(bookEditions.updatedAt)).limit(1)
      return row === undefined ? null : toEdition(row)
    })
  }

  public async getChapterContext(userId: string, bookId: string, editionKey: string, chapterId: string, display?: boolean): Promise<ChapterContext | null> {
    return withUser(userId, async (tx) => {
      // NUL 分隔符以 bytea 拼接，保持与 Node SHA-256 的 UTF-8 输入完全一致。
      const rows = await tx.execute(sql`
        select t.revision, t.source_fingerprint as "sourceFingerprint", c.chapter,
          t.chapters -> (c.ordinality::int) ->> 'chapterUrl' as "nextChapterUrl"
        from ${tocSnapshots} t
        left join lateral (
          select ${display ? sql`jsonb_strip_nulls(jsonb_build_object('sourceId', item->'sourceId', 'bookUrl', item->'bookUrl', 'chapterUrl', item->'chapterUrl', 'index', item->'index', 'title', item->'title'))` : sql`item`} as chapter, ordinality
          from jsonb_array_elements(t.chapters) with ordinality as entries(item, ordinality)
          where encode(sha256(convert_to(item->>'chapterUrl', 'UTF8') || decode('00', 'hex') || convert_to(item->>'index', 'UTF8')), 'hex') = ${chapterId}
          order by ordinality limit 1
        ) c on true
        where t.user_id = ${userId} and t.book_id = ${bookId} and t.edition_key = ${editionKey}
        limit 1
      `)
      const row = rows[0]
      return row === undefined ? null : { revision: row.revision as string, sourceFingerprint: row.sourceFingerprint as string, ...(row.chapter === null ? {} : { chapter: row.chapter as Chapter }), ...(row.nextChapterUrl === null ? {} : { nextChapterUrl: row.nextChapterUrl as string }) }
    })
  }

  public async getTocSummary(userId: string, bookId: string, editionKey: string): Promise<CachedTocSummary | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select({
        bookId: tocSnapshots.bookId, editionKey: tocSnapshots.editionKey,
        sourceFingerprint: tocSnapshots.sourceFingerprint, revision: tocSnapshots.revision, truncated: tocSnapshots.truncated,
        chapters: sql<CachedTocSummary['chapters']>`(
          select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'chapterId', encode(sha256(convert_to(item->>'chapterUrl', 'UTF8') || decode('00', 'hex') || convert_to(item->>'index', 'UTF8')), 'hex'),
            'chapterUrl', item->'chapterUrl', 'index', item->'index', 'title', item->'title',
            'isVolume', item->'isVolume', 'isVip', item->'isVip'
          )) order by ordinality), '[]'::jsonb)
          from jsonb_array_elements(${tocSnapshots.chapters}) with ordinality as entries(item, ordinality)
        )`,
      }).from(tocSnapshots).where(and(eq(tocSnapshots.userId, userId), eq(tocSnapshots.bookId, bookId), eq(tocSnapshots.editionKey, editionKey))).limit(1)
      return row ?? null
    })
  }

  public async getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(tocSnapshots).where(and(eq(tocSnapshots.userId, userId), eq(tocSnapshots.bookId, bookId), eq(tocSnapshots.editionKey, editionKey))).limit(1)
      return row === undefined ? null : toToc(row)
    })
  }

  public async saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.insert(tocSnapshots).values({
        userId,
        bookId: toc.bookId,
        editionKey: toc.editionKey,
        sourceFingerprint: toc.sourceFingerprint,
        revision: toc.revision,
        chapters: toc.chapters,
        bookPatch: toc.bookPatch,
        truncated: toc.truncated === true,
        ...(toc.bookAfter === undefined ? {} : { bookAfter: toc.bookAfter }),
        updatedAt: new Date(),
      }).onConflictDoUpdate({ target: [tocSnapshots.userId, tocSnapshots.editionKey], set: {
        sourceFingerprint: toc.sourceFingerprint,
        revision: toc.revision,
        chapters: toc.chapters,
        bookPatch: toc.bookPatch,
        truncated: toc.truncated === true,
        ...(toc.bookAfter === undefined ? {} : { bookAfter: toc.bookAfter }),
        updatedAt: new Date(),
      } }).returning()
      if (row === undefined) throw new Error('保存目录失败')
      return toToc(row)
    })
  }

  public async getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(chapterContents).where(and(eq(chapterContents.userId, userId), eq(chapterContents.editionKey, editionKey), eq(chapterContents.tocRevision, tocRevision), eq(chapterContents.chapterId, chapterId))).limit(1)
      return row === undefined ? null : toContent(row)
    })
  }

  public async saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.insert(chapterContents).values({
        userId,
        bookId: content.bookId,
        editionKey: content.editionKey,
        chapterId: content.chapterId,
        tocRevision: content.tocRevision,
        sourceFingerprint: content.sourceFingerprint,
        content: content.content,
        updatedAt: new Date(),
      }).onConflictDoUpdate({ target: [chapterContents.userId, chapterContents.editionKey, chapterContents.tocRevision, chapterContents.chapterId], set: { content: content.content, sourceFingerprint: content.sourceFingerprint, updatedAt: new Date() } }).returning()
      if (row === undefined) throw new Error('保存正文失败')
      return toContent(row)
    })
  }

  public async getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(readingRecords).where(and(eq(readingRecords.userId, userId), eq(readingRecords.bookId, bookId), eq(readingRecords.editionKey, editionKey))).limit(1)
      return row === undefined ? null : toPosition(row)
    })
  }

  public async savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.insert(readingRecords).values({
        userId,
        bookId: position.bookId,
        editionKey: position.editionKey,
        chapterId: position.chapterId,
        chapterUrl: position.chapterUrl,
        chapterIndex: position.chapterIndex,
        title: position.title,
        ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }),
        paragraphIndex: position.paragraphIndex,
        offset: position.offset,
        version: position.version,
        ...(position.lastReadAt === undefined ? {} : { lastReadAt: new Date(position.lastReadAt) }),
      }).onConflictDoUpdate({ target: [readingRecords.userId, readingRecords.bookId, readingRecords.editionKey], set: {
        chapterId: position.chapterId,
        chapterUrl: position.chapterUrl,
        chapterIndex: position.chapterIndex,
        title: position.title,
        ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }),
        paragraphIndex: position.paragraphIndex,
        offset: position.offset,
        version: position.version,
        ...(position.lastReadAt === undefined ? { lastReadAt: new Date() } : { lastReadAt: new Date(position.lastReadAt) }),
      } }).returning()
      if (row === undefined) throw new Error('保存阅读位置失败')
      return toPosition(row)
    })
  }
}

export class MemoryReaderRepository implements ReaderRepository {
  public async listBookListSummaries(userId: string, query = '', bookId?: string, picker = false) {
    const organization = await this.getBookOrganization(userId)
    return Promise.all(organization.lists.filter((row) => row.type === 'booklist' && row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map(async (row) => {
      const members = organization.items.filter((item) => item.bookListId === row.id).sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.bookId.localeCompare(a.bookId))
      const { id, name, description, createdAt, updatedAt } = row
      const coverBooks = picker ? [] : (await Promise.all(members.slice(0, 4).map((item) => this.getBook(userId, item.bookId)))).flatMap((book) => book ? [{ id: book.id, name: book.name, ...(book.coverUrl === undefined ? {} : { coverUrl: book.coverUrl }), ...(book.customCoverUrl === undefined ? {} : { customCoverUrl: book.customCoverUrl }) }] : [])
      return { id, name, description, ...(picker ? {} : { createdAt, updatedAt }), bookCount: members.length, containsBook: members.some((item) => item.bookId === bookId), ...(picker ? {} : { coverBooks }) }
    }))
  }
  public async getBookListDetails(userId: string, listId: string): Promise<BookListDetails | null> {
    const organization = await this.getBookOrganization(userId, listId)
    const list = organization.lists.find((row) => row.type === 'booklist')
    if (!list) return null
    const { id, name, description, createdAt, updatedAt } = list
    const items = (await Promise.all(organization.items.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.bookId.localeCompare(a.bookId)).map(async (row) => {
      const book = await this.getBook(userId, row.bookId)
      return book ? { bookId: row.bookId, description: row.description, addedAt: row.addedAt, book: displayBook(book) } : null
    }))).filter((row) => row !== null)
    return { list: { id, name, description, createdAt, updatedAt }, items }
  }
  public async getShelfGroups(userId: string, bookId?: string) {
    const organization = await this.getBookOrganization(userId, undefined, false)
    const shelfKeys = [...this.shelf.keys()].filter((key) => key.startsWith(userId + ':'))
    const groups = organization.lists.filter((row) => row.type === 'shelf_group').sort((a, b) => a.customOrder - b.customOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((row) => ({ id: row.id, name: row.name, bookCount: shelfKeys.filter((key) => this.shelfGroups.get(key) === row.id).length }))
    return { groups, ungroupedCount: shelfKeys.filter((key) => !this.shelfGroups.get(key)).length, ...(bookId ? { onBookshelf: this.shelf.has(`${userId}:${bookId}`), currentGroupId: this.shelfGroups.get(`${userId}:${bookId}`) ?? null } : {}) }
  }
  public async listBookIdentities(userId: string) {
    const rows = [...new Map([...this.books.values()].filter((entry) => entry.book.userId === userId).map(({ book }) => [book.id, book])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return rows.map(({ id, name, author }) => ({ id, name, ...(author === undefined ? {} : { author }), onBookshelf: this.shelf.has(`${userId}:${id}`) }))
  }
  public async getBookReadingInfo(userId: string, bookId: string, editionKey?: string): Promise<BookReadingInfo | null> {
    const book = await this.getBook(userId, bookId)
    if (book === null) return null
    const edition = await this.getEdition(userId, bookId, editionKey || book.activeEditionKey)
    if (edition === null) return null
    return { book: { id: book.id, name: book.name, ...(book.author === undefined ? {} : { author: book.author }), ...(book.activeEditionKey === undefined ? {} : { activeEditionKey: book.activeEditionKey }) },
      edition: { editionKey: edition.editionKey, ...(typeof edition.metadata.name === 'string' ? { name: edition.metadata.name } : {}) } }
  }
  public async getReadingEntry(userId: string, bookId: string) { const book = await this.getBook(userId, bookId); return book ? { activeEditionKey: book.activeEditionKey ?? null } : null }
  public async listEditionOptions(userId: string, bookId: string) {
    return Promise.all((await this.listEditions(userId, bookId)).map(async (edition) => ({ editionKey: edition.editionKey, sourceId: edition.sourceId, sourceName: await this.getSourceDisplayName(userId, edition.sourceId) ?? edition.sourceId })))
  }
  public async getDisplayEdition(userId: string, bookId: string, editionKey?: string) {
    const edition = await this.getEdition(userId, bookId, editionKey)
    if (!edition) return null
    const metadata = Object.fromEntries(Object.entries(edition.metadata).filter(([key]) => ['name', 'author', 'intro', 'coverUrl', 'kind', 'lastChapter', 'updateTime', 'wordCount', 'searchDurationMs'].includes(key))) as BookDetailsResponse['edition']['metadata']
    return { editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, metadata }
  }
  public async getDisplayPosition(userId: string, bookId: string, editionKey: string) { const row = await this.getPosition(userId, bookId, editionKey); return row ? { title: row.title, lastReadAt: row.lastReadAt } : null }
  public async listReadingMarkBooks(userId: string) {
    const referenced = new Set([...this.readingMarks.entries()].filter(([key]) => key.startsWith(userId + ':annotations:')).map(([, row]) => row.bookId))
    return [...new Map([...this.books.values()].filter(({ book }) => book.userId === userId && referenced.has(book.id)).map(({ book }) => [book.id, { id: book.id, name: book.name, author: book.author ?? null, activeEditionKey: book.activeEditionKey ?? null }])).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  private readonly readingMarks = new Map<string, ReadingMark>()
  public async listReadingMarks(userId: string, query: MarkQuery) {
    const books = new Map([...this.books.values()].filter(({ book }) => book.userId === userId).map(({ book }) => [book.id, book]))
    return structuredClone(markPage([...this.readingMarks.entries()].filter(([key]) => key.startsWith(userId + ':' + query.kind + ':')).map(([, row]) => { const book = books.get(row.bookId); return book ? { ...row, bookName: book.name, author: book.author ?? null } : row }), query))
  }
  public async listReaderMarks(userId: string, query: MarkQuery) { const page = await this.listReadingMarks(userId, { ...query, deleted: false }); return page.items.map((item) => ({ ...readerMark(item), ...(query.id ? { sourceName: item.sourceName } : {}) })) }
  public async listReadingMarkSummaries(userId: string, query: MarkQuery) { const page = await this.listReadingMarks(userId, query); return { ...page, items: page.items.map(markListItem) } }
  public async getCachedMarkChapter(userId: string, bookId: string, id: string) { const row = this.readingMarks.get(userId + ':annotations:' + id); return row?.bookId === bookId ? structuredClone({ cachedChapter: row.cachedChapter }) : null }
  public async mutateReadingMark(userId: string, command: MarkCommand) {
    const rows = [...this.readingMarks.entries()].filter(([key]) => key.startsWith(userId + ':' + command.kind + ':')).map(([, row]) => row)
    const next = changeMark(rows, userId, command)
    this.readingMarks.set(userId + ':' + command.kind + ':' + next.id, structuredClone(next))
    return structuredClone(next)
  }
  public async purgeReadingMark(userId: string, kind: MarkKind, bookId: string, id: string, expectedVersion: number) {
    const key = userId + ':' + kind + ':' + id
    const current = this.readingMarks.get(key)
    if (!current || current.bookId !== bookId) throw new MarkError(404, '记录不存在')
    if (current.version !== expectedVersion) throw new MarkError(409, '记录已修改，请重新加载')
    if (current.deletedAt === null) throw new MarkError(409, '只能彻底删除已删除的笔记')
    this.readingMarks.delete(key)
  }

  public async getOrganizationLibrary(userId: string, bookIds?: string[], includePositions?: boolean) {
    const rows = new Map<string, { book: StoredBook; editions: StoredEdition[] }>()
    for (const entry of this.books.values()) if (entry.book.userId === userId && (bookIds === undefined || bookIds.includes(entry.book.id))) { const row = rows.get(entry.book.id) ?? { book: entry.book, editions: [] }; row.editions.push(entry.edition); rows.set(entry.book.id, row) }
    return structuredClone({ books: [...rows.values()], positions: includePositions === false ? [] : [...this.positions.values()].filter((row) => row.userId === userId && (bookIds === undefined || bookIds.includes(row.bookId))), bookshelf: [...this.shelf.keys()].filter((key) => key.startsWith(userId + ':')).map((key) => ({ bookId: key.slice(userId.length + 1), groupId: this.shelfGroups.get(key) ?? null })) })
  }

  private readonly organizations = new Map<string, BookListOrganizationSnapshot>()
  private readonly shelfGroups = new Map<string, string | null>()
  public async getBookOrganization(userId: string, listId?: string, includeItems = true): Promise<BookListOrganizationSnapshot> { const value = this.organizations.get(userId) ?? { lists: [], items: [] }; return structuredClone({ lists: value.lists.filter((row) => !listId || row.id === listId), items: includeItems ? value.items.filter((row) => !listId || row.bookListId === listId) : [] }) }
  public async mutateBookOrganization(userId: string, command: OrganizationCommand): Promise<BookListOrganizationSnapshot> {
    // 在同步段内校验并提交，内存实现与数据库事务保持相同的失败语义。
    const before = structuredClone(this.organizations.get(userId) ?? { lists: [], items: [] })
    const shelf = new Map([...this.shelf.keys()].filter((key) => key.startsWith(userId + ':')).map((key) => [key.slice(userId.length + 1), this.shelfGroups.get(key) ?? null]))
    const state = { ...before, shelf, bookIds: new Set([...this.books.values()].filter((row) => row.book.userId === userId).map((row) => row.book.id)) }
    applyOrganizationCommand(state, userId, command)
    this.organizations.set(userId, { lists: state.lists, items: state.items })
    for (const key of this.shelf.keys()) if (key.startsWith(userId + ':')) {
      const bookId = key.slice(userId.length + 1)
      if (!state.shelf.has(bookId)) { this.shelf.delete(key); this.shelfGroups.delete(key) }
      else this.shelfGroups.set(key, state.shelf.get(bookId) ?? null)
    }
    if (command.kind === 'delete' && command.type === 'shelf_group') {
      const current = this.settings.get(userId)
      if (current?.general.bookshelfInitialGroup === command.id) this.settings.set(userId, { ...current, general: { ...current.general, bookshelfInitialGroup: 'all' } })
    }
    return structuredClone({ lists: state.lists, items: state.items })
  }

  private readonly userSourceMap = new Map<string, { source: StoredSourceRecord; deleted: boolean; revision: string }>()
  private readonly importPreviews = new Map<string, { userId: string; sourceUrl: string; preview: ImportPreview; consumedIds: string[]; result?: ImportConfirmResult }>()
  private readonly runtimeStates = new Map<string, { snapshot: RuntimeStateSnapshot; version: number; leaseToken: string | null; leaseUntil: number | null }>()
  private readonly searchLeases = new Map<string, number>()
  private readonly searches = new Map<string, SearchRunState>()
  private readonly books = new Map<string, { book: StoredBook; edition: StoredEdition }>()
  private readonly tocs = new Map<string, StoredToc>()
  private readonly contents = new Map<string, StoredContent>()
  private readonly positions = new Map<string, StoredPosition>()
  private readonly shelf = new Map<string, string>()
  private readonly history = new Map<string, SearchHistoryItem>()
  private readonly sourceCandidates = new Map<string, StoredBookSourceCandidate>()
  private readonly settings = new Map<string, ReaderSettings>()

  private readonly importHistory = new MemoryImportHistory(this.userSourceMap,
    (userId, sourceId) => this.runtimeEntriesForSource(userId, sourceId).some(([, value]) => (value.leaseUntil ?? 0) > Date.now()),
    (userId, sourceId) => { for (const [key] of this.runtimeEntriesForSource(userId, sourceId)) this.runtimeStates.delete(key) })
  public async acquireExecutionSlot(userId: string, _operationId: string) { return acquireMemoryExecutionSlot(userId) }
  public async releaseExecutionSlot(userId: string, lease: ExecutionLease) { releaseMemoryExecutionSlot(userId, lease) }
  public async listImportLinks(userId: string) { return this.importHistory.readLinks(userId) }
  public async orderImportLinks(userId: string, ids: string[], revision: string) { return this.importHistory.order(userId, ids, revision) }
  public async listImportHistory(userId: string, query: ImportHistoryQuery) { return this.importHistory.history(userId, query) }
  public async listImportItems(userId: string, batchId: string, query: ImportHistoryQuery) { return this.importHistory.items(userId, batchId, query) }
  public async previewImportUndo(userId: string, batchId: string, ids?: string[]) { return this.importHistory.preview(userId, batchId, ids) }
  public async undoImport(userId: string, batchId: string, input: UndoImportInput) { return this.importHistory.undo(userId, batchId, input) }
  private withPriority(userId: string, sources: StoredSourceRecord[]) { const priorities = new Map(this.importHistory.readLinks(userId).links.map((row) => [row.id, row.sortOrder])); return sources.map((source) => ({ ...source, sourceRevision: this.sourceRevision(userId, source.sourceId), priority: priorities.get(source.importLinkId ?? '') ?? Number.MAX_SAFE_INTEGER })).sort(compareSourcePriority) }
  public async listSourceSummaries(userId: string, sourceIds?: string[]): Promise<SourceListRecord[]> {
    const sources = sourceIds === undefined ? await this.listSourcesForUser(userId) : this.withPriority(userId, this.allSources(userId).filter((source) => sourceIds.includes(source.sourceId)))
    return sources.map((source) => ({ sourceId: source.sourceId, name: source.name, ...(source.group === undefined ? {} : { group: source.group }), fingerprint: source.fingerprint, enabled: source.enabled, ...(source.sourceUuid === undefined ? {} : { sourceUuid: source.sourceUuid }), ...(source.importLinkId === undefined ? {} : { importLinkId: source.importLinkId }), ...(source.sourceRevision === undefined ? {} : { sourceRevision: source.sourceRevision }), ...(source.priority === undefined ? {} : { priority: source.priority }), customOrder: readInteger(source.normalizedSource.customOrder, 0), canExplore: source.normalizedSource.enabledExplore !== false && typeof source.normalizedSource.exploreUrl === 'string' && source.normalizedSource.exploreUrl.trim().length > 0 }))
  }
  public async listSourcesForUser(userId: string): Promise<StoredSourceRecord[]> { return this.withPriority(userId, selectOneSourcePerDomain(this.allSources(userId).filter((source) => source.enabled), compareStoredSourceManagementOrder)) }
  public async listAllSourcesForUser(userId: string): Promise<StoredSourceRecord[]> { return this.withPriority(userId, this.allSources(userId)) }
  public async listSourceStatesForUser(userId: string): Promise<Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>> { return this.allSourceStates(userId).map(({ source, deleted }) => ({ source, sourceRevision: this.sourceRevision(userId, source.sourceId), deleted })) }
  public async getSourceForUser(userId: string, sourceId: string): Promise<StoredSourceRecord | null> { const row = this.userSourceMap.get(`${userId}:${sourceId}`); if (!row || row.deleted || !row.source.enabled) return null; const priority = this.importHistory.links.get(userId)?.find((link) => link.id === row.source.importLinkId)?.sortOrder ?? Number.MAX_SAFE_INTEGER; return { ...row.source, sourceRevision: row.revision, priority } }
  public async getSourceDisplayName(userId: string, sourceId: string): Promise<string | undefined> { return this.allSources(userId).find((source) => source.sourceId === sourceId)?.normalizedSource.bookSourceName }
  public async getSourceManagementStats(userId: string): Promise<SourceManagementStats> {
    return sourceManagementStats(this.allSources(userId))
  }
  public async listManagedSources(userId: string, params: { page: number; pageSize: number; query: string; status: SourceManagementStatus; all?: boolean; domain?: string | undefined; sourceIds?: string[] }): Promise<SourceManagementPage> {
    const query = params.query.toLocaleLowerCase()
    const allRows = this.allSources(userId)
    const enabledCount = allRows.filter((source) => source.enabled).length
    const rows = allRows.filter((source) => {
      const matchesQuery = query.length === 0 || `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(query)
      return matchesQuery && (params.domain === undefined || sourceDomainInfo(source.sourceId).key === sourceDomainInfo(params.domain).key) && (params.sourceIds === undefined || params.sourceIds.includes(source.sourceId)) && (params.status === 'all' || (params.status === 'enabled' ? source.enabled : !source.enabled))
    }).sort((a, b) => readInteger(a.normalizedSource.customOrder, 0) - readInteger(b.normalizedSource.customOrder, 0) || a.name.localeCompare(b.name, 'zh-Hans') || a.sourceId.localeCompare(b.sourceId))
    const offset = (params.page - 1) * params.pageSize
    return { sources: (params.all === true ? rows : rows.slice(offset, offset + params.pageSize)).map((source) => ({ ...managedSummary(source, this.sourceRevision(userId, source.sourceId), 'account'), ...this.importHistory.sourceMetadata(userId, source) })), page: params.all === true ? 1 : params.page, pageSize: params.all === true ? Math.max(1, rows.length) : params.pageSize, total: rows.length, enabledCount }
  }
  public async applySourceActions(userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }> {
    const seen = new Set<string>()
    const enabledDomains = new Set<string>()
    const updates: Array<{ source: StoredSourceRecord; deleted: boolean }> = []
    for (const item of items) {
      if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '操作列表包含重复书源')
      seen.add(item.sourceId)
      const domainKey = sourceDomainInfo(item.sourceId).key
      if (action === 'enable') {
        if (enabledDomains.has(domainKey)) throw new SourceManagementError('source-conflict', '同一域名只能启用一个书源版本')
        enabledDomains.add(domainKey)
      }
      const source = await this.getSourceForManagement(userId, item.sourceId)
      if (source === undefined) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
      if (this.sourceRevision(userId, item.sourceId) !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
      if (action === 'delete' && this.runtimeEntriesForSource(userId, item.sourceId).some(([, state]) => state.leaseToken !== null && (state.leaseUntil ?? 0) > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${item.sourceId}`)
      updates.push({ source, deleted: action === 'delete' })
    }
    if (action === 'enable') {
      const targetIds = new Set(items.map((item) => item.sourceId))
      for (const sibling of this.allSources(userId)) {
        if (!sibling.enabled || targetIds.has(sibling.sourceId) || !enabledDomains.has(sourceDomainInfo(sibling.sourceId).key)) continue
        const key = `${userId}:${sibling.sourceId}`
        const record = this.userSourceMap.get(key)
        if (record !== undefined && !record.deleted) this.userSourceMap.set(key, { ...record, source: { ...record.source, enabled: false }, revision: randomUUID() })
      }
    }
    for (const update of updates) {
      if (update.deleted) for (const [key] of this.runtimeEntriesForSource(userId, update.source.sourceId)) this.runtimeStates.delete(key)
      const next: StoredSourceRecord = { ...update.source, enabled: update.deleted ? update.source.enabled : action === 'enable' }
      this.userSourceMap.set(`${userId}:${update.source.sourceId}`, { source: next, deleted: update.deleted, revision: randomUUID() })
    }
    return { affected: items.length }
  }
  public async applySourceOrder(userId: string, items: SourceOrderItem[]): Promise<{ affected: number }> {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '排序列表包含重复书源')
      seen.add(item.sourceId)
      const key = `${userId}:${item.sourceId}`
      const record = this.userSourceMap.get(key)
      if (record === undefined || record.deleted) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
      if (record.revision !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
      const normalizedSource = { ...record.source.normalizedSource, customOrder: item.customOrder }
      this.userSourceMap.set(key, { ...record, source: { ...record.source, normalizedSource }, revision: randomUUID() })
    }
    return { affected: items.length }
  }

  public async saveImportPreview(userId: string, preview: ImportPreview, sourceUrl: string): Promise<void> { this.importPreviews.set(`${userId}:${preview.previewId}`, { userId, sourceUrl, preview, consumedIds: [] }) }
  public async getImportPreview(userId: string, previewId: string): Promise<ImportPreview | null> { const record = this.importPreviews.get(`${userId}:${previewId}`); return record === undefined || new Date(record.preview.expiresAt).getTime() <= Date.now() ? null : record.preview }
  public async commitImportPreview(userId: string, previewId: string, candidateIds: string[]): Promise<ImportConfirmResult> {
    const committed = this.importHistory.committed(userId, previewId, candidateIds)
    if (committed) return committed
    const record = this.importPreviews.get(`${userId}:${previewId}`)
    if (record === undefined || new Date(record.preview.expiresAt).getTime() <= Date.now()) throw new SourceManagementError('preview-expired', '导入预览已过期，请重新获取')
    if (record.consumedIds.length > 0) { if (sameStringSet(record.consumedIds, candidateIds)) return record.result!; throw new SourceManagementError('preview-invalid', '导入预览已经确认过') }
    const candidates = record.preview.candidates.filter((candidate) => candidateIds.includes(candidate.id))
    if (candidates.length !== candidateIds.length || candidates.some((candidate) => candidate.disposition === undefined)) throw new SourceManagementError('preview-invalid', '确认列表包含不可导入的书源')
    const currentStates = new Map([...this.userSourceMap.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([key, value]) => [key.slice(userId.length + 1), { enabled: value.source.enabled, deleted: value.deleted }]))
    const importEnabled = decideImportedSourceEnabled(candidates, currentStates)
    for (const candidate of candidates) {
      const currentRevision = this.userSourceMap.has(`${userId}:${candidate.sourceId}`) ? this.sourceRevision(userId, candidate.sourceId) : undefined
      if (candidate.sourceRevision === undefined ? currentRevision !== undefined : currentRevision !== candidate.sourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请重新获取预览：${candidate.name}`)
      if (this.runtimeEntriesForSource(userId, candidate.sourceId).some(([, state]) => state.leaseToken !== null && (state.leaseUntil ?? 0) > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${candidate.name}`)
    }
    const history = this.importHistory.record(userId, record.preview, record.sourceUrl, candidateIds)
    for (const candidate of candidates) {
      const current = this.userSourceMap.get(`${userId}:${candidate.sourceId}`)?.source
      if (current !== undefined && current.fingerprint !== candidate.fingerprint) for (const [key] of this.runtimeEntriesForSource(userId, candidate.sourceId)) this.runtimeStates.delete(key)
      const normalizedSource = mergeImportedSource(current, candidate.normalizedSource as NormalizedSource)
      this.userSourceMap.set(`${userId}:${candidate.sourceId}`, { source: { sourceUuid: history.changes.get(candidate.id)!.sourceUuid!, importLinkId: history.batch.linkId, currentImportItemId: history.changes.get(candidate.id)!.id, sourceId: candidate.sourceId, name: normalizedSource.bookSourceName, ...(typeof normalizedSource.bookSourceGroup === 'string' ? { group: normalizedSource.bookSourceGroup } : {}), fingerprint: candidate.fingerprint, enabled: importEnabled.get(candidate.id) ?? false, rawSource: candidate.rawSource, normalizedSource }, deleted: false, revision: history.changes.get(candidate.id)!.afterRevision! })
    }
    record.consumedIds = [...candidateIds]; record.result = this.importHistory.result(history.batch); return record.result
  }
  private allSources(userId: string): StoredSourceRecord[] { return [...this.userSourceMap.entries()].filter(([key, value]) => key.startsWith(`${userId}:`) && value.deleted === false).map(([, value]) => value.source) }
  private allSourceStates(userId: string): Array<{ source: StoredSourceRecord; deleted: boolean }> { return [...this.userSourceMap.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([, value]) => ({ source: value.source, deleted: value.deleted })) }
  private getSourceForManagement(userId: string, sourceId: string): Promise<StoredSourceRecord | undefined> { const override = this.userSourceMap.get(`${userId}:${sourceId}`); return Promise.resolve(override?.deleted === true ? undefined : override?.source) }
  private sourceRevision(userId: string, sourceId: string): string { return this.userSourceMap.get(`${userId}:${sourceId}`)?.revision ?? '' }
  private runtimeEntriesForSource(userId: string, sourceId: string): Array<[string, { snapshot: RuntimeStateSnapshot; version: number; leaseToken: string | null; leaseUntil: number | null }]> { return [...this.runtimeStates.entries()].filter(([key]) => { const identity = JSON.parse(key) as unknown[]; return identity[0] === userId && identity[1] === sourceId }) }
  public async acquireSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, leaseMs: number): Promise<SourceRuntimeLease | null> { const key = runtimeStateKey(userId, sourceId, sourceFingerprint); const now = Date.now(); const current = this.runtimeStates.get(key); if (current !== undefined && current.leaseToken !== null && (current.leaseUntil ?? 0) > now) return null; const next = current ?? { snapshot: {}, version: 0, leaseToken: null, leaseUntil: null }; next.leaseToken = leaseToken; next.leaseUntil = now + Math.max(1_000, leaseMs); this.runtimeStates.set(key, next); return { sourceId, sourceFingerprint, snapshot: cloneRuntimeSnapshot(next.snapshot), version: next.version, leaseToken } }
  public async saveSourceRuntimeState(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, expectedVersion: number, snapshot: RuntimeStateSnapshot): Promise<SourceRuntimeStateRecord | null> { const key = runtimeStateKey(userId, sourceId, sourceFingerprint); const current = this.runtimeStates.get(key); if (current === undefined || current.leaseToken !== leaseToken || current.version !== expectedVersion) return null; const next = { snapshot: cloneRuntimeSnapshot(snapshot), version: current.version + 1, leaseToken: null, leaseUntil: null }; this.runtimeStates.set(key, next); return { sourceId, sourceFingerprint, snapshot: cloneRuntimeSnapshot(next.snapshot), version: next.version } }
  public async releaseSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string): Promise<void> { const current = this.runtimeStates.get(runtimeStateKey(userId, sourceId, sourceFingerprint)); if (current?.leaseToken !== leaseToken) return; current.leaseToken = null; current.leaseUntil = null }
  public async getSettings(userId: string): Promise<ReaderSettings> { return this.settings.get(userId) ?? defaultReaderSettings(userId) }
  public async saveSettings(userId: string, patch: ReaderSettingsPatch): Promise<ReaderSettings> { const target = patch.general?.bookshelfInitialGroup; if (target !== undefined && target !== 'all' && target !== 'ungrouped' && !this.organizations.get(userId)?.lists.some((row) => row.type === 'shelf_group' && row.id === target)) throw new OrganizationError(404, '启动分组不存在'); const next = mergeReaderSettings(this.settings.get(userId) ?? defaultReaderSettings(userId), patch, new Date().toISOString()); this.settings.set(userId, next); return structuredClone(next) }
  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> { const now = new Date().toISOString(); const sourceIds = input.sourceIds === undefined || input.sourceIds.length === 0 ? [input.sourceId] : [...new Set(input.sourceIds)]; const sourceStates: SourceSearchState[] = sourceIds.map((sourceId) => ({ sourceId, ...input.sourceSnapshots?.find((item) => item.sourceId === sourceId), status: 'pending', candidates: [], diagnostics: [] })); const search: SearchRunState = { id: randomUUID(), userId, keyword: input.keyword, sourceId: sourceIds[0] ?? input.sourceId, sourceIds, ...(input.precision === true ? { precision: true } : {}), ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }), status: 'running', candidates: [], sourceStates, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), progress: { completed: 0, total: sourceIds.length }, version: 0, cancelled: false, createdAt: now, updatedAt: now }; this.searches.set(search.id, search); this.history.set(`${userId}:${search.id}`, { id: randomUUID(), searchId: search.id, keyword: input.keyword, sourceIds, status: 'running', resultCount: 0, createdAt: now, updatedAt: now }); return search }
  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> { const search = this.searches.get(searchId); return search?.userId === userId ? search : null }
  public async claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }, expectedVersion?: number, _knownRun?: SearchRunState): Promise<SearchRunState | null> {
    const current = this.searches.get(searchId)
    if (!current || current.userId !== userId || current.cancelled || (expectedVersion !== undefined && current.version !== expectedVersion) || (current.operationId && (this.searchLeases.get(searchId) ?? Infinity) > Date.now())) return null
    const next = { ...current, sourceStates, progress, operationId, status: 'running' as const, cancelled: false, version: current.version + 1 }
    this.searches.set(searchId, next); this.searchLeases.set(searchId, Date.now() + 30000); return next
  }
  public async updateSearch(userId: string, searchId: string, patch: { knownRun?: SearchRunState; status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null> { const current = await this.getSearch(userId, searchId); if (current === null || (patch.expectedOperationId !== undefined && current.operationId !== patch.expectedOperationId)) return null; const updated: SearchRunState = { ...current, ...(patch.status === undefined ? {} : { status: patch.status }), ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }), ...(patch.sourceStates === undefined ? {} : { sourceStates: patch.sourceStates }), ...(patch.sourceIds === undefined ? {} : { sourceIds: patch.sourceIds }), ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }), ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }), ...(patch.operationId === undefined || patch.operationId === null ? {} : { operationId: patch.operationId }), ...(patch.progress === undefined ? {} : { progress: patch.progress }), ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }), updatedAt: new Date().toISOString(), version: current.version + 1 }; if (patch.operationId === null) delete updated.operationId; this.searches.set(searchId, updated); if (updated.operationId) this.searchLeases.set(searchId, Date.now() + 30000); else this.searchLeases.delete(searchId); const history = this.history.get(`${userId}:${searchId}`); if (history !== undefined) this.history.set(`${userId}:${searchId}`, { ...history, status: updated.status, resultCount: updated.candidates.length, summary: searchSummary(updated.status, updated.candidates.length), updatedAt: updated.updatedAt }); return updated }
  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> { const existing = [...this.books.values()].find((item) => item.book.userId === userId && item.edition.editionKey === input.editionKey); const target = input.bookId === undefined ? undefined : [...this.books.values()].find((item) => item.book.userId === userId && item.book.id === input.bookId); if (input.bookId !== undefined && target === undefined) throw new Error('书籍不存在'); if (existing !== undefined && input.bookId !== undefined && existing.book.id !== input.bookId) throw new Error('书籍版本已经属于其他书籍'); const now = new Date().toISOString(); const book: StoredBook = existing?.book ?? target?.book ?? { id: randomUUID(), userId, name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍', ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), activeEditionKey: input.editionKey, createdAt: now, updatedAt: now }; const activeEditionKey = input.activateEdition === false ? book.activeEditionKey : input.editionKey; const updatedBook = input.activateEdition === false ? book : { ...book, name: input.metadata.name ?? book.name, ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), ...(activeEditionKey === undefined ? {} : { activeEditionKey }), updatedAt: now }; const edition: StoredEdition = { id: existing?.edition.id ?? randomUUID(), userId, bookId: updatedBook.id, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }; const value = { book: updatedBook, edition }; for (const [key, item] of this.books) if (item.book.id === updatedBook.id && item.book.userId === userId) this.books.set(key, { ...item, book: updatedBook }); this.books.set(`${userId}:${input.editionKey}`, value); if (input.addToBookshelf !== false) this.shelf.set(`${userId}:${updatedBook.id}`, now); return value }
  public async setCustomCover(userId: string, bookId: string, coverUrl: string | null): Promise<StoredBook | null> {
    const book = await this.getBook(userId, bookId)
    if (book === null) return null
    const next = { ...book }
    if (coverUrl === null) delete next.customCoverUrl
    else next.customCoverUrl = coverUrl
    for (const [key, item] of this.books) if (item.book.userId === userId && item.book.id === bookId) this.books.set(key, { ...item, book: next })
    return next
  }

  public async listBookSourceCandidates(userId: string, bookId: string): Promise<StoredBookSourceCandidate[]> {
    return [...this.sourceCandidates.values()].filter((row) => row.userId === userId && row.bookId === bookId).map((row) => structuredClone(row))
  }
  public async saveBookSourceCandidates(userId: string, bookId: string, candidates: StoredCandidate[]): Promise<void> {
    if (await this.getBook(userId, bookId) === null) throw new Error('书籍不存在')
    for (const candidate of candidates) {
      const key = JSON.stringify([userId, bookId, candidate.sourceId, candidate.sourceFingerprint, candidate.candidate.bookUrl])
      const previous = this.sourceCandidates.get(key)
      this.sourceCandidates.set(key, { id: previous?.id ?? randomUUID(), userId, bookId, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.candidate.bookUrl, candidate: cacheableCandidate(candidate), updatedAt: new Date().toISOString() })
    }
  }
  public async saveEdition(userId: string, bookId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<StoredEdition> {
    const book = await this.getBook(userId, bookId)
    if (book === null) throw new Error('书籍不存在')
    const existing = this.books.get(`${userId}:${input.editionKey}`)
    if (existing !== undefined) {
      if (existing.book.id !== bookId) throw new Error('书籍版本已经属于其他书籍')
      return existing.edition
    }
    const edition: StoredEdition = { id: randomUUID(), userId, bookId, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }
    this.books.set(`${userId}:${input.editionKey}`, { book, edition })
    return edition
  }
  public async addToBookshelf(userId: string, bookId: string): Promise<void> { this.shelf.set(`${userId}:${bookId}`, new Date().toISOString()) }
  public async removeFromBookshelf(userId: string, bookId: string): Promise<void> { this.shelf.delete(`${userId}:${bookId}`); this.shelfGroups.delete(`${userId}:${bookId}`) }
  public async isOnBookshelf(userId: string, bookId: string): Promise<boolean> { return this.shelf.has(`${userId}:${bookId}`) }
  public async getHome(userId: string): Promise<HomeSnapshot> {
    const values = [...this.books.values()].filter((item) => item.book.userId === userId)
    const activeValues = values.filter((item) => item.book.activeEditionKey === item.edition.editionKey)
    const positions = [...this.positions.values()].filter((position) => position.userId === userId).sort((a, b) => b.lastReadAt.localeCompare(a.lastReadAt))
    const sortByReadingTime = (await this.getSettings(userId)).general.bookshelfSort === 'lastReadAt'
    const seenReadingBooks = new Set<string>()
    const reading = positions.map((position) => {
      const value = values.find((item) => item.book.id === position.bookId && item.edition.editionKey === position.editionKey)
      return value === undefined || seenReadingBooks.has(position.bookId) ? undefined : (seenReadingBooks.add(position.bookId), { book: value.book, edition: value.edition, position })
    }).filter((item): item is { book: StoredBook; edition: StoredEdition; position: StoredPosition } => item !== undefined)
    const lastReadByBook = new Map<string, string>()
    for (const position of positions) if (!lastReadByBook.has(position.bookId)) lastReadByBook.set(position.bookId, position.lastReadAt)
    const shelfValues = activeValues.filter((item) => this.shelf.has(`${userId}:${item.book.id}`)).sort((left, right) => {
      const leftAddedAt = this.shelf.get(`${userId}:${left.book.id}`) ?? ''
      const rightAddedAt = this.shelf.get(`${userId}:${right.book.id}`) ?? ''
      if (sortByReadingTime) {
        const leftReadAt = lastReadByBook.get(left.book.id)
        const rightReadAt = lastReadByBook.get(right.book.id)
        if (leftReadAt === undefined && rightReadAt !== undefined) return 1
        if (rightReadAt === undefined && leftReadAt !== undefined) return -1
        if (leftReadAt !== undefined && rightReadAt !== undefined && leftReadAt !== rightReadAt) return rightReadAt.localeCompare(leftReadAt)
      }
      return rightAddedAt.localeCompare(leftAddedAt) || left.book.id.localeCompare(right.book.id)
    })
    const shelf = shelfValues.map((entry) => { const value = { ...entry, groupId: this.shelfGroups.get(`${userId}:${entry.book.id}`) ?? null }; const position = this.positions.get(`${userId}:${value.book.id}:${value.edition.editionKey}`); return position === undefined ? value : { ...value, position } })
    const searchHistory: HomeSearchHistory[] = latestSearchHistory([...this.history.values()].filter((item) => this.searches.get(item.searchId)?.userId === userId)).slice(0, 50).map(({ id, searchId, keyword, status, resultCount, summary, createdAt, updatedAt }) => ({ id, searchId, keyword, status, resultCount, ...(summary === undefined ? {} : { summary }), createdAt, updatedAt }))
    return { bookshelf: shelf.map((row) => ({ book: displayBook(row.book), edition: { editionKey: row.edition.editionKey }, groupId: row.groupId, ...('position' in row ? { position: displayPosition(row.position) } : {}) })), reading: reading.map((row) => ({ book: displayBook(row.book), edition: { editionKey: row.edition.editionKey }, position: displayPosition(row.position) })), searchHistory }
  }
  public async getBackupSnapshot(userId: string): Promise<ReaderBackupSnapshot> {
    const books = new Map<string, ReaderBackupBook>()
    for (const value of this.books.values()) {
      if (value.book.userId !== userId) continue
      const existing = books.get(value.book.id) ?? { book: value.book, editions: [], candidates: [] }
      existing.editions.push(value.edition)
      books.set(value.book.id, existing)
    }
    for (const value of this.sourceCandidates.values()) {
      if (value.userId !== userId) continue
      const existing = books.get(value.bookId)
      if (existing !== undefined) existing.candidates.push(value)
    }
    return {
      sources: this.allSourceStates(userId).map(({ source, deleted }) => ({ source, sourceRevision: this.sourceRevision(userId, source.sourceId), ...(deleted ? { deleted: true } : {}) })),
      settings: await this.getSettings(userId),
      organization: await this.getBookOrganization(userId),
      bookmarks: (await this.listReadingMarks(userId, { kind: 'bookmarks', all: true })).items,
      annotations: (await this.listReadingMarks(userId, { kind: 'annotations', all: true })).items,
      books: [...books.values()],
      bookshelf: [...this.shelf.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([key, addedAt]) => ({ bookId: key.slice(userId.length + 1), addedAt, groupId: this.shelfGroups.get(key) ?? null })),
      positions: [...this.positions.values()].filter((position) => position.userId === userId),
      searchHistory: [...this.history.values()].filter((item) => this.searches.get(item.searchId)?.userId === userId),
    }
  }
  public async restoreBackupSnapshot(userId: string, snapshot: ReaderBackupSnapshot, categories: readonly BackupCategory[]): Promise<void> {
    const selected = new Set(categories)
    if (selected.size === 0) throw new BackupRestoreError('至少选择一个恢复分类')
    snapshot = prepareOrganizationRestore(await this.getBackupSnapshot(userId), snapshot, selected)
    assertBackupSnapshotClosed(snapshot, userId)
    const bookIdMap = new Map<string, string>()
    const currentBookIds = new Set([...this.books.values()].filter((value) => value.book.userId === userId).map((value) => value.book.id))
    const incomingEditions = new Set(snapshot.books.flatMap((item) => item.editions.map((edition) => `${item.book.id}\u0000${edition.editionKey}`)))
    if (selected.has('bookshelf') && !selected.has('reading')) {
      const missing = [...this.positions.values()].filter((position) => position.userId === userId && !incomingEditions.has(`${position.bookId}\u0000${position.editionKey}`))
      if (missing.length > 0) throw new BackupRestoreError(`未选择阅读记录，但书架替换会使现有阅读记录失去依赖：${missing[0]?.bookId ?? ''}`)
    }
    if (selected.has('bookshelf')) for (const item of snapshot.books) bookIdMap.set(item.book.id, currentBookIds.has(item.book.id) ? item.book.id : item.book.id)
    else if (selected.has('reading')) for (const item of snapshot.books) if (currentBookIds.has(item.book.id)) bookIdMap.set(item.book.id, item.book.id)
    if (selected.has('reading')) {
      const missingBooks = [...new Set([...snapshot.positions, ...(snapshot.bookmarks ?? []), ...(snapshot.annotations ?? [])].map((position) => position.bookId))].filter((bookId) => !bookIdMap.has(bookId))
      if (missingBooks.length > 0) throw new BackupRestoreError(`阅读记录依赖的书籍不存在，请同时选择书架：${missingBooks.join('、')}`)
      if (!selected.has('bookshelf')) {
        const available = new Set([...this.books.values()].filter((value) => value.book.userId === userId).map((value) => `${value.book.id}\u0000${value.edition.editionKey}`))
        const missingEditions = [...new Set([...snapshot.positions, ...(snapshot.bookmarks ?? []), ...(snapshot.annotations ?? [])].map((position) => `${position.bookId}\u0000${position.editionKey}`))].filter((key) => !available.has(key))
        if (missingEditions.length > 0) throw new BackupRestoreError('阅读记录依赖的书籍版本不存在，请同时选择书架')
      }
    }
    const nextBooks = new Map(this.books)
    const nextCandidates = new Map(this.sourceCandidates)
    const nextShelf = new Map(this.shelf)
    const nextPositions = new Map(this.positions)
    const nextTocs = new Map(this.tocs)
    const nextContents = new Map(this.contents)
    const nextHistory = new Map(this.history)
    const nextSearches = new Map(this.searches)
    const nextSources = new Map(this.userSourceMap)
    const nextSettings = new Map(this.settings)
    const nextRuntimeStates = new Map(this.runtimeStates)
    if (selected.has('bookshelf')) {
      for (const [key, value] of nextBooks) if (value.book.userId === userId) nextBooks.delete(key)
      for (const [key, value] of nextCandidates) if (value.userId === userId) nextCandidates.delete(key)
      for (const [key] of nextTocs) if (key.startsWith(`${userId}:`)) nextTocs.delete(key)
      for (const [key] of nextContents) if (key.startsWith(`${userId}:`)) nextContents.delete(key)
      for (const [key] of nextShelf) if (key.startsWith(`${userId}:`)) nextShelf.delete(key)
      for (const item of snapshot.books) {
        const bookId = bookIdMap.get(item.book.id)
        if (bookId === undefined) throw new BackupRestoreError(`书籍映射失败：${item.book.id}`)
        for (const edition of item.editions) nextBooks.set(`${userId}:${edition.editionKey}`, { book: { ...item.book, id: bookId, userId }, edition: { ...edition, bookId, userId } })
        for (const candidate of item.candidates) nextCandidates.set(`${userId}:${bookId}:${candidate.sourceId}:${candidate.sourceFingerprint}:${candidate.bookUrl}`, { ...candidate, userId, bookId })
      }
    }
    if (selected.has('bookshelf')) for (const item of snapshot.bookshelf) {
      const bookId = bookIdMap.get(item.bookId)
      if (bookId === undefined) throw new BackupRestoreError(`书架缺少书籍：${item.bookId}`)
      nextShelf.set(`${userId}:${bookId}`, item.addedAt)
    }
    if (selected.has('reading')) {
      for (const [key, value] of nextPositions) if (value.userId === userId) nextPositions.delete(key)
      for (const position of snapshot.positions) {
        const bookId = bookIdMap.get(position.bookId)
        if (bookId === undefined) throw new BackupRestoreError(`阅读记录缺少书籍：${position.bookId}`)
        nextPositions.set(`${userId}:${bookId}:${position.editionKey}`, { ...position, userId, bookId })
      }
    }
    if (selected.has('search')) {
      for (const [key, item] of nextHistory) if (key.startsWith(`${userId}:`) || nextSearches.get(item.searchId)?.userId === userId) nextHistory.delete(key)
      for (const [searchId, item] of nextSearches) if (item.userId === userId) nextSearches.delete(searchId)
      for (const item of snapshot.searchHistory) {
        const existing = nextSearches.get(item.searchId)
        const searchId = existing === undefined || existing.userId === userId ? item.searchId : randomUUID()
        nextHistory.set(`${userId}:${searchId}`, { ...item, searchId })
        nextSearches.set(searchId, { id: searchId, userId, keyword: item.keyword, sourceId: item.sourceIds[0] ?? '', sourceIds: item.sourceIds, status: item.status as SearchRunState['status'], candidates: [], sourceStates: [], progress: { completed: 0, total: item.sourceIds.length }, version: 0, cancelled: false, createdAt: item.createdAt, updatedAt: item.updatedAt })
      }
    }
    if (selected.has('sources')) {
      for (const key of [...nextSources.keys()]) if (key.startsWith(`${userId}:`)) nextSources.delete(key)
      for (const item of snapshot.sources) nextSources.set(`${userId}:${item.source.sourceId}`, { source: { sourceId: item.source.sourceId, name: item.source.name, fingerprint: item.source.fingerprint, enabled: item.source.enabled, rawSource: item.source.rawSource, normalizedSource: item.source.normalizedSource, ...(item.source.group ? { group: item.source.group } : {}), sourceUuid: this.userSourceMap.get(`${userId}:${item.source.sourceId}`)?.source.sourceUuid ?? randomUUID() }, deleted: item.deleted === true, revision: randomUUID() })
      for (const [key] of nextRuntimeStates) {
        const identity = JSON.parse(key) as unknown[]
        if (identity[0] === userId) nextRuntimeStates.delete(key)
      }
    }
    if (selected.has('settings') || selected.has('bookshelf')) nextSettings.set(userId, { ...snapshot.settings })
    if (selected.has('bookshelf')) {
      if (snapshot.organization) this.organizations.set(userId, structuredClone(snapshot.organization))
      for (const key of this.shelfGroups.keys()) if (key.startsWith(userId + ':')) this.shelfGroups.delete(key)
      for (const row of snapshot.bookshelf) this.shelfGroups.set(`${userId}:${bookIdMap.get(row.bookId) ?? row.bookId}`, row.groupId ?? null)
    }
    if (selected.has('reading')) {
      for (const kind of ['bookmarks', 'annotations'] as const) if (snapshot[kind] !== undefined) {
        for (const key of this.readingMarks.keys()) if (key.startsWith(userId + ':' + kind + ':')) this.readingMarks.delete(key)
        for (const row of snapshot[kind]!) this.readingMarks.set(userId + ':' + kind + ':' + row.id, structuredClone({ ...row, userId, bookId: bookIdMap.get(row.bookId) ?? row.bookId }))
      }
    }
    this.books.clear(); for (const [key, value] of nextBooks) this.books.set(key, value)
    this.sourceCandidates.clear(); for (const [key, value] of nextCandidates) this.sourceCandidates.set(key, value)
    this.shelf.clear(); for (const [key, value] of nextShelf) this.shelf.set(key, value)
    this.positions.clear(); for (const [key, value] of nextPositions) this.positions.set(key, value)
    this.tocs.clear(); for (const [key, value] of nextTocs) this.tocs.set(key, value)
    this.contents.clear(); for (const [key, value] of nextContents) this.contents.set(key, value)
    this.searches.clear(); for (const [key, value] of nextSearches) this.searches.set(key, value)
    this.history.clear(); for (const [key, value] of nextHistory) this.history.set(key, value)
    if (selected.has('sources')) this.importHistory.invalidate(userId)
    this.userSourceMap.clear(); for (const [key, value] of nextSources) this.userSourceMap.set(key, value)
    this.settings.clear(); for (const [key, value] of nextSettings) this.settings.set(key, value)
    this.runtimeStates.clear(); for (const [key, value] of nextRuntimeStates) this.runtimeStates.set(key, value)
  }
  public async deleteSearchHistory(userId: string, historyId: string): Promise<boolean> { const item = [...this.history.entries()].find(([, value]) => value.id === historyId && this.searches.get(value.searchId)?.userId === userId); if (item === undefined) return false; for (const [key, value] of this.history) if (this.searches.get(value.searchId)?.userId === userId && normalizeIdentity(value.keyword) === normalizeIdentity(item[1].keyword)) this.history.delete(key); return true }
  public async listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>> { return [...this.books.values()].filter((item) => item.book.userId === userId && item.book.activeEditionKey === item.edition.editionKey).sort((a, b) => b.book.updatedAt.localeCompare(a.book.updatedAt)) }
  public async getBook(userId: string, bookId: string): Promise<StoredBook | null> { return [...this.books.values()].find((item) => item.book.userId === userId && item.book.id === bookId)?.book ?? null }
  public async listEditions(userId: string, bookId: string): Promise<StoredEdition[]> { return [...this.books.values()].filter((item) => item.book.userId === userId && item.book.id === bookId).map((item) => item.edition).sort((a, b) => a.editionKey.localeCompare(b.editionKey)) }
  public async activateEdition(userId: string, bookId: string, editionKey: string) { const edition = await this.setActiveEdition(userId, bookId, editionKey); return edition ? { editionKey: edition.editionKey } : null }
  public async getEditionSource(userId: string, bookId: string, editionKey: string) { const edition = await this.getEdition(userId, bookId, editionKey); return edition ? { sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint } : null }
  public async getContentDisplay(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<CachedReadingContent | null> {
    const cached = this.contents.get(`${userId}:${editionKey}:${tocRevision}:${chapterId}`)
    return cached ? { tocRevision: cached.tocRevision, sourceFingerprint: cached.sourceFingerprint, content: readingContent(cached.content, chapterId), ...(cached.content.truncated === undefined ? {} : { truncated: cached.content.truncated }) } : null
  }
  public async setActiveEdition(userId: string, bookId: string, editionKey: string): Promise<StoredEdition | null> { const selected = [...this.books.values()].find((item) => item.book.userId === userId && item.book.id === bookId && item.edition.editionKey === editionKey); if (selected === undefined) return null; const updatedBook = { ...selected.book, activeEditionKey: editionKey, updatedAt: new Date().toISOString() }; for (const [key, item] of this.books) if (item.book.userId === userId && item.book.id === bookId) this.books.set(key, { ...item, book: updatedBook }); return selected.edition }
  public async getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null> { const item = [...this.books.values()].find((value) => value.book.userId === userId && value.book.id === bookId && (editionKey === undefined || value.edition.editionKey === editionKey)); return item?.edition ?? null }
  public async getChapterContext(userId: string, bookId: string, editionKey: string, chapterId: string, _display?: boolean): Promise<ChapterContext | null> {
    const toc = await this.getToc(userId, bookId, editionKey)
    if (toc === null) return null
    const index = toc.chapters.findIndex((chapter) => createHash('sha256').update(`${chapter.chapterUrl}\u0000${chapter.index}`).digest('hex') === chapterId)
    return { revision: toc.revision, sourceFingerprint: toc.sourceFingerprint, ...(index < 0 ? {} : { chapter: toc.chapters[index], ...(toc.chapters[index + 1] === undefined ? {} : { nextChapterUrl: toc.chapters[index + 1]!.chapterUrl }) }) }
  }
  public async getTocSummary(userId: string, bookId: string, editionKey: string): Promise<CachedTocSummary | null> {
    const toc = this.tocs.get(`${userId}:${bookId}:${editionKey}`)
    return toc === undefined ? null : tocSummary(toc)
  }
  public async getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null> { return this.tocs.get(`${userId}:${bookId}:${editionKey}`) ?? null }
  public async saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc> { const value = { ...toc, userId, updatedAt: new Date().toISOString() }; this.tocs.set(`${userId}:${toc.bookId}:${toc.editionKey}`, value); return value }
  public async getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null> { return this.contents.get(`${userId}:${editionKey}:${tocRevision}:${chapterId}`) ?? null }
  public async saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent> { const value = { ...content, userId, updatedAt: new Date().toISOString() }; this.contents.set(`${userId}:${content.editionKey}:${content.tocRevision}:${content.chapterId}`, value); return value }
  public async getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null> { return this.positions.get(`${userId}:${bookId}:${editionKey}`) ?? null }
  public async savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition> { const value = { ...position, userId, lastReadAt: position.lastReadAt ?? new Date().toISOString() }; this.positions.set(`${userId}:${position.bookId}:${position.editionKey}`, value); return value }
}

async function lockUserSourceMutations(transaction: ReaderTransaction, userId: string): Promise<void> {
  // Domain membership spans multiple source rows, so serialize account-level source mutations without adding a schema constraint.
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`)
}
/** Keep an existing source's setting; otherwise leave new siblings disabled beside an active source, or select the newest import. */
function decideImportedSourceEnabled(candidates: readonly ImportPreviewCandidate[], currentById: ReadonlyMap<string, { enabled: boolean; deleted: boolean }>): Map<string, boolean> {
  const activeDomains = new Set([...currentById.entries()].filter(([, state]) => !state.deleted && state.enabled).map(([sourceId]) => sourceDomainInfo(sourceId).key))
  const enabledByCandidate = new Map(candidates.map((candidate) => [candidate.id, false]))
  for (const candidate of candidates) {
    const current = currentById.get(candidate.sourceId)
    if (current !== undefined && !current.deleted) enabledByCandidate.set(candidate.id, current.enabled)
  }

  const sortByRuleTime = (left: ImportPreviewCandidate, right: ImportPreviewCandidate) => compareSourceVersions(
    { sourceId: left.sourceId, name: left.name, ...(left.lastUpdateTime === undefined ? {} : { lastUpdateTime: left.lastUpdateTime }), customOrder: readInteger(left.normalizedSource.customOrder, 0) },
    { sourceId: right.sourceId, name: right.name, ...(right.lastUpdateTime === undefined ? {} : { lastUpdateTime: right.lastUpdateTime }), customOrder: readInteger(right.normalizedSource.customOrder, 0) },
  )
  const restores = candidates.filter((candidate) => currentById.get(candidate.sourceId)?.deleted === true && currentById.get(candidate.sourceId)?.enabled === true).sort(sortByRuleTime)
  for (const candidate of restores) {
    const domainKey = sourceDomainInfo(candidate.sourceId).key
    if (activeDomains.has(domainKey)) continue
    enabledByCandidate.set(candidate.id, true)
    activeDomains.add(domainKey)
  }

  const newByDomain = new Map<string, ImportPreviewCandidate[]>()
  for (const candidate of candidates) {
    if (currentById.has(candidate.sourceId)) continue
    const domainKey = sourceDomainInfo(candidate.sourceId).key
    const domainCandidates = newByDomain.get(domainKey) ?? []
    domainCandidates.push(candidate)
    newByDomain.set(domainKey, domainCandidates)
  }
  for (const [domainKey, domainCandidates] of newByDomain) {
    if (activeDomains.has(domainKey)) continue
    const [selected] = domainCandidates.sort(sortByRuleTime)
    if (selected !== undefined) {
      enabledByCandidate.set(selected.id, true)
      activeDomains.add(domainKey)
    }
  }
  return enabledByCandidate
}
const sourceListColumns = {
  sourceId: userSources.sourceId, fingerprint: userSources.fingerprint, enabled: userSources.enabled,
  sourceUuid: userSources.sourceUuid, importLinkId: userSources.importLinkId, sourceRevision: userSources.revision,
  customOrder: userSources.customOrder,
  name: sql<unknown>`${userSources.normalizedSource}->'bookSourceName'`,
  group: sql<unknown>`${userSources.normalizedSource}->'bookSourceGroup'`,
  ruleOrder: sql<unknown>`${userSources.normalizedSource}->'customOrder'`,
  canExplore: sql<boolean>`coalesce(${userSources.normalizedSource}->'enabledExplore' <> 'false'::jsonb, true) and jsonb_typeof(${userSources.normalizedSource}->'exploreUrl') = 'string' and length(btrim(${userSources.normalizedSource}->>'exploreUrl', ${' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'})) > 0`,
}

type SourceListRow = { sourceId: string; fingerprint: string; enabled: boolean; sourceUuid: string; importLinkId: string | null; sourceRevision: string; customOrder: number; name: unknown; group: unknown; ruleOrder: unknown; canExplore: boolean; priority?: number | null }
function sourceListRecord(row: SourceListRow): SourceListRecord {
  return { sourceId: row.sourceId, name: typeof row.name === 'string' ? row.name : row.sourceId, ...(typeof row.group === 'string' ? { group: row.group } : {}), fingerprint: row.fingerprint, enabled: row.enabled, sourceUuid: row.sourceUuid, ...(row.importLinkId ? { importLinkId: row.importLinkId } : {}), sourceRevision: row.sourceRevision, customOrder: readInteger(row.ruleOrder, 0), priority: row.priority ?? Number.MAX_SAFE_INTEGER, canExplore: row.canExplore === true }
}
function managedListSummary(row: SourceListRow & { revision: string; author: unknown; bookSourceAuthor: unknown; lastUpdateTime: unknown }): ManagedSourceSummary {
  const source = sourceListRecord(row)
  const author = [row.author, row.bookSourceAuthor].find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const time = readTimestamp(row.lastUpdateTime)
  return { sourceId: source.sourceId, name: source.name, ...(source.group === undefined ? {} : { group: source.group }), fingerprint: source.fingerprint, enabled: source.enabled, ...(source.sourceUuid === undefined ? {} : { sourceUuid: source.sourceUuid }), ...(source.importLinkId ? { importLinkId: source.importLinkId } : {}), sourceRevision: row.revision, customOrder: row.customOrder, origin: 'account', ...(author === undefined ? {} : { author: author.trim() }), ...(time === undefined ? {} : { lastUpdateTime: time }) }
}
export function compareSourceListPriority(left: SourceListRecord, right: SourceListRecord): number { return (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER) || left.customOrder - right.customOrder || left.sourceId.localeCompare(right.sourceId) }

function compareStoredSourceManagementOrder(left: StoredSourceRecord, right: StoredSourceRecord): number { return readInteger(left.normalizedSource.customOrder, 0) - readInteger(right.normalizedSource.customOrder, 0) || left.sourceId.localeCompare(right.sourceId) }
function toRuntimeState(row: SourceRuntimeRow): SourceRuntimeStateRecord { return { sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint, snapshot: decryptRuntimeState(row.encryptedState), version: row.version } }
function toRuntimeLease(row: SourceRuntimeRow, leaseToken: string): SourceRuntimeLease { return { ...toRuntimeState(row), leaseToken } }
function runtimeStateKey(userId: string, sourceId: string, sourceFingerprint: string): string { return JSON.stringify([userId, sourceId, sourceFingerprint]) }
function cloneRuntimeSnapshot(snapshot: RuntimeStateSnapshot): RuntimeStateSnapshot { return structuredClone(snapshot) }
function toUserSource(row: UserSourceRow): StoredSourceRecord { return { sourceUuid: row.sourceUuid, sourceRevision: row.revision, ...(row.importLinkId ? { importLinkId: row.importLinkId } : {}), ...(row.currentImportItemId ? { currentImportItemId: row.currentImportItemId } : {}), sourceId: row.sourceId, name: typeof row.normalizedSource.bookSourceName === 'string' ? row.normalizedSource.bookSourceName : row.sourceId, ...(typeof row.normalizedSource.bookSourceGroup === 'string' ? { group: row.normalizedSource.bookSourceGroup } : {}), fingerprint: row.fingerprint, enabled: row.enabled, rawSource: row.rawSource, normalizedSource: row.normalizedSource } }
export function managedSummary(source: StoredSourceRecord, sourceRevision: string, origin: 'account', customOrder = readInteger(source.normalizedSource.customOrder, 0)): ManagedSourceSummary { const time = readTimestamp(source.normalizedSource.lastUpdateTime); const author = [source.normalizedSource.author, source.normalizedSource.bookSourceAuthor].find((value): value is string => typeof value === 'string' && value.trim().length > 0); return { ...(author === undefined ? {} : { author: author.trim() }), ...(source.sourceUuid ? { sourceUuid: source.sourceUuid } : {}), ...(source.importLinkId ? { importLinkId: source.importLinkId } : {}), sourceId: source.sourceId, name: source.name, ...(source.group === undefined ? {} : { group: source.group }), fingerprint: source.fingerprint, enabled: source.enabled, customOrder, sourceRevision, origin, ...(time === undefined ? {} : { lastUpdateTime: time }) } }
function readInteger(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback }
function readTimestamp(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined }
function sameStringSet(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)) }
function mergeImportedSource(local: StoredSourceRecord | undefined, remote: NormalizedSource): NormalizedSource {
  if (local === undefined) return remote
  const result = { ...remote } as Record<string, unknown>
  const localValue = local.normalizedSource as Record<string, unknown>
  for (const key of ['bookSourceName', 'bookSourceGroup', 'enabled', 'enabledExplore', 'customOrder', 'weight']) {
    if (Object.prototype.hasOwnProperty.call(localValue, key)) result[key] = localValue[key]
    else delete result[key]
  }
  return result as NormalizedSource
}
function defaultReaderSettings(userId: string): ReaderSettings { return { userId, ...DEFAULT_READER_SETTINGS, updatedAt: new Date().toISOString() } }
function mergeReaderSettings(current: ReaderSettings, patch: ReaderSettingsPatch, updatedAt: string): ReaderSettings { return { ...current, ...patch, general: { ...current.general, ...patch.general }, updatedAt } }
function readerSettingsValues(userId: string, settings: ReaderSettings, updatedAt: Date) {
  const preferences: ReaderSettingsPreferences = {
    schemaVersion: 1,
    general: settings.general,
    pageTapZones: settings.pageTapZones,
    display: {
      theme: settings.theme,
      readingMode: settings.readingMode,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      marginTop: settings.marginTop,
      marginRight: settings.marginRight,
      marginBottom: settings.marginBottom,
      marginLeft: settings.marginLeft,
    },
  }
  return { userId, preferences, updatedAt }
}
function toSettings(row: ReaderSettingsRow): ReaderSettings {
  const preferences = settingsObject(row.preferences)
  const general = settingsObject(preferences.general)
  const display = settingsObject(preferences.display)
  const bookshelfSort = general.bookshelfSort === 'lastReadAt' ? 'lastReadAt' : DEFAULT_READER_SETTINGS.general.bookshelfSort
  return {
    userId: row.userId,
    theme: display.theme === 'system' || display.theme === 'light' || display.theme === 'dark' ? display.theme : DEFAULT_READER_SETTINGS.theme,
    readingMode: display.readingMode === 'scroll' || display.readingMode === 'paged' ? display.readingMode : DEFAULT_READER_SETTINGS.readingMode,
    fontSize: typeof display.fontSize === 'number' && Number.isInteger(display.fontSize) && display.fontSize >= 15 && display.fontSize <= 28 ? display.fontSize : DEFAULT_READER_SETTINGS.fontSize,
    lineHeight: typeof display.lineHeight === 'number' && display.lineHeight >= 1.4 && display.lineHeight <= 2.6 ? display.lineHeight : DEFAULT_READER_SETTINGS.lineHeight,
    marginTop: typeof display.marginTop === 'number' && Number.isInteger(display.marginTop) && display.marginTop >= 0 && display.marginTop <= 64 ? display.marginTop : DEFAULT_READER_SETTINGS.marginTop,
    marginRight: typeof display.marginRight === 'number' && Number.isInteger(display.marginRight) && display.marginRight >= 0 && display.marginRight <= 64 ? display.marginRight : DEFAULT_READER_SETTINGS.marginRight,
    marginBottom: typeof display.marginBottom === 'number' && Number.isInteger(display.marginBottom) && display.marginBottom >= 0 && display.marginBottom <= 64 ? display.marginBottom : DEFAULT_READER_SETTINGS.marginBottom,
    marginLeft: typeof display.marginLeft === 'number' && Number.isInteger(display.marginLeft) && display.marginLeft >= 0 && display.marginLeft <= 64 ? display.marginLeft : DEFAULT_READER_SETTINGS.marginLeft,
    general: { searchConcurrency: searchConcurrencySchema.catch(DEFAULT_SEARCH_CONCURRENCY).parse(general.searchConcurrency), bookshelfSort, bookshelfInitialGroup: typeof general.bookshelfInitialGroup === 'string' ? general.bookshelfInitialGroup : 'all' },
    pageTapZones: readPageTapZones(preferences.pageTapZones),
    updatedAt: row.updatedAt.toISOString(),
  }
}
function readPageTapZones(value: unknown): ReaderSettings['pageTapZones'] {
  const zones = settingsObject(value)
  const { leftWidthPercent, centerWidthPercent, centerTopHeightPercent, centerMiddleHeightPercent, centerTopAction, centerBottomAction } = zones
  const validPercent = (part: unknown): part is number => typeof part === 'number' && Number.isInteger(part) && part >= 18 && part <= 64
  const validAction = (part: unknown): part is 'previous' | 'next' => part === 'previous' || part === 'next'
  if (!validPercent(leftWidthPercent) || !validPercent(centerWidthPercent) || !validPercent(centerTopHeightPercent) || !validPercent(centerMiddleHeightPercent) || leftWidthPercent + centerWidthPercent > 82 || centerTopHeightPercent + centerMiddleHeightPercent > 82 || !validAction(centerTopAction) || !validAction(centerBottomAction)) return DEFAULT_READER_SETTINGS.pageTapZones
  return { leftWidthPercent, centerWidthPercent, centerTopHeightPercent, centerMiddleHeightPercent, centerTopAction, centerBottomAction }
}
function settingsObject(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function toBook(row: BookRow): StoredBook { return { id: row.id, userId: row.userId, name: row.name, ...(row.author === null ? {} : { author: row.author }), ...(row.intro === null ? {} : { intro: row.intro }), ...(row.coverUrl === null ? {} : { coverUrl: row.coverUrl }), ...(row.customCoverUrl === null ? {} : { customCoverUrl: row.customCoverUrl }), ...(row.activeEditionKey === null ? {} : { activeEditionKey: row.activeEditionKey }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toEdition(row: BookEditionRow): StoredEdition { return { id: row.id, userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint, bookUrl: row.bookUrl, metadata: row.metadata, ...(row.variable === null ? {} : { variable: row.variable }) } }
// 结果只存于 candidates；逐源状态保存元数据，读取时共享同一批候选对象，避免 JSON 重复存储和解析。
function compactSearchStates(states: SourceSearchState[]): SourceSearchState[] { return states.map((state) => ({ ...state, candidates: [] })) }
function toSearch(row: SearchRunRow): SearchRunState {
  const candidatesBySource = new Map<string, StoredCandidate[]>()
  for (const candidate of row.candidates) {
    const group = candidatesBySource.get(candidate.sourceId) ?? []
    group.push(candidate); candidatesBySource.set(candidate.sourceId, group)
  }
  const sourceStates = row.sourceStates.map((state) => ({ ...state, candidates: state.candidates.length > 0 ? state.candidates : candidatesBySource.get(state.sourceId) ?? [] }))
  const sourceIds = row.sourceIds.length === 0 ? [row.sourceId] : row.sourceIds
  return {
    id: row.id, userId: row.userId, keyword: row.keyword, sourceId: row.sourceId, sourceIds,
    ...(row.precision ? { precision: true } : {}),
    ...(row.sourceFingerprint === null ? {} : { sourceFingerprint: row.sourceFingerprint }),
    status: row.status as SearchRunState['status'], candidates: row.candidates, sourceStates,
    ...(row.cursor == null ? {} : { cursor: row.cursor }),
    ...(row.nextCursor == null ? {} : { nextCursor: row.nextCursor }),
    ...(row.operationId === null ? {} : { operationId: row.operationId }),
    progress: { completed: row.progressCompleted, total: row.progressTotal === 0 ? sourceIds.length : row.progressTotal },
    version: row.version, cancelled: row.cancelled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }
}
function toHistory(row: SearchHistoryRow): SearchHistoryItem { return { id: row.id, searchId: row.searchId, keyword: row.keyword, sourceIds: row.sourceIds, status: row.status, resultCount: row.resultCount, ...(row.summary === null ? {} : { summary: row.summary }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function searchSummary(status: string, count: number): string { if (status === 'success') return `${count} 条结果`; if (status === 'empty') return '没有找到结果'; if (status === 'partial') return `${count} 条结果，部分书源失败`; if (status === 'cancelled') return '已取消'; if (status === 'failed') return '搜索失败'; return status }
function toToc(row: TocSnapshotRow): StoredToc { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceFingerprint: row.sourceFingerprint, revision: row.revision, chapters: row.chapters, bookPatch: row.bookPatch, ...(row.bookAfter === null || row.bookAfter === undefined ? {} : { bookAfter: row.bookAfter }), ...(row.truncated === true ? { truncated: true } : {}), updatedAt: row.updatedAt.toISOString() } }
function toContent(row: ChapterContentRow): StoredContent { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, tocRevision: row.tocRevision, sourceFingerprint: row.sourceFingerprint, content: row.content, updatedAt: row.updatedAt.toISOString() } }
function toPosition(row: typeof readingRecords.$inferSelect): StoredPosition { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, chapterUrl: row.chapterUrl, chapterIndex: row.chapterIndex, title: row.title, ...(row.tocRevision === null ? {} : { tocRevision: row.tocRevision }), paragraphIndex: row.paragraphIndex, offset: row.offset, version: row.version, lastReadAt: row.lastReadAt.toISOString() } }

function assertBackupSnapshotClosed(snapshot: ReaderBackupSnapshot, userId: string): void {
  if (!snapshot.organization && snapshot.bookshelf.some((row) => row.groupId != null)) throw new BackupRestoreError('备份缺少分组定义')
  if (snapshot.organization) {
    const { lists, items } = snapshot.organization
    for (const row of lists) if (row.userId !== userId || (row.type === 'shelf_group' && (row.description !== '' || row.isPublic))) throw new BackupRestoreError('书单归属或类型字段无效')
    const groups = new Set(lists.filter((row) => row.type === 'shelf_group').map((row) => row.id))
    if (new Set(lists.map((row) => row.id)).size !== lists.length || new Set(items.map((row) => `${row.bookListId}:${row.bookId}`)).size !== items.length) throw new BackupRestoreError('书单记录重复')
    const names = lists.filter((row) => row.type === 'shelf_group').map((row) => row.name)
    if (new Set(names).size !== names.length || names.some((name) => name === '全部' || name === '默认' || [...name].length > 30)) throw new BackupRestoreError('分组名称无效')
    for (const row of items) if (row.userId !== userId || !lists.some((list) => list.id === row.bookListId && list.type === 'booklist') || !snapshot.books.some((book) => book.book.id === row.bookId)) throw new BackupRestoreError('书单书籍关联无效')
    for (const row of snapshot.bookshelf) if (row.groupId && !groups.has(row.groupId)) throw new BackupRestoreError('书架分组关联无效')
  }

  const sourceIds = new Set<string>()
  for (const item of snapshot.sources) {
    if (item.source.sourceId.length === 0 || sourceIds.has(item.source.sourceId)) throw new BackupRestoreError(`书源定义重复：${item.source.sourceId}`)
    sourceIds.add(item.source.sourceId)
  }
  const bookIds = new Set<string>()
  const editionOwners = new Map<string, string>()
  const candidateOwners = new Map<string, string>()
  for (const item of snapshot.books) {
    if (item.book.userId !== userId || bookIds.has(item.book.id) || item.editions.length === 0) throw new BackupRestoreError(`书籍数据无效：${item.book.id}`)
    bookIds.add(item.book.id)
    for (const edition of item.editions) {
      if (edition.userId !== userId || edition.bookId !== item.book.id || edition.editionKey !== backupEditionKey(edition.sourceId, edition.bookUrl)) throw new BackupRestoreError(`书籍版本数据无效：${item.book.id}`)
      const owner = editionOwners.get(edition.editionKey)
      if (owner !== undefined && owner !== item.book.id) throw new BackupRestoreError(`书籍版本重复：${edition.editionKey}`)
      editionOwners.set(edition.editionKey, item.book.id)
    }
    if (item.book.activeEditionKey !== undefined && !item.editions.some((edition) => edition.editionKey === item.book.activeEditionKey)) throw new BackupRestoreError(`书籍活动版本不存在：${item.book.id}`)
    for (const candidate of item.candidates) {
      if (candidate.userId !== userId || candidate.bookId !== item.book.id || candidate.sourceFingerprint.length === 0 || candidate.candidate.sourceId !== candidate.sourceId || candidate.candidate.sourceFingerprint !== candidate.sourceFingerprint || candidate.candidate.candidate.bookUrl !== candidate.bookUrl) throw new BackupRestoreError(`书籍候选数据无效：${item.book.id}`)
      const candidateKey = backupEditionKey(candidate.sourceId, candidate.bookUrl)
      if (editionOwners.has(candidateKey) || candidateOwners.has(candidateKey)) throw new BackupRestoreError(`书籍候选版本重复：${candidateKey}`)
      candidateOwners.set(candidateKey, item.book.id)
    }
  }
  for (const item of snapshot.bookshelf) if (!bookIds.has(item.bookId)) throw new BackupRestoreError(`书架缺少书籍：${item.bookId}`)
  for (const position of snapshot.positions) if (position.userId !== userId || !editionOwners.has(position.editionKey) || !snapshot.books.some((item) => item.book.id === position.bookId && item.editions.some((edition) => edition.editionKey === position.editionKey))) throw new BackupRestoreError(`阅读记录缺少书籍版本：${position.editionKey}`)
  const historyIds = new Set<string>()
  const searchIds = new Set<string>()
  for (const item of snapshot.searchHistory) {
    if (!isUuid(item.id) || historyIds.has(item.id) || !isUuid(item.searchId) || searchIds.has(item.searchId) || !isIsoDateString(item.createdAt) || !isIsoDateString(item.updatedAt)) throw new BackupRestoreError(`搜索记录数据无效：${item.id}`)
    historyIds.add(item.id)
    searchIds.add(item.searchId)
  }
  for (const kind of ['bookmarks', 'annotations'] as const) {
    const ids = new Set<string>()
    for (const row of snapshot[kind] ?? []) {
      if (!readingMarkSchema.safeParse(row).success || row.userId !== userId || ids.has(row.id) || !snapshot.books.some((item) => item.book.id === row.bookId && item.editions.some((e) => e.editionKey === row.editionKey))) throw new BackupRestoreError('批注缺少书籍版本或记录格式无效')
      ids.add(row.id)
    }
    validateMarkCollection(snapshot[kind] ?? [], kind)
  }
  if (snapshot.settings.userId !== userId) throw new BackupRestoreError('阅读设置用户不匹配')
}

export function createRepository(): ReaderRepository { return new PostgresReaderRepository() }

export function sourceSummaryFromSource(source: NormalizedSource, fingerprint: string, enabled = true): SourceSummary { return { sourceId: source.bookSourceUrl, name: source.bookSourceName, ...(typeof source.bookSourceGroup === 'string' ? { group: source.bookSourceGroup } : {}), fingerprint, enabled } }

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) }

/** 缓存去掉只能在搜索响应中使用的详情页正文，但保留 JS 详情脚本重建候选所需的变量和原始字段。 */
function cacheableCandidate(stored: StoredCandidate): StoredCandidate {
  const { sourceId, bookUrl, name, author, intro, coverUrl, kind, wordCount, lastChapter, updateTime, tocUrl, variable, rawFields } = stored.candidate
  const fields = Object.fromEntries(Object.entries({ name, author, intro, coverUrl, kind, wordCount, lastChapter, updateTime, tocUrl }).filter(([, value]) => value !== undefined))
  return { sourceId: stored.sourceId, sourceFingerprint: stored.sourceFingerprint, ...(stored.searchDurationMs === undefined ? {} : { searchDurationMs: stored.searchDurationMs }), candidate: { sourceId, bookUrl, ...fields, ...(variable === undefined ? {} : { variable }), rawFields: structuredClone(rawFields), traceRef: 'book-source-cache' } }
}

async function readOrganization(tx: ReaderTransaction, userId: string, listId?: string, includeItems = true): Promise<BookListOrganizationSnapshot> {
  const lists = await tx.select().from(bookLists).where(and(eq(bookLists.userId, userId), listId ? eq(bookLists.id, listId) : undefined))
  const items = includeItems ? await tx.select().from(bookListItems).where(and(eq(bookListItems.userId, userId), listId ? eq(bookListItems.bookListId, listId) : undefined)) : []
  return { lists: lists.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })), items: items.map((row) => ({ ...row, addedAt: row.addedAt.toISOString(), updatedAt: row.updatedAt.toISOString() })) }
}

async function readBackupSnapshot(transaction: ReaderTransaction, userId: string): Promise<ReaderBackupSnapshot> {
  const [sourceRows, settingRows, bookRows, editionRows, candidateRows, shelfRows, positionRows, historyRows] = await Promise.all([
    transaction.select().from(userSources).where(eq(userSources.userId, userId)),
    transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1),
    transaction.select().from(books).where(eq(books.userId, userId)),
    transaction.select().from(bookEditions).where(eq(bookEditions.userId, userId)),
    transaction.select().from(bookSourceCandidates).where(eq(bookSourceCandidates.userId, userId)),
    transaction.select().from(bookshelf).where(eq(bookshelf.userId, userId)),
    transaction.select().from(readingRecords).where(eq(readingRecords.userId, userId)),
    transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt))),
  ])
  const editionsByBook = new Map<string, StoredEdition[]>()
  for (const row of editionRows) editionsByBook.set(row.bookId, [...(editionsByBook.get(row.bookId) ?? []), toEdition(row)])
  const candidatesByBook = new Map<string, StoredBookSourceCandidate[]>()
  for (const row of candidateRows) candidatesByBook.set(row.bookId, [...(candidatesByBook.get(row.bookId) ?? []), { ...row, updatedAt: row.updatedAt.toISOString() }])
  return {
    sources: sourceRows.map((row) => ({ source: toUserSource(row), sourceRevision: row.revision, ...(row.deleted ? { deleted: true } : {}) })),
    settings: settingRows[0] === undefined ? defaultReaderSettings(userId) : toSettings(settingRows[0]),
    books: bookRows.map((row) => ({ book: toBook(row), editions: editionsByBook.get(row.id) ?? [], candidates: candidatesByBook.get(row.id) ?? [] })),
    organization: await readOrganization(transaction, userId),
    bookmarks: (await readMarks(transaction, userId, { kind: 'bookmarks', all: true })).items,
    annotations: (await readMarks(transaction, userId, { kind: 'annotations', all: true })).items,
    bookshelf: shelfRows.map((row) => ({ bookId: row.bookId, addedAt: row.addedAt.toISOString(), groupId: row.groupId })),
    positions: positionRows.map(toPosition),
    searchHistory: historyRows.map(toHistory),
  }

}

function prepareOrganizationRestore(current: ReaderBackupSnapshot, input: ReaderBackupSnapshot, selected: ReadonlySet<BackupCategory>): ReaderBackupSnapshot {
  assertBackupSnapshotClosed(input, input.settings.userId)
  const next = structuredClone(input)
  if (!selected.has('settings')) next.settings = structuredClone(current.settings)
  if (selected.has('bookshelf')) {
    // 缺少批注扩展或未选择恢复批注时，保留其书籍及版本依赖。
    const retained = (['bookmarks', 'annotations'] as const).flatMap((kind) => !selected.has('reading') || next[kind] === undefined ? current[kind] ?? [] : [])
    for (const old of current.books.filter((entry) => retained.some((row) => row.bookId === entry.book.id))) {
      let incoming = next.books.find((entry) => entry.book.id === old.book.id)
      if (incoming && (normalizeIdentity(incoming.book.name) !== normalizeIdentity(old.book.name) || normalizeIdentity(incoming.book.author ?? '') !== normalizeIdentity(old.book.author ?? ''))) throw new BackupRestoreError('导入书籍与现有笔记的书籍标识冲突，请先保留现有书籍')
      if (!incoming) { incoming = structuredClone(old); next.books.push(incoming) }
      else for (const edition of old.editions.filter((e) => retained.some((row) => row.bookId === old.book.id && row.editionKey === e.editionKey))) if (!incoming.editions.some((e) => e.editionKey === edition.editionKey)) incoming.editions.push(structuredClone(edition))
    }
    const editionOwners = new Map<string, string>()
    for (const entry of next.books) for (const edition of entry.editions) {
      const owner = editionOwners.get(edition.editionKey)
      if (owner && owner !== entry.book.id) throw new BackupRestoreError('导入版本与现有笔记的书籍冲突，请保留原版本后恢复')
      editionOwners.set(edition.editionKey, entry.book.id)
    }
  }
  const listIdMap = new Map<string, string>()
  if (selected.has('bookshelf') && next.organization) {
    for (const row of next.organization.lists) { const previous = row.id; row.id = randomUUID(); listIdMap.set(previous, row.id) }
    for (const row of next.organization.items) row.bookListId = listIdMap.get(row.bookListId) ?? row.bookListId
    for (const row of next.bookshelf) if (row.groupId) row.groupId = listIdMap.get(row.groupId) ?? row.groupId
    const initial = next.settings.general.bookshelfInitialGroup
    if (initial && listIdMap.has(initial)) next.settings.general.bookshelfInitialGroup = listIdMap.get(initial)!
  }
  const organization = selected.has('bookshelf') ? next.organization ?? current.organization : current.organization
  if (selected.has('bookshelf') && next.organization === undefined && organization) {
    // 旧备份不包含书单扩展，保留本地书单依赖，避免替换书架后关联悬空。
    const referenced = new Set(organization.items.map((row) => row.bookId))
    const incoming = new Map(next.books.map((row) => [row.book.id, row]))
    for (const old of current.books.filter((row) => referenced.has(row.book.id))) {
      const conflict = incoming.get(old.book.id)
      if (conflict && (normalizeIdentity(conflict.book.name) !== normalizeIdentity(old.book.name) || normalizeIdentity(conflict.book.author ?? '') !== normalizeIdentity(old.book.author ?? ''))) {
        const replacement = randomUUID()
        conflict.book.id = replacement
        for (const row of conflict.editions) row.bookId = replacement
        for (const row of conflict.candidates) row.bookId = replacement
        for (const row of next.bookshelf) if (row.bookId === old.book.id) row.bookId = replacement
        for (const row of next.positions) if (row.bookId === old.book.id) row.bookId = replacement
        for (const row of [...(next.bookmarks ?? []), ...(next.annotations ?? [])]) if (row.bookId === old.book.id) row.bookId = replacement
        next.books.push(structuredClone(old))
      } else if (!conflict) next.books.push(structuredClone(old))
    }
    next.organization = structuredClone(organization)
  }
  const target = next.settings.general.bookshelfInitialGroup ?? 'all'
  const valid = target === 'all' || target === 'ungrouped' || organization?.lists.some((row) => row.type === 'shelf_group' && row.id === target)
  if (selected.has('settings')) next.settings.general.bookshelfInitialGroup = valid ? target : 'all'
  else if (!valid) next.settings.general.bookshelfInitialGroup = 'all'
  assertBackupSnapshotClosed(next, next.settings.userId)
  return next
}

export function compareSourcePriority(left: StoredSourceRecord, right: StoredSourceRecord): number { return (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER) || compareStoredSourceManagementOrder(left, right) }

const bookDisplayColumns = { id: books.id, name: books.name, author: books.author, coverUrl: books.coverUrl, customCoverUrl: books.customCoverUrl }
const bookListDisplayColumns = { id: bookLists.id, name: bookLists.name, description: bookLists.description, createdAt: bookLists.createdAt, updatedAt: bookLists.updatedAt }
function displayBook(row: { id: string; name: string; author?: string | null; coverUrl?: string | null; customCoverUrl?: string | null }): BookDisplay {
  return { id: row.id, name: row.name, ...(row.author == null ? {} : { author: row.author }), ...(row.coverUrl == null ? {} : { coverUrl: row.coverUrl }), ...(row.customCoverUrl == null ? {} : { customCoverUrl: row.customCoverUrl }) }
}
function displayPosition(row: { chapterId: string; title: string; lastReadAt: Date | string }) { return { chapterId: row.chapterId, title: row.title, lastReadAt: typeof row.lastReadAt === 'string' ? row.lastReadAt : row.lastReadAt.toISOString() } }

function sourceManagementStats(sources: Array<{ sourceId: string; enabled: boolean }>): SourceManagementStats {
  const domains = new Set<string>()
  const enabledDomains = new Set<string>()
  for (const source of sources) {
    const key = sourceDomainInfo(source.sourceId).key
    domains.add(key)
    if (source.enabled) enabledDomains.add(key)
  }
  return { total: sources.length, domainCount: domains.size, enabledDomainCount: enabledDomains.size }
}

export function tocSummary(toc: StoredToc): CachedTocSummary {
  return { bookId: toc.bookId, editionKey: toc.editionKey, sourceFingerprint: toc.sourceFingerprint, revision: toc.revision,
    chapters: toc.chapters.map(({ chapterUrl, index, title, isVolume, isVip }) => ({ chapterId: createHash('sha256').update(`${chapterUrl}\u0000${index}`).digest('hex'), chapterUrl, index, title, ...(isVolume === undefined ? {} : { isVolume }), ...(isVip === undefined ? {} : { isVip }) })),
    ...(toc.truncated === undefined ? {} : { truncated: toc.truncated }) }
}
