import { randomUUID } from 'node:crypto'
import type { ImportBatch, ImportConfirmResult, ImportHistoryItem, ImportHistoryQuery, ImportPreview, UndoImportInput, UndoPreviewItem } from '../../shared/source-management.ts'
import type { StoredSourceRecord } from './repository.ts'
import { SourceManagementError } from './repository.ts'
import { displayImportOrigin, importUrlInfo, itemStatus, selectionKey, undoReason } from './source-import-history.ts'
import { sourceDomainInfo } from '../../shared/source-domain.ts'

export interface MemorySource { source: StoredSourceRecord; deleted: boolean; revision: string }
type MemoryItem = ImportHistoryItem & { before: MemorySource | null }
export class MemoryImportHistory {
  readonly links = new Map<string, { id: string; key: string; displayUrl: string; sortOrder: number }[]>()
  readonly revisions = new Map<string, string>()
  readonly batches = new Map<string, { userId: string; previewId: string; selected: string[]; batch: ImportBatch; items: MemoryItem[] }>()
  readonly undos = new Map<string, { signature: string; result: { affected: number; batchId: string; undoStatus: ImportBatch['undoStatus'] } }>()
  private sources: Map<string, MemorySource>
  private busy: (userId: string, sourceId: string) => boolean
  private clearRuntime: (userId: string, sourceId: string) => void
  constructor(sources: Map<string, MemorySource>, busy: (userId: string, sourceId: string) => boolean, clearRuntime: (userId: string, sourceId: string) => void) { this.sources = sources; this.busy = busy; this.clearRuntime = clearRuntime }
  readLinks(userId: string) {
    return { links: (this.links.get(userId) ?? []).map((row) => ({ id: row.id, displayUrl: row.displayUrl, sortOrder: row.sortOrder, sourceCount: [...this.sources.entries()].filter(([key, value]) => key.startsWith(userId + ':') && !value.deleted && value.source.importLinkId === row.id).length })), revision: this.revisions.get(userId) ?? 'initial' }
  }
  sourceMetadata(userId: string, source: StoredSourceRecord) {
    const link = this.links.get(userId)?.find((row) => row.id === source.importLinkId)
    const batch = [...this.batches.values()].find((row) => row.userId === userId && row.items.some((item) => item.id === source.currentImportItemId))?.batch
    return { ...(link ? { importPriority: link.sortOrder, importDisplayUrl: link.displayUrl } : {}), ...(batch ? { importedAt: batch.importedAt } : {}) }
  }
  order(userId: string, ids: string[], revision: string) {
    const current = this.links.get(userId) ?? []
    if ((this.revisions.get(userId) ?? 'initial') !== revision || ids.length !== current.length || new Set(ids).size !== ids.length || current.some((row) => !ids.includes(row.id))) throw new SourceManagementError('source-conflict', '来源列表已变化，请刷新后重试')
    this.links.set(userId, ids.map((id, sortOrder) => ({ ...current.find((row) => row.id === id)!, sortOrder })))
    this.revisions.set(userId, randomUUID()); return this.readLinks(userId)
  }
  committed(userId: string, previewId: string, selected: string[]): ImportConfirmResult | undefined {
    const row = [...this.batches.values()].find((row) => row.userId === userId && row.previewId === previewId)
    if (!row) return undefined
    if (selectionKey(row.selected) !== selectionKey(selected)) throw new SourceManagementError('preview-invalid', '导入预览已经确认过，选择内容不同')
    return this.result(row.batch)
  }
  result(batch: ImportBatch): ImportConfirmResult { return { imported: batch.imported, batchId: batch.id, newCount: batch.newCount, updatedCount: batch.updatedCount, restoredCount: batch.restoredCount } }
  record(userId: string, preview: ImportPreview, sourceUrl: string, selected: string[]) {
    const info = importUrlInfo(sourceUrl); const currentLinks = this.links.get(userId) ?? []
    let link = currentLinks.find((row) => row.key === info.key)
    if (!link) { link = { id: randomUUID(), key: info.key, displayUrl: info.display, sortOrder: currentLinks.length }; this.links.set(userId, [...currentLinks, link]); this.revisions.set(userId, randomUUID()) }
    const batch: ImportBatch = { id: randomUUID(), linkId: link.id, displayUrl: link.displayUrl, importedAt: new Date().toISOString(), imported: selected.length, newCount: 0, updatedCount: 0, restoredCount: 0, skippedCount: 0, unselectedCount: 0, undoStatus: 'none', undoneAt: null, invalidatedReason: null }
    const details = preview.candidates.map((candidate): MemoryItem => {
      const chosen = selected.includes(candidate.id)
      const prior = this.sources.get(`${userId}:${candidate.sourceId}`)
      const action = chosen ? candidate.disposition! : candidate.disposition ? 'unselected' : 'skipped'
      if (action === 'new') batch.newCount++
      if (action === 'update') batch.updatedCount++
      if (action === 'restore') batch.restoredCount++
      if (action === 'skipped') batch.skippedCount++
      if (action === 'unselected') batch.unselectedCount++
      return { id: randomUUID(), sourceUuid: prior?.source.sourceUuid ?? (chosen ? randomUUID() : null), sourceId: candidate.sourceId, name: candidate.name, group: candidate.group ?? null, action, reason: candidate.reason, displayUrl: displayImportOrigin(candidate.originLocation ?? sourceUrl), afterRevision: chosen ? randomUUID() : null, undoneAt: null, currentStatus: chosen ? 'unchanged' : 'skipped', before: chosen && prior ? structuredClone(prior) : null }
    })
    this.batches.set(batch.id, { userId, previewId: preview.previewId, selected: [...selected], batch, items: details })
    return { batch, details, changes: new Map(preview.candidates.map((candidate, index) => [candidate.id, details[index]!])) }
  }
  require(userId: string, batchId: string) { const row = this.batches.get(batchId); if (!row || row.userId !== userId) throw new SourceManagementError('source-not-found', '导入记录不存在'); return row }
  history(userId: string, query: ImportHistoryQuery) {
    const rows = [...this.batches.values()].filter((row) => row.userId === userId && (!query.linkId || row.batch.linkId === query.linkId) && (!query.sourceUuid || row.items.some((item) => item.sourceUuid === query.sourceUuid))).reverse()
    return { batches: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((row) => structuredClone(row.batch)), total: rows.length, page: query.page, pageSize: query.pageSize }
  }
  items(userId: string, batchId: string, query: ImportHistoryQuery) {
    const row = this.require(userId, batchId)
    const details = row.items.filter((item) => query.filter === 'all' || (query.filter === 'imported' ? !!item.afterRevision : !item.afterRevision))
    return { batch: structuredClone(row.batch), items: details.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(({ before, ...item }) => ({ ...item, author: [this.sources.get(userId + ':' + item.sourceId)?.source.normalizedSource.author, this.sources.get(userId + ':' + item.sourceId)?.source.normalizedSource.bookSourceAuthor].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null, currentStatus: itemStatus(item, this.sources.get(userId + ':' + item.sourceId)) })), total: details.length, page: query.page, pageSize: query.pageSize }
  }
  preview(userId: string, batchId: string, ids?: string[]) {
    const row = this.require(userId, batchId)
    const selected = row.items.filter((item) => ids ? ids.includes(item.id) : item.afterRevision)
    if (ids && (new Set(ids).size !== ids.length || selected.length !== ids.length)) throw new SourceManagementError('preview-invalid', '撤销列表包含无效明细')
    const preview: UndoPreviewItem[] = selected.map((item) => {
      const current = this.sources.get(userId + ':' + item.sourceId)
      const before = item.before
      const conflict = before?.source.enabled === true && !before.deleted && [...this.sources.entries()].some(([key, value]) => key.startsWith(userId + ':') && value.source.sourceId !== item.sourceId && value.source.enabled && !value.deleted && sourceDomainInfo(value.source.sourceId).key === sourceDomainInfo(item.sourceId).key)
      const reason = undoReason(item, current, row.batch.invalidatedReason, this.busy(userId, item.sourceId), conflict)
      return { itemId: item.id, name: item.name, action: item.action, expectedRevision: current?.revision ?? null, canUndo: !reason, reason }
    })
    return { items: preview, removable: preview.filter((item) => item.canUndo && item.action === 'new').length, restorable: preview.filter((item) => item.canUndo && item.action !== 'new').length }
  }
  undo(userId: string, batchId: string, input: UndoImportInput) {
    const key = userId + ':' + input.idempotencyKey; const signature = batchId + selectionKey(input.items.map((item) => item.itemId + ':' + item.expectedRevision))
    const done = this.undos.get(key)
    if (done) { if (done.signature !== signature) throw new SourceManagementError('source-conflict', '撤销请求标识已用于其他操作'); return done.result }
    const preview = this.preview(userId, batchId, input.items.map((item) => item.itemId))
    const blocked = preview.items.find((item) => !item.canUndo || item.expectedRevision !== input.items.find((value) => value.itemId === item.itemId)?.expectedRevision)
    if (blocked) throw new SourceManagementError('source-conflict', `${blocked.name}：${blocked.reason || '版本已变化，请重新预览撤销'}`)
    const row = this.require(userId, batchId)
    for (const selected of input.items) {
      const item = row.items.find((item) => item.id === selected.itemId)!; const sourceKey = userId + ':' + item.sourceId
      const current = this.sources.get(sourceKey)!
      this.sources.set(sourceKey, item.before ? { ...structuredClone(item.before), revision: randomUUID() } : { ...current, deleted: true, revision: randomUUID() })
      item.undoneAt = new Date().toISOString(); this.clearRuntime(userId, item.sourceId)
    }
    row.batch.undoStatus = row.items.some((item) => item.afterRevision && !item.undoneAt) ? 'partial' : 'all'; row.batch.undoneAt = new Date().toISOString()
    const result = { affected: input.items.length, batchId, undoStatus: row.batch.undoStatus }; this.undos.set(key, { signature, result }); return result
  }
  invalidate(userId: string) { for (const row of this.batches.values()) if (row.userId === userId) row.batch.invalidatedReason = '备份恢复后不可撤销' }
}
