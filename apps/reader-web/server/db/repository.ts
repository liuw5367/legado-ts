import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { NormalizedSource, PageCursor } from '@legado/source-core'
import { withReaderDb, withUser } from './client.ts'
import { bookEditions, books, bookshelf, chapterContents, readingRecords, searchHistory, searchRuns, sources, tocSnapshots, type BookEditionRow, type BookRow, type ChapterContentRow, type SearchHistoryRow, type SearchRunRow, type SourceRow, type TocSnapshotRow } from './schema.ts'
import type { BookCreationInput, HomeSnapshot, SearchHistoryItem, SearchInput, SearchRunState, SourceSearchState, SourceSummary, StoredBook, StoredCandidate, StoredContent, StoredEdition, StoredPosition, StoredToc } from '../domain/types.ts'

export interface StoredSourceRecord extends SourceSummary {
  rawSource: unknown
  normalizedSource: NormalizedSource
}

export interface ReaderRepository {
  upsertSources(records: Array<{ sourceId: string; fingerprint: string; rawSource: unknown; normalizedSource: NormalizedSource }>): Promise<void>
  listSources(): Promise<StoredSourceRecord[]>
  getSource(sourceId: string): Promise<StoredSourceRecord | null>
  createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState>
  getSearch(userId: string, searchId: string): Promise<SearchRunState | null>
  claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }): Promise<SearchRunState | null>
  updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null>
  createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }>
  addToBookshelf(userId: string, bookId: string): Promise<void>
  removeFromBookshelf(userId: string, bookId: string): Promise<void>
  getHome(userId: string): Promise<HomeSnapshot>
  deleteSearchHistory(userId: string, historyId: string): Promise<boolean>
  listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>>
  getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null>
  getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null>
  saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc>
  getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null>
  saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent>
  getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null>
  savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition>
}

export class PostgresReaderRepository implements ReaderRepository {
  public async upsertSources(records: Array<{ sourceId: string; fingerprint: string; rawSource: unknown; normalizedSource: NormalizedSource }>): Promise<void> {
    if (records.length === 0) return
    await withReaderDb(async (database) => {
      for (const record of records) {
        await database.insert(sources).values({ sourceId: record.sourceId, fingerprint: record.fingerprint, rawSource: record.rawSource, normalizedSource: record.normalizedSource, enabled: true }).onConflictDoUpdate({ target: sources.sourceId, set: { fingerprint: record.fingerprint, rawSource: record.rawSource, normalizedSource: record.normalizedSource, enabled: true, updatedAt: new Date() } })
      }
    })
  }

  public listSources(): Promise<StoredSourceRecord[]> {
    return withReaderDb(async (database) => {
      const rows = await database.select().from(sources).where(eq(sources.enabled, true)).orderBy(asc(sources.customOrder), asc(sources.sourceId))
      return rows.map(toSource)
    })
  }

  public async getSource(sourceId: string): Promise<StoredSourceRecord | null> {
    return withReaderDb(async (database) => {
      const [row] = await database.select().from(sources).where(and(eq(sources.sourceId, sourceId), eq(sources.enabled, true))).limit(1)
      return row === undefined ? null : toSource(row)
    })
  }

  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> {
    return withUser(userId, async (transaction) => {
      const sourceIds = input.sourceIds === undefined || input.sourceIds.length === 0 ? [input.sourceId] : [...new Set(input.sourceIds)]
      const sourceStates: SourceSearchState[] = sourceIds.map((sourceId) => ({ sourceId, status: 'pending', candidates: [], diagnostics: [] }))
      const [row] = await transaction.insert(searchRuns).values({
        userId,
        keyword: input.keyword,
        sourceId: input.sourceId,
        sourceIds,
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

  public async claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({ operationId, sourceStates, progressCompleted: progress.completed, progressTotal: progress.total, status: 'running', cancelled: false, version: sql`${searchRuns.version} + 1`, updatedAt: new Date() }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId), isNull(searchRuns.operationId))).returning()
      return row === undefined ? null : toSearch(row)
    })
  }

  public async updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }),
        ...(patch.sourceStates === undefined ? {} : { sourceStates: patch.sourceStates }),
        ...(patch.sourceIds === undefined ? {} : { sourceIds: patch.sourceIds }),
        ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }),
        ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }),
        ...(patch.operationId === undefined ? {} : { operationId: patch.operationId }),
        ...(patch.progress === undefined ? {} : { progressCompleted: patch.progress.completed, progressTotal: patch.progress.total }),
        ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }),
        updatedAt: new Date(),
        version: sql`${searchRuns.version} + 1`,
      }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId), ...(patch.expectedOperationId === undefined ? [] : [eq(searchRuns.operationId, patch.expectedOperationId)]))).returning()
      if (row !== undefined) {
        const historyStatus = row.status === 'capability-missing' ? 'failed' : row.status
        await transaction.update(searchHistory).set({ status: historyStatus, resultCount: row.candidates.length, summary: searchSummary(historyStatus, row.candidates.length), updatedAt: new Date() }).where(and(eq(searchHistory.userId, userId), eq(searchHistory.searchId, searchId), isNull(searchHistory.deletedAt)))
      }
      return row === undefined ? null : toSearch(row)
    })
  }

  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> {
    return withUser(userId, async (transaction) => {
      const existing = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.editionKey, input.editionKey))).limit(1)
      const now = new Date()
      if (existing[0] !== undefined) {
        const [book] = await transaction.update(books).set({
          name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍',
          ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
          ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }),
          ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }),
          activeEditionKey: input.editionKey,
          updatedAt: now,
        }).where(and(eq(books.userId, userId), eq(books.id, existing[0].bookId))).returning()
        const [edition] = await transaction.update(bookEditions).set({
          sourceId: input.candidate.sourceId,
          sourceFingerprint: input.sourceFingerprint,
          bookUrl: input.metadata.bookUrl,
          metadata: input.metadata,
          ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }),
          updatedAt: now,
        }).where(and(eq(bookEditions.userId, userId), eq(bookEditions.editionKey, input.editionKey))).returning()
        if (book === undefined || edition === undefined) throw new Error('更新书籍失败')
        await transaction.insert(bookshelf).values({ userId, bookId: book.id }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] })
        return { book: toBook(book), edition: toEdition(edition) }
      }
      const [book] = await transaction.insert(books).values({
        userId,
        name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍',
        ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
        ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }),
        ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }),
        activeEditionKey: input.editionKey,
      }).returning()
      if (book === undefined) throw new Error('创建书籍失败')
      const [edition] = await transaction.insert(bookEditions).values({
        userId,
        bookId: book.id,
        editionKey: input.editionKey,
        sourceId: input.candidate.sourceId,
        sourceFingerprint: input.sourceFingerprint,
        bookUrl: input.metadata.bookUrl,
        metadata: input.metadata,
        ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }),
      }).returning()
      if (edition === undefined) throw new Error('创建书籍版本失败')
      await transaction.insert(bookshelf).values({ userId, bookId: book.id }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] })
      return { book: toBook(book), edition: toEdition(edition) }
    })
  }

  public async addToBookshelf(userId: string, bookId: string): Promise<void> {
    await withUser(userId, async (transaction) => { await transaction.insert(bookshelf).values({ userId, bookId }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] }) })
  }

  public async removeFromBookshelf(userId: string, bookId: string): Promise<void> {
    await withUser(userId, async (transaction) => { await transaction.delete(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, bookId))) })
  }

  public async getHome(userId: string): Promise<HomeSnapshot> {
    return withUser(userId, async (transaction) => {
      const shelfRows = await transaction.select({ book: books, edition: bookEditions }).from(bookshelf).innerJoin(books, and(eq(books.userId, userId), eq(books.id, bookshelf.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(bookshelf.userId, userId)).orderBy(desc(bookshelf.addedAt))
      const readingRows = await transaction.select({ book: books, edition: bookEditions, position: readingRecords }).from(readingRecords).innerJoin(books, and(eq(books.userId, userId), eq(books.id, readingRecords.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, readingRecords.bookId), eq(bookEditions.editionKey, readingRecords.editionKey))).where(eq(readingRecords.userId, userId)).orderBy(desc(readingRecords.lastReadAt)).limit(50)
      const historyRows = await transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt))).orderBy(desc(searchHistory.updatedAt)).limit(50)
      const positions = new Map(readingRows.map((row) => [`${row.book.id}:${row.edition.editionKey}`, toPosition(row.position)]))
      const shelf = shelfRows.map((row) => { const book = toBook(row.book); const edition = toEdition(row.edition); const position = positions.get(`${row.book.id}:${row.edition.editionKey}`); return position === undefined ? { book, edition } : { book, edition, position } })
      return { bookshelf: shelf, reading: readingRows.map((row) => ({ book: toBook(row.book), edition: toEdition(row.edition), position: toPosition(row.position) })), searchHistory: historyRows.map(toHistory) }
    })
  }

  public async deleteSearchHistory(userId: string, historyId: string): Promise<boolean> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchHistory).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(searchHistory.userId, userId), eq(searchHistory.id, historyId), isNull(searchHistory.deletedAt))).returning({ id: searchHistory.id })
      return row !== undefined
    })
  }

  public async listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select({ book: books, edition: bookEditions }).from(books).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(books.userId, userId)).orderBy(desc(books.updatedAt))
      return rows.map((row) => ({ book: toBook(row.book), edition: toEdition(row.edition) }))
    })
  }

  public async getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null> {
    return withUser(userId, async (transaction) => {
      const conditions = [eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), ...(editionKey === undefined ? [] : [eq(bookEditions.editionKey, editionKey)])]
      const [row] = await transaction.select().from(bookEditions).where(and(...conditions)).orderBy(desc(bookEditions.updatedAt)).limit(1)
      return row === undefined ? null : toEdition(row)
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
        ...(toc.bookAfter === undefined ? {} : { bookAfter: toc.bookAfter }),
        updatedAt: new Date(),
      }).onConflictDoUpdate({ target: [tocSnapshots.userId, tocSnapshots.editionKey], set: {
        sourceFingerprint: toc.sourceFingerprint,
        revision: toc.revision,
        chapters: toc.chapters,
        bookPatch: toc.bookPatch,
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
  private readonly sourceMap = new Map<string, StoredSourceRecord>()
  private readonly searches = new Map<string, SearchRunState>()
  private readonly books = new Map<string, { book: StoredBook; edition: StoredEdition }>()
  private readonly tocs = new Map<string, StoredToc>()
  private readonly contents = new Map<string, StoredContent>()
  private readonly positions = new Map<string, StoredPosition>()
  private readonly shelf = new Map<string, string>()
  private readonly history = new Map<string, SearchHistoryItem>()

  public constructor(sourcesToSeed: StoredSourceRecord[] = []) { for (const source of sourcesToSeed) this.sourceMap.set(source.sourceId, source) }
  public async upsertSources(records: Array<{ sourceId: string; fingerprint: string; rawSource: unknown; normalizedSource: NormalizedSource }>): Promise<void> { for (const record of records) this.sourceMap.set(record.sourceId, { sourceId: record.sourceId, name: record.normalizedSource.bookSourceName, ...(typeof record.normalizedSource.bookSourceGroup === 'string' ? { group: record.normalizedSource.bookSourceGroup } : {}), fingerprint: record.fingerprint, enabled: true, rawSource: record.rawSource, normalizedSource: record.normalizedSource }) }
  public async listSources(): Promise<StoredSourceRecord[]> { return [...this.sourceMap.values()].filter((source) => source.enabled) }
  public async getSource(sourceId: string): Promise<StoredSourceRecord | null> { const source = this.sourceMap.get(sourceId); return source?.enabled === true ? source : null }
  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> { const now = new Date().toISOString(); const sourceIds = input.sourceIds === undefined || input.sourceIds.length === 0 ? [input.sourceId] : [...new Set(input.sourceIds)]; const sourceStates: SourceSearchState[] = sourceIds.map((sourceId) => ({ sourceId, status: 'pending', candidates: [], diagnostics: [] })); const search: SearchRunState = { id: randomUUID(), userId, keyword: input.keyword, sourceId: sourceIds[0] ?? input.sourceId, sourceIds, ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }), status: 'running', candidates: [], sourceStates, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), progress: { completed: 0, total: sourceIds.length }, version: 0, cancelled: false, createdAt: now, updatedAt: now }; this.searches.set(search.id, search); this.history.set(`${userId}:${search.id}`, { id: randomUUID(), searchId: search.id, keyword: input.keyword, sourceIds, status: 'running', resultCount: 0, createdAt: now, updatedAt: now }); return search }
  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> { const search = this.searches.get(searchId); return search?.userId === userId ? search : null }
  public async claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }): Promise<SearchRunState | null> { const current = await this.getSearch(userId, searchId); if (current === null || current.operationId !== undefined) return null; return this.updateSearch(userId, searchId, { sourceStates, progress, operationId, status: 'running', cancelled: false }) }
  public async updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null> { const current = await this.getSearch(userId, searchId); if (current === null || (patch.expectedOperationId !== undefined && current.operationId !== patch.expectedOperationId)) return null; const updated: SearchRunState = { ...current, ...(patch.status === undefined ? {} : { status: patch.status }), ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }), ...(patch.sourceStates === undefined ? {} : { sourceStates: patch.sourceStates }), ...(patch.sourceIds === undefined ? {} : { sourceIds: patch.sourceIds }), ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }), ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }), ...(patch.operationId === undefined || patch.operationId === null ? {} : { operationId: patch.operationId }), ...(patch.progress === undefined ? {} : { progress: patch.progress }), ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }), updatedAt: new Date().toISOString(), version: current.version + 1 }; if (patch.operationId === null) delete updated.operationId; this.searches.set(searchId, updated); const history = this.history.get(`${userId}:${searchId}`); if (history !== undefined) this.history.set(`${userId}:${searchId}`, { ...history, status: updated.status, resultCount: updated.candidates.length, summary: searchSummary(updated.status, updated.candidates.length), updatedAt: updated.updatedAt }); return updated }
  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> { const existing = [...this.books.values()].find((item) => item.book.userId === userId && item.edition.editionKey === input.editionKey); const now = new Date().toISOString(); const book: StoredBook = existing?.book ?? { id: randomUUID(), userId, name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍', ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), activeEditionKey: input.editionKey, createdAt: now, updatedAt: now }; const updatedBook = { ...book, name: input.metadata.name ?? book.name, ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), activeEditionKey: input.editionKey, updatedAt: now }; const edition: StoredEdition = { id: existing?.edition.id ?? randomUUID(), userId, bookId: updatedBook.id, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }; const value = { book: updatedBook, edition }; this.books.set(`${userId}:${input.editionKey}`, value); this.shelf.set(`${userId}:${updatedBook.id}`, now); return value }
  public async addToBookshelf(userId: string, bookId: string): Promise<void> { this.shelf.set(`${userId}:${bookId}`, new Date().toISOString()) }
  public async removeFromBookshelf(userId: string, bookId: string): Promise<void> { this.shelf.delete(`${userId}:${bookId}`) }
  public async getHome(userId: string): Promise<HomeSnapshot> { const values = [...this.books.values()].filter((item) => item.book.userId === userId); const reading = [...this.positions.values()].filter((position) => position.userId === userId).sort((a, b) => b.lastReadAt.localeCompare(a.lastReadAt)).map((position) => { const value = values.find((item) => item.book.id === position.bookId && item.edition.editionKey === position.editionKey); return value === undefined ? undefined : { book: value.book, edition: value.edition, position } }).filter((item): item is { book: StoredBook; edition: StoredEdition; position: StoredPosition } => item !== undefined); const shelfValues = values.filter((item) => this.shelf.has(`${userId}:${item.book.id}`)).sort((a, b) => (this.shelf.get(`${userId}:${b.book.id}`) ?? '').localeCompare(this.shelf.get(`${userId}:${a.book.id}`) ?? '')); const shelf = shelfValues.map((value) => { const position = this.positions.get(`${userId}:${value.book.id}:${value.edition.editionKey}`); return position === undefined ? value : { ...value, position } }); return { bookshelf: shelf, reading, searchHistory: [...this.history.values()].filter((item) => this.searches.get(item.searchId)?.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  }
  public async deleteSearchHistory(userId: string, historyId: string): Promise<boolean> { const item = [...this.history.entries()].find(([, value]) => value.id === historyId && this.searches.get(value.searchId)?.userId === userId); if (item === undefined) return false; this.history.delete(item[0]); return true }
  public async listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>> { return [...this.books.values()].filter((item) => item.book.userId === userId).sort((a, b) => b.book.updatedAt.localeCompare(a.book.updatedAt)) }
  public async getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null> { const item = [...this.books.values()].find((value) => value.book.userId === userId && value.book.id === bookId && (editionKey === undefined || value.edition.editionKey === editionKey)); return item?.edition ?? null }
  public async getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null> { return this.tocs.get(`${userId}:${bookId}:${editionKey}`) ?? null }
  public async saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc> { const value = { ...toc, userId, updatedAt: new Date().toISOString() }; this.tocs.set(`${userId}:${toc.bookId}:${toc.editionKey}`, value); return value }
  public async getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null> { return this.contents.get(`${userId}:${editionKey}:${tocRevision}:${chapterId}`) ?? null }
  public async saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent> { const value = { ...content, userId, updatedAt: new Date().toISOString() }; this.contents.set(`${userId}:${content.editionKey}:${content.tocRevision}:${content.chapterId}`, value); return value }
  public async getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null> { return this.positions.get(`${userId}:${bookId}:${editionKey}`) ?? null }
  public async savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition> { const value = { ...position, userId, lastReadAt: position.lastReadAt ?? new Date().toISOString() }; this.positions.set(`${userId}:${position.bookId}:${position.editionKey}`, value); return value }
}

function toSource(row: SourceRow): StoredSourceRecord { return { sourceId: row.sourceId, name: typeof row.normalizedSource.bookSourceName === 'string' ? row.normalizedSource.bookSourceName : row.sourceId, ...(typeof row.normalizedSource.bookSourceGroup === 'string' ? { group: row.normalizedSource.bookSourceGroup } : {}), fingerprint: row.fingerprint, enabled: row.enabled, rawSource: row.rawSource, normalizedSource: row.normalizedSource } }
function toBook(row: BookRow): StoredBook { return { id: row.id, userId: row.userId, name: row.name, ...(row.author === null ? {} : { author: row.author }), ...(row.intro === null ? {} : { intro: row.intro }), ...(row.coverUrl === null ? {} : { coverUrl: row.coverUrl }), ...(row.activeEditionKey === null ? {} : { activeEditionKey: row.activeEditionKey }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toEdition(row: BookEditionRow): StoredEdition { return { id: row.id, userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint, bookUrl: row.bookUrl, metadata: row.metadata, ...(row.variable === null ? {} : { variable: row.variable }) } }
function toSearch(row: SearchRunRow): SearchRunState { const sourceIds = row.sourceIds.length === 0 ? [row.sourceId] : row.sourceIds; return { id: row.id, userId: row.userId, keyword: row.keyword, sourceId: row.sourceId, sourceIds, ...(row.sourceFingerprint === null ? {} : { sourceFingerprint: row.sourceFingerprint }), status: row.status as SearchRunState['status'], candidates: row.candidates, sourceStates: row.sourceStates, ...(row.cursor === null || row.cursor === undefined ? {} : { cursor: row.cursor }), ...(row.nextCursor === null || row.nextCursor === undefined ? {} : { nextCursor: row.nextCursor }), ...(row.operationId === null ? {} : { operationId: row.operationId }), progress: { completed: row.progressCompleted, total: row.progressTotal === 0 ? sourceIds.length : row.progressTotal }, version: row.version, cancelled: row.cancelled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toHistory(row: SearchHistoryRow): SearchHistoryItem { return { id: row.id, searchId: row.searchId, keyword: row.keyword, sourceIds: row.sourceIds, status: row.status, resultCount: row.resultCount, ...(row.summary === null ? {} : { summary: row.summary }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function searchSummary(status: string, count: number): string { if (status === 'success') return `${count} 条结果`; if (status === 'empty') return '没有找到结果'; if (status === 'partial') return `${count} 条结果，部分书源失败`; if (status === 'cancelled') return '已取消'; if (status === 'failed') return '搜索失败'; return status }
function toToc(row: TocSnapshotRow): StoredToc { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceFingerprint: row.sourceFingerprint, revision: row.revision, chapters: row.chapters, bookPatch: row.bookPatch, ...(row.bookAfter === null || row.bookAfter === undefined ? {} : { bookAfter: row.bookAfter }), updatedAt: row.updatedAt.toISOString() } }
function toContent(row: ChapterContentRow): StoredContent { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, tocRevision: row.tocRevision, sourceFingerprint: row.sourceFingerprint, content: row.content, updatedAt: row.updatedAt.toISOString() } }
function toPosition(row: typeof readingRecords.$inferSelect): StoredPosition { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, chapterUrl: row.chapterUrl, chapterIndex: row.chapterIndex, title: row.title, ...(row.tocRevision === null ? {} : { tocRevision: row.tocRevision }), paragraphIndex: row.paragraphIndex, offset: row.offset, version: row.version, lastReadAt: row.lastReadAt.toISOString() } }

export function createRepository(): ReaderRepository { return new PostgresReaderRepository() }

export function sourceSummaryFromSource(source: NormalizedSource, fingerprint: string, enabled = true): SourceSummary { return { sourceId: source.bookSourceUrl, name: source.bookSourceName, ...(typeof source.bookSourceGroup === 'string' ? { group: source.bookSourceGroup } : {}), fingerprint, enabled } }
