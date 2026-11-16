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
  // Android SearchBook/Book have no updateTime member, so Gson-unknown input must not enter the JS Book binding.
  delete projected.updateTime
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
export function javascriptChapterProjection(chapter: ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }): Record<string, unknown> {
  // Android 将 JS 返回的章节 Gson 反序列化为 BookChapter；只把实体声明的属性交给后续 JS。
  // 这也保留实体构造时 String?/Long? 字段的 null 默认值，而不把 TS 的内部身份字段泄漏给脚本。
  return {
    url: chapter.url ?? chapter.chapterUrl ?? '',
    title: chapter.title ?? '',
    isVolume: chapter.isVolume ?? false,
    // Rhino exposes Kotlin `isVolume` as the JavaBeans property `volume` as well.
    volume: chapter.isVolume ?? false,
    baseUrl: chapter.baseUrl ?? '',
    bookUrl: chapter.bookUrl,
    index: chapter.index,
    isVip: chapter.isVip ?? false,
    vip: chapter.isVip ?? false,
    isPay: chapter.isPay ?? false,
    pay: chapter.isPay ?? false,
    resourceUrl: chapter.resourceUrl ?? null,
    tag: chapter.tag ?? null,
    wordCount: chapter.wordCount ?? null,
    start: chapter.start ?? null,
    end: chapter.end ?? null,
    startFragmentId: chapter.startFragmentId ?? null,
    endFragmentId: chapter.endFragmentId ?? null,
    variable: chapter.variable ?? null,
    imgUrl: chapter.imgUrl ?? null,
  }
}

function rawText(fields: JsonObject, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined
}
