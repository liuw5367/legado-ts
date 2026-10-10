import { randomUUID } from 'node:crypto'
import { importSources, createRequestPlan, type ImportReader } from '@legado/source-core'
import { NodeCookieStore, NodeNetworkHost } from '@legado/source-node'
import type { ImportPreview, ImportPreviewCandidate, ImportPreviewSummary, ImportPreviewSummaryCandidate, SourceActionItem } from '../../shared/source-management.ts'
import type { ReaderRepository } from '../db/repository.ts'
import { SourceManagementError } from '../db/repository.ts'
import { compareImportCandidates } from './source-comparison.ts'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_CANDIDATES = 1000
const MAX_SOURCE_URLS = 32
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024
const MAX_PREVIEW_TIME_MS = 45_000
const PREVIEW_TTL_MS = 15 * 60 * 1000

export { SourceManagementError }

export async function createImportPreview(repository: ReaderRepository, userId: string, sourceUrl: string, parentSignal?: AbortSignal): Promise<ImportPreview> {
  const url = validateImportUrl(sourceUrl)
  const reader = createImportReader()
  const timeoutSignal = AbortSignal.timeout(MAX_PREVIEW_TIME_MS)
  const signal = parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal])
  const candidates = await importSources({ kind: 'url', uri: url, origin: { kind: 'remote-url', location: url } }, {
    reader,
    signal,
    limits: { maxCandidates: MAX_CANDIDATES, maxBytes: MAX_RESPONSE_BYTES, maxSourceUrls: MAX_SOURCE_URLS },
  })
  const states = await repository.listSourceStatesForUser(userId)
  const localById = new Map(states.map((state) => [state.source.sourceId, state]))
  const previewCandidates = compareImportCandidates(candidates, localById)
  const previewBytes = new TextEncoder().encode(JSON.stringify(previewCandidates)).byteLength
  if (previewBytes > MAX_PREVIEW_BYTES) throw new SourceManagementError('preview-invalid', '导入预览超过大小限制，请拆分书源后重试')
  const preview: ImportPreview = { previewId: randomUUID(), expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), candidates: previewCandidates, writableCount: previewCandidates.filter((candidate) => candidate.disposition !== undefined).length }
  await repository.saveImportPreview(userId, preview, url)
  return preview
}

export function publicImportPreview(preview: ImportPreview): ImportPreviewSummary {
  const candidates: ImportPreviewSummaryCandidate[] = preview.candidates.map((candidate) => ({ id: candidate.id, sourceId: candidate.sourceId, name: candidate.name, ...(candidate.group === undefined ? {} : { group: candidate.group }), ...(candidate.disposition === undefined ? {} : { disposition: candidate.disposition }), ...(candidate.skippedReason === undefined ? {} : { skippedReason: candidate.skippedReason }), reason: candidate.reason, ...(candidate.lastUpdateTime === undefined ? {} : { lastUpdateTime: candidate.lastUpdateTime }), ...(candidate.localLastUpdateTime === undefined ? {} : { localLastUpdateTime: candidate.localLastUpdateTime }) }))
  return { previewId: preview.previewId, expiresAt: preview.expiresAt, candidates, writableCount: preview.writableCount }
}

export function confirmImport(repository: ReaderRepository, userId: string, previewId: string, candidateIds: string[]): Promise<{ imported: number }> {
  return repository.commitImportPreview(userId, previewId, [...new Set(candidateIds)])
}

export function listSourceActions(repository: ReaderRepository, userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }> {
  return repository.applySourceActions(userId, action, items)
}

function validateImportUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new SourceManagementError('preview-invalid', '导入地址不是有效 URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SourceManagementError('preview-invalid', '导入地址只允许 HTTP(S) 协议')
  if (url.username.length > 0 || url.password.length > 0) throw new SourceManagementError('preview-invalid', '导入地址不能包含账号或密码')
  return url.toString()
}

function createImportReader(): ImportReader {
  const cookieStore = new NodeCookieStore()
  const network = new NodeNetworkHost({ cookieStore })
  let totalBytes = 0
  return {
    async read(request) {
      const planResult = createRequestPlan({
        url: request.uri,
        method: 'GET',
        responseType: 'bytes',
        followRedirects: true,
        execution: { cookieJar: false },
        // 每次跳转也占用请求预算，5次跳转需要包含首个请求的6次预算。
        budget: { timeoutMs: 15_000, maxRequests: 6, maxPages: 1, maxResponseBytes: Math.min(request.maxBytes, MAX_RESPONSE_BYTES), maxTotalBytes: MAX_TOTAL_BYTES, maxRedirects: 5, ...(request.signal === undefined ? {} : { signal: request.signal }) },
      })
      if (planResult.plan === undefined) throw new Error(planResult.error?.message ?? '导入地址无效')
      const response = await network.request(planResult.plan)
      if (response.status < 200 || response.status >= 300) throw new Error(`导入链接返回 HTTP ${response.status}`)
      totalBytes += response.bytes.byteLength
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('导入内容超过总字节限制')
      return { text: new TextDecoder().decode(response.bytes), location: response.url }
    },
  }
}

export function previewWritableCandidates(preview: ImportPreview): ImportPreviewCandidate[] { return preview.candidates.filter((candidate) => candidate.disposition !== undefined) }
