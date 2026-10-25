import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { ImportBatch, ImportConfirmResult, ImportHistoryItem, ImportHistoryQuery, ImportPreview, UndoImportInput, UndoPreviewItem } from '../../shared/source-management.ts'
import { sourceDomainInfo } from '../../shared/source-domain.ts'
import type { ReaderTransaction } from './client.ts'
import { sourceImportBatches as batches, sourceImportItems as items, sourceImportLinks as links, sourceImportSettings as settings, sourceImportUndoOperations as undoOperations, sourceRuntimeState, userSources } from './schema.ts'
import type { UserSourceRow } from './schema.ts'
import { decryptImportData, encryptImportData } from './runtime-state-crypto.ts'
import { SourceManagementError } from './repository.ts'

export type BeforeSource = Pick<UserSourceRow, 'sourceUuid' | 'sourceId' | 'fingerprint' | 'rawSource' | 'normalizedSource' | 'enabled' | 'customOrder' | 'deleted' | 'importLinkId' | 'currentImportItemId'>
type BatchRow = typeof batches.$inferSelect
export const itemSummaryColumns = { id: items.id, sourceUuid: items.sourceUuid, sourceId: items.sourceId, name: items.name, group: items.group, action: items.action, reason: items.reason, displayUrl: items.displayUrl, afterRevision: items.afterRevision, undoneAt: items.undoneAt }

export function importUrlInfo(value: string): { key: string; display: string; normalized: string } {
  const url = new URL(value)
  url.hash = ''
  const normalized = url.toString()
  const key = createHash('sha256').update(normalized).digest('hex')
  url.username = ''; url.password = ''
  for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '已隐藏')
  let display = url.toString()
  try { display = decodeURI(display) } catch { /* 不完整的百分号转义仍可作为合法 URL 追踪。 */ }
  return { key, normalized, display }
}
export function displayImportOrigin(value: string): string {
  try { return importUrlInfo(value).display } catch { return '无效来源地址' }
}
export function selectionKey(values: string[]): string { return JSON.stringify([...values].sort()) }
export function batchResult(row: Pick<BatchRow, 'id' | 'imported' | 'newCount' | 'updatedCount' | 'restoredCount'>): ImportConfirmResult { return { imported: row.imported, batchId: row.id, newCount: row.newCount, updatedCount: row.updatedCount, restoredCount: row.restoredCount } }
export function summarizeBatch(row: BatchRow, displayUrl: string): ImportBatch { return { id: row.id, linkId: row.linkId, displayUrl, importedAt: row.importedAt.toISOString(), imported: row.imported, newCount: row.newCount, updatedCount: row.updatedCount, restoredCount: row.restoredCount, skippedCount: row.skippedCount, unselectedCount: row.unselectedCount, undoStatus: row.undoStatus, undoneAt: row.undoneAt?.toISOString() ?? null, invalidatedReason: row.invalidatedReason } }
export function itemStatus(item: { action: string; undoneAt: unknown; afterRevision: string | null }, current?: { revision: string; deleted: boolean }): ImportHistoryItem['currentStatus'] {
  if (!item.afterRevision) return 'skipped'
  if (item.undoneAt) return 'undone'
  if (!current || current.deleted) return 'deleted'
  return current.revision === item.afterRevision ? 'unchanged' : 'modified'
}
export function undoReason(item: { afterRevision: string | null; undoneAt: unknown }, current: { revision: string; deleted: boolean } | undefined, invalidated: string | null, busy: boolean, domainConflict: boolean): string {
  if (invalidated) return invalidated
  if (!item.afterRevision) return '本项没有产生导入变更'
  if (item.undoneAt) return '本项已经撤销'
  if (!current || current.revision !== item.afterRevision) return '书源在导入后已修改或删除'
  if (busy) return '书源正在使用，请稍后重试'
  if (domainConflict) return '恢复启用会与当前同域书源冲突'
  return ''
}

export async function lockSourceMutations(tx: ReaderTransaction, userId: string): Promise<void> { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`) }

export async function committedImport(tx: ReaderTransaction, userId: string, previewId: string, candidateIds: string[]): Promise<ImportConfirmResult | undefined> {
  const [row] = await tx.select().from(batches).where(and(eq(batches.userId, userId), eq(batches.previewId, previewId)))
  if (!row) return undefined
  if (selectionKey(row.selection) !== selectionKey(candidateIds)) throw new SourceManagementError('preview-invalid', '导入预览已经确认过，选择内容不同')
  return batchResult(row)
}

/** 调用者持有账号锁；本函数与实际书源变更必须使用同一事务。 */
export async function recordImport(tx: ReaderTransaction, userId: string, previewId: string, sourceUrl: string, preview: ImportPreview, candidateIds: string[], previous: UserSourceRow[]) {
  const info = importUrlInfo(sourceUrl)
  let [link] = await tx.select().from(links).where(and(eq(links.userId, userId), eq(links.urlKey, info.key)))
  if (!link) {
    const [last] = await tx.select({ order: sql<number>`coalesce(max(${links.sortOrder}), -1)` }).from(links).where(eq(links.userId, userId))
    ;[link] = await tx.insert(links).values({ userId, urlKey: info.key, encryptedUrl: encryptImportData(info.normalized), displayUrl: info.display, sortOrder: (last?.order ?? -1) + 1 }).returning()
    await tx.insert(settings).values({ userId, revision: randomUUID() }).onConflictDoUpdate({ target: settings.userId, set: { revision: randomUUID() } })
  }
  if (!link) throw new Error('导入来源保存失败')
  const chosen = new Set(candidateIds)
  const counts = { imported: chosen.size, newCount: 0, updatedCount: 0, restoredCount: 0, skippedCount: 0, unselectedCount: 0 }
  const previousById = new Map(previous.map((row) => [row.sourceId, row]))
  const batchId = randomUUID()
  const changes = new Map<string, { itemId: string; revision: string; sourceUuid: string }>()
  const values = preview.candidates.map((candidate) => {
    const selected = chosen.has(candidate.id)
    const action = selected ? candidate.disposition! : candidate.disposition ? 'unselected' as const : 'skipped' as const
    if (action === 'new') counts.newCount++
    if (action === 'update') counts.updatedCount++
    if (action === 'restore') counts.restoredCount++
    if (action === 'skipped') counts.skippedCount++
    if (action === 'unselected') counts.unselectedCount++
    const prior = previousById.get(candidate.sourceId)
    const id = randomUUID(); const revision = selected ? randomUUID() : null
    const sourceUuid = prior?.sourceUuid ?? (selected ? randomUUID() : null)
    if (selected) changes.set(candidate.id, { itemId: id, revision: revision!, sourceUuid: sourceUuid! })
    const origin = candidate.originLocation ?? sourceUrl
    return { id, userId, batchId, sourceUuid, sourceId: candidate.sourceId, name: candidate.name, group: candidate.group ?? null, action, reason: candidate.reason, displayUrl: displayImportOrigin(origin), encryptedOrigin: encryptImportData(origin), beforeSnapshot: selected ? encryptImportData(prior ? beforeSource(prior) : null) : null, afterRevision: revision }
  })
  const [batch] = await tx.insert(batches).values({ id: batchId, userId, previewId, linkId: link.id, selection: candidateIds, ...counts }).returning()
  // 分块避免 Postgres 参数数量上限，仍位于同一导入事务中。
  for (let offset = 0; offset < values.length; offset += 100) await tx.insert(items).values(values.slice(offset, offset + 100))
  return { linkId: link.id, changes, result: batchResult(batch!) }
}
export function beforeSource(row: BeforeSource): BeforeSource { return { sourceUuid: row.sourceUuid, sourceId: row.sourceId, fingerprint: row.fingerprint, rawSource: row.rawSource, normalizedSource: row.normalizedSource, enabled: row.enabled, customOrder: row.customOrder, deleted: row.deleted, importLinkId: row.importLinkId, currentImportItemId: row.currentImportItemId } }

export async function readImportLinks(tx: ReaderTransaction, userId: string) {
  const rows = await tx.select({ id: links.id, displayUrl: links.displayUrl, sortOrder: links.sortOrder, sourceCount: sql<number>`(select count(*)::int from reader.user_sources s where s.user_id = ${links.userId} and s.import_link_id = ${links.id} and not s.deleted)` }).from(links).where(eq(links.userId, userId)).orderBy(asc(links.sortOrder), asc(links.id))
  const [row] = await tx.select().from(settings).where(eq(settings.userId, userId))
  return { links: rows, revision: row?.revision ?? 'initial' }
}
export async function orderImportLinks(tx: ReaderTransaction, userId: string, orderedIds: string[], expectedRevision: string) {
  await lockSourceMutations(tx, userId)
  const current = await readImportLinks(tx, userId)
  if (current.revision !== expectedRevision || orderedIds.length !== current.links.length || new Set(orderedIds).size !== orderedIds.length || current.links.some((row) => !orderedIds.includes(row.id))) throw new SourceManagementError('source-conflict', '来源列表已变化，请刷新后重试')
  for (const [sortOrder, id] of orderedIds.entries()) await tx.update(links).set({ sortOrder }).where(and(eq(links.userId, userId), eq(links.id, id)))
  await tx.insert(settings).values({ userId, revision: randomUUID() }).onConflictDoUpdate({ target: settings.userId, set: { revision: randomUUID() } })
  return readImportLinks(tx, userId)
}
export async function readImportHistory(tx: ReaderTransaction, userId: string, query: ImportHistoryQuery) {
  const condition = and(eq(batches.userId, userId), query.linkId ? eq(batches.linkId, query.linkId) : undefined, query.sourceUuid ? sql`exists (select 1 from reader.source_import_items i where i.user_id = ${userId} and i.batch_id = ${batches.id} and i.source_uuid = ${query.sourceUuid}::uuid)` : undefined)
  const rows = await tx.select({ batch: batches, displayUrl: links.displayUrl }).from(batches).innerJoin(links, and(eq(links.id, batches.linkId), eq(links.userId, userId))).where(condition).orderBy(desc(batches.importedAt), desc(batches.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
  const [total] = await tx.select({ value: count() }).from(batches).where(condition)
  return { batches: rows.map((row) => summarizeBatch(row.batch, row.displayUrl)), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize }
}
async function requireBatch(tx: ReaderTransaction, userId: string, batchId: string) {
  const [row] = await tx.select({ batch: batches, displayUrl: links.displayUrl }).from(batches).innerJoin(links, and(eq(links.id, batches.linkId), eq(links.userId, userId))).where(and(eq(batches.userId, userId), eq(batches.id, batchId)))
  if (!row) throw new SourceManagementError('source-not-found', '导入记录不存在')
  return row
}
export async function readImportItems(tx: ReaderTransaction, userId: string, batchId: string, query: ImportHistoryQuery) {
  const { batch, displayUrl } = await requireBatch(tx, userId, batchId)
  const condition = and(eq(items.userId, userId), eq(items.batchId, batchId), query.filter === 'imported' ? inArray(items.action, ['new', 'update', 'restore']) : query.filter === 'skipped' ? inArray(items.action, ['skipped', 'unselected']) : undefined)
  const rows = await tx.select({ item: itemSummaryColumns, revision: userSources.revision, deleted: userSources.deleted, author: sql<string | null>`coalesce(nullif(trim(${userSources.normalizedSource}->>'author'), ''), nullif(trim(${userSources.normalizedSource}->>'bookSourceAuthor'), ''))` }).from(items).leftJoin(userSources, and(eq(userSources.userId, userId), eq(userSources.sourceUuid, items.sourceUuid))).where(condition).orderBy(asc(items.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
  const [total] = await tx.select({ value: count() }).from(items).where(condition)
  return { batch: summarizeBatch(batch, displayUrl), items: rows.map(({ item, revision, deleted, author }) => ({ ...item, author, undoneAt: item.undoneAt?.toISOString() ?? null, currentStatus: itemStatus(item, revision ? { revision, deleted: deleted ?? false } : undefined) })), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize }
}

async function undoContext(tx: ReaderTransaction, userId: string, batchId: string, itemIds?: string[]) {
  const { batch } = await requireBatch(tx, userId, batchId)
  const selected = await tx.select().from(items).where(and(eq(items.userId, userId), eq(items.batchId, batchId), itemIds ? inArray(items.id, itemIds) : inArray(items.action, ['new', 'update', 'restore'])))
  if (itemIds && (new Set(itemIds).size !== itemIds.length || selected.length !== itemIds.length)) throw new SourceManagementError('preview-invalid', '撤销列表包含无效明细')
  const sources = await tx.select().from(userSources).where(eq(userSources.userId, userId))
  const runtime = await tx.select({ sourceId: sourceRuntimeState.sourceId }).from(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), sql`${sourceRuntimeState.leaseUntil} > now()`))
  const byUuid = new Map(sources.map((row) => [row.sourceUuid, row]))
  const busy = new Set(runtime.map((row) => row.sourceId))
  const restores = new Map<string, BeforeSource | null>(selected.map((item) => [item.id, item.beforeSnapshot ? decryptImportData<BeforeSource | null>(item.beforeSnapshot) : null]))
  const preview: UndoPreviewItem[] = selected.map((item) => {
    const current = item.sourceUuid ? byUuid.get(item.sourceUuid) : undefined
    const before = restores.get(item.id)
    const conflict = before?.enabled === true && !before.deleted && sources.some((row) => row.sourceUuid !== item.sourceUuid && row.enabled && !row.deleted && sourceDomainInfo(row.sourceId).key === sourceDomainInfo(item.sourceId).key)
    const reason = undoReason(item, current, batch.invalidatedReason, busy.has(item.sourceId), conflict)
    return { itemId: item.id, name: item.name, action: item.action, expectedRevision: current?.revision ?? null, canUndo: !reason, reason }
  })
  return { batch, selected, byUuid, restores, preview }
}
export async function previewUndo(tx: ReaderTransaction, userId: string, batchId: string, itemIds?: string[]) {
  const { preview } = await undoContext(tx, userId, batchId, itemIds)
  return { items: preview, removable: preview.filter((row) => row.canUndo && row.action === 'new').length, restorable: preview.filter((row) => row.canUndo && row.action !== 'new').length }
}
export async function undoImport(tx: ReaderTransaction, userId: string, batchId: string, input: UndoImportInput) {
  await lockSourceMutations(tx, userId)
  const signature = selectionKey(input.items.map((row) => row.itemId + ':' + row.expectedRevision))
  const [done] = await tx.select().from(undoOperations).where(and(eq(undoOperations.userId, userId), eq(undoOperations.idempotencyKey, input.idempotencyKey)))
  if (done) {
    if (done.batchId !== batchId || done.selection !== signature) throw new SourceManagementError('source-conflict', '撤销请求标识已用于其他操作')
    return done.result
  }
  const context = await undoContext(tx, userId, batchId, input.items.map((row) => row.itemId))
  const expected = new Map(input.items.map((row) => [row.itemId, row.expectedRevision]))
  const blocked = context.preview.find((row) => !row.canUndo || row.expectedRevision !== expected.get(row.itemId))
  if (blocked) throw new SourceManagementError('source-conflict', `${blocked.name}：${blocked.reason || '版本已变化，请重新预览撤销'}`)
  for (const item of context.selected) {
    const current = context.byUuid.get(item.sourceUuid!)!
    const before = context.restores.get(item.id)
    const revision = randomUUID()
    await tx.update(userSources).set({ ...(before ?? { deleted: true }), revision, updatedAt: new Date() }).where(and(eq(userSources.userId, userId), eq(userSources.sourceUuid, current.sourceUuid), eq(userSources.revision, expected.get(item.id)!)))
    await tx.delete(sourceRuntimeState).where(and(eq(sourceRuntimeState.userId, userId), eq(sourceRuntimeState.sourceId, item.sourceId)))
    await tx.update(items).set({ undoneAt: new Date(), undoRevision: revision }).where(and(eq(items.userId, userId), eq(items.id, item.id)))
  }
  const [remaining] = await tx.select({ value: count() }).from(items).where(and(eq(items.userId, userId), eq(items.batchId, batchId), sql`${items.afterRevision} is not null and ${items.undoneAt} is null`))
  const undoStatus = remaining?.value === 0 ? 'all' as const : 'partial' as const
  await tx.update(batches).set({ undoStatus, undoneAt: new Date() }).where(and(eq(batches.userId, userId), eq(batches.id, batchId)))
  const result = { affected: input.items.length, batchId, undoStatus }
  await tx.insert(undoOperations).values({ userId, idempotencyKey: input.idempotencyKey, batchId, selection: signature, result })
  return result
}
