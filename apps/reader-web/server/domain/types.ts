import type { BookCandidate, BookMetadata, Chapter, ChapterContent, JsonObject, NormalizedSource, PageCursor, TocBookPatch } from '@legado/source-core'

export type StoredSource = Pick<NormalizedSource, 'bookSourceUrl' | 'bookSourceName' | 'bookSourceGroup' | 'bookSourceType' | 'searchUrl' | 'exploreUrl' | 'ruleSearch' | 'ruleExplore' | 'ruleBookInfo' | 'ruleToc' | 'ruleContent' | 'concurrentRate' | 'loginUrl' | 'enabled'> & Record<string, unknown>

export interface StoredCandidate {
  sourceId: string
  sourceFingerprint: string
  candidate: BookCandidate
}

export interface SearchRunState {
  id: string
  userId: string
  keyword: string
  sourceId: string
  sourceFingerprint?: string
  status: 'running' | 'success' | 'empty' | 'partial' | 'failed' | 'cancelled'
  candidates: StoredCandidate[]
  cursor?: PageCursor
  nextCursor?: PageCursor
  version: number
  cancelled: boolean
  createdAt: string
  updatedAt: string
}

export interface StoredBook {
  id: string
  userId: string
  name: string
  author?: string
  intro?: string
  coverUrl?: string
  activeEditionKey?: string
  createdAt: string
  updatedAt: string
}

export interface StoredEdition {
  id: string
  userId: string
  bookId: string
  editionKey: string
  sourceId: string
  sourceFingerprint: string
  bookUrl: string
  metadata: BookMetadata
  variable?: string
}

export interface StoredToc {
  userId: string
  bookId: string
  editionKey: string
  sourceFingerprint: string
  revision: string
  chapters: Chapter[]
  bookPatch: TocBookPatch
  bookAfter?: BookMetadata
  updatedAt: string
}

export interface StoredContent {
  userId: string
  bookId: string
  editionKey: string
  chapterId: string
  tocRevision: string
  sourceFingerprint: string
  content: ChapterContent
  updatedAt: string
}

export interface StoredPosition {
  userId: string
  bookId: string
  editionKey: string
  chapterId: string
  chapterUrl: string
  chapterIndex: number
  title: string
  tocRevision?: string
  paragraphIndex: number
  offset: number
  version: number
  lastReadAt: string
}

export interface SearchHistoryItem {
  id: string
  searchId: string
  keyword: string
  sourceIds: string[]
  status: string
  resultCount: number
  summary?: string
  createdAt: string
  updatedAt: string
}

export interface HomeSnapshot {
  bookshelf: Array<{ book: StoredBook; edition: StoredEdition } & ({ position: StoredPosition } | Record<never, never>)>
  reading: Array<{ book: StoredBook; edition: StoredEdition; position: StoredPosition }>
  searchHistory: SearchHistoryItem[]
}

export interface SourceSummary {
  sourceId: string
  name: string
  group?: string
  fingerprint: string
  enabled: boolean
}

export interface SearchInput {
  keyword: string
  sourceId: string
  precision?: boolean
  cursor?: PageCursor
}

export interface SearchBatchResult {
  search: SearchRunState
  candidates: StoredCandidate[]
  sourceStatus: 'success' | 'empty' | 'partial' | 'failed' | 'capability-missing'
  diagnostics: unknown[]
}

export interface BookCreationInput {
  candidate: StoredCandidate
  metadata: BookMetadata
}

export interface RuntimeStateSnapshot {
  cookies?: string
  variables?: Record<string, string>
  cache?: Record<string, { value: string; expiresAt?: number }>
}

export type JsonValue = JsonObject | readonly JsonValue[] | string | number | boolean | null
