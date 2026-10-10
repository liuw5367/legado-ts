import { latestSearchHistory } from '../../shared/search-history.ts'
import { normalizeIdentity } from '../../shared/book-identity.ts'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { NormalizedSource, PageCursor } from '@legado/source-core'
import { withUser } from './client.ts'
import { bookSourceCandidates, bookEditions, books, bookshelf, chapterContents, readerSettings, readingRecords, searchHistory, searchRuns, sourceImportPreviews, sourceRuntimeState, tocSnapshots, userSources, type BookEditionRow, type BookRow, type ChapterContentRow, type ReaderSettingsRow, type SearchHistoryRow, type SearchRunRow, type SourceRuntimeRow, type TocSnapshotRow, type UserSourceRow } from './schema.ts'
import type { ImportPreview, ImportPreviewCandidate, ManagedSourceSummary, SourceActionItem, SourceManagementPage, SourceManagementStatus, SourceOrderItem } from '../../shared/source-management.ts'
import { DEFAULT_READER_SETTINGS, type BookCreationInput, type HomeSnapshot, type ReaderSettings, type ReadingMode, type RuntimeStateSnapshot, type SearchHistoryItem, type SearchInput, type SearchRunState, type SourceSearchState, type SourceSummary, type StoredBookSourceCandidate, type StoredBook, type StoredCandidate, type StoredContent, type StoredEdition, type StoredPosition, type ThemeMode, type StoredToc } from '../domain/types.ts'
import { decryptRuntimeState, encryptRuntimeState } from './runtime-state-crypto.ts'

export interface StoredSourceRecord extends SourceSummary {
  rawSource: unknown
  normalizedSource: NormalizedSource
}

export interface SourceRuntimeStateRecord {
  sourceId: string
  sourceFingerprint: string
  snapshot: RuntimeStateSnapshot
  version: number
}

export interface SourceRuntimeLease extends SourceRuntimeStateRecord {
  leaseToken: string
}

export class SourceManagementError extends Error {
  public readonly code: 'source-conflict' | 'source-not-found' | 'preview-expired' | 'preview-invalid' | 'source-busy'
  public constructor(code: SourceManagementError['code'], message: string) { super(message); this.code = code }
}

export interface ReaderRepository {
  listSourcesForUser(userId: string): Promise<StoredSourceRecord[]>
  listAllSourcesForUser(userId: string): Promise<StoredSourceRecord[]>
  listSourceStatesForUser(userId: string): Promise<Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>>
  getSourceForUser(userId: string, sourceId: string): Promise<StoredSourceRecord | null>
  getSourceDisplayName(userId: string, sourceId: string): Promise<string | undefined>
  listManagedSources(userId: string, params: { page: number; pageSize: number; query: string; status: SourceManagementStatus; all?: boolean }): Promise<SourceManagementPage>
  applySourceActions(userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }>
  applySourceOrder(userId: string, items: SourceOrderItem[]): Promise<{ affected: number }>
  saveImportPreview(userId: string, preview: ImportPreview, sourceUrl: string): Promise<void>
  getImportPreview(userId: string, previewId: string): Promise<ImportPreview | null>
  commitImportPreview(userId: string, previewId: string, candidateIds: string[]): Promise<{ imported: number }>
  acquireSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, leaseMs: number): Promise<SourceRuntimeLease | null>
  saveSourceRuntimeState(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, expectedVersion: number, snapshot: RuntimeStateSnapshot): Promise<SourceRuntimeStateRecord | null>
  releaseSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string): Promise<void>
  getSettings(userId: string): Promise<ReaderSettings>
  saveSettings(userId: string, patch: { theme?: ReaderSettings['theme'] | undefined; readingMode?: ReadingMode | undefined; fontSize?: number | undefined; lineHeight?: number | undefined; marginTop?: number | undefined; marginRight?: number | undefined; marginBottom?: number | undefined; marginLeft?: number | undefined }): Promise<ReaderSettings>
  createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState>
  getSearch(userId: string, searchId: string): Promise<SearchRunState | null>
  claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }): Promise<SearchRunState | null>
  updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null>
  createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }>
  listBookSourceCandidates(userId: string, bookId: string): Promise<StoredBookSourceCandidate[]>
  saveBookSourceCandidates(userId: string, bookId: string, candidates: StoredCandidate[]): Promise<void>
  /** 保存版本用于目录预览，不修改书籍元数据、活动来源或书架关系。 */
  saveEdition(userId: string, bookId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<StoredEdition>
  addToBookshelf(userId: string, bookId: string): Promise<void>
  removeFromBookshelf(userId: string, bookId: string): Promise<void>
  isOnBookshelf(userId: string, bookId: string): Promise<boolean>
  getHome(userId: string): Promise<HomeSnapshot>
  deleteSearchHistory(userId: string, historyId: string): Promise<boolean>
  listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>>
  getBook(userId: string, bookId: string): Promise<StoredBook | null>
  listEditions(userId: string, bookId: string): Promise<StoredEdition[]>
  setActiveEdition(userId: string, bookId: string, editionKey: string): Promise<StoredEdition | null>
  getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null>
  getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null>
  saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc>
  getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null>
  saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent>
  getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null>
  savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition>
}

export class PostgresReaderRepository implements ReaderRepository {
  public async listSourcesForUser(userId: string): Promise<StoredSourceRecord[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.enabled, true), eq(userSources.deleted, false))).orderBy(asc(userSources.customOrder), asc(userSources.sourceId))
      return rows.map(toUserSource)
    })
  }

  public async listAllSourcesForUser(userId: string): Promise<StoredSourceRecord[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false))).orderBy(asc(userSources.customOrder), asc(userSources.sourceId))
      return rows.map(toUserSource)
    })
  }

  public async listSourceStatesForUser(userId: string): Promise<Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(eq(userSources.userId, userId))
      return rows.map((row) => ({ source: toUserSource(row), sourceRevision: row.revision, ...(row.deleted ? { deleted: true } : {}) }))
    })
  }

  public async getSourceForUser(userId: string, sourceId: string): Promise<StoredSourceRecord | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId), eq(userSources.enabled, true), eq(userSources.deleted, false))).limit(1)
      return row === undefined ? null : toUserSource(row)
    })
  }

  public async getSourceDisplayName(userId: string, sourceId: string): Promise<string | undefined> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select({ normalizedSource: userSources.normalizedSource }).from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId), eq(userSources.deleted, false))).limit(1)
      return row?.normalizedSource.bookSourceName
    })
  }

  public async listManagedSources(userId: string, params: { page: number; pageSize: number; query: string; status: SourceManagementStatus; all?: boolean }): Promise<SourceManagementPage> {
    return withUser(userId, async (transaction) => {
      const sourceRows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false)))
      const allRows = sourceRows.map((row) => managedSummary(toUserSource(row), row.revision, 'account', row.customOrder))
      const enabledCount = allRows.filter((source) => source.enabled).length
      const rows = allRows
        .filter((source) => {
          const query = params.query.toLocaleLowerCase()
          const matchesQuery = query.length === 0 || `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(query)
          return matchesQuery && (params.status === 'all' || (params.status === 'enabled' ? source.enabled : !source.enabled))
        })
        .sort((a, b) => a.customOrder - b.customOrder || a.name.localeCompare(b.name, 'zh-Hans') || a.sourceId.localeCompare(b.sourceId))
      const offset = (params.page - 1) * params.pageSize
      const page = params.all === true ? rows : rows.slice(offset, offset + params.pageSize)
      return { sources: page, page: params.all === true ? 1 : params.page, pageSize: params.all === true ? Math.max(1, rows.length) : params.pageSize, total: rows.length, enabledCount }
    })
  }

  public async applySourceActions(userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }> {
    return withUser(userId, async (transaction) => {
      const overrides = await transaction.select().from(userSources).where(eq(userSources.userId, userId)).for('update')
      const overrideById = new Map(overrides.map((row) => [row.sourceId, row]))
      const seen = new Set<string>()
      for (const item of items) {
        if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '操作列表包含重复书源')
        seen.add(item.sourceId)
        const override = overrideById.get(item.sourceId)
        if (override === undefined || override.deleted) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
        const current = toUserSource(override)
        if (override.revision !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
        const nextEnabled = action === 'enable'
        if (action === 'delete') {
          const runtimeRows = await transaction.select().from(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, current.sourceId))).for('update')
          if (runtimeRows.some((row) => row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${item.sourceId}`)
          await transaction.delete(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, current.sourceId)))
        }
        await transaction.insert(userSources).values({
          userId,
          sourceId: current.sourceId,
          fingerprint: current.fingerprint,
          rawSource: current.rawSource,
          normalizedSource: current.normalizedSource,
          enabled: action === 'delete' ? current.enabled : nextEnabled,
          customOrder: readInteger(current.normalizedSource.customOrder, 0),
          deleted: action === 'delete',
          revision: randomUUID(),
          updatedAt: new Date(),
        }).onConflictDoUpdate({ target: [userSources.userId, userSources.sourceId], set: { fingerprint: sql.raw('excluded."fingerprint"'), rawSource: sql.raw('excluded."raw_source"'), normalizedSource: sql.raw('excluded."normalized_source"'), enabled: sql.raw('excluded."enabled"'), customOrder: sql.raw('excluded."custom_order"'), deleted: sql.raw('excluded."deleted"'), revision: sql.raw('excluded."revision"'), updatedAt: new Date() } })
      }
      return { affected: items.length }
    })
  }

  public async applySourceOrder(userId: string, items: SourceOrderItem[]): Promise<{ affected: number }> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(userSources).where(and(eq(userSources.userId, userId), eq(userSources.deleted, false))).for('update')
      const byId = new Map(rows.map((row) => [row.sourceId, row]))
      const seen = new Set<string>()
      for (const item of items) {
        if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '排序列表包含重复书源')
        seen.add(item.sourceId)
        const current = byId.get(item.sourceId)
        if (current === undefined) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
        if (current.revision !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
        const normalizedSource = { ...current.normalizedSource, customOrder: item.customOrder }
        await transaction.update(userSources).set({ customOrder: item.customOrder, normalizedSource, revision: randomUUID(), updatedAt: new Date() }).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, item.sourceId), eq(userSources.revision, item.expectedSourceRevision)))
      }
      return { affected: items.length }
    })
  }

  public async saveImportPreview(userId: string, preview: ImportPreview, sourceUrl: string): Promise<void> {
    await withUser(userId, async (transaction) => {
      await transaction.delete(sourceImportPreviews).where(and(eq(sourceImportPreviews.userId, userId), lt(sourceImportPreviews.expiresAt, new Date())))
      await transaction.insert(sourceImportPreviews).values({ id: preview.previewId, userId, sourceUrl, candidates: preview.candidates, expiresAt: new Date(preview.expiresAt) })
    })
  }

  public async getImportPreview(userId: string, previewId: string): Promise<ImportPreview | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(sourceImportPreviews).where(and(eq(sourceImportPreviews.userId, userId), eq(sourceImportPreviews.id, previewId))).limit(1)
      if (row === undefined || row.expiresAt.getTime() <= Date.now()) return null
      return { previewId: row.id, expiresAt: row.expiresAt.toISOString(), candidates: row.candidates as ImportPreviewCandidate[], writableCount: (row.candidates as ImportPreviewCandidate[]).filter((candidate) => candidate.disposition !== undefined).length }
    })
  }

  public async commitImportPreview(userId: string, previewId: string, candidateIds: string[]): Promise<{ imported: number }> {
    return withUser(userId, async (transaction) => {
      const [previewRow] = await transaction.select().from(sourceImportPreviews).where(and(eq(sourceImportPreviews.userId, userId), eq(sourceImportPreviews.id, previewId))).limit(1).for('update')
      if (previewRow === undefined || previewRow.expiresAt.getTime() <= Date.now()) throw new SourceManagementError('preview-expired', '导入预览已过期，请重新获取')
      const previousIds = previewRow.consumedCandidateIds
      if (previousIds.length > 0) {
        if (sameStringSet(previousIds, candidateIds)) return previewRow.consumedResult ?? { imported: 0 }
        throw new SourceManagementError('preview-invalid', '导入预览已经确认过')
      }
      const candidates = (previewRow.candidates as ImportPreviewCandidate[]).filter((candidate) => candidateIds.includes(candidate.id))
      if (candidates.length !== candidateIds.length || candidates.some((candidate) => candidate.disposition === undefined)) throw new SourceManagementError('preview-invalid', '确认列表包含不可导入的书源')
      const overrides = await transaction.select().from(userSources).where(eq(userSources.userId, userId)).for('update')
      const overrideById = new Map(overrides.map((row) => [row.sourceId, row]))
      for (const candidate of candidates) {
        const current = overrideById.get(candidate.sourceId)
        const currentRevision = current?.revision
        if (candidate.sourceRevision === undefined ? currentRevision !== undefined : currentRevision !== candidate.sourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请重新获取预览：${candidate.name}`)
        const currentSource = current === undefined ? undefined : toUserSource(current)
        const normalizedSource = mergeImportedSource(currentSource, candidate.normalizedSource as NormalizedSource)
        const runtimeRows = await transaction.select().from(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, candidate.sourceId))).for('update')
        if (runtimeRows.some((row) => row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${candidate.name}`)
        if (currentSource !== undefined && currentSource.fingerprint !== candidate.fingerprint) await transaction.delete(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, candidate.sourceId)))
        await transaction.insert(userSources).values({ userId, sourceId: candidate.sourceId, fingerprint: candidate.fingerprint, rawSource: candidate.rawSource, normalizedSource, enabled: currentSource?.enabled ?? true, customOrder: readInteger(currentSource?.normalizedSource.customOrder, 0), deleted: false, revision: randomUUID(), updatedAt: new Date() }).onConflictDoUpdate({ target: [userSources.userId, userSources.sourceId], set: { fingerprint: sql.raw('excluded."fingerprint"'), rawSource: sql.raw('excluded."raw_source"'), normalizedSource: sql.raw('excluded."normalized_source"'), enabled: sql.raw('excluded."enabled"'), customOrder: sql.raw('excluded."custom_order"'), deleted: false, revision: sql.raw('excluded."revision"'), updatedAt: new Date() } })
      }
      const result = { imported: candidates.length }
      await transaction.update(sourceImportPreviews).set({ consumedCandidateIds: candidateIds, consumedResult: result }).where(and(eq(sourceImportPreviews.userId, userId), eq(sourceImportPreviews.id, previewId)))
      return result
    })
  }

  public async acquireSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, leaseMs: number): Promise<SourceRuntimeLease | null> {
    return withUser(userId, async (transaction) => {
      const identity = and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, sourceId), eq(sourceRuntimeState.sourceFingerprint, sourceFingerprint))
      const now = new Date()
      const leaseUntil = new Date(now.getTime() + Math.max(1_000, leaseMs))
      const [existing] = await transaction.select().from(sourceRuntimeState).where(identity).limit(1)
      if (existing === undefined) {
        const [created] = await transaction.insert(sourceRuntimeState).values({ userId, sourceId, sourceFingerprint, encryptedState: encryptRuntimeState({}), leaseToken, leaseUntil, updatedAt: now }).onConflictDoNothing().returning()
        if (created !== undefined) return toRuntimeLease(created, leaseToken)
      }
      const [leased] = await transaction.update(sourceRuntimeState).set({ leaseToken, leaseUntil, updatedAt: now }).where(and(identity, or(isNull(sourceRuntimeState.leaseToken), isNull(sourceRuntimeState.leaseUntil), lt(sourceRuntimeState.leaseUntil, now)))).returning()
      return leased === undefined ? null : toRuntimeLease(leased, leaseToken)
    })
  }

  public async saveSourceRuntimeState(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, expectedVersion: number, snapshot: RuntimeStateSnapshot): Promise<SourceRuntimeStateRecord | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(sourceRuntimeState).set({ encryptedState: encryptRuntimeState(snapshot), version: sql`${sourceRuntimeState.version} + 1`, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, sourceId), eq(sourceRuntimeState.sourceFingerprint, sourceFingerprint), eq(sourceRuntimeState.leaseToken, leaseToken), eq(sourceRuntimeState.version, expectedVersion))).returning()
      return row === undefined ? null : toRuntimeState(row)
    })
  }

  public async releaseSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string): Promise<void> {
    await withUser(userId, async (transaction) => {
      await transaction.update(sourceRuntimeState).set({ leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, sourceId), eq(sourceRuntimeState.sourceFingerprint, sourceFingerprint), eq(sourceRuntimeState.leaseToken, leaseToken)))
    })
  }

  public async getSettings(userId: string): Promise<ReaderSettings> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      return row === undefined ? defaultReaderSettings(userId) : toSettings(row)
    })
  }

  public async saveSettings(userId: string, patch: { theme?: ReaderSettings['theme'] | undefined; readingMode?: ReadingMode | undefined; fontSize?: number | undefined; lineHeight?: number | undefined; marginTop?: number | undefined; marginRight?: number | undefined; marginBottom?: number | undefined; marginLeft?: number | undefined }): Promise<ReaderSettings> {
    return withUser(userId, async (transaction) => {
      const [current] = await transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      const values = {
        userId,
        theme: patch.theme ?? current?.theme ?? DEFAULT_READER_SETTINGS.theme,
        readingMode: patch.readingMode ?? current?.readingMode ?? DEFAULT_READER_SETTINGS.readingMode,
        fontSize: patch.fontSize ?? current?.fontSize ?? DEFAULT_READER_SETTINGS.fontSize,
        lineHeightUnits: Math.round((patch.lineHeight ?? (current === undefined ? DEFAULT_READER_SETTINGS.lineHeight : current.lineHeightUnits / 100)) * 100),
        marginTop: patch.marginTop ?? current?.marginTop ?? DEFAULT_READER_SETTINGS.marginTop,
        marginRight: patch.marginRight ?? current?.marginRight ?? DEFAULT_READER_SETTINGS.marginRight,
        marginBottom: patch.marginBottom ?? current?.marginBottom ?? DEFAULT_READER_SETTINGS.marginBottom,
        marginLeft: patch.marginLeft ?? current?.marginLeft ?? DEFAULT_READER_SETTINGS.marginLeft,
        updatedAt: new Date(),
      }
      const [row] = await transaction.insert(readerSettings).values(values).onConflictDoUpdate({ target: readerSettings.userId, set: { theme: values.theme, readingMode: values.readingMode, fontSize: values.fontSize, lineHeightUnits: values.lineHeightUnits, marginTop: values.marginTop, marginRight: values.marginRight, marginBottom: values.marginBottom, marginLeft: values.marginLeft, updatedAt: values.updatedAt } }).returning()
      if (row === undefined) throw new Error('保存阅读设置失败')
      return toSettings(row)
    })
  }

  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> {
    return withUser(userId, async (transaction) => {
      const sourceIds = input.sourceIds === undefined || input.sourceIds.length === 0 ? [input.sourceId] : [...new Set(input.sourceIds)]
      const sourceStates: SourceSearchState[] = sourceIds.map((sourceId) => ({ sourceId, status: 'pending', candidates: [], diagnostics: [] }))
      const [row] = await transaction.insert(searchRuns).values({
        userId,
        keyword: input.keyword,
        sourceId: input.sourceId,
        sourceIds,
        precision: input.precision === true,
        ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
        status: 'running',
        sourceStates,
        progressTotal: sourceIds.length,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }).returning()
      if (row === undefined) throw new Error('创建搜索任务失败')
      await transaction.insert(searchHistory).values({ userId, searchId: row.id, keyword: input.keyword, sourceIds, status: 'running', resultCount: 0 })
      return toSearch(row)
    })
  }

  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(searchRuns).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId))).limit(1)
      return row === undefined ? null : toSearch(row)
    })
  }

  public async claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({ operationId, sourceStates, progressCompleted: progress.completed, progressTotal: progress.total, status: 'running', cancelled: false, version: sql`${searchRuns.version} + 1`, updatedAt: new Date() }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId), isNull(searchRuns.operationId))).returning()
      return row === undefined ? null : toSearch(row)
    })
  }

  public async updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.update(searchRuns).set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }),
        ...(patch.sourceStates === undefined ? {} : { sourceStates: patch.sourceStates }),
        ...(patch.sourceIds === undefined ? {} : { sourceIds: patch.sourceIds }),
        ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }),
        ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }),
        ...(patch.operationId === undefined ? {} : { operationId: patch.operationId }),
        ...(patch.progress === undefined ? {} : { progressCompleted: patch.progress.completed, progressTotal: patch.progress.total }),
        ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }),
        updatedAt: new Date(),
        version: sql`${searchRuns.version} + 1`,
      }).where(and(eq(searchRuns.userId, userId), eq(searchRuns.id, searchId), ...(patch.expectedOperationId === undefined ? [] : [eq(searchRuns.operationId, patch.expectedOperationId)]))).returning()
      if (row !== undefined) {
        const historyStatus = row.status === 'capability-missing' ? 'failed' : row.status
        await transaction.update(searchHistory).set({ status: historyStatus, resultCount: row.candidates.length, summary: searchSummary(historyStatus, row.candidates.length), updatedAt: new Date() }).where(and(eq(searchHistory.userId, userId), eq(searchHistory.searchId, searchId), isNull(searchHistory.deletedAt)))
      }
      return row === undefined ? null : toSearch(row)
    })
  }

  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> {
    return withUser(userId, async (transaction) => {
      const [existingEdition] = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.editionKey, input.editionKey))).limit(1)
      if (existingEdition !== undefined && input.bookId !== undefined && existingEdition.bookId !== input.bookId) throw new Error('书籍版本已经属于其他书籍')
      const now = new Date()
      const targetBookId = existingEdition?.bookId ?? input.bookId
      let book: BookRow | undefined
      if (targetBookId !== undefined) {
        const [updatedBook] = await transaction.update(books).set({
          name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍',
          ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
          ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }),
          ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }),
          ...(input.activateEdition === false ? {} : { activeEditionKey: input.editionKey }),
          updatedAt: now,
        }).where(and(eq(books.userId, userId), eq(books.id, targetBookId))).returning()
        book = updatedBook
      } else {
        const [createdBook] = await transaction.insert(books).values({
          userId,
          name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍',
          ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
          ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }),
          ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }),
          activeEditionKey: input.editionKey,
        }).returning()
        book = createdBook
      }
      if (book === undefined) throw new Error('创建书籍失败')
      const editionValues = {
        userId,
        bookId: book.id,
        editionKey: input.editionKey,
        sourceId: input.candidate.sourceId,
        sourceFingerprint: input.sourceFingerprint,
        bookUrl: input.metadata.bookUrl,
        metadata: input.metadata,
        ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }),
        updatedAt: now,
      }
      const [edition] = existingEdition === undefined
        ? await transaction.insert(bookEditions).values(editionValues).returning()
        : await transaction.update(bookEditions).set({ sourceId: editionValues.sourceId, sourceFingerprint: editionValues.sourceFingerprint, bookUrl: editionValues.bookUrl, metadata: editionValues.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }), updatedAt: now }).where(and(eq(bookEditions.userId, userId), eq(bookEditions.editionKey, input.editionKey))).returning()
      if (edition === undefined) throw new Error('创建书籍版本失败')
      if (input.addToBookshelf !== false) await transaction.insert(bookshelf).values({ userId, bookId: book.id }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] })
      return { book: toBook(book), edition: toEdition(edition) }
    })
  }

  public async listBookSourceCandidates(userId: string, bookId: string): Promise<StoredBookSourceCandidate[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(bookSourceCandidates).where(and(eq(bookSourceCandidates.userId, userId), eq(bookSourceCandidates.bookId, bookId))).orderBy(desc(bookSourceCandidates.updatedAt), asc(bookSourceCandidates.id))
      return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
    })
  }

  public async saveBookSourceCandidates(userId: string, bookId: string, candidates: StoredCandidate[]): Promise<void> {
    if (candidates.length === 0) return
    await withUser(userId, async (transaction) => {
      const [book] = await transaction.select({ id: books.id }).from(books).where(and(eq(books.userId, userId), eq(books.id, bookId)))
      if (book === undefined) throw new Error('书籍不存在')
      const unique = new Map(candidates.map((candidate) => [JSON.stringify([candidate.sourceId, candidate.sourceFingerprint, candidate.candidate.bookUrl]), candidate]))
      // 分块避免大型搜索超过Postgres参数上限；旧版本缓存保留，但读取时验证fingerprint。
      const values = [...unique.values()]
      for (let offset = 0; offset < values.length; offset += 100) {
        await transaction.insert(bookSourceCandidates).values(values.slice(offset, offset + 100).map((candidate) => ({ userId, bookId, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.candidate.bookUrl, candidate: cacheableCandidate(candidate) }))).onConflictDoUpdate({ target: [bookSourceCandidates.userId, bookSourceCandidates.bookId, bookSourceCandidates.sourceId, bookSourceCandidates.sourceFingerprint, bookSourceCandidates.bookUrl], set: { candidate: sql`excluded.candidate`, updatedAt: new Date() } })
      }
    })
  }

  public async saveEdition(userId: string, bookId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<StoredEdition> {
    return withUser(userId, async (transaction) => {
      const [book] = await transaction.select({ id: books.id }).from(books).where(and(eq(books.userId, userId), eq(books.id, bookId)))
      if (book === undefined) throw new Error('书籍不存在')
      await transaction.insert(bookEditions).values({ userId, bookId, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }).onConflictDoNothing({ target: [bookEditions.userId, bookEditions.editionKey] })
      const [edition] = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), eq(bookEditions.editionKey, input.editionKey)))
      if (edition === undefined) throw new Error('书籍版本已经属于其他书籍')
      return toEdition(edition)
    })
  }

  public async addToBookshelf(userId: string, bookId: string): Promise<void> {
    await withUser(userId, async (transaction) => { await transaction.insert(bookshelf).values({ userId, bookId }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] }) })
  }

  public async removeFromBookshelf(userId: string, bookId: string): Promise<void> {
    await withUser(userId, async (transaction) => { await transaction.delete(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, bookId))) })
  }

  public async isOnBookshelf(userId: string, bookId: string): Promise<boolean> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select({ bookId: bookshelf.bookId }).from(bookshelf).where(and(eq(bookshelf.userId, userId), eq(bookshelf.bookId, bookId))).limit(1)
      return rows.length > 0
    })
  }

  public async getHome(userId: string): Promise<HomeSnapshot> {
    return withUser(userId, async (transaction) => {
      const shelfRows = await transaction.select({ book: books, edition: bookEditions }).from(bookshelf).innerJoin(books, and(eq(books.userId, userId), eq(books.id, bookshelf.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(bookshelf.userId, userId)).orderBy(desc(bookshelf.addedAt))
      const readingRows = await transaction.select({ book: books, edition: bookEditions, position: readingRecords }).from(readingRecords).innerJoin(books, and(eq(books.userId, userId), eq(books.id, readingRecords.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, readingRecords.bookId), eq(bookEditions.editionKey, readingRecords.editionKey))).where(eq(readingRecords.userId, userId)).orderBy(desc(readingRecords.lastReadAt)).limit(50)
      const historyRows = await transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt))).orderBy(desc(searchHistory.createdAt), desc(searchHistory.id))
      const positions = new Map(readingRows.map((row) => [`${row.book.id}:${row.edition.editionKey}`, toPosition(row.position)]))
      const shelf = shelfRows.map((row) => { const book = toBook(row.book); const edition = toEdition(row.edition); const position = positions.get(`${row.book.id}:${row.edition.editionKey}`); return position === undefined ? { book, edition } : { book, edition, position } })
      const seenReadingBooks = new Set<string>()
      const reading = readingRows.filter((row) => { if (seenReadingBooks.has(row.book.id)) return false; seenReadingBooks.add(row.book.id); return true }).map((row) => ({ book: toBook(row.book), edition: toEdition(row.edition), position: toPosition(row.position) }))
      return { bookshelf: shelf, reading, searchHistory: latestSearchHistory(historyRows.map(toHistory)).slice(0, 50) }
    })
  }

  public async deleteSearchHistory(userId: string, historyId: string): Promise<boolean> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt)))
      const target = rows.find((row) => row.id === historyId)
      if (target === undefined) return false
      const ids = rows.filter((row) => normalizeIdentity(row.keyword) === normalizeIdentity(target.keyword)).map((row) => row.id)
      // 删除整组展示历史，避免旧请求记录在去重后重新出现；搜索任务仍保留。
      await transaction.update(searchHistory).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(searchHistory.userId, userId), inArray(searchHistory.id, ids)))
      return true
    })
  }

  public async listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select({ book: books, edition: bookEditions }).from(books).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(books.userId, userId)).orderBy(desc(books.updatedAt))
      return rows.map((row) => ({ book: toBook(row.book), edition: toEdition(row.edition) }))
    })
  }

  public async getBook(userId: string, bookId: string): Promise<StoredBook | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(books).where(and(eq(books.userId, userId), eq(books.id, bookId))).limit(1)
      return row === undefined ? null : toBook(row)
    })
  }

  public async listEditions(userId: string, bookId: string): Promise<StoredEdition[]> {
    return withUser(userId, async (transaction) => {
      const rows = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId))).orderBy(desc(bookEditions.updatedAt), asc(bookEditions.createdAt))
      return rows.map(toEdition)
    })
  }

  public async setActiveEdition(userId: string, bookId: string, editionKey: string): Promise<StoredEdition | null> {
    return withUser(userId, async (transaction) => {
      const [edition] = await transaction.select().from(bookEditions).where(and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), eq(bookEditions.editionKey, editionKey))).limit(1)
      if (edition === undefined) return null
      await transaction.update(books).set({ activeEditionKey: editionKey, updatedAt: new Date() }).where(and(eq(books.userId, userId), eq(books.id, bookId)))
      return toEdition(edition)
    })
  }

  public async getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null> {
    return withUser(userId, async (transaction) => {
      const conditions = [eq(bookEditions.userId, userId), eq(bookEditions.bookId, bookId), ...(editionKey === undefined ? [] : [eq(bookEditions.editionKey, editionKey)])]
      const [row] = await transaction.select().from(bookEditions).where(and(...conditions)).orderBy(desc(bookEditions.updatedAt)).limit(1)
      return row === undefined ? null : toEdition(row)
    })
  }

  public async getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(tocSnapshots).where(and(eq(tocSnapshots.userId, userId), eq(tocSnapshots.bookId, bookId), eq(tocSnapshots.editionKey, editionKey))).limit(1)
      return row === undefined ? null : toToc(row)
    })
  }

  public async saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.insert(tocSnapshots).values({
        userId,
        bookId: toc.bookId,
        editionKey: toc.editionKey,
        sourceFingerprint: toc.sourceFingerprint,
        revision: toc.revision,
        chapters: toc.chapters,
        bookPatch: toc.bookPatch,
        ...(toc.bookAfter === undefined ? {} : { bookAfter: toc.bookAfter }),
        updatedAt: new Date(),
      }).onConflictDoUpdate({ target: [tocSnapshots.userId, tocSnapshots.editionKey], set: {
        sourceFingerprint: toc.sourceFingerprint,
        revision: toc.revision,
        chapters: toc.chapters,
        bookPatch: toc.bookPatch,
        ...(toc.bookAfter === undefined ? {} : { bookAfter: toc.bookAfter }),
        updatedAt: new Date(),
      } }).returning()
      if (row === undefined) throw new Error('保存目录失败')
      return toToc(row)
    })
  }

  public async getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(chapterContents).where(and(eq(chapterContents.userId, userId), eq(chapterContents.editionKey, editionKey), eq(chapterContents.tocRevision, tocRevision), eq(chapterContents.chapterId, chapterId))).limit(1)
      return row === undefined ? null : toContent(row)
    })
  }

  public async saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.insert(chapterContents).values({
        userId,
        bookId: content.bookId,
        editionKey: content.editionKey,
        chapterId: content.chapterId,
        tocRevision: content.tocRevision,
        sourceFingerprint: content.sourceFingerprint,
        content: content.content,
        updatedAt: new Date(),
      }).onConflictDoUpdate({ target: [chapterContents.userId, chapterContents.editionKey, chapterContents.tocRevision, chapterContents.chapterId], set: { content: content.content, sourceFingerprint: content.sourceFingerprint, updatedAt: new Date() } }).returning()
      if (row === undefined) throw new Error('保存正文失败')
      return toContent(row)
    })
  }

  public async getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.select().from(readingRecords).where(and(eq(readingRecords.userId, userId), eq(readingRecords.bookId, bookId), eq(readingRecords.editionKey, editionKey))).limit(1)
      return row === undefined ? null : toPosition(row)
    })
  }

  public async savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition> {
    return withUser(userId, async (transaction) => {
      const [row] = await transaction.insert(readingRecords).values({
        userId,
        bookId: position.bookId,
        editionKey: position.editionKey,
        chapterId: position.chapterId,
        chapterUrl: position.chapterUrl,
        chapterIndex: position.chapterIndex,
        title: position.title,
        ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }),
        paragraphIndex: position.paragraphIndex,
        offset: position.offset,
        version: position.version,
        ...(position.lastReadAt === undefined ? {} : { lastReadAt: new Date(position.lastReadAt) }),
      }).onConflictDoUpdate({ target: [readingRecords.userId, readingRecords.bookId, readingRecords.editionKey], set: {
        chapterId: position.chapterId,
        chapterUrl: position.chapterUrl,
        chapterIndex: position.chapterIndex,
        title: position.title,
        ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }),
        paragraphIndex: position.paragraphIndex,
        offset: position.offset,
        version: position.version,
        ...(position.lastReadAt === undefined ? { lastReadAt: new Date() } : { lastReadAt: new Date(position.lastReadAt) }),
      } }).returning()
      if (row === undefined) throw new Error('保存阅读位置失败')
      return toPosition(row)
    })
  }
}

export class MemoryReaderRepository implements ReaderRepository {
  private readonly userSourceMap = new Map<string, { source: StoredSourceRecord; deleted: boolean; revision: string }>()
  private readonly importPreviews = new Map<string, { userId: string; sourceUrl: string; preview: ImportPreview; consumedIds: string[]; result?: { imported: number } }>()
  private readonly runtimeStates = new Map<string, { snapshot: RuntimeStateSnapshot; version: number; leaseToken: string | null; leaseUntil: number | null }>()
  private readonly searches = new Map<string, SearchRunState>()
  private readonly books = new Map<string, { book: StoredBook; edition: StoredEdition }>()
  private readonly tocs = new Map<string, StoredToc>()
  private readonly contents = new Map<string, StoredContent>()
  private readonly positions = new Map<string, StoredPosition>()
  private readonly shelf = new Map<string, string>()
  private readonly history = new Map<string, SearchHistoryItem>()
  private readonly sourceCandidates = new Map<string, StoredBookSourceCandidate>()
  private readonly settings = new Map<string, ReaderSettings>()

  public async listSourcesForUser(userId: string): Promise<StoredSourceRecord[]> { return this.sortSources(this.allSources(userId).filter((source) => source.enabled)) }
  public async listAllSourcesForUser(userId: string): Promise<StoredSourceRecord[]> { return this.sortSources(this.allSources(userId)) }
  public async listSourceStatesForUser(userId: string): Promise<Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>> { return this.allSourceStates(userId).map(({ source, deleted }) => ({ source, sourceRevision: this.sourceRevision(userId, source.sourceId), deleted })) }
  public async getSourceForUser(userId: string, sourceId: string): Promise<StoredSourceRecord | null> { return this.allSources(userId).find((source) => source.sourceId === sourceId && source.enabled) ?? null }
  public async getSourceDisplayName(userId: string, sourceId: string): Promise<string | undefined> { return this.allSources(userId).find((source) => source.sourceId === sourceId)?.normalizedSource.bookSourceName }
  public async listManagedSources(userId: string, params: { page: number; pageSize: number; query: string; status: SourceManagementStatus; all?: boolean }): Promise<SourceManagementPage> {
    const query = params.query.toLocaleLowerCase()
    const allRows = this.allSources(userId)
    const enabledCount = allRows.filter((source) => source.enabled).length
    const rows = allRows.filter((source) => {
      const matchesQuery = query.length === 0 || `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(query)
      return matchesQuery && (params.status === 'all' || (params.status === 'enabled' ? source.enabled : !source.enabled))
    }).sort((a, b) => readInteger(a.normalizedSource.customOrder, 0) - readInteger(b.normalizedSource.customOrder, 0) || a.name.localeCompare(b.name, 'zh-Hans') || a.sourceId.localeCompare(b.sourceId))
    const offset = (params.page - 1) * params.pageSize
    return { sources: (params.all === true ? rows : rows.slice(offset, offset + params.pageSize)).map((source) => managedSummary(source, this.sourceRevision(userId, source.sourceId), 'account')), page: params.all === true ? 1 : params.page, pageSize: params.all === true ? Math.max(1, rows.length) : params.pageSize, total: rows.length, enabledCount }
  }
  public async applySourceActions(userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }> {
    const seen = new Set<string>()
    const updates: Array<{ source: StoredSourceRecord; deleted: boolean }> = []
    for (const item of items) {
      if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '操作列表包含重复书源')
      seen.add(item.sourceId)
      const source = await this.getSourceForManagement(userId, item.sourceId)
      if (source === undefined) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
      if (this.sourceRevision(userId, item.sourceId) !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
      if (action === 'delete' && this.runtimeEntriesForSource(userId, item.sourceId).some(([, state]) => state.leaseToken !== null && (state.leaseUntil ?? 0) > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${item.sourceId}`)
      updates.push({ source, deleted: action === 'delete' })
    }
    for (const update of updates) {
      if (update.deleted) for (const [key] of this.runtimeEntriesForSource(userId, update.source.sourceId)) this.runtimeStates.delete(key)
      const next: StoredSourceRecord = { ...update.source, enabled: update.deleted ? update.source.enabled : action === 'enable' }
      this.userSourceMap.set(`${userId}:${update.source.sourceId}`, { source: next, deleted: update.deleted, revision: randomUUID() })
    }
    return { affected: items.length }
  }
  public async applySourceOrder(userId: string, items: SourceOrderItem[]): Promise<{ affected: number }> {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '排序列表包含重复书源')
      seen.add(item.sourceId)
      const key = `${userId}:${item.sourceId}`
      const record = this.userSourceMap.get(key)
      if (record === undefined || record.deleted) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
      if (record.revision !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
      const normalizedSource = { ...record.source.normalizedSource, customOrder: item.customOrder }
      this.userSourceMap.set(key, { ...record, source: { ...record.source, normalizedSource }, revision: randomUUID() })
    }
    return { affected: items.length }
  }
  private sortSources(sources: StoredSourceRecord[]): StoredSourceRecord[] { return sources.sort((a, b) => readInteger(a.normalizedSource.customOrder, 0) - readInteger(b.normalizedSource.customOrder, 0) || a.name.localeCompare(b.name, 'zh-Hans') || a.sourceId.localeCompare(b.sourceId)) }
  public async saveImportPreview(userId: string, preview: ImportPreview, sourceUrl: string): Promise<void> { this.importPreviews.set(`${userId}:${preview.previewId}`, { userId, sourceUrl, preview, consumedIds: [] }) }
  public async getImportPreview(userId: string, previewId: string): Promise<ImportPreview | null> { const record = this.importPreviews.get(`${userId}:${previewId}`); return record === undefined || new Date(record.preview.expiresAt).getTime() <= Date.now() ? null : record.preview }
  public async commitImportPreview(userId: string, previewId: string, candidateIds: string[]): Promise<{ imported: number }> {
    const record = this.importPreviews.get(`${userId}:${previewId}`)
    if (record === undefined || new Date(record.preview.expiresAt).getTime() <= Date.now()) throw new SourceManagementError('preview-expired', '导入预览已过期，请重新获取')
    if (record.consumedIds.length > 0) { if (sameStringSet(record.consumedIds, candidateIds)) return record.result ?? { imported: 0 }; throw new SourceManagementError('preview-invalid', '导入预览已经确认过') }
    const candidates = record.preview.candidates.filter((candidate) => candidateIds.includes(candidate.id))
    if (candidates.length !== candidateIds.length || candidates.some((candidate) => candidate.disposition === undefined)) throw new SourceManagementError('preview-invalid', '确认列表包含不可导入的书源')
    for (const candidate of candidates) {
      const currentRevision = this.userSourceMap.has(`${userId}:${candidate.sourceId}`) ? this.sourceRevision(userId, candidate.sourceId) : undefined
      if (candidate.sourceRevision === undefined ? currentRevision !== undefined : currentRevision !== candidate.sourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请重新获取预览：${candidate.name}`)
      if (this.runtimeEntriesForSource(userId, candidate.sourceId).some(([, state]) => state.leaseToken !== null && (state.leaseUntil ?? 0) > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${candidate.name}`)
    }
    for (const candidate of candidates) {
      const current = this.userSourceMap.get(`${userId}:${candidate.sourceId}`)?.source
      if (current !== undefined && current.fingerprint !== candidate.fingerprint) for (const [key] of this.runtimeEntriesForSource(userId, candidate.sourceId)) this.runtimeStates.delete(key)
      const normalizedSource = mergeImportedSource(current, candidate.normalizedSource as NormalizedSource)
      this.userSourceMap.set(`${userId}:${candidate.sourceId}`, { source: { sourceId: candidate.sourceId, name: normalizedSource.bookSourceName, ...(typeof normalizedSource.bookSourceGroup === 'string' ? { group: normalizedSource.bookSourceGroup } : {}), fingerprint: candidate.fingerprint, enabled: current?.enabled ?? true, rawSource: candidate.rawSource, normalizedSource }, deleted: false, revision: randomUUID() })
    }
    record.consumedIds = [...candidateIds]; record.result = { imported: candidates.length }; return record.result
  }
  private allSources(userId: string): StoredSourceRecord[] { return [...this.userSourceMap.entries()].filter(([key, value]) => key.startsWith(`${userId}:`) && value.deleted === false).map(([, value]) => value.source) }
  private allSourceStates(userId: string): Array<{ source: StoredSourceRecord; deleted: boolean }> { return [...this.userSourceMap.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([, value]) => ({ source: value.source, deleted: value.deleted })) }
  private getSourceForManagement(userId: string, sourceId: string): Promise<StoredSourceRecord | undefined> { const override = this.userSourceMap.get(`${userId}:${sourceId}`); return Promise.resolve(override?.deleted === true ? undefined : override?.source) }
  private sourceRevision(userId: string, sourceId: string): string { return this.userSourceMap.get(`${userId}:${sourceId}`)?.revision ?? '' }
  private runtimeEntriesForSource(userId: string, sourceId: string): Array<[string, { snapshot: RuntimeStateSnapshot; version: number; leaseToken: string | null; leaseUntil: number | null }]> { return [...this.runtimeStates.entries()].filter(([key]) => { const identity = JSON.parse(key) as unknown[]; return identity[0] === userId && identity[1] === sourceId }) }
  public async acquireSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, leaseMs: number): Promise<SourceRuntimeLease | null> { const key = runtimeStateKey(userId, sourceId, sourceFingerprint); const now = Date.now(); const current = this.runtimeStates.get(key); if (current !== undefined && current.leaseToken !== null && (current.leaseUntil ?? 0) > now) return null; const next = current ?? { snapshot: {}, version: 0, leaseToken: null, leaseUntil: null }; next.leaseToken = leaseToken; next.leaseUntil = now + Math.max(1_000, leaseMs); this.runtimeStates.set(key, next); return { sourceId, sourceFingerprint, snapshot: cloneRuntimeSnapshot(next.snapshot), version: next.version, leaseToken } }
  public async saveSourceRuntimeState(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string, expectedVersion: number, snapshot: RuntimeStateSnapshot): Promise<SourceRuntimeStateRecord | null> { const key = runtimeStateKey(userId, sourceId, sourceFingerprint); const current = this.runtimeStates.get(key); if (current === undefined || current.leaseToken !== leaseToken || current.version !== expectedVersion) return null; const next = { snapshot: cloneRuntimeSnapshot(snapshot), version: current.version + 1, leaseToken: null, leaseUntil: null }; this.runtimeStates.set(key, next); return { sourceId, sourceFingerprint, snapshot: cloneRuntimeSnapshot(next.snapshot), version: next.version } }
  public async releaseSourceRuntimeLease(userId: string, sourceId: string, sourceFingerprint: string, leaseToken: string): Promise<void> { const current = this.runtimeStates.get(runtimeStateKey(userId, sourceId, sourceFingerprint)); if (current?.leaseToken !== leaseToken) return; current.leaseToken = null; current.leaseUntil = null }
  public async getSettings(userId: string): Promise<ReaderSettings> { return this.settings.get(userId) ?? defaultReaderSettings(userId) }
  public async saveSettings(userId: string, patch: { theme?: ReaderSettings['theme'] | undefined; readingMode?: ReadingMode | undefined; fontSize?: number | undefined; lineHeight?: number | undefined; marginTop?: number | undefined; marginRight?: number | undefined; marginBottom?: number | undefined; marginLeft?: number | undefined }): Promise<ReaderSettings> { const current = await this.getSettings(userId); const next: ReaderSettings = { ...current, ...(patch.theme === undefined ? {} : { theme: patch.theme }), ...(patch.readingMode === undefined ? {} : { readingMode: patch.readingMode }), ...(patch.fontSize === undefined ? {} : { fontSize: patch.fontSize }), ...(patch.lineHeight === undefined ? {} : { lineHeight: patch.lineHeight }), ...(patch.marginTop === undefined ? {} : { marginTop: patch.marginTop }), ...(patch.marginRight === undefined ? {} : { marginRight: patch.marginRight }), ...(patch.marginBottom === undefined ? {} : { marginBottom: patch.marginBottom }), ...(patch.marginLeft === undefined ? {} : { marginLeft: patch.marginLeft }), updatedAt: new Date().toISOString() }; this.settings.set(userId, next); return next }
  public async createSearch(userId: string, input: SearchInput, sourceFingerprint?: string): Promise<SearchRunState> { const now = new Date().toISOString(); const sourceIds = input.sourceIds === undefined || input.sourceIds.length === 0 ? [input.sourceId] : [...new Set(input.sourceIds)]; const sourceStates: SourceSearchState[] = sourceIds.map((sourceId) => ({ sourceId, status: 'pending', candidates: [], diagnostics: [] })); const search: SearchRunState = { id: randomUUID(), userId, keyword: input.keyword, sourceId: sourceIds[0] ?? input.sourceId, sourceIds, ...(input.precision === true ? { precision: true } : {}), ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }), status: 'running', candidates: [], sourceStates, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), progress: { completed: 0, total: sourceIds.length }, version: 0, cancelled: false, createdAt: now, updatedAt: now }; this.searches.set(search.id, search); this.history.set(`${userId}:${search.id}`, { id: randomUUID(), searchId: search.id, keyword: input.keyword, sourceIds, status: 'running', resultCount: 0, createdAt: now, updatedAt: now }); return search }
  public async getSearch(userId: string, searchId: string): Promise<SearchRunState | null> { const search = this.searches.get(searchId); return search?.userId === userId ? search : null }
  public async claimSearch(userId: string, searchId: string, operationId: string, sourceStates: SourceSearchState[], progress: { completed: number; total: number }): Promise<SearchRunState | null> { const current = await this.getSearch(userId, searchId); if (current === null || current.operationId !== undefined) return null; return this.updateSearch(userId, searchId, { sourceStates, progress, operationId, status: 'running', cancelled: false }) }
  public async updateSearch(userId: string, searchId: string, patch: { status?: SearchRunState['status']; candidates?: StoredCandidate[]; sourceStates?: SourceSearchState[]; sourceIds?: string[]; cursor?: PageCursor; nextCursor?: PageCursor; operationId?: string | null; expectedOperationId?: string; progress?: { completed: number; total: number }; cancelled?: boolean }): Promise<SearchRunState | null> { const current = await this.getSearch(userId, searchId); if (current === null || (patch.expectedOperationId !== undefined && current.operationId !== patch.expectedOperationId)) return null; const updated: SearchRunState = { ...current, ...(patch.status === undefined ? {} : { status: patch.status }), ...(patch.candidates === undefined ? {} : { candidates: patch.candidates }), ...(patch.sourceStates === undefined ? {} : { sourceStates: patch.sourceStates }), ...(patch.sourceIds === undefined ? {} : { sourceIds: patch.sourceIds }), ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }), ...(patch.nextCursor === undefined ? {} : { nextCursor: patch.nextCursor }), ...(patch.operationId === undefined || patch.operationId === null ? {} : { operationId: patch.operationId }), ...(patch.progress === undefined ? {} : { progress: patch.progress }), ...(patch.cancelled === undefined ? {} : { cancelled: patch.cancelled }), updatedAt: new Date().toISOString(), version: current.version + 1 }; if (patch.operationId === null) delete updated.operationId; this.searches.set(searchId, updated); const history = this.history.get(`${userId}:${searchId}`); if (history !== undefined) this.history.set(`${userId}:${searchId}`, { ...history, status: updated.status, resultCount: updated.candidates.length, summary: searchSummary(updated.status, updated.candidates.length), updatedAt: updated.updatedAt }); return updated }
  public async createBook(userId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<{ book: StoredBook; edition: StoredEdition }> { const existing = [...this.books.values()].find((item) => item.book.userId === userId && item.edition.editionKey === input.editionKey); const target = input.bookId === undefined ? undefined : [...this.books.values()].find((item) => item.book.userId === userId && item.book.id === input.bookId); if (input.bookId !== undefined && target === undefined) throw new Error('书籍不存在'); if (existing !== undefined && input.bookId !== undefined && existing.book.id !== input.bookId) throw new Error('书籍版本已经属于其他书籍'); const now = new Date().toISOString(); const book: StoredBook = existing?.book ?? target?.book ?? { id: randomUUID(), userId, name: input.metadata.name ?? input.candidate.candidate.name ?? '未命名书籍', ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), activeEditionKey: input.editionKey, createdAt: now, updatedAt: now }; const activeEditionKey = input.activateEdition === false ? book.activeEditionKey : input.editionKey; const updatedBook = { ...book, name: input.metadata.name ?? book.name, ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }), ...(input.metadata.intro === undefined ? {} : { intro: input.metadata.intro }), ...(input.metadata.coverUrl === undefined ? {} : { coverUrl: input.metadata.coverUrl }), ...(activeEditionKey === undefined ? {} : { activeEditionKey }), updatedAt: now }; const edition: StoredEdition = { id: existing?.edition.id ?? randomUUID(), userId, bookId: updatedBook.id, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }; const value = { book: updatedBook, edition }; for (const [key, item] of this.books) if (item.book.id === updatedBook.id && item.book.userId === userId) this.books.set(key, { ...item, book: updatedBook }); this.books.set(`${userId}:${input.editionKey}`, value); if (input.addToBookshelf !== false) this.shelf.set(`${userId}:${updatedBook.id}`, now); return value }
  public async listBookSourceCandidates(userId: string, bookId: string): Promise<StoredBookSourceCandidate[]> {
    return [...this.sourceCandidates.values()].filter((row) => row.userId === userId && row.bookId === bookId).map((row) => structuredClone(row))
  }
  public async saveBookSourceCandidates(userId: string, bookId: string, candidates: StoredCandidate[]): Promise<void> {
    if (await this.getBook(userId, bookId) === null) throw new Error('书籍不存在')
    for (const candidate of candidates) {
      const key = JSON.stringify([userId, bookId, candidate.sourceId, candidate.sourceFingerprint, candidate.candidate.bookUrl])
      const previous = this.sourceCandidates.get(key)
      this.sourceCandidates.set(key, { id: previous?.id ?? randomUUID(), userId, bookId, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.candidate.bookUrl, candidate: cacheableCandidate(candidate), updatedAt: new Date().toISOString() })
    }
  }
  public async saveEdition(userId: string, bookId: string, input: BookCreationInput & { editionKey: string; sourceFingerprint: string }): Promise<StoredEdition> {
    const book = await this.getBook(userId, bookId)
    if (book === null) throw new Error('书籍不存在')
    const existing = this.books.get(`${userId}:${input.editionKey}`)
    if (existing !== undefined) {
      if (existing.book.id !== bookId) throw new Error('书籍版本已经属于其他书籍')
      return existing.edition
    }
    const edition: StoredEdition = { id: randomUUID(), userId, bookId, editionKey: input.editionKey, sourceId: input.candidate.sourceId, sourceFingerprint: input.sourceFingerprint, bookUrl: input.metadata.bookUrl, metadata: input.metadata, ...(input.metadata.variable === undefined ? {} : { variable: input.metadata.variable }) }
    this.books.set(`${userId}:${input.editionKey}`, { book, edition })
    return edition
  }
  public async addToBookshelf(userId: string, bookId: string): Promise<void> { this.shelf.set(`${userId}:${bookId}`, new Date().toISOString()) }
  public async removeFromBookshelf(userId: string, bookId: string): Promise<void> { this.shelf.delete(`${userId}:${bookId}`) }
  public async isOnBookshelf(userId: string, bookId: string): Promise<boolean> { return this.shelf.has(`${userId}:${bookId}`) }
  public async getHome(userId: string): Promise<HomeSnapshot> { const values = [...this.books.values()].filter((item) => item.book.userId === userId); const activeValues = values.filter((item) => item.book.activeEditionKey === item.edition.editionKey); const positions = [...this.positions.values()].filter((position) => position.userId === userId).sort((a, b) => b.lastReadAt.localeCompare(a.lastReadAt)); const seenReadingBooks = new Set<string>(); const reading = positions.map((position) => { const value = values.find((item) => item.book.id === position.bookId && item.edition.editionKey === position.editionKey); return value === undefined || seenReadingBooks.has(position.bookId) ? undefined : (seenReadingBooks.add(position.bookId), { book: value.book, edition: value.edition, position }) }).filter((item): item is { book: StoredBook; edition: StoredEdition; position: StoredPosition } => item !== undefined); const shelfValues = activeValues.filter((item) => this.shelf.has(`${userId}:${item.book.id}`)).sort((a, b) => (this.shelf.get(`${userId}:${b.book.id}`) ?? '').localeCompare(this.shelf.get(`${userId}:${a.book.id}`) ?? '')); const shelf = shelfValues.map((value) => { const position = this.positions.get(`${userId}:${value.book.id}:${value.edition.editionKey}`); return position === undefined ? value : { ...value, position } }); return { bookshelf: shelf, reading, searchHistory: latestSearchHistory([...this.history.values()].filter((item) => this.searches.get(item.searchId)?.userId === userId)).slice(0, 50) }
  }
  public async deleteSearchHistory(userId: string, historyId: string): Promise<boolean> { const item = [...this.history.entries()].find(([, value]) => value.id === historyId && this.searches.get(value.searchId)?.userId === userId); if (item === undefined) return false; for (const [key, value] of this.history) if (this.searches.get(value.searchId)?.userId === userId && normalizeIdentity(value.keyword) === normalizeIdentity(item[1].keyword)) this.history.delete(key); return true }
  public async listBooks(userId: string): Promise<Array<{ book: StoredBook; edition: StoredEdition }>> { return [...this.books.values()].filter((item) => item.book.userId === userId && item.book.activeEditionKey === item.edition.editionKey).sort((a, b) => b.book.updatedAt.localeCompare(a.book.updatedAt)) }
  public async getBook(userId: string, bookId: string): Promise<StoredBook | null> { return [...this.books.values()].find((item) => item.book.userId === userId && item.book.id === bookId)?.book ?? null }
  public async listEditions(userId: string, bookId: string): Promise<StoredEdition[]> { return [...this.books.values()].filter((item) => item.book.userId === userId && item.book.id === bookId).map((item) => item.edition).sort((a, b) => a.editionKey.localeCompare(b.editionKey)) }
  public async setActiveEdition(userId: string, bookId: string, editionKey: string): Promise<StoredEdition | null> { const selected = [...this.books.values()].find((item) => item.book.userId === userId && item.book.id === bookId && item.edition.editionKey === editionKey); if (selected === undefined) return null; const updatedBook = { ...selected.book, activeEditionKey: editionKey, updatedAt: new Date().toISOString() }; for (const [key, item] of this.books) if (item.book.userId === userId && item.book.id === bookId) this.books.set(key, { ...item, book: updatedBook }); return selected.edition }
  public async getEdition(userId: string, bookId: string, editionKey?: string): Promise<StoredEdition | null> { const item = [...this.books.values()].find((value) => value.book.userId === userId && value.book.id === bookId && (editionKey === undefined || value.edition.editionKey === editionKey)); return item?.edition ?? null }
  public async getToc(userId: string, bookId: string, editionKey: string): Promise<StoredToc | null> { return this.tocs.get(`${userId}:${bookId}:${editionKey}`) ?? null }
  public async saveToc(userId: string, toc: Omit<StoredToc, 'updatedAt'>): Promise<StoredToc> { const value = { ...toc, userId, updatedAt: new Date().toISOString() }; this.tocs.set(`${userId}:${toc.bookId}:${toc.editionKey}`, value); return value }
  public async getContent(userId: string, editionKey: string, tocRevision: string, chapterId: string): Promise<StoredContent | null> { return this.contents.get(`${userId}:${editionKey}:${tocRevision}:${chapterId}`) ?? null }
  public async saveContent(userId: string, content: Omit<StoredContent, 'updatedAt'>): Promise<StoredContent> { const value = { ...content, userId, updatedAt: new Date().toISOString() }; this.contents.set(`${userId}:${content.editionKey}:${content.tocRevision}:${content.chapterId}`, value); return value }
  public async getPosition(userId: string, bookId: string, editionKey: string): Promise<StoredPosition | null> { return this.positions.get(`${userId}:${bookId}:${editionKey}`) ?? null }
  public async savePosition(userId: string, position: Omit<StoredPosition, 'lastReadAt'> & { lastReadAt?: string }): Promise<StoredPosition> { const value = { ...position, userId, lastReadAt: position.lastReadAt ?? new Date().toISOString() }; this.positions.set(`${userId}:${position.bookId}:${position.editionKey}`, value); return value }
}

function toRuntimeState(row: SourceRuntimeRow): SourceRuntimeStateRecord { return { sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint, snapshot: decryptRuntimeState(row.encryptedState), version: row.version } }
function toRuntimeLease(row: SourceRuntimeRow, leaseToken: string): SourceRuntimeLease { return { ...toRuntimeState(row), leaseToken } }
function runtimeStateKey(userId: string, sourceId: string, sourceFingerprint: string): string { return JSON.stringify([userId, sourceId, sourceFingerprint]) }
function cloneRuntimeSnapshot(snapshot: RuntimeStateSnapshot): RuntimeStateSnapshot { return structuredClone(snapshot) }
function toUserSource(row: UserSourceRow): StoredSourceRecord { return { sourceId: row.sourceId, name: typeof row.normalizedSource.bookSourceName === 'string' ? row.normalizedSource.bookSourceName : row.sourceId, ...(typeof row.normalizedSource.bookSourceGroup === 'string' ? { group: row.normalizedSource.bookSourceGroup } : {}), fingerprint: row.fingerprint, enabled: row.enabled, rawSource: row.rawSource, normalizedSource: row.normalizedSource } }
function managedSummary(source: StoredSourceRecord, sourceRevision: string, origin: 'account', customOrder = readInteger(source.normalizedSource.customOrder, 0)): ManagedSourceSummary { const time = readTimestamp(source.normalizedSource.lastUpdateTime); return { sourceId: source.sourceId, name: source.name, ...(source.group === undefined ? {} : { group: source.group }), fingerprint: source.fingerprint, enabled: source.enabled, customOrder, sourceRevision, origin, ...(time === undefined ? {} : { lastUpdateTime: time }) } }
function readInteger(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback }
function readTimestamp(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined }
function sameStringSet(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)) }
function mergeImportedSource(local: StoredSourceRecord | undefined, remote: NormalizedSource): NormalizedSource {
  if (local === undefined) return remote
  const result = { ...remote } as Record<string, unknown>
  const localValue = local.normalizedSource as Record<string, unknown>
  for (const key of ['bookSourceName', 'bookSourceGroup', 'enabled', 'enabledExplore', 'customOrder', 'weight']) {
    if (Object.prototype.hasOwnProperty.call(localValue, key)) result[key] = localValue[key]
    else delete result[key]
  }
  return result as NormalizedSource
}
function defaultReaderSettings(userId: string): ReaderSettings { return { userId, ...DEFAULT_READER_SETTINGS, updatedAt: new Date().toISOString() } }
function toSettings(row: ReaderSettingsRow): ReaderSettings { return { userId: row.userId, theme: row.theme as ThemeMode, readingMode: row.readingMode as ReadingMode, fontSize: row.fontSize, lineHeight: row.lineHeightUnits / 100, marginTop: row.marginTop, marginRight: row.marginRight, marginBottom: row.marginBottom, marginLeft: row.marginLeft, updatedAt: row.updatedAt.toISOString() } }
function toBook(row: BookRow): StoredBook { return { id: row.id, userId: row.userId, name: row.name, ...(row.author === null ? {} : { author: row.author }), ...(row.intro === null ? {} : { intro: row.intro }), ...(row.coverUrl === null ? {} : { coverUrl: row.coverUrl }), ...(row.activeEditionKey === null ? {} : { activeEditionKey: row.activeEditionKey }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toEdition(row: BookEditionRow): StoredEdition { return { id: row.id, userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint, bookUrl: row.bookUrl, metadata: row.metadata, ...(row.variable === null ? {} : { variable: row.variable }) } }
function toSearch(row: SearchRunRow): SearchRunState { const sourceIds = row.sourceIds.length === 0 ? [row.sourceId] : row.sourceIds; return { id: row.id, userId: row.userId, keyword: row.keyword, sourceId: row.sourceId, sourceIds, ...(row.precision ? { precision: true } : {}), ...(row.sourceFingerprint === null ? {} : { sourceFingerprint: row.sourceFingerprint }), status: row.status as SearchRunState['status'], candidates: row.candidates, sourceStates: row.sourceStates, ...(row.cursor === null || row.cursor === undefined ? {} : { cursor: row.cursor }), ...(row.nextCursor === null || row.nextCursor === undefined ? {} : { nextCursor: row.nextCursor }), ...(row.operationId === null ? {} : { operationId: row.operationId }), progress: { completed: row.progressCompleted, total: row.progressTotal === 0 ? sourceIds.length : row.progressTotal }, version: row.version, cancelled: row.cancelled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toHistory(row: SearchHistoryRow): SearchHistoryItem { return { id: row.id, searchId: row.searchId, keyword: row.keyword, sourceIds: row.sourceIds, status: row.status, resultCount: row.resultCount, ...(row.summary === null ? {} : { summary: row.summary }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function searchSummary(status: string, count: number): string { if (status === 'success') return `${count} 条结果`; if (status === 'empty') return '没有找到结果'; if (status === 'partial') return `${count} 条结果，部分书源失败`; if (status === 'cancelled') return '已取消'; if (status === 'failed') return '搜索失败'; return status }
function toToc(row: TocSnapshotRow): StoredToc { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceFingerprint: row.sourceFingerprint, revision: row.revision, chapters: row.chapters, bookPatch: row.bookPatch, ...(row.bookAfter === null || row.bookAfter === undefined ? {} : { bookAfter: row.bookAfter }), updatedAt: row.updatedAt.toISOString() } }
function toContent(row: ChapterContentRow): StoredContent { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, tocRevision: row.tocRevision, sourceFingerprint: row.sourceFingerprint, content: row.content, updatedAt: row.updatedAt.toISOString() } }
function toPosition(row: typeof readingRecords.$inferSelect): StoredPosition { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, chapterUrl: row.chapterUrl, chapterIndex: row.chapterIndex, title: row.title, ...(row.tocRevision === null ? {} : { tocRevision: row.tocRevision }), paragraphIndex: row.paragraphIndex, offset: row.offset, version: row.version, lastReadAt: row.lastReadAt.toISOString() } }

export function createRepository(): ReaderRepository { return new PostgresReaderRepository() }

export function sourceSummaryFromSource(source: NormalizedSource, fingerprint: string, enabled = true): SourceSummary { return { sourceId: source.bookSourceUrl, name: source.bookSourceName, ...(typeof source.bookSourceGroup === 'string' ? { group: source.bookSourceGroup } : {}), fingerprint, enabled } }

/** 缓存去掉只能在搜索响应中使用的详情页正文，但保留 JS 详情脚本重建候选所需的变量和原始字段。 */
function cacheableCandidate(stored: StoredCandidate): StoredCandidate {
  const { sourceId, bookUrl, name, author, intro, coverUrl, kind, wordCount, lastChapter, updateTime, tocUrl, variable, rawFields } = stored.candidate
  const fields = Object.fromEntries(Object.entries({ name, author, intro, coverUrl, kind, wordCount, lastChapter, updateTime, tocUrl }).filter(([, value]) => value !== undefined))
  return { sourceId: stored.sourceId, sourceFingerprint: stored.sourceFingerprint, ...(stored.searchDurationMs === undefined ? {} : { searchDurationMs: stored.searchDurationMs }), candidate: { sourceId, bookUrl, ...fields, ...(variable === undefined ? {} : { variable }), rawFields: structuredClone(rawFields), traceRef: 'book-source-cache' } }
}
