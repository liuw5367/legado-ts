import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { NormalizedSource, PageCursor } from '@legado/source-core'
import { withReaderDb, withUser } from './client.ts'
import { bookEditions, books, chapterContents, readingRecords, searchRuns, sources, tocSnapshots, type BookEditionRow, type BookRow, type ChapterContentRow, type SearchRunRow, type SourceRow, type TocSnapshotRow } from './schema.ts'
import type { BookCreationInput, SearchInput, SearchRunState, SourceSummary, StoredBook, StoredCandidate, StoredContent, StoredEdition, StoredPosition, StoredToc } from '../domain/types.ts'

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
  updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; cursor?: PageCursor; nextCursor?: PageCursor; cancelled?: boolean }): Promise<SearchRunState | null>
  createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }>
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
      const [row] = await transaction.insert(searchRuns).values({
        userId,
        keyword: input.keyword,
        sourceId: input.sourceId,
        ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
        status: 'running',
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }).returning()
      if (row === undefined) throw new Error('创建搜索任务失败')
      return toSearch(row)
    })
  }

  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(searchRuns).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId))).limit(1)
      return row === undefined ? null : toSearch(row)
    })
  }

  public async updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; cursor?: PageCursor; nextCursor?: PageCursor; cancelled?: boolean }): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }),
        ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }),
        ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }),
        ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }),
        updatedAt: new Date(),
      }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId))).returning()
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
      return { book: toBook(book), edition: toEdition(edition) }
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

  public constructor(sourcesToSeed: StoredSourceRecord[] = []) { for (const source of sourcesToSeed) this.sourceMap.set(source.sourceId, source) }
  public async upsertSources(records: Array<{ sourceId: string; fingerprint: string; rawSource: unknown; normalizedSource: NormalizedSource }>): Promise<void> { for (const record of records) this.sourceMap.set(record.sourceId, { sourceId: record.sourceId, name: record.normalizedSource.bookSourceName, ...(typeof record.normalizedSource.bookSourceGroup === 'string' ? { group: record.normalizedSource.bookSourceGroup } : {}), fingerprint: record.fingerprint, enabled: true, rawSource: record.rawSource, normalizedSource: record.normalizedSource }) }
  public async listSources(): Promise<StoredSourceRecord[]> { return [...this.sourceMap.values()].filter((source) => source.enabled) }
  public async getSource(sourceId: string): Promise<StoredSourceRecord | null> { const source = this.sourceMap.get(sourceId); return source?.enabled === true ? source : null }
  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> { const now = new Date().toISOString(); const search: SearchRunState = { id: randomUUID(), userId, keyword: input.keyword, sourceId: input.sourceId, ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }), status: 'running', candidates: [], ...(input.cursor === undefined ? {} : { cursor: input.cursor }), version: 0, cancelled: false, createdAt: now, updatedAt: now }; this.searches.set(search.id, search); return search }
  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> { const search = this.searches.get(searchId); return search?.userId === userId ? search : null }
  public async updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; cursor?: PageCursor; nextCursor?: PageCursor; cancelled?: boolean }): Promise<SearchRunState | null> { const current = await this.getSearch(userId, searchId); if (current === null) return null; const updated = { ...current, ...patch, updatedAt: new Date().toISOString() }; this.searches.set(searchId, updated); return updated }
  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> { const existing = [...this.books.values()].find((item) => item.book.userId === userId && item.edition.editionKey === input.editionKey); const now = new Date().toISOString(); const book: StoredBook = existing?.book ?? { id: randomUUID(), userId, name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍', ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), activeEditionKey: input.editionKey, createdAt: now, updatedAt: now }; const updatedBook = { ...book, name: input.metadata.name ?? book.name, ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), activeEditionKey: input.editionKey, updatedAt: now }; const edition: StoredEdition = { id: existing?.edition.id ?? randomUUID(), userId, bookId: updatedBook.id, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }; const value = { book: updatedBook, edition }; this.books.set(`${userId}:${input.editionKey}`, value); return value }
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
function toSearch(row: SearchRunRow): SearchRunState { return { id: row.id, userId: row.userId, keyword: row.keyword, sourceId: row.sourceId, ...(row.sourceFingerprint === null ? {} : { sourceFingerprint: row.sourceFingerprint }), status: row.status as SearchRunState['status'], candidates: row.candidates, ...(row.cursor === null || row.cursor === undefined ? {} : { cursor: row.cursor }), ...(row.nextCursor === null || row.nextCursor === undefined ? {} : { nextCursor: row.nextCursor }), version: row.version, cancelled: row.cancelled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toToc(row: TocSnapshotRow): StoredToc { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceFingerprint: row.sourceFingerprint, revision: row.revision, chapters: row.chapters, bookPatch: row.bookPatch, ...(row.bookAfter === null || row.bookAfter === undefined ? {} : { bookAfter: row.bookAfter }), updatedAt: row.updatedAt.toISOString() } }
function toContent(row: ChapterContentRow): StoredContent { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, tocRevision: row.tocRevision, sourceFingerprint: row.sourceFingerprint, content: row.content, updatedAt: row.updatedAt.toISOString() } }
function toPosition(row: typeof readingRecords.$inferSelect): StoredPosition { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, chapterUrl: row.chapterUrl, chapterIndex: row.chapterIndex, title: row.title, ...(row.tocRevision === null ? {} : { tocRevision: row.tocRevision }), paragraphIndex: row.paragraphIndex, offset: row.offset, version: row.version, lastReadAt: row.lastReadAt.toISOString() } }

export function createRepository(): ReaderRepository { return new PostgresReaderRepository() }

export function sourceSummaryFromSource(source: NormalizedSource, fingerprint: string, enabled = true): SourceSummary { return { sourceId: source.bookSourceUrl, name: source.bookSourceName, ...(typeof source.bookSourceGroup === 'string' ? { group: source.bookSourceGroup } : {}), fingerprint, enabled } }
