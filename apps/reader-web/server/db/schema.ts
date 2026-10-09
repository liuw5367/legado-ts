import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { BookMetadata, Chapter, ChapterContent, NormalizedSource, PageCursor, TocBookPatch } from '@legado/source-core'
import type { RuntimeStateSnapshot, StoredCandidate } from '../domain/types.ts'

export const readerSchema = pgSchema('reader')

export const sources = readerSchema.table('sources', {
  sourceId: text('source_id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  rawSource: jsonb('raw_source').$type<unknown>().notNull(),
  normalizedSource: jsonb('normalized_source').$type<NormalizedSource>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  customOrder: integer('custom_order').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('sources_enabled_order_idx').on(table.enabled, table.customOrder)])

export const books = readerSchema.table('books', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  author: text('author'),
  intro: text('intro'),
  coverUrl: text('cover_url'),
  activeEditionKey: text('active_edition_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('books_user_updated_idx').on(table.userId, table.updatedAt)])

export const bookshelf = readerSchema.table('bookshelf', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('bookshelf_user_book_idx').on(table.userId, table.bookId), index('bookshelf_user_added_idx').on(table.userId, table.addedAt)])

export const bookEditions = readerSchema.table('book_editions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(),
  sourceId: text('source_id').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  bookUrl: text('book_url').notNull(),
  metadata: jsonb('metadata').$type<BookMetadata>().notNull(),
  variable: text('variable'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('book_editions_user_edition_idx').on(table.userId, table.editionKey), index('book_editions_user_book_idx').on(table.userId, table.bookId)])

export const readingRecords = readerSchema.table('reading_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(),
  chapterId: text('chapter_id').notNull(),
  chapterUrl: text('chapter_url').notNull(),
  chapterIndex: integer('chapter_index').notNull(),
  title: text('title').notNull(),
  tocRevision: text('toc_revision'),
  paragraphIndex: integer('paragraph_index').notNull().default(0),
  offset: integer('offset').notNull().default(0),
  version: integer('version').notNull().default(0),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('reading_records_user_book_edition_idx').on(table.userId, table.bookId, table.editionKey), index('reading_records_user_recent_idx').on(table.userId, table.lastReadAt)])

export const searchRuns = readerSchema.table('search_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  keyword: text('keyword').notNull(),
  sourceId: text('source_id').notNull(),
  sourceFingerprint: text('source_fingerprint'),
  status: text('status').notNull(),
  candidates: jsonb('candidates').$type<StoredCandidate[]>().notNull().default([]),
  cursor: jsonb('cursor').$type<PageCursor | null>(),
  nextCursor: jsonb('next_cursor').$type<PageCursor | null>(),
  version: integer('version').notNull().default(0),
  cancelled: boolean('cancelled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('search_runs_user_id_idx').on(table.userId, table.id), index('search_runs_user_updated_idx').on(table.userId, table.updatedAt)])

export const searchHistory = readerSchema.table('search_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  searchId: uuid('search_id').notNull(),
  keyword: text('keyword').notNull(),
  sourceIds: jsonb('source_ids').$type<string[]>().notNull().default([]),
  status: text('status').notNull(),
  resultCount: integer('result_count').notNull().default(0),
  summary: text('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [uniqueIndex('search_history_user_search_idx').on(table.userId, table.searchId), index('search_history_user_updated_idx').on(table.userId, table.updatedAt)])

export const tocSnapshots = readerSchema.table('toc_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  revision: text('revision').notNull(),
  chapters: jsonb('chapters').$type<Chapter[]>().notNull(),
  bookPatch: jsonb('book_patch').$type<TocBookPatch>().notNull(),
  bookAfter: jsonb('book_after').$type<BookMetadata | null>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('toc_snapshots_user_edition_idx').on(table.userId, table.editionKey), index('toc_snapshots_user_book_idx').on(table.userId, table.bookId)])

export const chapterContents = readerSchema.table('chapter_contents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(),
  chapterId: text('chapter_id').notNull(),
  tocRevision: text('toc_revision').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  content: jsonb('content').$type<ChapterContent>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('chapter_contents_user_identity_idx').on(table.userId, table.editionKey, table.tocRevision, table.chapterId)])

export const sourceRuntimeState = readerSchema.table('source_runtime_state', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  sourceId: text('source_id').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  encryptedState: text('encrypted_state').notNull(),
  version: integer('version').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('source_runtime_user_source_idx').on(table.userId, table.sourceId, table.sourceFingerprint), index('source_runtime_lease_idx').on(table.leaseUntil)])

export type SourceRow = typeof sources.$inferSelect
export type BookRow = typeof books.$inferSelect
export type BookshelfRow = typeof bookshelf.$inferSelect
export type BookEditionRow = typeof bookEditions.$inferSelect
export type ReadingRecordRow = typeof readingRecords.$inferSelect
export type SearchRunRow = typeof searchRuns.$inferSelect
export type SearchHistoryRow = typeof searchHistory.$inferSelect
export type TocSnapshotRow = typeof tocSnapshots.$inferSelect
export type ChapterContentRow = typeof chapterContents.$inferSelect
export type SourceRuntimeRow = typeof sourceRuntimeState.$inferSelect

export type RuntimeStateJson = RuntimeStateSnapshot
