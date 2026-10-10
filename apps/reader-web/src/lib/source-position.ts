import type { ApiChapter } from './api.ts'

/** 先按来源保留的原始章节索引定位，缺少对应索引时才回退到可读章节序号。 */
export function fallbackChapterForPosition(chapters: readonly ApiChapter[], chapterIndex: number): ApiChapter | undefined {
  return chapters.find((chapter) => chapter.index === chapterIndex)
    ?? chapters[Math.min(Math.max(chapterIndex, 0), Math.max(0, chapters.length - 1))]
}
