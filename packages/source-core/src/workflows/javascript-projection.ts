import type { JsonObject, NormalizedSource } from '../model/types.ts'
import type { BookCandidate, BookMetadata, ChapterIdentity } from './types.ts'

type JavaScriptBook = BookCandidate | BookMetadata
type TocUrlFallback = 'empty' | 'bookUrl'

/**
 * Project a core book back to the object shape Android gives to JS sources.
 * Public workflow identities stay normalized, while raw fields remain visible
 * to scripts because Android's Gson marshaller does not resolve URLs.
 */
export function javascriptBookProjection(book: JavaScriptBook, source: NormalizedSource, type: number, tocUrlFallback: TocUrlFallback): Record<string, unknown> {
  const raw = book.rawFields
  const rawBookUrl = rawText(raw, 'bookUrl') ?? book.bookUrl
  const projected: Record<string, unknown> = {
    ...raw,
    ...book,
    origin: book.sourceId,
    originName: source.bookSourceName,
    type,
    bookUrl: rawBookUrl,
  }
  for (const key of ['name', 'author', 'kind', 'coverUrl', 'intro', 'wordCount', 'variable'] as const) {
    const value = rawText(raw, key)
    if (value !== undefined) projected[key] = value
  }
  const latestChapterTitle = rawText(raw, 'latestChapterTitle') ?? rawText(raw, 'lastChapter') ?? book.lastChapter
  if (latestChapterTitle !== undefined) projected.latestChapterTitle = latestChapterTitle
  const rawTocUrl = rawText(raw, 'tocUrl')
  projected.tocUrl = rawTocUrl !== undefined
    ? rawTocUrl
    : tocUrlFallback === 'bookUrl'
      ? book.tocUrl ?? rawBookUrl
      : ''
  return projected
}

/** Project the Chapter object passed to getContent without resolving Android's raw fields again. */
export function javascriptChapterProjection(chapter: ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }): (ChapterIdentity & { title: string; variable?: string; rawFields?: JsonObject }) & Record<string, unknown> {
  return {
    ...(chapter.rawFields ?? {}),
    ...chapter,
    url: chapter.url ?? chapter.chapterUrl,
    baseUrl: chapter.baseUrl ?? '',
    chapterUrl: chapter.chapterUrl,
    title: chapter.title ?? '',
  }
}

function rawText(fields: JsonObject, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined
}
