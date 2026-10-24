import { z } from 'zod'

export const sourceManagementStatusSchema = z.enum(['all', 'enabled', 'disabled'])
export const sourceManagementPageSchema = z.object({
  all: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50),
  query: z.string().trim().max(200).default(''),
  status: sourceManagementStatusSchema.default('all'),
})

export const sourceActionSchema = z.object({
  action: z.enum(['enable', 'disable', 'delete']),
  items: z.array(z.object({ sourceId: z.string().trim().min(1).max(2000), expectedSourceRevision: z.string().trim().min(1).max(200) })).min(1).max(1000),
})
export const sourceOrderSchema = z.object({
  items: z.array(z.object({ sourceId: z.string().trim().min(1).max(2000), expectedSourceRevision: z.string().trim().min(1).max(200), customOrder: z.number().int().min(-1_000_000_000).max(1_000_000_000) })).min(1).max(1000),
})

export const importPreviewRequestSchema = z.object({ url: z.string().trim().url().max(4000) })
export const importConfirmRequestSchema = z.object({ previewId: z.string().uuid(), candidateIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1000) })

export type SourceManagementStatus = z.infer<typeof sourceManagementStatusSchema>
export type SourceManagementPageRequest = z.infer<typeof sourceManagementPageSchema>
export type SourceAction = z.infer<typeof sourceActionSchema>
export type SourceActionItem = z.infer<typeof sourceActionSchema>['items'][number]
export type SourceOrderItem = z.infer<typeof sourceOrderSchema>['items'][number]
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>
export type ImportConfirmRequest = z.infer<typeof importConfirmRequestSchema>

export interface ManagedSourceSummary {
  importPriority?: number
  sourceUuid?: string
  importLinkId?: string
  importDisplayUrl?: string
  importedAt?: string
  sourceId: string
  name: string
  group?: string
  fingerprint: string
  enabled: boolean
  customOrder: number
  sourceRevision: string
  lastUpdateTime?: number
  origin: 'account'
}

export interface SourceManagementPage {
  sources: ManagedSourceSummary[]
  page: number
  pageSize: number
  total: number
  enabledCount: number
}

export type ImportCandidateDisposition = 'new' | 'update' | 'restore'
export type ImportSkippedReason = 'old-version' | 'same-version' | 'conflict' | 'invalid' | 'duplicate' | 'fetch-failed' | 'unsupported'

export interface ImportPreviewCandidate {
  originLocation?: string
  id: string
  sourceId: string
  name: string
  group?: string
  fingerprint: string
  normalizedSource: Record<string, unknown>
  rawSource: unknown
  disposition?: ImportCandidateDisposition
  skippedReason?: ImportSkippedReason
  reason: string
  sourceRevision?: string
  lastUpdateTime?: number
  localLastUpdateTime?: number
}

export interface ImportPreview {
  previewId: string
  expiresAt: string
  candidates: ImportPreviewCandidate[]
  writableCount: number
}

export interface ImportPreviewSummaryCandidate {
  id: string
  sourceId: string
  name: string
  group?: string
  disposition?: ImportCandidateDisposition
  skippedReason?: ImportSkippedReason
  reason: string
  lastUpdateTime?: number
  localLastUpdateTime?: number
}

export interface ImportPreviewSummary {
  previewId: string
  expiresAt: string
  candidates: ImportPreviewSummaryCandidate[]
  writableCount: number
}

export interface ImportConfirmResult {
  imported: number
  batchId: string
  newCount: number
  updatedCount: number
  restoredCount: number
}

export const importHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50),
  linkId: z.string().uuid().optional(),
  sourceUuid: z.string().uuid().optional(),
  filter: z.enum(['imported', 'skipped', 'all']).default('imported'),
})
export const importLinkOrderSchema = z.object({ orderedIds: z.array(z.string().uuid()).max(10000), expectedRevision: z.string().min(1) })
export const undoPreviewSchema = z.object({ itemIds: z.array(z.string().uuid()).min(1).max(1000).optional() })
export const undoImportSchema = z.object({ idempotencyKey: z.string().uuid(), items: z.array(z.object({ itemId: z.string().uuid(), expectedRevision: z.string().min(1) })).min(1).max(1000) })
export type ImportHistoryQuery = z.infer<typeof importHistoryQuerySchema>
export type UndoImportInput = z.infer<typeof undoImportSchema>
export interface ImportLink { id: string; displayUrl: string; sortOrder: number; sourceCount: number }
export interface ImportLinksResponse { links: ImportLink[]; revision: string }
export interface ImportBatch {
  id: string; linkId: string; displayUrl: string; importedAt: string
  imported: number; newCount: number; updatedCount: number; restoredCount: number; skippedCount: number; unselectedCount: number
  undoStatus: 'none' | 'partial' | 'all'; undoneAt: string | null; invalidatedReason: string | null
}
export interface ImportHistoryItem {
  id: string; sourceUuid: string | null; sourceId: string; name: string; group: string | null
  action: 'new' | 'update' | 'restore' | 'skipped' | 'unselected'; reason: string; displayUrl: string
  afterRevision: string | null; undoneAt: string | null
  currentStatus: 'unchanged' | 'modified' | 'deleted' | 'undone' | 'skipped'
}
export interface ImportHistoryPage { batches: ImportBatch[]; total: number; page: number; pageSize: number }
export interface ImportItemsPage { batch: ImportBatch; items: ImportHistoryItem[]; total: number; page: number; pageSize: number }
export interface UndoPreviewItem { itemId: string; name: string; action: ImportHistoryItem['action']; expectedRevision: string | null; canUndo: boolean; reason: string }
export interface UndoPreview { items: UndoPreviewItem[]; removable: number; restorable: number }
export interface UndoImportResult { affected: number; batchId: string; undoStatus: ImportBatch['undoStatus'] }
