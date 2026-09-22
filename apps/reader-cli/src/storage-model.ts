import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@legado/source-core'

export interface SearchHistoryEntry {
  id: string
  keyword: string
  sourceScope: 'all' | string[]
  startedAt: string
  completedAt?: string
  summary: {
    searched: number
    success: number
    empty: number
    failed: number
    capabilityMissing: number
    candidates: number
  }
  openedBookIds: string[]
}

export interface ReadingPosition {
  editionKey: string
  sourceId: string
  bookUrl: string
  chapterUrl: string
  index: number
  title: string
  tocRevision?: string
  paragraphIndex: number
  offset: number
  lastReadAt: string
}

export interface ReadingRecord {
  bookId: string
  activeEditionKey?: string
  lastReadAt?: string
  lastOpenedAt?: string
  positions: Record<string, ReadingPosition>
  updatedAt: string
}

export interface BookshelfEntry {
  bookId: string
  addedAt: string
  updatedAt: string
}

export interface BookDocument {
  bookId: string
  name: string
  author?: string
  intro?: string
  coverUrl?: string
  tocUrl?: string
  activeEditionKey?: string
  metadataEditionKey?: string
  createdAt: string
  updatedAt: string
}

export type KnownSourceMatch = 'selected' | 'title-author' | 'title-only' | 'user-confirmed'

export interface KnownSource {
  editionKey: string
  sourceId: string
  sourceFingerprint: string
  bookUrl: string
  name?: string
  author?: string
  intro?: string
  coverUrl?: string
  tocUrl?: string
  lastChapter?: string
  updateTime?: string
  /** 本次搜索从书源请求真正开始到返回终态的耗时，单位毫秒。 */
  searchDurationMs?: number
  rawFields: JsonObject
  discoveredAt: string
  searchId?: string
  matchKind: KnownSourceMatch
  confirmedAt?: string
}

export interface StoragePaths {
  dataRoot: string
  cacheRoot: string
}

export interface HomeBookView {
  book: BookDocument
  reading?: ReadingRecord
  isOnBookshelf: boolean
  lastReadAt?: string
  currentChapter?: string
}

export interface KnownSourceView extends KnownSource {
  state: 'available' | 'removed' | 'stale' | 'conflict'
  sourceName?: string
}

export interface StorageOptions {
  paths?: StoragePaths
  now?: () => Date
  maxCacheBytes?: number
}

export function defaultStoragePaths(_platform = process.platform, environment: NodeJS.ProcessEnv = process.env): StoragePaths {
  const home = environment.HOME ?? homedir()
  const root = join(home, '.config', 'reader-cli')
  const dataRoot = join(root, 'data-v1')
  const cacheRoot = join(root, 'cache-v1')
  return { dataRoot, cacheRoot }
}

export function editionKey(sourceId: string, bookUrl: string): string {
  return sha256(`${sourceId}\u0000${bookUrl}`)
}

export function chapterKey(input: { editionKey: string; tocRevision?: string; chapterUrl: string; index: number }): string {
  return sha256(`${input.editionKey}\u0000${input.tocRevision ?? ''}\u0000${input.chapterUrl}\u0000${input.index}`)
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 搜索历史的去重键只代表搜索框名称，不代表某本书的永久身份。 */
export function normalizeSearchName(value: string): string {
  // Search history treats repeated whitespace as the same visible name.
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-Hans')
}
