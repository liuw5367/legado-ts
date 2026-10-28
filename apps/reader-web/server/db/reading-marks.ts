import type { ReadingMarkListItem, TextPoint } from '../../shared/reading-annotations.ts'
import type { ReaderMark } from '../../shared/reading-annotations.ts'
import { and, eq, sql } from 'drizzle-orm'
import { books, readingAnnotations, readingBookmarks } from './schema.ts'
import type { ReaderTransaction } from './client.ts'
import { changeMark, MarkError, markCursor, markOrder, parseMarkCursor, type MarkCommand, type MarkKind, type MarkQuery, type ReadingMark, type MarkPage, type MarkSummaryPage } from '../../shared/reading-annotations.ts'

export function readMarks(tx: ReaderTransaction, userId: string, query: MarkQuery): Promise<MarkPage>
export function readMarks(tx: ReaderTransaction, userId: string, query: MarkQuery, summary: true): Promise<MarkSummaryPage>
export async function readMarks(tx: ReaderTransaction, userId: string, query: MarkQuery, summary = false) {
  if (summary) return readMarkList(tx, userId, query)
  const table = query.kind === 'bookmarks' ? readingBookmarks : readingAnnotations
  const data = table.data
  const chapter = sql`(${data}->>'chapterIndex')::integer`; const paragraph = sql`(${data}->'anchor'->'start'->>'paragraphIndex')::integer`; const offset = sql`(${data}->'anchor'->'start'->>'offset')::integer`; const time = sql`${data}->>'createdAt'`
  const q = (query.q ?? '').trim().toLocaleLowerCase(); const cursor = parseMarkCursor(query); const ordered = markOrder(query)
  const rows = await tx.select({ data, bookName: books.name, author: books.author }).from(table).leftJoin(books, and(eq(books.userId, userId), eq(books.id, table.bookId))).where(and(eq(table.userId, userId), query.id ? eq(table.id, query.id) : undefined, query.bookId ? eq(table.bookId, query.bookId) : undefined, query.editionKey ? eq(table.editionKey, query.editionKey) : undefined, query.chapterUrl ? eq(table.chapterUrl, query.chapterUrl) : undefined,
    query.all ? undefined : query.deleted ? sql`${data}->>'deletedAt' is not null` : sql`${data}->>'deletedAt' is null`,
    q ? sql`(strpos(lower(${data}->'anchor'->>'exact'), ${q}) > 0 or strpos(lower(coalesce(${data}->>'note', '')), ${q}) > 0)` : undefined,
    cursor ? ordered ? sql`(${chapter}, ${paragraph}, ${offset}, ${table.id}) > (${cursor.chapter}, ${cursor.paragraph}, ${cursor.offset}, ${cursor.id}::uuid)` : sql`(${time}, ${table.id}) < (${cursor.time}, ${cursor.id}::uuid)` : undefined,
  )).orderBy(...(ordered ? [sql`${chapter} asc`, sql`${paragraph} asc`, sql`${offset} asc`, sql`${table.id} asc`] : [sql`${time} desc`, sql`${table.id} desc`])).limit(query.all || query.chapterUrl ? 2147483647 : 51)
  const items = rows.map((r) => ({ ...r.data, bookName: r.bookName ?? r.data.bookName, author: r.bookName === null ? r.data.author : r.author }))
  return { items: query.all || query.chapterUrl ? items : items.slice(0, 50), nextCursor: !query.all && !query.chapterUrl && items.length > 50 ? markCursor(items[49]!, query) : null }
}
export async function writeMark(tx: ReaderTransaction, userId: string, command: MarkCommand) {
  // 与备份恢复共用账号锁，避免恢复覆盖正在保存的标记。
  await lockMarks(tx, userId)
  const table = command.kind === 'bookmarks' ? readingBookmarks : readingAnnotations
  const [sameId] = await tx.select({ data: table.data }).from(table).where(and(eq(table.userId, userId), eq(table.id, command.id)))
  const chapter = command.action === 'save' ? command.input : sameId?.data
  const before = chapter ? await readMarks(tx, userId, { kind: command.kind, bookId: command.bookId, editionKey: chapter.editionKey, chapterUrl: chapter.chapterUrl, all: true }) : { items: [] }
  const next = changeMark([...before.items, ...(sameId && !before.items.some((r) => r.id === sameId.data.id) ? [sameId.data] : [])], userId, command)
  await tx.insert(table).values(markValues(next)).onConflictDoUpdate({ target: [table.userId, table.id], set: markValues(next) })
  return next
}
export async function purgeMark(tx: ReaderTransaction, userId: string, kind: MarkKind, bookId: string, id: string, expectedVersion: number) {
  await lockMarks(tx, userId)
  const table = kind === 'bookmarks' ? readingBookmarks : readingAnnotations
  const [row] = await tx.select({ data: table.data }).from(table).where(and(eq(table.userId, userId), eq(table.bookId, bookId), eq(table.id, id)))
  if (row === undefined) throw new MarkError(404, '记录不存在')
  if (row.data.version !== expectedVersion) throw new MarkError(409, '记录已修改，请重新加载')
  if (row.data.deletedAt === null) throw new MarkError(409, '只能彻底删除已删除的笔记')
  await tx.delete(table).where(and(eq(table.userId, userId), eq(table.bookId, bookId), eq(table.id, id)))
}
export async function lockMarks(tx: ReaderTransaction, userId: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId + ':reading-marks'}, 0))`) }
export function markValues(row: ReadingMark) { return { id: row.id, userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterUrl: row.chapterUrl, data: row } }
export async function restoreMarks(tx: ReaderTransaction, userId: string, kind: MarkKind, rows: ReadingMark[]) {
  const table = kind === 'bookmarks' ? readingBookmarks : readingAnnotations
  await tx.delete(table).where(eq(table.userId, userId))
  for (const row of rows) await tx.insert(table).values(markValues({ ...row, userId }))
}

export async function readReaderMarks(tx: ReaderTransaction, userId: string, query: MarkQuery): Promise<ReaderMark[]> {
  const table = query.kind === 'bookmarks' ? readingBookmarks : readingAnnotations
  const data = table.data
  const rows = await tx.select({ data: sql<ReaderMark>`jsonb_build_object(
    'id', ${data}->'id', 'version', ${data}->'version', 'editionKey', ${data}->'editionKey', 'sourceFingerprint', ${data}->'sourceFingerprint',
    'chapterId', ${data}->'chapterId', 'chapterUrl', ${data}->'chapterUrl', 'chapterIndex', ${data}->'chapterIndex', 'chapterTitle', ${data}->'chapterTitle',
    'tocRevision', ${data}->'tocRevision', 'anchor', ${data}->'anchor', 'color', ${data}->'color', 'note', ${data}->'note'
  ) || ${query.id ? sql`jsonb_build_object('sourceName', ${data}->'sourceName')` : sql`'{}'::jsonb`}` }).from(table).where(and(eq(table.userId, userId), eq(table.bookId, query.bookId!), query.id ? eq(table.id, query.id) : undefined, query.editionKey ? eq(table.editionKey, query.editionKey) : undefined, query.chapterUrl ? eq(table.chapterUrl, query.chapterUrl) : undefined, query.all ? undefined : sql`${data}->>'deletedAt' is null`)).orderBy(sql`(${data}->'anchor'->'start'->>'paragraphIndex')::integer`, sql`(${data}->'anchor'->'start'->>'offset')::integer`, table.id)
  return rows.map((row) => row.data)
}

async function readMarkList(tx: ReaderTransaction, userId: string, query: MarkQuery): Promise<MarkSummaryPage> {
  const table = query.kind === 'bookmarks' ? readingBookmarks : readingAnnotations
  const data = table.data
  const chapter = sql`(${data}->>'chapterIndex')::integer`; const paragraph = sql`(${data}->'anchor'->'start'->>'paragraphIndex')::integer`; const offset = sql`(${data}->'anchor'->'start'->>'offset')::integer`; const time = sql`${data}->>'createdAt'`
  const q = (query.q ?? '').trim().toLocaleLowerCase(); const cursor = parseMarkCursor(query); const ordered = markOrder(query)
  const rows = await tx.select({
    item: sql<ReadingMarkListItem>`jsonb_build_object('id', ${data}->'id', 'bookId', ${data}->'bookId', 'bookName', coalesce(to_jsonb(${books.name}), ${data}->'bookName'),
      'chapterTitle', ${data}->'chapterTitle', 'color', ${data}->'color', 'note', ${data}->'note', 'createdAt', ${data}->'createdAt', 'deletedAt', ${data}->'deletedAt',
      'version', ${data}->'version', 'excerpt', ${data}->'anchor'->'exact', 'hasCachedChapter', coalesce(${data}->'cachedChapter' <> 'null'::jsonb, false))`,
    chapterIndex: sql<number>`${chapter}`, point: sql<TextPoint>`${data}->'anchor'->'start'`,
  }).from(table).leftJoin(books, and(eq(books.userId, userId), eq(books.id, table.bookId))).where(and(eq(table.userId, userId), query.id ? eq(table.id, query.id) : undefined, query.bookId ? eq(table.bookId, query.bookId) : undefined, query.editionKey ? eq(table.editionKey, query.editionKey) : undefined, query.chapterUrl ? eq(table.chapterUrl, query.chapterUrl) : undefined,
    query.all ? undefined : query.deleted ? sql`${data}->>'deletedAt' is not null` : sql`${data}->>'deletedAt' is null`,
    q ? sql`(strpos(lower(${data}->'anchor'->>'exact'), ${q}) > 0 or strpos(lower(coalesce(${data}->>'note', '')), ${q}) > 0)` : undefined,
    cursor ? ordered ? sql`(${chapter}, ${paragraph}, ${offset}, ${table.id}) > (${cursor.chapter}, ${cursor.paragraph}, ${cursor.offset}, ${cursor.id}::uuid)` : sql`(${time}, ${table.id}) < (${cursor.time}, ${cursor.id}::uuid)` : undefined,
  )).orderBy(...(ordered ? [sql`${chapter} asc`, sql`${paragraph} asc`, sql`${offset} asc`, sql`${table.id} asc`] : [sql`${time} desc`, sql`${table.id} desc`])).limit(query.all || query.chapterUrl ? 2147483647 : 51)
  const last = rows[49]
  return { items: (query.all || query.chapterUrl ? rows : rows.slice(0, 50)).map((row) => row.item), nextCursor: !query.all && !query.chapterUrl && rows.length > 50 && last ? markCursor({ ...last.item, chapterIndex: last.chapterIndex, anchor: { start: last.point } }, query) : null }
}
