import type { Chapter } from '@legado/source-core'

export type TocChapter = Pick<Chapter, 'chapterUrl' | 'index' | 'title' | 'isVolume' | 'isVip'> & { chapterId: string }
export interface TocSummary { bookId: string; editionKey: string; sourceFingerprint: string; revision: string; chapters: TocChapter[]; runtimeWarning?: string }
export type CachedTocSummary = Omit<TocSummary, 'runtimeWarning'> & { truncated?: boolean }
