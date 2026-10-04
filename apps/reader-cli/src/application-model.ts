import type { BookCandidate, BookMetadata, Chapter, ContentIdentity, ContentStore, NormalizedSource, PageCursor, RequestBudget, SearchMatchRank, TocBookPatch, TocChange, WorkflowStatus } from '@legado/source-core'
import type { SourceCatalogResult, SourceEntry } from './source-catalog.ts'
import type { BookDocument, KnownSource, KnownSourceView, ReadingRecord, ReaderStorage, SearchHistoryEntry, ReadingPosition, SourceCheckRecord, ReaderSettings } from './storage.ts'
import type { DebugCapture } from './debug-capture.ts'

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

export type { SearchMatchRank } from '@legado/source-core'

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
  /** 是否启用了 Android 兼容的名称、作者或分类包含过滤。 */
  precision?: boolean
  elapsedMs: number
  startedAt: string
  completedAt: string
  cancelled: boolean
}

export type SearchUpdateListener = (snapshot: SearchOperationResult) => void

/** 应用层搜索策略；未设置时保留普通搜索结果。 */
export interface SearchOptions {
  precision?: boolean
}

/** 单个书源会话的搜索参数，由应用层把操作期限传入核心工作流。 */
export interface ReaderSourceSearchOptions {
  precision?: boolean
  cursor?: PageCursor
  budget?: Partial<RequestBudget>
}

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

export interface SourceCheckProgress {
  total: number
  completed: number
  passed: number
  failed: number
  cancelled: number
  activeSources: string[]
  currentStage?: string
}

export interface SourceCheckResult extends SourceCheckRecord {
  sourceId: string
  sourceName: string
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
  bookPatch: TocBookPatch
  changes: TocChange[]
  source: SourceEntry
  edition: KnownSource
}

export interface ReaderApplicationOptions {
  catalog: SourceCatalogResult
  storage: ReaderStorage
  maxConcurrentSources?: number
  /** 单个书源搜索的总期限，默认 30 秒；测试和宿主可按需缩短。 */
  sourceSearchTimeoutMs?: number
  settings?: ReaderSettings
  sessionFactory?: (source: NormalizedSource) => ReaderSourceSession
}

export interface ReaderSourceSession {
  search(keyword: string, signal?: AbortSignal, capture?: DebugCapture, options?: ReaderSourceSearchOptions): Promise<SearchWorkflowResult>
  discover?(signal?: AbortSignal, capture?: DebugCapture): Promise<SearchWorkflowResult>
  detail(candidate: BookCandidate, signal?: AbortSignal, capture?: DebugCapture): Promise<DetailWorkflowResult>
  toc(book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean; runPerJs?: boolean; isFromBookInfo?: boolean; tocCountWords?: boolean }, capture?: DebugCapture): Promise<TocWorkflowResult>
  /** `nextChapterUrl` 触发正文分页护栏：命中时停止抓取，避免把下一章并入本章。 */
  content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string; contentStore?: ContentStore; contentIdentity?: ContentIdentity; operationId?: string; saveChapterMetadata?: boolean }, capture?: DebugCapture): Promise<ContentWorkflowResult>
  attachCache(storage: ReaderStorage): void
  /** 应用关闭时释放 source session 内的限流等待。 */
  close?(): void
}

export type { BookCandidate, BookMetadata, Chapter, KnownSource, KnownSourceView, ReadingPosition, SearchHistoryEntry }
export type { DebugCapture, DebugSessionSnapshot, ProcessRecord, RequestRecord, StageEvidence } from './debug-capture.ts'
