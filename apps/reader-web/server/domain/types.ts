import type { ShelfChapterSummary } from '../../shared/shelf-chapters.ts'
import { DEFAULT_SEARCH_CONCURRENCY } from '../../shared/search-settings.ts'
import type { SourceCacheWarning } from '../../shared/book-sources.ts'
import type { BookCandidate, BookMetadata, Chapter, ChapterContent, JsonObject, NormalizedSource, PageCursor, TocBookPatch } from '@legado/source-core'

export type StoredSource = Pick<NormalizedSource, 'bookSourceUrl' | 'bookSourceName' | 'bookSourceGroup' | 'bookSourceType' | 'searchUrl' | 'exploreUrl' | 'ruleSearch' | 'ruleExplore' | 'ruleBookInfo' | 'ruleToc' | 'ruleContent' | 'concurrentRate' | 'loginUrl' | 'enabled'> & Record<string, unknown>

export interface StoredCandidate {
  sourceOrder?: number
  sourceId: string
  sourceFingerprint: string
  searchDurationMs?: number
  candidate: BookCandidate
}

export type StoredBookMetadata = BookMetadata & { searchDurationMs?: number }

export interface StoredBookSourceCandidate {
  id: string
  userId: string
  bookId: string
  sourceId: string
  sourceFingerprint: string
  bookUrl: string
  candidate: StoredCandidate
  updatedAt: string
}

export interface SearchRunState {
  id: string
  userId: string
  keyword: string
  sourceId: string
  sourceIds: string[]
  precision?: boolean
  sourceFingerprint?: string
  sourceStates: SourceSearchState[]
  status: 'running' | 'success' | 'empty' | 'partial' | 'failed' | 'cancelled'
  candidates: StoredCandidate[]
  cursor?: PageCursor
  nextCursor?: PageCursor
  operationId?: string
  progress: { completed: number; total: number; currentGroup?: string; activeSources?: string[] }
  version: number
  cancelled: boolean
  createdAt: string
  updatedAt: string
}

export interface SourceSearchState {
  sourceRevision?: string
  importLinkId?: string
  priority?: number
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
  /** 用户选择的书籍封面，优先于来源封面；缺省表示跟随书源。 */
  customCoverUrl?: string
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
  metadata: StoredBookMetadata
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
  /** 该快照在抓取时命中分页/预算上限；缓存命中时据此继续提示，不静默当成完整目录。 */
  truncated?: boolean
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

export type HomeBook = Pick<StoredBook, 'id' | 'name' | 'author' | 'coverUrl' | 'customCoverUrl'>
export type HomePosition = Pick<StoredPosition, 'chapterId' | 'title' | 'lastReadAt'>
export type HomeSearchHistory = Pick<SearchHistoryItem, 'id' | 'searchId' | 'keyword' | 'status' | 'resultCount' | 'summary' | 'createdAt' | 'updatedAt'>
export interface HomeSnapshot {
  bookshelf: Array<{ book: HomeBook; edition: Pick<StoredEdition, 'editionKey'>; groupId?: string | null; chapters: ShelfChapterSummary } & ({ position: HomePosition } | Record<never, never>)>
  reading: Array<{ book: HomeBook; edition: Pick<StoredEdition, 'editionKey'>; position: HomePosition }>
  searchHistory: HomeSearchHistory[]
}

export interface SourceSummary {
  sourceId: string
  name: string
  group?: string
  fingerprint: string
  enabled: boolean
}

export interface SearchInput {
  sourceSnapshots?: Array<{ sourceId: string; sourceFingerprint: string; sourceRevision?: string; importLinkId?: string; priority?: number }>
  keyword: string
  sourceId: string
  sourceIds?: string[]
  precision?: boolean
  cursor?: PageCursor
}

export interface SearchBatchResult {
  hasPending?: boolean
  retryAfterMs?: number
  cacheWarning?: SourceCacheWarning
  search: SearchRunState
  candidates: StoredCandidate[]
  sourceResults: SourceSearchState[]
  progress: SearchRunState['progress']
  sourceStatus: 'success' | 'empty' | 'partial' | 'failed' | 'capability-missing' | 'cancelled'
  diagnostics: unknown[]
}

export interface BookCreationInput {
  candidate: StoredCandidate
  metadata: StoredBookMetadata
  bookId?: string
  addToBookshelf?: boolean
  /** false 表示预览来源：只保存 edition，保留已有书籍元数据与活动来源；新书仍正常初始化。 */
  activateEdition?: boolean
}

export type ThemeMode = 'system' | 'light' | 'dark'
export type ReadingMode = 'scroll' | 'paged'
export type BookshelfSortMode = 'addedAt' | 'lastReadAt'

export interface GeneralSettings {
  searchConcurrency: number
  bookshelfInitialGroup?: string
  bookshelfSort: BookshelfSortMode
}

export type PageTapAction = 'previous' | 'next'

export interface PageTapZones {
  leftWidthPercent: number
  centerWidthPercent: number
  centerTopHeightPercent: number
  centerMiddleHeightPercent: number
  centerTopAction: PageTapAction
  centerBottomAction: PageTapAction
}

export interface DisplaySettings {
  theme: ThemeMode
  readingMode: ReadingMode
  fontSize: number
  lineHeight: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

export interface ReaderSettingsPreferences {
  schemaVersion: 1
  general: GeneralSettings
  display: DisplaySettings
  pageTapZones: PageTapZones
}

export interface ReaderSettings extends DisplaySettings {
  userId: string
  general: GeneralSettings
  pageTapZones: PageTapZones
  updatedAt: string
}

export type ReaderSettingsPatch = Partial<Pick<ReaderSettings, 'theme' | 'readingMode' | 'fontSize' | 'lineHeight' | 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft'>> & {
  general?: Partial<GeneralSettings>
  pageTapZones?: PageTapZones
}

export const DEFAULT_READER_SETTINGS = {
  theme: 'system' as ThemeMode,
  readingMode: 'scroll' as ReadingMode,
  fontSize: 18,
  lineHeight: 1.9,
  marginTop: 16,
  marginRight: 16,
  marginBottom: 16,
  marginLeft: 16,
  general: { searchConcurrency: DEFAULT_SEARCH_CONCURRENCY, bookshelfSort: 'addedAt' as BookshelfSortMode, bookshelfInitialGroup: 'all' },
  pageTapZones: { leftWidthPercent: 33, centerWidthPercent: 34, centerTopHeightPercent: 33, centerMiddleHeightPercent: 34, centerTopAction: 'previous' as PageTapAction, centerBottomAction: 'next' as PageTapAction },
}

export const DEFAULT_READER_SETTINGS_PREFERENCES: ReaderSettingsPreferences = {
  schemaVersion: 1,
  general: DEFAULT_READER_SETTINGS.general,
  pageTapZones: DEFAULT_READER_SETTINGS.pageTapZones,
  display: {
    theme: DEFAULT_READER_SETTINGS.theme,
    readingMode: DEFAULT_READER_SETTINGS.readingMode,
    fontSize: DEFAULT_READER_SETTINGS.fontSize,
    lineHeight: DEFAULT_READER_SETTINGS.lineHeight,
    marginTop: DEFAULT_READER_SETTINGS.marginTop,
    marginRight: DEFAULT_READER_SETTINGS.marginRight,
    marginBottom: DEFAULT_READER_SETTINGS.marginBottom,
    marginLeft: DEFAULT_READER_SETTINGS.marginLeft,
  },
}

export interface RuntimeStateSnapshot {
  cookies?: string
  variables?: Record<string, string>
  /** Node 源宿主的源键值、登录信息和脚本缓存；不包含 Cookie。 */
  nodeRuntime?: {
    version: 1
    sourceVariables?: Record<string, string>
    sourceValues?: Record<string, Record<string, string>>
    loginHeaders?: Record<string, string>
    loginInfos?: Record<string, string>
    cache?: {
      values?: Record<string, { value: string; expiresAt?: number }>
      memory?: Record<string, string>
      files?: Record<string, { value: string; expiresAt?: number }>
    }
  }
  /** Android InfoMap 的书源级发现控件状态；按账号和书源版本隔离。 */
  infoMap?: Record<string, string>
  /** Android InfoMap.save(time) 的绝对到期时间；缺省为不过期。 */
  infoMapExpiresAt?: number
  /** 已解析的发现分类；绑定源 fingerprint，避免分页重新执行动态分类脚本。 */
  discovery?: {
    version: 1
    fingerprint: string
    /** 分类或控件刷新后的单调代次；游标必须绑定当前代次。 */
    generation?: number
    categories: Array<{
      id: string
      title: string
      group?: string
      url?: string
      type?: string
      label?: string
      action?: string
      chars?: Array<string | null>
      default?: string
      viewName?: string
      style?: Record<string, unknown>
    }>
  }
  cache?: Record<string, { value: string; expiresAt?: number }>
}

export type JsonValue = JsonObject | readonly JsonValue[] | string | number | boolean | null
