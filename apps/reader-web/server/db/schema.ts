import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { BookMetadata, Chapter, ChapterContent, NormalizedSource, PageCursor, TocBookPatch } from '@legado/source-core'
import { DEFAULT_READER_SETTINGS_PREFERENCES, type ReaderSettingsPreferences, type RuntimeStateSnapshot, type SourceSearchState, type StoredBookMetadata, type StoredCandidate } from '../domain/types.ts'

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

export const userSources = readerSchema.table('user_sources', {
  userId: uuid('user_id').notNull(),
  sourceUuid: uuid('source_uuid').notNull().defaultRandom(),
  importLinkId: uuid('import_link_id'),
  currentImportItemId: uuid('current_import_item_id'),
  sourceId: text('source_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  rawSource: jsonb('raw_source').$type<unknown>().notNull(),
  normalizedSource: jsonb('normalized_source').$type<NormalizedSource>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  customOrder: integer('custom_order').notNull().default(0),
  deleted: boolean('deleted').notNull().default(false),
  revision: text('revision').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('user_sources_uuid_idx').on(table.sourceUuid), uniqueIndex('user_sources_identity_idx').on(table.userId, table.sourceId), index('user_sources_user_enabled_idx').on(table.userId, table.enabled, table.deleted)])

export const sourceImportPreviews = readerSchema.table('source_import_previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  sourceUrl: text('source_url').notNull(),
  candidates: jsonb('candidates').$type<unknown[]>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedCandidateIds: jsonb('consumed_candidate_ids').$type<string[]>().notNull().default([]),
  consumedResult: jsonb('consumed_result').$type<{ imported: number } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('source_import_previews_user_expiry_idx').on(table.userId, table.expiresAt)])

export const readerSettings = readerSchema.table('reader_settings', {
  userId: uuid('user_id').primaryKey(),
  preferences: jsonb('preferences').$type<ReaderSettingsPreferences>().notNull().default(DEFAULT_READER_SETTINGS_PREFERENCES),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const books = readerSchema.table('books', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  author: text('author'),
  intro: text('intro'),
  coverUrl: text('cover_url'),
  customCoverUrl: text('custom_cover_url'),
  activeEditionKey: text('active_edition_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('books_user_updated_idx').on(table.userId, table.updatedAt)])

export const bookLists = readerSchema.table('book_lists', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  type: text('type').$type<'booklist' | 'shelf_group'>().notNull().default('booklist'),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isPublic: boolean('is_public').notNull().default(false),
  customOrder: integer('custom_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('book_lists_user_updated_idx').on(t.userId, t.type, t.updatedAt, t.id),
  index('book_lists_user_order_idx').on(t.userId, t.type, t.customOrder, t.createdAt, t.id),
  uniqueIndex('book_lists_group_name_idx').on(t.userId, t.name).where(sql`${t.type} = 'shelf_group'`),
  check('book_lists_type_check', sql`${t.type} in ('booklist', 'shelf_group')`),
  check('book_lists_name_check', sql`char_length(trim(${t.name})) between 1 and case when ${t.type} = 'shelf_group' then 30 else 100 end`),
  check('book_lists_description_check', sql`char_length(${t.description}) <= 2000`),
  check('book_lists_order_check', sql`${t.customOrder} >= 0`),
  check('book_lists_group_fields_check', sql`${t.type} <> 'shelf_group' or (${t.name} not in ('全部', '默认') and ${t.description} = '' and not ${t.isPublic})`),
])

export const bookListItems = readerSchema.table('book_list_items', {
  userId: uuid('user_id').notNull(),
  bookListId: uuid('book_list_id').notNull(),
  bookId: uuid('book_id').notNull(),
  description: text('description').notNull().default(''),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('book_list_items_identity_idx').on(t.userId, t.bookListId, t.bookId),
  index('book_list_items_order_idx').on(t.userId, t.bookListId, t.addedAt, t.bookId),
  index('book_list_items_book_idx').on(t.userId, t.bookId),
  check('book_list_items_description_check', sql`char_length(${t.description}) <= 2000`),
])

export const bookshelf = readerSchema.table('bookshelf', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  groupId: uuid('group_id'),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('bookshelf_user_book_idx').on(table.userId, table.bookId), index('bookshelf_user_added_idx').on(table.userId, table.addedAt), index('bookshelf_user_group_idx').on(table.userId, table.groupId)])

export const bookEditions = readerSchema.table('book_editions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(),
  sourceId: text('source_id').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  bookUrl: text('book_url').notNull(),
  metadata: jsonb('metadata').$type<StoredBookMetadata>().notNull(),
  variable: text('variable'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('book_editions_user_edition_idx').on(table.userId, table.editionKey), index('book_editions_user_book_idx').on(table.userId, table.bookId)])

export const bookSourceCandidates = readerSchema.table('book_source_candidates', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  bookId: uuid('book_id').notNull(),
  sourceId: text('source_id').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  bookUrl: text('book_url').notNull(),
  candidate: jsonb('candidate').$type<StoredCandidate>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('book_source_candidates_identity_idx').on(table.userId, table.bookId, table.sourceId, table.sourceFingerprint, table.bookUrl), index('book_source_candidates_user_book_idx').on(table.userId, table.bookId)])

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
  sourceIds: jsonb('source_ids').$type<string[]>().notNull().default([]),
  precision: boolean('precision').notNull().default(false),
  sourceFingerprint: text('source_fingerprint'),
  status: text('status').notNull(),
  candidates: jsonb('candidates').$type<StoredCandidate[]>().notNull().default([]),
  sourceStates: jsonb('source_states').$type<SourceSearchState[]>().notNull().default([]),
  cursor: jsonb('cursor').$type<PageCursor | null>(),
  nextCursor: jsonb('next_cursor').$type<PageCursor | null>(),
  operationId: text('operation_id'),
  operationLeaseUntil: timestamp('operation_lease_until', { withTimezone: true }),
  progressCompleted: integer('progress_completed').notNull().default(0),
  progressTotal: integer('progress_total').notNull().default(0),
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
  truncated: boolean('truncated').notNull().default(false),
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
export type UserSourceRow = typeof userSources.$inferSelect
export type SourceImportPreviewRow = typeof sourceImportPreviews.$inferSelect
export type ReaderSettingsRow = typeof readerSettings.$inferSelect
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

export const sourceImportLinks = readerSchema.table('source_import_links', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull(),
  urlKey: text('url_key').notNull(), encryptedUrl: text('encrypted_url').notNull(), displayUrl: text('display_url').notNull(),
  sortOrder: integer('sort_order').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('source_import_links_url_idx').on(t.userId, t.urlKey), index('source_import_links_order_idx').on(t.userId, t.sortOrder)])
export const sourceImportSettings = readerSchema.table('source_import_settings', {
  userId: uuid('user_id').primaryKey(), revision: text('revision').notNull(),
})
export const sourceImportBatches = readerSchema.table('source_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull(), previewId: uuid('preview_id').notNull().unique(), linkId: uuid('link_id').notNull(),
  selection: jsonb('selection').$type<string[]>().notNull(), importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  imported: integer('imported').notNull(), newCount: integer('new_count').notNull(), updatedCount: integer('updated_count').notNull(), restoredCount: integer('restored_count').notNull(), skippedCount: integer('skipped_count').notNull(), unselectedCount: integer('unselected_count').notNull(),
  undoStatus: text('undo_status').$type<'none' | 'partial' | 'all'>().notNull().default('none'), undoneAt: timestamp('undone_at', { withTimezone: true }), invalidatedAt: timestamp('invalidated_at', { withTimezone: true }), invalidatedReason: text('invalidated_reason'),
}, (t) => [index('source_import_batches_time_idx').on(t.userId, t.importedAt), check('source_import_batches_undo_check', sql`${t.undoStatus} in ('none', 'partial', 'all')`)])
export const sourceImportItems = readerSchema.table('source_import_items', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull(), batchId: uuid('batch_id').notNull(), sourceUuid: uuid('source_uuid'), sourceId: text('source_id').notNull(),
  name: text('name').notNull(), group: text('source_group'), action: text('action').$type<'new' | 'update' | 'restore' | 'skipped' | 'unselected'>().notNull(), reason: text('reason').notNull(),
  displayUrl: text('display_url').notNull(), encryptedOrigin: text('encrypted_origin').notNull(), beforeSnapshot: text('before_snapshot'), afterRevision: text('after_revision'), undoRevision: text('undo_revision'), undoneAt: timestamp('undone_at', { withTimezone: true }),
}, (t) => [index('source_import_items_batch_idx').on(t.userId, t.batchId, t.id), index('source_import_items_source_idx').on(t.userId, t.sourceUuid), check('source_import_items_action_check', sql`${t.action} in ('new', 'update', 'restore', 'skipped', 'unselected')`)])
export const sourceImportUndoOperations = readerSchema.table('source_import_undo_operations', {
  userId: uuid('user_id').notNull(), idempotencyKey: uuid('idempotency_key').notNull(), batchId: uuid('batch_id').notNull(), selection: text('selection').notNull(), result: jsonb('result').$type<import('../../shared/source-management.ts').UndoImportResult>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('source_import_undo_key_idx').on(t.userId, t.idempotencyKey)])
export const sourceExecutionSlots = readerSchema.table('source_execution_slots', {
  slotId: integer('slot_id').primaryKey(), userId: uuid('user_id'), operationId: uuid('operation_id'), leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
})

// 批注使用独立新表，不修改既有书籍、正文、位置及设置表。
export const readingBookmarks = readerSchema.table('reading_bookmarks', {
  userId: uuid('user_id').notNull(), id: uuid('id').notNull(), bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(), chapterUrl: text('chapter_url').notNull(),
  data: jsonb('data').$type<import('../../shared/reading-annotations.ts').ReadingMark>().notNull(),
}, (t) => [uniqueIndex('reading_bookmarks_user_id_idx').on(t.userId, t.id), index('reading_bookmarks_chapter_idx').on(t.userId, t.bookId, t.editionKey, t.chapterUrl)])
export const readingAnnotations = readerSchema.table('reading_annotations', {
  userId: uuid('user_id').notNull(), id: uuid('id').notNull(), bookId: uuid('book_id').notNull(),
  editionKey: text('edition_key').notNull(), chapterUrl: text('chapter_url').notNull(),
  data: jsonb('data').$type<import('../../shared/reading-annotations.ts').ReadingMark>().notNull(),
}, (t) => [uniqueIndex('reading_annotations_user_id_idx').on(t.userId, t.id), index('reading_annotations_chapter_idx').on(t.userId, t.bookId, t.editionKey, t.chapterUrl)])
