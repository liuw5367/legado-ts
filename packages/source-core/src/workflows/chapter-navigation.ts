import type { Chapter } from './types.ts'

/**
 * Calculate the next chapter address from a caller-owned TOC snapshot.
 *
 * The core cannot query an Android-style chapter database, so callers pass the
 * snapshot they already have. Matching by URL keeps the helper usable after a
 * display layer reorders chapters; a valid persisted index is preferred when
 * it still points at the same chapter. The address exposed to source scripts
 * is the raw URL when present, while the derived absolute URL remains the
 * fallback for declarative chapters.
 */
export function nextChapterUrlFor(chapters: readonly Chapter[] | undefined, current: Chapter): string | undefined {
  if (chapters === undefined || chapters.length === 0) return undefined
  const currentIndex = Number.isInteger(current.index) && current.index >= 0 && chapters[current.index]?.chapterUrl === current.chapterUrl
    ? current.index
    : chapters.findIndex((item) => item.chapterUrl === current.chapterUrl)
  if (currentIndex < 0) return undefined
  const next = chapters[(currentIndex + 1) % chapters.length]
  if (next === undefined || next.chapterUrl.length === 0) return undefined
  return next.url?.trim() || next.chapterUrl
}
