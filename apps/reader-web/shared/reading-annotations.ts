import { z } from 'zod'

export const MARK_COLORS = [
  { value: 'pink', label: '粉色', hex: '#FF8FA8' },
  { value: 'purple', label: '紫色', hex: '#B79AF7' },
  { value: 'blue', label: '蓝色', hex: '#75B2F5' },
  { value: 'green', label: '绿色', hex: '#72CE82' },
  { value: 'orange', label: '橙黄色', hex: '#F7C879' },
] as const
export const markColorSchema = z.enum(['pink', 'purple', 'blue', 'green', 'orange'])
const pointSchema = z.object({ paragraphIndex: z.number().int().min(0), offset: z.number().int().min(0) }).strict()
export type TextPoint = z.infer<typeof pointSchema>
export const markAnchorSchema = z.object({ start: pointSchema, end: pointSchema, exact: z.string().min(1).max(50000), prefix: z.string().max(32), suffix: z.string().max(32), contentHash: z.string().min(1).max(128) }).strict().refine((a) => comparePoints(a.start, a.end) <= 0, '文字范围无效')
export type MarkAnchor = z.infer<typeof markAnchorSchema>
export type MarkKind = 'bookmarks' | 'annotations'
export const markInputSchema = z.object({
  editionKey: z.string().min(1).max(2048), sourceFingerprint: z.string().min(1).max(256),
  chapterId: z.string().min(1).max(256), chapterUrl: z.string().min(1).max(8192), chapterIndex: z.number().int().min(0), chapterTitle: z.string().max(1000), tocRevision: z.string().min(1).max(256),
  anchor: markAnchorSchema, color: markColorSchema.default('orange'), note: z.string().trim().max(2000).nullable().default(null), expectedVersion: z.number().int().min(0).optional(),
}).strict()
export type MarkInput = z.infer<typeof markInputSchema>
export interface ReadingMark extends Omit<MarkInput, 'expectedVersion'> {
  id: string; userId: string; bookId: string; bookName: string; author: string | null
  createdAt: string; updatedAt: string; deletedAt: string | null; version: number
}
export const readingMarkSchema = markInputSchema.omit({ expectedVersion: true }).extend({ id: z.uuid(), userId: z.uuid(), bookId: z.uuid(), bookName: z.string(), author: z.string().nullable(), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }), deletedAt: z.iso.datetime({ offset: true }).nullable(), version: z.number().int().min(0) }).strict()
export interface MarkQuery { kind: MarkKind; bookId?: string; editionKey?: string; chapterUrl?: string; q?: string; deleted?: boolean; cursor?: string; all?: boolean }
export interface MarkPage { items: ReadingMark[]; nextCursor: string | null }
export type MarkCommand = { action: 'save'; kind: MarkKind; id: string; bookId: string; input: MarkInput; bookName: string; author: string | null } | { action: 'delete' | 'restore'; kind: MarkKind; id: string; bookId: string; expectedVersion: number }
export class MarkError extends Error { public readonly status: 400 | 404 | 409; constructor(status: 400 | 404 | 409, message: string) { super(message); this.status = status } }
export function comparePoints(a: TextPoint, b: TextPoint) { return a.paragraphIndex - b.paragraphIndex || a.offset - b.offset }
export function sameChapter(a: Pick<ReadingMark, 'editionKey' | 'chapterUrl' | 'sourceFingerprint'>, b: Pick<ReadingMark, 'editionKey' | 'chapterUrl' | 'sourceFingerprint'>) { return a.editionKey === b.editionKey && a.chapterUrl === b.chapterUrl && a.sourceFingerprint === b.sourceFingerprint }
export function rangesOverlap(a: MarkAnchor, b: MarkAnchor) { return comparePoints(a.start, b.end) < 0 && comparePoints(b.start, a.end) < 0 }
export function markOrder(query: MarkQuery) { return Boolean(query.bookId && !query.q && !query.deleted) }
function queryIdentity(query: MarkQuery) { return JSON.stringify([query.kind, query.bookId ?? '', query.editionKey ?? '', query.chapterUrl ?? '', (query.q ?? '').trim(), Boolean(query.deleted)]) }
export function markCursor(row: ReadingMark, query: MarkQuery) { return encodeURIComponent(JSON.stringify({ scope: queryIdentity(query), id: row.id, time: row.createdAt, chapter: row.chapterIndex, paragraph: row.anchor.start.paragraphIndex, offset: row.anchor.start.offset })) }
export function parseMarkCursor(query: MarkQuery) {
  if (!query.cursor) return null
  try {
    const parsed = z.object({ scope: z.string(), id: z.uuid(), time: z.iso.datetime({ offset: true }), chapter: z.number().int().min(0), paragraph: z.number().int().min(0), offset: z.number().int().min(0) }).strict().parse(JSON.parse(decodeURIComponent(query.cursor)))
    if (parsed.scope !== queryIdentity(query)) throw new Error('scope')
    return parsed
  } catch { throw new MarkError(400, '分页条件无效，请重新加载') }
}
export function markPage(rows: ReadingMark[], query: MarkQuery): MarkPage {
  const q = (query.q ?? '').trim().toLocaleLowerCase()
  let items = rows.filter((r) => (!query.bookId || r.bookId === query.bookId) && (!query.editionKey || r.editionKey === query.editionKey) && (!query.chapterUrl || r.chapterUrl === query.chapterUrl) && (query.all || Boolean(r.deletedAt) === Boolean(query.deleted)) && (!q || r.anchor.exact.toLocaleLowerCase().includes(q) || (r.note ?? '').toLocaleLowerCase().includes(q)))
  const chapterOrder = markOrder(query)
  items.sort((a, b) => chapterOrder ? a.chapterIndex - b.chapterIndex || comparePoints(a.anchor.start, b.anchor.start) || a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const cursor = parseMarkCursor(query)
  if (cursor) items = items.filter((r) => chapterOrder ? (r.chapterIndex - cursor.chapter || r.anchor.start.paragraphIndex - cursor.paragraph || r.anchor.start.offset - cursor.offset || r.id.localeCompare(cursor.id)) > 0 : (r.createdAt.localeCompare(cursor.time) || r.id.localeCompare(cursor.id)) < 0)
  if (query.all || query.chapterUrl) return { items, nextCursor: null }
  return { items: items.slice(0, 50), nextCursor: items.length > 50 ? markCursor(items[49]!, query) : null }
}

/** 同章变更串行执行；数据库和内存实现共享重复范围、重叠与版本语义。 */
export function changeMark(rows: ReadingMark[], userId: string, command: MarkCommand): ReadingMark {
  if (rows.some((r) => r.id === command.id && r.bookId !== command.bookId)) throw new MarkError(409, '记录标识已用于其他书籍')
  const current = rows.find((r) => r.id === command.id && r.bookId === command.bookId)
  if (command.action !== 'save') {
    if (!current) throw new MarkError(404, '记录不存在')
    if (current.version !== command.expectedVersion) throw new MarkError(409, '记录已修改，请重新加载')
    if (command.action === 'restore' && !current.deletedAt) return current
    if (command.action === 'delete' && current.deletedAt) return current
    if (command.action === 'restore') checkOverlap(rows, current, command.kind)
    return { ...current, deletedAt: command.action === 'delete' ? new Date().toISOString() : null, updatedAt: new Date().toISOString(), version: current.version + 1 }
  }
  if (current && !current.deletedAt && command.input.expectedVersion === undefined) {
    const { expectedVersion: _expected, ...requested } = command.input
    const { id: _id, userId: _user, bookId: _book, bookName: _name, author: _author, createdAt: _created, updatedAt: _updated, deletedAt: _deleted, version: _version, ...saved } = current
    if (JSON.stringify(requested) === JSON.stringify(saved)) return current
  }
  if (current && (current.version !== command.input.expectedVersion || current.deletedAt)) throw new MarkError(409, '记录已修改或删除，请重新加载')
  if (!current && command.input.expectedVersion !== undefined) throw new MarkError(404, '记录不存在')
  const { expectedVersion: _version, ...input } = command.input
  const now = new Date().toISOString()
  const next: ReadingMark = { ...input, id: command.id, userId, bookId: command.bookId, bookName: command.bookName, author: command.author, createdAt: current?.createdAt ?? now, updatedAt: now, version: (current?.version ?? -1) + 1, deletedAt: null }
  const duplicate = rows.find((r) => r.id !== next.id && !r.deletedAt && sameChapter(r, next) && comparePoints(r.anchor.start, next.anchor.start) === 0 && (command.kind === 'bookmarks' || comparePoints(r.anchor.end, next.anchor.end) === 0))
  if (duplicate) return duplicate
  checkOverlap(rows, next, command.kind)
  return next
}
function checkOverlap(rows: ReadingMark[], next: ReadingMark, kind: MarkKind) {
  if (rows.some((r) => r.id !== next.id && !r.deletedAt && sameChapter(r, next) && (kind === 'annotations' ? rangesOverlap(r.anchor, next.anchor) : comparePoints(r.anchor.start, next.anchor.start) === 0))) throw new MarkError(409, '与已有标记重叠，请编辑已有标记或重新选择')
}
