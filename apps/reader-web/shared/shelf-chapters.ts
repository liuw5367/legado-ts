import type { TocSummary } from './toc.ts'

export interface ShelfChapterSummary {
  chapterCount: number | null
  latestChapterTitle: string | null
  unreadChapterCount: number | null
}

export interface RefreshShelfChaptersResponse extends ShelfChapterSummary {
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
