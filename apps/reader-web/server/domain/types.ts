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
  sourceIds: string[]
  sourceFingerprint?: string
  sourceStates: SourceSearchState[]
  status: 'running' | 'success' | 'empty' | 'partial' | 'failed' | 'cancelled'
  candidates: StoredCandidate[]
  cursor?: PageCursor
  nextCursor?: PageCursor
  operationId?: string
  progress: { completed: number; total: number }
  version: number
  cancelled: boolean
  createdAt: string
  updatedAt: string
}

export interface SourceSearchState {
  sourceId: string
  sourceFingerprint?: string
  status: 'pending' | 'running' | 'success' | 'empty' | 'partial' | 'failed' | 'capability-missing' | 'cancelled'
  candidates: StoredCandidate[]
  cursor?: PageCursor
  nextCursor?: PageCursor
  diagnostics: unknown[]
  startedAt?: string
  completedAt?: string
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
  sourceIds?: string[]
  precision?: boolean
  cursor?: PageCursor
}

export interface SearchBatchResult {
  search: SearchRunState
  candidates: StoredCandidate[]
  sourceResults: SourceSearchState[]
  progress: { completed: number; total: number }
  sourceStatus: 'success' | 'empty' | 'partial' | 'failed' | 'capability-missing' | 'cancelled'
  diagnostics: unknown[]
}

export interface BookCreationInput {
  candidate: StoredCandidate
  metadata: BookMetadata
  bookId?: string
}

export type ThemeMode = 'system' | 'light' | 'dark'

export interface ReaderSettings {
  userId: string
  theme: ThemeMode
  fontSize: number
  lineHeight: number
  updatedAt: string
}

export const DEFAULT_READER_SETTINGS = {
  theme: 'system' as ThemeMode,
  fontSize: 18,
  lineHeight: 1.9,
}

export interface RuntimeStateSnapshot {
  cookies?: string
  variables?: Record<string, string>
  cache?: Record<string, { value: string; expiresAt?: number }>
}

export type JsonValue = JsonObject | readonly JsonValue[] | string | number | boolean | null
