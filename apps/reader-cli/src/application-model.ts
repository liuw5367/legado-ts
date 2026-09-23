import type { BookCandidate, BookMetadata, Chapter, NormalizedSource, WorkflowStatus } from '@legado/source-core'
import type { SourceCatalogResult, SourceEntry } from './source-catalog.ts'
import type { BookDocument, KnownSource, KnownSourceView, ReadingRecord, ReaderStorage, SearchHistoryEntry, ReadingPosition } from './storage.ts'

type SearchWorkflowResult = Awaited<ReturnType<typeof import('@legado/source-core').searchBooks>>
type DetailWorkflowResult = Awaited<ReturnType<typeof import('@legado/source-core').loadBookDetails>>
type TocWorkflowResult = Awaited<ReturnType<typeof import('@legado/source-core').loadTableOfContents>>
type ContentWorkflowResult = Awaited<ReturnType<typeof import('@legado/source-core').loadChapterContent>>

export interface SearchResult {
  candidate: BookCandidate
  source: SourceEntry
  searchId: string
  /** 全局搜索返回顺序，用于同一匹配等级下保持稳定排序。 */
  arrivalIndex: number
  /** 候选所属书源本次搜索耗时，单位毫秒。 */
  searchDurationMs?: number
}

export interface SourceSearchResult {
  source: SourceEntry
  status: WorkflowStatus
  candidates: SearchResult[]
  /** 从该书源真正开始执行请求到返回终态的耗时，单位毫秒。 */
  durationMs: number
  message?: string
}

export type SearchMatchRank = 'exact' | 'contains' | 'other'

export interface SearchResultGroup {
  key: string
  candidate: BookCandidate
  source: SourceEntry
  candidates: SearchResult[]
  rank: SearchMatchRank
  firstArrivalIndex: number
}

export interface SearchOperationResult {
  searchId: string
  keyword: string
  results: SearchResult[]
  sources: SourceSearchResult[]
  groups: SearchResultGroup[]
  elapsedMs: number
  startedAt: string
  completedAt: string
  cancelled: boolean
}

export type SearchUpdateListener = (snapshot: SearchOperationResult) => void

export interface SearchProgress {
  total: number
  completed: number
  activeSources: string[]
  candidates: number
  elapsedMs: number
  success: number
  partial: number
  empty: number
  failed: number
  capabilityMissing: number
  cancelled: number
}

export type SearchProgressListener = (progress: SearchProgress) => void

export interface OpenBookResult {
  book: BookDocument
  source: SourceEntry
  metadata?: BookMetadata
  sources: KnownSource[]
  onBookshelf: boolean
  reading?: ReadingRecord
}

export interface TocResult {
  chapters: Chapter[]
  revision: string
  source: SourceEntry
  edition: KnownSource
}

export interface ReaderApplicationOptions {
  catalog: SourceCatalogResult
  storage: ReaderStorage
  maxConcurrentSources?: number
  sessionFactory?: (source: NormalizedSource) => ReaderSourceSession
}

export interface ReaderSourceSession {
  search(keyword: string, signal?: AbortSignal): Promise<SearchWorkflowResult>
  detail(candidate: BookCandidate, signal?: AbortSignal): Promise<DetailWorkflowResult>
  toc(book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean }): Promise<TocWorkflowResult>
  /** `nextChapterUrl` 触发正文分页护栏：命中时停止抓取，避免把下一章并入本章。 */
  content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string }): Promise<ContentWorkflowResult>
  attachCache(storage: ReaderStorage): void
}

export type { BookCandidate, BookMetadata, Chapter, KnownSource, KnownSourceView, ReadingPosition, SearchHistoryEntry }
