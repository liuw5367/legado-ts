import type { ApiBookListDetails, ApiBookListItem } from './api.ts'
export type BookListDisplayItem = ApiBookListItem & { removed?: boolean }
export interface BookListPageSnapshot { data: ApiBookListDetails; rows: BookListDisplayItem[]; scrollY?: number; anchor?: { bookId: string; top: number } }
/** 真实成员与当前历史条目的移除快照合并，避免返回刷新丢失恢复入口。 */
export function mergeBookListRows(previous: BookListDisplayItem[], incoming: ApiBookListItem[]): BookListDisplayItem[] {
  const fresh = new Map(incoming.map((row) => [row.bookId, row]))
  const oldIds = new Set(previous.map((row) => row.bookId))
  return [...incoming.filter((row) => !oldIds.has(row.bookId)), ...previous.flatMap((row) => { const next = fresh.get(row.bookId); return next ? [next] : row.removed ? [row] : [] })]
}
