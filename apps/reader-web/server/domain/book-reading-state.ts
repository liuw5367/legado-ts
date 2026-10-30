import { createHash } from 'node:crypto'
import type { StoredBook, StoredPosition, StoredToc } from './types.ts'
import type { ShelfChapterSummary } from '../../shared/shelf-chapters.ts'

export function bookChapterState(toc: StoredToc | null, position: StoredPosition | null) {
  const chapters = toc?.chapters.filter((chapter) => !chapter.isVolume)
  const current = position?.editionKey === toc?.editionKey ? chapters?.findIndex((chapter) => chapter.chapterUrl === position?.chapterUrl && chapter.index === position?.chapterIndex) : -1
  return {
    latestChapterIndex: chapters === undefined ? null : chapters.length - 1,
    latestChapterName: chapters?.at(-1)?.title?.trim() || null,
    currentChapterIndex: current === undefined || current < 0 ? null : current,
    currentChapterName: position?.title ?? null,
  }
}

export function bookShelfSummary(book: Pick<StoredBook, 'latestChapterIndex' | 'latestChapterName' | 'currentChapterIndex'>, hasPosition: boolean): ShelfChapterSummary {
  const latest = book.latestChapterIndex
  const current = book.currentChapterIndex
  return { chapterCount: latest == null ? null : latest + 1, latestChapterTitle: book.latestChapterName ?? null, unreadChapterCount: latest == null ? null : !hasPosition ? latest + 1 : current == null ? null : Math.max(0, latest - current) }
}

export function mapReadingPosition(position: StoredPosition, toc: StoredToc): StoredPosition | null {
  const chapters = toc.chapters.filter((chapter) => !chapter.isVolume)
  // 换源先匹配规范化名称，缺少同名章节时沿用原始章节索引定位。
  const normalize = (title: string) => title.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const title = normalize(position.title)
  const sameEdition = position.editionKey === toc.editionKey
  const chapter = (sameEdition ? chapters.find((chapter) => chapter.chapterUrl === position.chapterUrl && chapter.index === position.chapterIndex) : undefined)
    ?? (sameEdition ? chapters.find((chapter) => chapter.chapterUrl === position.chapterUrl) : undefined)
    ?? (title ? chapters.find((chapter) => normalize(chapter.title ?? '') === title) : undefined)
    ?? (!sameEdition ? chapters.find((chapter) => chapter.index === position.chapterIndex) ?? chapters[Math.min(position.chapterIndex, Math.max(0, chapters.length - 1))] : undefined)
  if (!chapter) return sameEdition ? position : null
  if (sameEdition && chapter.chapterUrl === position.chapterUrl && chapter.index === position.chapterIndex && chapter.title === position.title) return position
  return { ...position, editionKey: toc.editionKey, chapterId: createHash('sha256').update(`${chapter.chapterUrl}\u0000${chapter.index}`).digest('hex'), chapterUrl: chapter.chapterUrl, chapterIndex: chapter.index, title: chapter.title ?? `第 ${chapter.index + 1} 章`, tocRevision: toc.revision, paragraphIndex: sameEdition && chapter.chapterUrl === position.chapterUrl ? position.paragraphIndex : 0, offset: sameEdition && chapter.chapterUrl === position.chapterUrl ? position.offset : 0, version: position.version + 1 }
}
