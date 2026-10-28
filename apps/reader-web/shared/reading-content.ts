import type { ChapterContent } from '@legado/source-core'

export interface ReadingContent {
  chapter: { chapterId: string; chapterUrl: string; index: number; title?: string }
  contentType: 'text' | 'html'
  cleaned: string
  resources: Array<{ kind: 'image'; url: string }>
  finalUrl?: string
}
export interface ReadingContentResponse { tocRevision: string; content: ReadingContent; runtimeWarning?: string }
export type CachedReadingContent = ReadingContentResponse & { sourceFingerprint: string; truncated?: boolean }
export function readingContent(content: ChapterContent, chapterId: string, title = (content.chapter as { title?: string }).title): ReadingContent {
  return { chapter: { chapterId, chapterUrl: content.chapter.chapterUrl, index: content.chapter.index, ...(title === undefined ? {} : { title }) },
    contentType: content.contentType as 'text' | 'html', cleaned: content.cleaned, resources: content.resources.map(({ kind, url }) => ({ kind, url })),
    ...(content.finalUrl === undefined ? {} : { finalUrl: content.finalUrl }) }
}
