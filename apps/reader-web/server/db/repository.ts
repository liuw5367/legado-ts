import { latestSearchHistory } from '../../shared/search-history.ts'
import { normalizeIdentity } from '../../shared/book-identity.ts'
import { compareSourceManagementOrder, compareSourceVersions, selectOneSourcePerDomain, sourceDomainInfo } from '../../shared/source-domain.ts'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, lt, max, or, sql } from 'drizzle-orm'
import { editionKey as backupEditionKey, isIsoDateString, type BackupCategory } from '@legado/reader-backup'
import type { NormalizedSource, PageCursor } from '@legado/source-core'
import { withUser, type ReaderTransaction } from './client.ts'
import { bookSourceCandidates, bookEditions, books, bookshelf, chapterContents, readerSettings, readingRecords, searchHistory, searchRuns, sourceImportPreviews, sourceRuntimeState, tocSnapshots, userSources, type BookEditionRow, type BookRow, type ChapterContentRow, type ReaderSettingsRow, type SearchHistoryRow, type SearchRunRow, type SourceRuntimeRow, type TocSnapshotRow, type UserSourceRow } from './schema.ts'
import type { ImportPreview, ImportPreviewCandidate, ManagedSourceSummary, SourceActionItem, SourceManagementPage, SourceManagementStatus, SourceOrderItem } from '../../shared/source-management.ts'
import { DEFAULT_READER_SETTINGS, type BookCreationInput, type HomeSnapshot, type ReaderSettings, type ReaderSettingsPatch, type ReaderSettingsPreferences, type RuntimeStateSnapshot, type SearchHistoryItem, type SearchInput, type SearchRunState, type SourceSearchState, type SourceSummary, type StoredBookSourceCandidate, type StoredBook, type StoredCandidate, type StoredContent, type StoredEdition, type StoredPosition, type StoredToc } from '../domain/types.ts'
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

export interface ReaderBackupBook {
  book: StoredBook
  editions: StoredEdition[]
  candidates: StoredBookSourceCandidate[]
}

export interface ReaderBackupSnapshot {
  sources: Array<{ source: StoredSourceRecord; sourceRevision: string; deleted?: boolean }>
  settings: ReaderSettings
  books: ReaderBackupBook[]
  bookshelf: Array<{ bookId: string; addedAt: string }>
  positions: StoredPosition[]
  searchHistory: SearchHistoryItem[]
}

export class SourceManagementError extends Error {
  public readonly code: 'source-conflict' | 'source-not-found' | 'preview-expired' | 'preview-invalid' | 'source-busy'
  public constructor(code: SourceManagementError['code'], message: string) { super(message); this.code = code }
}

export class BackupRestoreError extends Error {
  public constructor(message: string) { super(message); this.name = 'BackupRestoreError' }
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
  saveSettings(userId: string, patch: ReaderSettingsPatch): Promise<ReaderSettings>
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
  getBackupSnapshot(userId: string): Promise<ReaderBackupSnapshot>
  restoreBackupSnapshot(userId: string, snapshot: ReaderBackupSnapshot, categories: readonly BackupCategory[]): Promise<void>
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
      return selectOneSourcePerDomain(rows, compareSourceManagementOrder).map(toUserSource)
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
      await lockUserSourceMutations(transaction, userId)
      const overrides = await transaction.select().from(userSources).where(eq(userSources.userId, userId)).for('update')
      const overrideById = new Map(overrides.map((row) => [row.sourceId, row]))
      const seen = new Set<string>()
      const enabledDomains = new Set<string>()
      for (const item of items) {
        if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '操作列表包含重复书源')
        seen.add(item.sourceId)
        const domainKey = sourceDomainInfo(item.sourceId).key
        if (action === 'enable') {
          if (enabledDomains.has(domainKey)) throw new SourceManagementError('source-conflict', '同一域名只能启用一个书源版本')
          enabledDomains.add(domainKey)
        }
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
        if (action === 'enable') {
          const selectedIds = new Set(items.map((entry) => entry.sourceId))
          for (const sibling of overrides) {
            if (sibling.deleted || !sibling.enabled || selectedIds.has(sibling.sourceId) || sourceDomainInfo(sibling.sourceId).key !== domainKey) continue
            const updated = await transaction.update(userSources).set({ enabled: false, revision: randomUUID(), updatedAt: new Date() }).where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sibling.sourceId), eq(userSources.revision, sibling.revision))).returning({ sourceId: userSources.sourceId })
            if (updated.length === 0) throw new SourceManagementError('source-conflict', `同域书源已更新，请刷新后重试：${sibling.sourceId}`)
          }
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
      await lockUserSourceMutations(transaction, userId)
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
      await lockUserSourceMutations(transaction, userId)
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
      const importEnabled = decideImportedSourceEnabled(candidates, new Map(overrides.map((row) => [row.sourceId, { enabled: row.enabled, deleted: row.deleted }])))
      for (const candidate of candidates) {
        const current = overrideById.get(candidate.sourceId)
        const currentRevision = current?.revision
        if (candidate.sourceRevision === undefined ? currentRevision !== undefined : currentRevision !== candidate.sourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请重新获取预览：${candidate.name}`)
        const currentSource = current === undefined ? undefined : toUserSource(current)
        const normalizedSource = mergeImportedSource(currentSource, candidate.normalizedSource as NormalizedSource)
        const runtimeRows = await transaction.select().from(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, candidate.sourceId))).for('update')
        if (runtimeRows.some((row) => row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${candidate.name}`)
        if (currentSource !== undefined && currentSource.fingerprint !== candidate.fingerprint) await transaction.delete(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, candidate.sourceId)))
        await transaction.insert(userSources).values({ userId, sourceId: candidate.sourceId, fingerprint: candidate.fingerprint, rawSource: candidate.rawSource, normalizedSource, enabled: importEnabled.get(candidate.id) ?? false, customOrder: readInteger(currentSource?.normalizedSource.customOrder, 0), deleted: false, revision: randomUUID(), updatedAt: new Date() }).onConflictDoUpdate({ target: [userSources.userId, userSources.sourceId], set: { fingerprint: sql.raw('excluded."fingerprint"'), rawSource: sql.raw('excluded."raw_source"'), normalizedSource: sql.raw('excluded."normalized_source"'), enabled: sql.raw('excluded."enabled"'), customOrder: sql.raw('excluded."custom_order"'), deleted: false, revision: sql.raw('excluded."revision"'), updatedAt: new Date() } })
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

  public async saveSettings(userId: string, patch: ReaderSettingsPatch): Promise<ReaderSettings> {
    return withUser(userId, async (transaction) => {
      const [currentRow] = await transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      const current = currentRow === undefined ? defaultReaderSettings(userId) : toSettings(currentRow)
      const next = mergeReaderSettings(current, patch, new Date().toISOString())
      const values = readerSettingsValues(userId, next, new Date(next.updatedAt))
      const [row] = await transaction.insert(readerSettings).values(values).onConflictDoUpdate({ target: readerSettings.userId, set: { preferences: values.preferences, updatedAt: values.updatedAt } }).returning()
      if (row === undefined) throw new Error('保存设置失败')
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
      const [settingsRow] = await transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1)
      const settings = settingsRow === undefined ? defaultReaderSettings(userId) : toSettings(settingsRow)
      const shelfRows = await transaction.select({ book: books, edition: bookEditions, addedAt: bookshelf.addedAt }).from(bookshelf).innerJoin(books, and(eq(books.userId, userId), eq(books.id, bookshelf.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, books.id), eq(bookEditions.editionKey, books.activeEditionKey!))).where(eq(bookshelf.userId, userId)).orderBy(desc(bookshelf.addedAt))
      let sortedShelfRows = shelfRows
      if (settings.general.bookshelfSort === 'lastReadAt' && shelfRows.length > 0) {
        const lastReadRows = await transaction.select({ bookId: readingRecords.bookId, lastReadAt: max(readingRecords.lastReadAt) }).from(readingRecords).where(and(eq(readingRecords.userId, userId), inArray(readingRecords.bookId, shelfRows.map((row) => row.book.id)))).groupBy(readingRecords.bookId)
        const lastReadByBookId = new Map<string, Date>()
        for (const row of lastReadRows) if (row.lastReadAt !== null) lastReadByBookId.set(row.bookId, row.lastReadAt)
        sortedShelfRows = [...shelfRows].sort((left, right) => {
          const leftReadAt = lastReadByBookId.get(left.book.id)
          const rightReadAt = lastReadByBookId.get(right.book.id)
          if (leftReadAt === undefined && rightReadAt !== undefined) return 1
          if (rightReadAt === undefined && leftReadAt !== undefined) return -1
          if (leftReadAt !== undefined && rightReadAt !== undefined && leftReadAt.getTime() !== rightReadAt.getTime()) return rightReadAt.getTime() - leftReadAt.getTime()
          return right.addedAt.getTime() - left.addedAt.getTime() || left.book.id.localeCompare(right.book.id)
        })
      }
      const readingRows = await transaction.select({ book: books, edition: bookEditions, position: readingRecords }).from(readingRecords).innerJoin(books, and(eq(books.userId, userId), eq(books.id, readingRecords.bookId))).innerJoin(bookEditions, and(eq(bookEditions.userId, userId), eq(bookEditions.bookId, readingRecords.bookId), eq(bookEditions.editionKey, readingRecords.editionKey))).where(eq(readingRecords.userId, userId)).orderBy(desc(readingRecords.lastReadAt)).limit(50)
      const historyRows = await transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt))).orderBy(desc(searchHistory.createdAt), desc(searchHistory.id))
      const positions = new Map(readingRows.map((row) => [`${row.book.id}:${row.edition.editionKey}`, toPosition(row.position)]))
      const shelf = sortedShelfRows.map((row) => { const book = toBook(row.book); const edition = toEdition(row.edition); const position = positions.get(`${row.book.id}:${edition.editionKey}`); return position === undefined ? { book, edition } : { book, edition, position } })
      const seenReadingBooks = new Set<string>()
      const reading = readingRows.filter((row) => { if (seenReadingBooks.has(row.book.id)) return false; seenReadingBooks.add(row.book.id); return true }).map((row) => ({ book: toBook(row.book), edition: toEdition(row.edition), position: toPosition(row.position) }))
      return { bookshelf: shelf, reading, searchHistory: latestSearchHistory(historyRows.map(toHistory)).slice(0, 50) }
    })
  }

  public async getBackupSnapshot(userId: string): Promise<ReaderBackupSnapshot> {
    return withUser(userId, async (transaction) => {
      const [sourceRows, settingRows, bookRows, editionRows, candidateRows, shelfRows, positionRows, historyRows] = await Promise.all([
        transaction.select().from(userSources).where(eq(userSources.userId, userId)),
        transaction.select().from(readerSettings).where(eq(readerSettings.userId, userId)).limit(1),
        transaction.select().from(books).where(eq(books.userId, userId)),
        transaction.select().from(bookEditions).where(eq(bookEditions.userId, userId)),
        transaction.select().from(bookSourceCandidates).where(eq(bookSourceCandidates.userId, userId)),
        transaction.select().from(bookshelf).where(eq(bookshelf.userId, userId)),
        transaction.select().from(readingRecords).where(eq(readingRecords.userId, userId)),
        transaction.select().from(searchHistory).where(and(eq(searchHistory.userId, userId), isNull(searchHistory.deletedAt))),
      ])
      const editionsByBook = new Map<string, StoredEdition[]>()
      for (const row of editionRows) editionsByBook.set(row.bookId, [...(editionsByBook.get(row.bookId) ?? []), toEdition(row)])
      const candidatesByBook = new Map<string, StoredBookSourceCandidate[]>()
      for (const row of candidateRows) candidatesByBook.set(row.bookId, [...(candidatesByBook.get(row.bookId) ?? []), { ...row, updatedAt: row.updatedAt.toISOString() }])
      return {
        sources: sourceRows.map((row) => ({ source: toUserSource(row), sourceRevision: row.revision, ...(row.deleted ? { deleted: true } : {}) })),
        settings: settingRows[0] === undefined ? defaultReaderSettings(userId) : toSettings(settingRows[0]),
        books: bookRows.map((row) => ({ book: toBook(row), editions: editionsByBook.get(row.id) ?? [], candidates: candidatesByBook.get(row.id) ?? [] })),
        bookshelf: shelfRows.map((row) => ({ bookId: row.bookId, addedAt: row.addedAt.toISOString() })),
        positions: positionRows.map(toPosition),
        searchHistory: historyRows.map(toHistory),
      }
    })
  }

  public async restoreBackupSnapshot(userId: string, snapshot: ReaderBackupSnapshot, categories: readonly BackupCategory[]): Promise<void> {
    const selected = new Set(categories)
    assertBackupSnapshotClosed(snapshot, userId)
    if (selected.size === 0) throw new BackupRestoreError('至少选择一个恢复分类')
    await withUser(userId, async (transaction) => {
      if (selected.has('sources')) await lockUserSourceMutations(transaction, userId)
      const bookIdMap = new Map<string, string>()
      const currentBookRows = selected.has('bookshelf') || selected.has('reading') ? await transaction.select({ id: books.id, userId: books.userId }).from(books).where(eq(books.userId, userId)) : []
      const existingBookIds = new Set(currentBookRows.map((row) => row.id))
      if (selected.has('bookshelf') && !selected.has('reading')) {
        const currentPositions = await transaction.select({ bookId: readingRecords.bookId, editionKey: readingRecords.editionKey }).from(readingRecords).where(eq(readingRecords.userId, userId))
        const incomingEditions = new Set(snapshot.books.flatMap((item) => item.editions.map((edition) => `${item.book.id}\u0000${edition.editionKey}`)))
        const missing = currentPositions.filter((position) => !incomingEditions.has(`${position.bookId}\u0000${position.editionKey}`))
        if (missing.length > 0) throw new BackupRestoreError(`未选择阅读记录，但书架替换会使现有阅读记录失去依赖：${missing[0]?.bookId ?? ''}`)
      }
      if (selected.has('bookshelf')) {
        const incomingIds = snapshot.books.map((item) => item.book.id)
        const occupiedRows = incomingIds.length === 0 ? [] : await transaction.select({ id: books.id, userId: books.userId }).from(books).where(inArray(books.id, incomingIds))
        const occupiedById = new Map(occupiedRows.map((row) => [row.id, row.userId]))
        for (const item of snapshot.books) bookIdMap.set(item.book.id, occupiedById.get(item.book.id) === undefined || occupiedById.get(item.book.id) === userId ? item.book.id : randomUUID())
      } else if (selected.has('reading')) {
        for (const item of snapshot.books) if (existingBookIds.has(item.book.id)) bookIdMap.set(item.book.id, item.book.id)
      }
      if (selected.has('bookshelf')) {
        if (selected.has('reading')) await transaction.delete(readingRecords).where(eq(readingRecords.userId, userId))
        await transaction.delete(chapterContents).where(eq(chapterContents.userId, userId))
        await transaction.delete(tocSnapshots).where(eq(tocSnapshots.userId, userId))
        await transaction.delete(bookSourceCandidates).where(eq(bookSourceCandidates.userId, userId))
        await transaction.delete(bookEditions).where(eq(bookEditions.userId, userId))
        await transaction.delete(bookshelf).where(eq(bookshelf.userId, userId))
        await transaction.delete(books).where(eq(books.userId, userId))
        for (const item of snapshot.books) {
          const targetBookId = bookIdMap.get(item.book.id)
          if (targetBookId === undefined) throw new BackupRestoreError(`书籍映射失败：${item.book.id}`)
          await transaction.insert(books).values({ id: targetBookId, userId, name: item.book.name, ...(item.book.author === undefined ? {} : { author: item.book.author }), ...(item.book.intro === undefined ? {} : { intro: item.book.intro }), ...(item.book.coverUrl === undefined ? {} : { coverUrl: item.book.coverUrl }), ...(item.book.activeEditionKey === undefined ? {} : { activeEditionKey: item.book.activeEditionKey }), createdAt: new Date(item.book.createdAt), updatedAt: new Date(item.book.updatedAt) })
          for (const edition of item.editions) await transaction.insert(bookEditions).values({ id: randomUUID(), userId, bookId: targetBookId, editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, metadata: edition.metadata, ...(edition.variable === undefined ? {} : { variable: edition.variable }), createdAt: new Date(item.book.createdAt), updatedAt: new Date(item.book.updatedAt) })
          for (const candidate of item.candidates) await transaction.insert(bookSourceCandidates).values({ id: randomUUID(), userId, bookId: targetBookId, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.bookUrl, candidate: candidate.candidate, updatedAt: new Date(candidate.updatedAt) })
        }
      }
      if (selected.has('bookshelf')) {
        for (const item of snapshot.bookshelf) {
          const bookId = bookIdMap.get(item.bookId)
          if (bookId === undefined) throw new BackupRestoreError(`书架缺少书籍：${item.bookId}`)
          await transaction.insert(bookshelf).values({ userId, bookId, addedAt: new Date(item.addedAt) }).onConflictDoNothing({ target: [bookshelf.userId, bookshelf.bookId] })
        }
      }
      if (selected.has('reading')) {
        const missingBooks = [...new Set(snapshot.positions.map((position) => position.bookId))].filter((bookId) => !bookIdMap.has(bookId))
        if (missingBooks.length > 0) throw new BackupRestoreError(`阅读记录依赖的书籍不存在，请同时选择书架：${missingBooks.join('、')}`)
        if (!selected.has('bookshelf')) {
          const existingEditions = await transaction.select({ bookId: bookEditions.bookId, editionKey: bookEditions.editionKey }).from(bookEditions).where(eq(bookEditions.userId, userId))
          const available = new Set(existingEditions.map((item) => `${item.bookId}\u0000${item.editionKey}`))
          const unavailable = [...new Set(snapshot.positions.map((position) => `${bookIdMap.get(position.bookId)}\u0000${position.editionKey}`))].filter((key) => !available.has(key))
          if (unavailable.length > 0) throw new BackupRestoreError('阅读记录依赖的书籍版本不存在，请同时选择书架')
        }
        if (!selected.has('bookshelf')) await transaction.delete(readingRecords).where(eq(readingRecords.userId, userId))
        for (const position of snapshot.positions) {
          const bookId = bookIdMap.get(position.bookId)
          if (bookId === undefined) continue
          await transaction.insert(readingRecords).values({ id: randomUUID(), userId, bookId, editionKey: position.editionKey, chapterId: position.chapterId, chapterUrl: position.chapterUrl, chapterIndex: position.chapterIndex, title: position.title, ...(position.tocRevision === undefined ? {} : { tocRevision: position.tocRevision }), paragraphIndex: position.paragraphIndex, offset: position.offset, version: position.version, lastReadAt: new Date(position.lastReadAt) }).onConflictDoUpdate({ target: [readingRecords.userId, readingRecords.bookId, readingRecords.editionKey], set: { chapterId: position.chapterId, chapterUrl: position.chapterUrl, chapterIndex: position.chapterIndex, title: position.title, tocRevision: position.tocRevision ?? null, paragraphIndex: position.paragraphIndex, offset: position.offset, version: position.version, lastReadAt: new Date(position.lastReadAt) } })
        }
      }
      if (selected.has('search')) {
        await transaction.delete(searchHistory).where(eq(searchHistory.userId, userId))
        for (const item of snapshot.searchHistory) {
          await transaction.insert(searchHistory).values({ id: isUuid(item.id) ? item.id : randomUUID(), userId, searchId: isUuid(item.searchId) ? item.searchId : randomUUID(), keyword: item.keyword, sourceIds: item.sourceIds, status: item.status, resultCount: item.resultCount, ...(item.summary === undefined ? {} : { summary: item.summary }), createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) })
        }
      }
      if (selected.has('sources')) {
        await transaction.delete(userSources).where(eq(userSources.userId, userId))
        await transaction.delete(sourceRuntimeState).where(eq(sourceRuntimeState.userId, userId))
        for (const item of snapshot.sources) {
          const normalized = { ...item.source.normalizedSource, enabled: item.source.enabled }
          await transaction.insert(userSources).values({ userId, sourceId: item.source.sourceId, fingerprint: item.source.fingerprint, rawSource: item.source.rawSource, normalizedSource: normalized, enabled: item.source.enabled, customOrder: readInteger((normalized as Record<string, unknown>).customOrder, 0), deleted: item.deleted === true, revision: item.sourceRevision || randomUUID(), updatedAt: new Date() })
        }
      }
      if (selected.has('settings')) {
        const values = readerSettingsValues(userId, snapshot.settings, new Date(snapshot.settings.updatedAt))
        await transaction.insert(readerSettings).values(values).onConflictDoUpdate({ target: readerSettings.userId, set: { preferences: values.preferences, updatedAt: values.updatedAt } })
      }
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

  public async listSourcesForUser(userId: string): Promise<StoredSourceRecord[]> { return selectOneSourcePerDomain(this.allSources(userId).filter((source) => source.enabled), compareStoredSourceManagementOrder) }
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
    const enabledDomains = new Set<string>()
    const updates: Array<{ source: StoredSourceRecord; deleted: boolean }> = []
    for (const item of items) {
      if (seen.has(item.sourceId)) throw new SourceManagementError('source-conflict', '操作列表包含重复书源')
      seen.add(item.sourceId)
      const domainKey = sourceDomainInfo(item.sourceId).key
      if (action === 'enable') {
        if (enabledDomains.has(domainKey)) throw new SourceManagementError('source-conflict', '同一域名只能启用一个书源版本')
        enabledDomains.add(domainKey)
      }
      const source = await this.getSourceForManagement(userId, item.sourceId)
      if (source === undefined) throw new SourceManagementError('source-not-found', `书源不存在：${item.sourceId}`)
      if (this.sourceRevision(userId, item.sourceId) !== item.expectedSourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请刷新后重试：${item.sourceId}`)
      if (action === 'delete' && this.runtimeEntriesForSource(userId, item.sourceId).some(([, state]) => state.leaseToken !== null && (state.leaseUntil ?? 0) > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${item.sourceId}`)
      updates.push({ source, deleted: action === 'delete' })
    }
    if (action === 'enable') {
      const targetIds = new Set(items.map((item) => item.sourceId))
      for (const sibling of this.allSources(userId)) {
        if (!sibling.enabled || targetIds.has(sibling.sourceId) || !enabledDomains.has(sourceDomainInfo(sibling.sourceId).key)) continue
        const key = `${userId}:${sibling.sourceId}`
        const record = this.userSourceMap.get(key)
        if (record !== undefined && !record.deleted) this.userSourceMap.set(key, { ...record, source: { ...record.source, enabled: false }, revision: randomUUID() })
      }
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
    const currentStates = new Map([...this.userSourceMap.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([key, value]) => [key.slice(userId.length + 1), { enabled: value.source.enabled, deleted: value.deleted }]))
    const importEnabled = decideImportedSourceEnabled(candidates, currentStates)
    for (const candidate of candidates) {
      const currentRevision = this.userSourceMap.has(`${userId}:${candidate.sourceId}`) ? this.sourceRevision(userId, candidate.sourceId) : undefined
      if (candidate.sourceRevision === undefined ? currentRevision !== undefined : currentRevision !== candidate.sourceRevision) throw new SourceManagementError('source-conflict', `书源已更新，请重新获取预览：${candidate.name}`)
      if (this.runtimeEntriesForSource(userId, candidate.sourceId).some(([, state]) => state.leaseToken !== null && (state.leaseUntil ?? 0) > Date.now())) throw new SourceManagementError('source-busy', `书源正在使用，请稍后重试：${candidate.name}`)
    }
    for (const candidate of candidates) {
      const current = this.userSourceMap.get(`${userId}:${candidate.sourceId}`)?.source
      if (current !== undefined && current.fingerprint !== candidate.fingerprint) for (const [key] of this.runtimeEntriesForSource(userId, candidate.sourceId)) this.runtimeStates.delete(key)
      const normalizedSource = mergeImportedSource(current, candidate.normalizedSource as NormalizedSource)
      this.userSourceMap.set(`${userId}:${candidate.sourceId}`, { source: { sourceId: candidate.sourceId, name: normalizedSource.bookSourceName, ...(typeof normalizedSource.bookSourceGroup === 'string' ? { group: normalizedSource.bookSourceGroup } : {}), fingerprint: candidate.fingerprint, enabled: importEnabled.get(candidate.id) ?? false, rawSource: candidate.rawSource, normalizedSource }, deleted: false, revision: randomUUID() })
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
  public async saveSettings(userId: string, patch: ReaderSettingsPatch): Promise<ReaderSettings> { const next = mergeReaderSettings(await this.getSettings(userId), patch, new Date().toISOString()); this.settings.set(userId, next); return next }
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
  public async getHome(userId: string): Promise<HomeSnapshot> {
    const values = [...this.books.values()].filter((item) => item.book.userId === userId)
    const activeValues = values.filter((item) => item.book.activeEditionKey === item.edition.editionKey)
    const positions = [...this.positions.values()].filter((position) => position.userId === userId).sort((a, b) => b.lastReadAt.localeCompare(a.lastReadAt))
    const sortByReadingTime = (await this.getSettings(userId)).general.bookshelfSort === 'lastReadAt'
    const seenReadingBooks = new Set<string>()
    const reading = positions.map((position) => {
      const value = values.find((item) => item.book.id === position.bookId && item.edition.editionKey === position.editionKey)
      return value === undefined || seenReadingBooks.has(position.bookId) ? undefined : (seenReadingBooks.add(position.bookId), { book: value.book, edition: value.edition, position })
    }).filter((item): item is { book: StoredBook; edition: StoredEdition; position: StoredPosition } => item !== undefined)
    const lastReadByBook = new Map<string, string>()
    for (const position of positions) if (!lastReadByBook.has(position.bookId)) lastReadByBook.set(position.bookId, position.lastReadAt)
    const shelfValues = activeValues.filter((item) => this.shelf.has(`${userId}:${item.book.id}`)).sort((left, right) => {
      const leftAddedAt = this.shelf.get(`${userId}:${left.book.id}`) ?? ''
      const rightAddedAt = this.shelf.get(`${userId}:${right.book.id}`) ?? ''
      if (sortByReadingTime) {
        const leftReadAt = lastReadByBook.get(left.book.id)
        const rightReadAt = lastReadByBook.get(right.book.id)
        if (leftReadAt === undefined && rightReadAt !== undefined) return 1
        if (rightReadAt === undefined && leftReadAt !== undefined) return -1
        if (leftReadAt !== undefined && rightReadAt !== undefined && leftReadAt !== rightReadAt) return rightReadAt.localeCompare(leftReadAt)
      }
      return rightAddedAt.localeCompare(leftAddedAt) || left.book.id.localeCompare(right.book.id)
    })
    const shelf = shelfValues.map((value) => { const position = this.positions.get(`${userId}:${value.book.id}:${value.edition.editionKey}`); return position === undefined ? value : { ...value, position } })
    return { bookshelf: shelf, reading, searchHistory: latestSearchHistory([...this.history.values()].filter((item) => this.searches.get(item.searchId)?.userId === userId)).slice(0, 50) }
  }
  public async getBackupSnapshot(userId: string): Promise<ReaderBackupSnapshot> {
    const books = new Map<string, ReaderBackupBook>()
    for (const value of this.books.values()) {
      if (value.book.userId !== userId) continue
      const existing = books.get(value.book.id) ?? { book: value.book, editions: [], candidates: [] }
      existing.editions.push(value.edition)
      books.set(value.book.id, existing)
    }
    for (const value of this.sourceCandidates.values()) {
      if (value.userId !== userId) continue
      const existing = books.get(value.bookId)
      if (existing !== undefined) existing.candidates.push(value)
    }
    return {
      sources: this.allSourceStates(userId).map(({ source, deleted }) => ({ source, sourceRevision: this.sourceRevision(userId, source.sourceId), ...(deleted ? { deleted: true } : {}) })),
      settings: await this.getSettings(userId),
      books: [...books.values()],
      bookshelf: [...this.shelf.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([key, addedAt]) => ({ bookId: key.slice(userId.length + 1), addedAt })),
      positions: [...this.positions.values()].filter((position) => position.userId === userId),
      searchHistory: [...this.history.values()].filter((item) => this.searches.get(item.searchId)?.userId === userId),
    }
  }
  public async restoreBackupSnapshot(userId: string, snapshot: ReaderBackupSnapshot, categories: readonly BackupCategory[]): Promise<void> {
    const selected = new Set(categories)
    if (selected.size === 0) throw new BackupRestoreError('至少选择一个恢复分类')
    assertBackupSnapshotClosed(snapshot, userId)
    const bookIdMap = new Map<string, string>()
    const currentBookIds = new Set([...this.books.values()].filter((value) => value.book.userId === userId).map((value) => value.book.id))
    const incomingEditions = new Set(snapshot.books.flatMap((item) => item.editions.map((edition) => `${item.book.id}\u0000${edition.editionKey}`)))
    if (selected.has('bookshelf') && !selected.has('reading')) {
      const missing = [...this.positions.values()].filter((position) => position.userId === userId && !incomingEditions.has(`${position.bookId}\u0000${position.editionKey}`))
      if (missing.length > 0) throw new BackupRestoreError(`未选择阅读记录，但书架替换会使现有阅读记录失去依赖：${missing[0]?.bookId ?? ''}`)
    }
    if (selected.has('bookshelf')) for (const item of snapshot.books) bookIdMap.set(item.book.id, currentBookIds.has(item.book.id) ? item.book.id : item.book.id)
    else if (selected.has('reading')) for (const item of snapshot.books) if (currentBookIds.has(item.book.id)) bookIdMap.set(item.book.id, item.book.id)
    if (selected.has('reading')) {
      const missingBooks = [...new Set(snapshot.positions.map((position) => position.bookId))].filter((bookId) => !bookIdMap.has(bookId))
      if (missingBooks.length > 0) throw new BackupRestoreError(`阅读记录依赖的书籍不存在，请同时选择书架：${missingBooks.join('、')}`)
      if (!selected.has('bookshelf')) {
        const available = new Set([...this.books.values()].filter((value) => value.book.userId === userId).map((value) => `${value.book.id}\u0000${value.edition.editionKey}`))
        const missingEditions = [...new Set(snapshot.positions.map((position) => `${position.bookId}\u0000${position.editionKey}`))].filter((key) => !available.has(key))
        if (missingEditions.length > 0) throw new BackupRestoreError('阅读记录依赖的书籍版本不存在，请同时选择书架')
      }
    }
    const nextBooks = new Map(this.books)
    const nextCandidates = new Map(this.sourceCandidates)
    const nextShelf = new Map(this.shelf)
    const nextPositions = new Map(this.positions)
    const nextTocs = new Map(this.tocs)
    const nextContents = new Map(this.contents)
    const nextHistory = new Map(this.history)
    const nextSearches = new Map(this.searches)
    const nextSources = new Map(this.userSourceMap)
    const nextSettings = new Map(this.settings)
    const nextRuntimeStates = new Map(this.runtimeStates)
    if (selected.has('bookshelf')) {
      for (const [key, value] of nextBooks) if (value.book.userId === userId) nextBooks.delete(key)
      for (const [key, value] of nextCandidates) if (value.userId === userId) nextCandidates.delete(key)
      for (const [key] of nextTocs) if (key.startsWith(`${userId}:`)) nextTocs.delete(key)
      for (const [key] of nextContents) if (key.startsWith(`${userId}:`)) nextContents.delete(key)
      for (const [key] of nextShelf) if (key.startsWith(`${userId}:`)) nextShelf.delete(key)
      for (const item of snapshot.books) {
        const bookId = bookIdMap.get(item.book.id)
        if (bookId === undefined) throw new BackupRestoreError(`书籍映射失败：${item.book.id}`)
        for (const edition of item.editions) nextBooks.set(`${userId}:${edition.editionKey}`, { book: { ...item.book, id: bookId, userId }, edition: { ...edition, bookId, userId } })
        for (const candidate of item.candidates) nextCandidates.set(`${userId}:${bookId}:${candidate.sourceId}:${candidate.sourceFingerprint}:${candidate.bookUrl}`, { ...candidate, userId, bookId })
      }
    }
    if (selected.has('bookshelf')) for (const item of snapshot.bookshelf) {
      const bookId = bookIdMap.get(item.bookId)
      if (bookId === undefined) throw new BackupRestoreError(`书架缺少书籍：${item.bookId}`)
      nextShelf.set(`${userId}:${bookId}`, item.addedAt)
    }
    if (selected.has('reading')) {
      for (const [key, value] of nextPositions) if (value.userId === userId) nextPositions.delete(key)
      for (const position of snapshot.positions) {
        const bookId = bookIdMap.get(position.bookId)
        if (bookId === undefined) throw new BackupRestoreError(`阅读记录缺少书籍：${position.bookId}`)
        nextPositions.set(`${userId}:${bookId}:${position.editionKey}`, { ...position, userId, bookId })
      }
    }
    if (selected.has('search')) {
      for (const [key, item] of nextHistory) if (key.startsWith(`${userId}:`) || nextSearches.get(item.searchId)?.userId === userId) nextHistory.delete(key)
      for (const [searchId, item] of nextSearches) if (item.userId === userId) nextSearches.delete(searchId)
      for (const item of snapshot.searchHistory) {
        const existing = nextSearches.get(item.searchId)
        const searchId = existing === undefined || existing.userId === userId ? item.searchId : randomUUID()
        nextHistory.set(`${userId}:${searchId}`, { ...item, searchId })
        nextSearches.set(searchId, { id: searchId, userId, keyword: item.keyword, sourceId: item.sourceIds[0] ?? '', sourceIds: item.sourceIds, status: item.status as SearchRunState['status'], candidates: [], sourceStates: [], progress: { completed: 0, total: item.sourceIds.length }, version: 0, cancelled: false, createdAt: item.createdAt, updatedAt: item.updatedAt })
      }
    }
    if (selected.has('sources')) {
      for (const key of [...nextSources.keys()]) if (key.startsWith(`${userId}:`)) nextSources.delete(key)
      for (const item of snapshot.sources) nextSources.set(`${userId}:${item.source.sourceId}`, { source: item.source, deleted: item.deleted === true, revision: item.sourceRevision || randomUUID() })
      for (const [key] of nextRuntimeStates) {
        const identity = JSON.parse(key) as unknown[]
        if (identity[0] === userId) nextRuntimeStates.delete(key)
      }
    }
    if (selected.has('settings')) nextSettings.set(userId, { ...snapshot.settings })
    this.books.clear(); for (const [key, value] of nextBooks) this.books.set(key, value)
    this.sourceCandidates.clear(); for (const [key, value] of nextCandidates) this.sourceCandidates.set(key, value)
    this.shelf.clear(); for (const [key, value] of nextShelf) this.shelf.set(key, value)
    this.positions.clear(); for (const [key, value] of nextPositions) this.positions.set(key, value)
    this.tocs.clear(); for (const [key, value] of nextTocs) this.tocs.set(key, value)
    this.contents.clear(); for (const [key, value] of nextContents) this.contents.set(key, value)
    this.searches.clear(); for (const [key, value] of nextSearches) this.searches.set(key, value)
    this.history.clear(); for (const [key, value] of nextHistory) this.history.set(key, value)
    this.userSourceMap.clear(); for (const [key, value] of nextSources) this.userSourceMap.set(key, value)
    this.settings.clear(); for (const [key, value] of nextSettings) this.settings.set(key, value)
    this.runtimeStates.clear(); for (const [key, value] of nextRuntimeStates) this.runtimeStates.set(key, value)
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

async function lockUserSourceMutations(transaction: ReaderTransaction, userId: string): Promise<void> {
  // Domain membership spans multiple source rows, so serialize account-level source mutations without adding a schema constraint.
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`)
}
/** Keep an existing source's setting; otherwise leave new siblings disabled beside an active source, or select the newest import. */
function decideImportedSourceEnabled(candidates: readonly ImportPreviewCandidate[], currentById: ReadonlyMap<string, { enabled: boolean; deleted: boolean }>): Map<string, boolean> {
  const activeDomains = new Set([...currentById.entries()].filter(([, state]) => !state.deleted && state.enabled).map(([sourceId]) => sourceDomainInfo(sourceId).key))
  const enabledByCandidate = new Map(candidates.map((candidate) => [candidate.id, false]))
  for (const candidate of candidates) {
    const current = currentById.get(candidate.sourceId)
    if (current !== undefined && !current.deleted) enabledByCandidate.set(candidate.id, current.enabled)
  }

  const sortByRuleTime = (left: ImportPreviewCandidate, right: ImportPreviewCandidate) => compareSourceVersions(
    { sourceId: left.sourceId, name: left.name, ...(left.lastUpdateTime === undefined ? {} : { lastUpdateTime: left.lastUpdateTime }), customOrder: readInteger(left.normalizedSource.customOrder, 0) },
    { sourceId: right.sourceId, name: right.name, ...(right.lastUpdateTime === undefined ? {} : { lastUpdateTime: right.lastUpdateTime }), customOrder: readInteger(right.normalizedSource.customOrder, 0) },
  )
  const restores = candidates.filter((candidate) => currentById.get(candidate.sourceId)?.deleted === true && currentById.get(candidate.sourceId)?.enabled === true).sort(sortByRuleTime)
  for (const candidate of restores) {
    const domainKey = sourceDomainInfo(candidate.sourceId).key
    if (activeDomains.has(domainKey)) continue
    enabledByCandidate.set(candidate.id, true)
    activeDomains.add(domainKey)
  }

  const newByDomain = new Map<string, ImportPreviewCandidate[]>()
  for (const candidate of candidates) {
    if (currentById.has(candidate.sourceId)) continue
    const domainKey = sourceDomainInfo(candidate.sourceId).key
    const domainCandidates = newByDomain.get(domainKey) ?? []
    domainCandidates.push(candidate)
    newByDomain.set(domainKey, domainCandidates)
  }
  for (const [domainKey, domainCandidates] of newByDomain) {
    if (activeDomains.has(domainKey)) continue
    const [selected] = domainCandidates.sort(sortByRuleTime)
    if (selected !== undefined) {
      enabledByCandidate.set(selected.id, true)
      activeDomains.add(domainKey)
    }
  }
  return enabledByCandidate
}
function compareStoredSourceManagementOrder(left: StoredSourceRecord, right: StoredSourceRecord): number { return readInteger(left.normalizedSource.customOrder, 0) - readInteger(right.normalizedSource.customOrder, 0) || left.sourceId.localeCompare(right.sourceId) }
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
function mergeReaderSettings(current: ReaderSettings, patch: ReaderSettingsPatch, updatedAt: string): ReaderSettings { return { ...current, ...patch, general: { ...current.general, ...patch.general }, updatedAt } }
function readerSettingsValues(userId: string, settings: ReaderSettings, updatedAt: Date) {
  const preferences: ReaderSettingsPreferences = {
    schemaVersion: 1,
    general: settings.general,
    display: {
      theme: settings.theme,
      readingMode: settings.readingMode,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      marginTop: settings.marginTop,
      marginRight: settings.marginRight,
      marginBottom: settings.marginBottom,
      marginLeft: settings.marginLeft,
    },
  }
  return { userId, preferences, updatedAt }
}
function toSettings(row: ReaderSettingsRow): ReaderSettings {
  const preferences = settingsObject(row.preferences)
  const general = settingsObject(preferences.general)
  const display = settingsObject(preferences.display)
  const bookshelfSort = general.bookshelfSort === 'lastReadAt' ? 'lastReadAt' : DEFAULT_READER_SETTINGS.general.bookshelfSort
  return {
    userId: row.userId,
    theme: display.theme === 'system' || display.theme === 'light' || display.theme === 'dark' ? display.theme : DEFAULT_READER_SETTINGS.theme,
    readingMode: display.readingMode === 'scroll' || display.readingMode === 'paged' ? display.readingMode : DEFAULT_READER_SETTINGS.readingMode,
    fontSize: typeof display.fontSize === 'number' && Number.isInteger(display.fontSize) && display.fontSize >= 15 && display.fontSize <= 28 ? display.fontSize : DEFAULT_READER_SETTINGS.fontSize,
    lineHeight: typeof display.lineHeight === 'number' && display.lineHeight >= 1.4 && display.lineHeight <= 2.6 ? display.lineHeight : DEFAULT_READER_SETTINGS.lineHeight,
    marginTop: typeof display.marginTop === 'number' && Number.isInteger(display.marginTop) && display.marginTop >= 0 && display.marginTop <= 64 ? display.marginTop : DEFAULT_READER_SETTINGS.marginTop,
    marginRight: typeof display.marginRight === 'number' && Number.isInteger(display.marginRight) && display.marginRight >= 0 && display.marginRight <= 64 ? display.marginRight : DEFAULT_READER_SETTINGS.marginRight,
    marginBottom: typeof display.marginBottom === 'number' && Number.isInteger(display.marginBottom) && display.marginBottom >= 0 && display.marginBottom <= 64 ? display.marginBottom : DEFAULT_READER_SETTINGS.marginBottom,
    marginLeft: typeof display.marginLeft === 'number' && Number.isInteger(display.marginLeft) && display.marginLeft >= 0 && display.marginLeft <= 64 ? display.marginLeft : DEFAULT_READER_SETTINGS.marginLeft,
    general: { bookshelfSort },
    updatedAt: row.updatedAt.toISOString(),
  }
}
function settingsObject(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function toBook(row: BookRow): StoredBook { return { id: row.id, userId: row.userId, name: row.name, ...(row.author === null ? {} : { author: row.author }), ...(row.intro === null ? {} : { intro: row.intro }), ...(row.coverUrl === null ? {} : { coverUrl: row.coverUrl }), ...(row.activeEditionKey === null ? {} : { activeEditionKey: row.activeEditionKey }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toEdition(row: BookEditionRow): StoredEdition { return { id: row.id, userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint, bookUrl: row.bookUrl, metadata: row.metadata, ...(row.variable === null ? {} : { variable: row.variable }) } }
function toSearch(row: SearchRunRow): SearchRunState { const sourceIds = row.sourceIds.length === 0 ? [row.sourceId] : row.sourceIds; return { id: row.id, userId: row.userId, keyword: row.keyword, sourceId: row.sourceId, sourceIds, ...(row.precision ? { precision: true } : {}), ...(row.sourceFingerprint === null ? {} : { sourceFingerprint: row.sourceFingerprint }), status: row.status as SearchRunState['status'], candidates: row.candidates, sourceStates: row.sourceStates, ...(row.cursor === null || row.cursor === undefined ? {} : { cursor: row.cursor }), ...(row.nextCursor === null || row.nextCursor === undefined ? {} : { nextCursor: row.nextCursor }), ...(row.operationId === null ? {} : { operationId: row.operationId }), progress: { completed: row.progressCompleted, total: row.progressTotal === 0 ? sourceIds.length : row.progressTotal }, version: row.version, cancelled: row.cancelled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function toHistory(row: SearchHistoryRow): SearchHistoryItem { return { id: row.id, searchId: row.searchId, keyword: row.keyword, sourceIds: row.sourceIds, status: row.status, resultCount: row.resultCount, ...(row.summary === null ? {} : { summary: row.summary }), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } }
function searchSummary(status: string, count: number): string { if (status === 'success') return `${count} 条结果`; if (status === 'empty') return '没有找到结果'; if (status === 'partial') return `${count} 条结果，部分书源失败`; if (status === 'cancelled') return '已取消'; if (status === 'failed') return '搜索失败'; return status }
function toToc(row: TocSnapshotRow): StoredToc { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, sourceFingerprint: row.sourceFingerprint, revision: row.revision, chapters: row.chapters, bookPatch: row.bookPatch, ...(row.bookAfter === null || row.bookAfter === undefined ? {} : { bookAfter: row.bookAfter }), updatedAt: row.updatedAt.toISOString() } }
function toContent(row: ChapterContentRow): StoredContent { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, tocRevision: row.tocRevision, sourceFingerprint: row.sourceFingerprint, content: row.content, updatedAt: row.updatedAt.toISOString() } }
function toPosition(row: typeof readingRecords.$inferSelect): StoredPosition { return { userId: row.userId, bookId: row.bookId, editionKey: row.editionKey, chapterId: row.chapterId, chapterUrl: row.chapterUrl, chapterIndex: row.chapterIndex, title: row.title, ...(row.tocRevision === null ? {} : { tocRevision: row.tocRevision }), paragraphIndex: row.paragraphIndex, offset: row.offset, version: row.version, lastReadAt: row.lastReadAt.toISOString() } }

function assertBackupSnapshotClosed(snapshot: ReaderBackupSnapshot, userId: string): void {
  const sourceIds = new Set<string>()
  for (const item of snapshot.sources) {
    if (item.source.sourceId.length === 0 || sourceIds.has(item.source.sourceId)) throw new BackupRestoreError(`书源定义重复：${item.source.sourceId}`)
    sourceIds.add(item.source.sourceId)
  }
  const bookIds = new Set<string>()
  const editionOwners = new Map<string, string>()
  const candidateOwners = new Map<string, string>()
  for (const item of snapshot.books) {
    if (item.book.userId !== userId || bookIds.has(item.book.id) || item.editions.length === 0) throw new BackupRestoreError(`书籍数据无效：${item.book.id}`)
    bookIds.add(item.book.id)
    for (const edition of item.editions) {
      if (edition.userId !== userId || edition.bookId !== item.book.id || edition.editionKey !== backupEditionKey(edition.sourceId, edition.bookUrl)) throw new BackupRestoreError(`书籍版本数据无效：${item.book.id}`)
      const owner = editionOwners.get(edition.editionKey)
      if (owner !== undefined && owner !== item.book.id) throw new BackupRestoreError(`书籍版本重复：${edition.editionKey}`)
      editionOwners.set(edition.editionKey, item.book.id)
    }
    if (item.book.activeEditionKey !== undefined && !item.editions.some((edition) => edition.editionKey === item.book.activeEditionKey)) throw new BackupRestoreError(`书籍活动版本不存在：${item.book.id}`)
    for (const candidate of item.candidates) {
      if (candidate.userId !== userId || candidate.bookId !== item.book.id || candidate.sourceFingerprint.length === 0 || candidate.candidate.sourceId !== candidate.sourceId || candidate.candidate.sourceFingerprint !== candidate.sourceFingerprint || candidate.candidate.candidate.bookUrl !== candidate.bookUrl) throw new BackupRestoreError(`书籍候选数据无效：${item.book.id}`)
      const candidateKey = backupEditionKey(candidate.sourceId, candidate.bookUrl)
      if (editionOwners.has(candidateKey) || candidateOwners.has(candidateKey)) throw new BackupRestoreError(`书籍候选版本重复：${candidateKey}`)
      candidateOwners.set(candidateKey, item.book.id)
    }
  }
  for (const item of snapshot.bookshelf) if (!bookIds.has(item.bookId)) throw new BackupRestoreError(`书架缺少书籍：${item.bookId}`)
  for (const position of snapshot.positions) if (position.userId !== userId || !editionOwners.has(position.editionKey) || !snapshot.books.some((item) => item.book.id === position.bookId && item.editions.some((edition) => edition.editionKey === position.editionKey))) throw new BackupRestoreError(`阅读记录缺少书籍版本：${position.editionKey}`)
  const historyIds = new Set<string>()
  const searchIds = new Set<string>()
  for (const item of snapshot.searchHistory) {
    if (!isUuid(item.id) || historyIds.has(item.id) || !isUuid(item.searchId) || searchIds.has(item.searchId) || !isIsoDateString(item.createdAt) || !isIsoDateString(item.updatedAt)) throw new BackupRestoreError(`搜索记录数据无效：${item.id}`)
    historyIds.add(item.id)
    searchIds.add(item.searchId)
  }
  if (snapshot.settings.userId !== userId) throw new BackupRestoreError('阅读设置用户不匹配')
}

export function createRepository(): ReaderRepository { return new PostgresReaderRepository() }

export function sourceSummaryFromSource(source: NormalizedSource, fingerprint: string, enabled = true): SourceSummary { return { sourceId: source.bookSourceUrl, name: source.bookSourceName, ...(typeof source.bookSourceGroup === 'string' ? { group: source.bookSourceGroup } : {}), fingerprint, enabled } }

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) }

/** 缓存去掉只能在搜索响应中使用的详情页正文，但保留 JS 详情脚本重建候选所需的变量和原始字段。 */
function cacheableCandidate(stored: StoredCandidate): StoredCandidate {
  const { sourceId, bookUrl, name, author, intro, coverUrl, kind, wordCount, lastChapter, updateTime, tocUrl, variable, rawFields } = stored.candidate
  const fields = Object.fromEntries(Object.entries({ name, author, intro, coverUrl, kind, wordCount, lastChapter, updateTime, tocUrl }).filter(([, value]) => value !== undefined))
  return { sourceId: stored.sourceId, sourceFingerprint: stored.sourceFingerprint, ...(stored.searchDurationMs === undefined ? {} : { searchDurationMs: stored.searchDurationMs }), candidate: { sourceId, bookUrl, ...fields, ...(variable === undefined ? {} : { variable }), rawFields: structuredClone(rawFields), traceRef: 'book-source-cache' } }
}
