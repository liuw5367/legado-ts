import { z } from 'zod'

export const sourceManagementStatusSchema = z.enum(['all', 'enabled', 'disabled'])
export const sourceManagementPageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50),
  query: z.string().trim().max(200).default(''),
  status: sourceManagementStatusSchema.default('all'),
})

export const sourceActionSchema = z.object({
  action: z.enum(['enable', 'disable', 'delete']),
  items: z.array(z.object({ sourceId: z.string().trim().min(1).max(2000), expectedSourceRevision: z.string().trim().min(1).max(200) })).min(1).max(1000),
})

export const importPreviewRequestSchema = z.object({ url: z.string().trim().url().max(4000) })
export const importConfirmRequestSchema = z.object({ previewId: z.string().uuid(), candidateIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1000) })

export type SourceManagementStatus = z.infer<typeof sourceManagementStatusSchema>
export type SourceManagementPageRequest = z.infer<typeof sourceManagementPageSchema>
export type SourceAction = z.infer<typeof sourceActionSchema>
export type SourceActionItem = z.infer<typeof sourceActionSchema>['items'][number]
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>
export type ImportConfirmRequest = z.infer<typeof importConfirmRequestSchema>

export interface ManagedSourceSummary {
  sourceId: string
  name: string
  group?: string
  fingerprint: string
  enabled: boolean
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
  previewId: string
}
