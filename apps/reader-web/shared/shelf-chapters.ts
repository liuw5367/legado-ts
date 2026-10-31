import { z } from 'zod'
import type { TocSummary } from './toc.ts'

export const DEFAULT_BOOKSHELF_REFRESH_CONCURRENCY = 5
export const bookshelfRefreshConcurrencySchema = z.number().int().min(5).max(10)
export const shelfRefreshRequestSchema = z.object({ books: z.array(z.object({ bookId: z.string().min(1), editionKey: z.string().min(1) })).min(1) })
export type ShelfRefreshTarget = z.infer<typeof shelfRefreshRequestSchema>['books'][number]
export type ShelfRefreshEvent =
  | { type: 'batch-start'; total: number }
  | { type: 'book-result'; bookId: string; editionKey: string; result: RefreshShelfChaptersResponse }
  | { type: 'book-error'; bookId: string; editionKey: string; error: string }
  | { type: 'batch-end'; total: number; succeeded: number; failed: number; updated: number }

export interface ShelfChapterSummary {
  chapterCount: number | null
  latestChapterTitle: string | null
  unreadChapterCount: number | null
}

export interface RefreshShelfChaptersResponse extends ShelfChapterSummary {
  position: { chapterId: string; title: string; lastReadAt: string } | null
  previousChapterCount: number | null
  hasNewChapters: boolean
  runtimeWarning?: string
}

export function shelfChapterSummary(toc: TocSummary | null, position: { chapterId: string; chapterIndex?: number } | null, lastChapter?: string): ShelfChapterSummary {
  if (toc === null) return { chapterCount: null, latestChapterTitle: lastChapter?.trim() || null, unreadChapterCount: null }
  const chapters = toc.chapters.filter((chapter) => !chapter.isVolume)
  const current = position === null ? undefined : toc.chapters.find((chapter) => chapter.chapterId === position.chapterId)
  // 目录刷新可能改变章节 ID，仍可按已保存的章节序号计算；卷标题不计入未读数。
  const index = current?.index ?? position?.chapterIndex
  return {
    chapterCount: chapters.length,
    latestChapterTitle: chapters.at(-1)?.title?.trim() || lastChapter?.trim() || null,
    unreadChapterCount: position === null ? chapters.length : index === undefined ? null : chapters.filter((chapter) => chapter.index > index).length,
  }
}
