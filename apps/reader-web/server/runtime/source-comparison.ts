import type { ImportCandidate, NormalizedSource } from '@legado/source-core'
import type { ImportPreviewCandidate } from '../../shared/source-management.ts'
import type { StoredSourceRecord } from '../db/repository.ts'

export interface LocalSourceForComparison {
  source: StoredSourceRecord
  sourceRevision: string
  deleted?: boolean
}

const ignoredFields = new Set(['enabled', 'enabledExplore', 'customOrder', 'weight', 'lastUpdateTime', 'respondTime'])

export function sourceContentKey(source: Record<string, unknown>): string {
  return JSON.stringify(canonical(Object.fromEntries(Object.entries(source).filter(([key]) => !ignoredFields.has(key)))))
}

export function sourceUpdateTime(source: Record<string, unknown>): number | undefined {
  const value = source.lastUpdateTime
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function compareImportCandidates(candidates: ImportCandidate[], localById: Map<string, LocalSourceForComparison>): ImportPreviewCandidate[] {
  const result: ImportPreviewCandidate[] = []
  const valid = new Map<string, Array<{ candidate: ImportCandidate; source: NormalizedSource }>>()
  for (const candidate of candidates) {
    if (candidate.source === undefined || !candidate.writable) {
      result.push(toPreviewCandidate(candidate, undefined, 'invalid', diagnosticMessage(candidate)))
      continue
    }
    const sourceType = candidate.source.bookSourceType
    if (sourceType !== undefined && sourceType !== 0) {
      result.push(toPreviewCandidate(candidate, undefined, 'unsupported', '仅支持正文书源'))
      continue
    }
    const values = valid.get(candidate.source.bookSourceUrl) ?? []
    values.push({ candidate, source: candidate.source })
    valid.set(candidate.source.bookSourceUrl, values)
  }
  for (const [sourceId, values] of valid) {
    const chosen = chooseBatchCandidate(values, result)
    if (chosen === undefined) continue
    const local = localById.get(sourceId)
    const remoteKey = sourceContentKey(chosen.source)
    const remoteTime = sourceUpdateTime(chosen.source)
    if (local === undefined) {
      result.push(toPreviewCandidate(chosen.candidate, 'new', '可导入'))
      continue
    }
    const localKey = sourceContentKey(local.source.normalizedSource)
    const localTime = sourceUpdateTime(local.source.normalizedSource)
    const base = toPreviewCandidate(chosen.candidate, undefined, 'same-version', '')
    base.sourceRevision = local.sourceRevision
    if (remoteKey === localKey) {
      if (local.deleted === true) { base.disposition = 'restore'; base.reason = '书源已删除，内容相同，可恢复' }
      else { base.skippedReason = 'same-version'; base.reason = '内容相同，跳过' }
    } else if (remoteTime !== undefined && localTime !== undefined && remoteTime < localTime) {
      base.skippedReason = 'old-version'; base.reason = '远端版本较旧，跳过'; if (localTime !== undefined) base.localLastUpdateTime = localTime
    } else if (remoteTime !== undefined && localTime !== undefined && remoteTime > localTime) {
      base.disposition = 'update'; base.reason = '远端版本较新，可更新'; if (localTime !== undefined) base.localLastUpdateTime = localTime
    } else {
      base.skippedReason = 'conflict'; base.reason = '内容不同但无法安全判断版本'; if (localTime !== undefined) base.localLastUpdateTime = localTime
    }
    result.push(base)
  }
  return result
}

function chooseBatchCandidate(values: Array<{ candidate: ImportCandidate; source: NormalizedSource }>, output: ImportPreviewCandidate[]): { candidate: ImportCandidate; source: NormalizedSource } | undefined {
  if (values.length === 1) return values[0]
  const byKey = new Map(values.map((value) => [sourceContentKey(value.source), value]))
  if (byKey.size === 1) {
    const first = values[0]
    if (first === undefined) return undefined
    for (const duplicate of values.slice(1)) output.push(toPreviewCandidate(duplicate.candidate, undefined, 'duplicate', '同一批次中重复，保留首项'))
    return first
  }
  const times = values.map((value) => sourceUpdateTime(value.source))
  if (times.some((time) => time === undefined)) {
    for (const value of values) output.push(toPreviewCandidate(value.candidate, undefined, 'conflict', '同一 URL 包含多个无法排序的版本'))
    return undefined
  }
  const max = Math.max(...times as number[])
  const latest = values.filter((value) => sourceUpdateTime(value.source) === max)
  if (latest.length !== 1) {
    for (const value of values) output.push(toPreviewCandidate(value.candidate, undefined, 'conflict', '同一 URL 的最高版本时间相同但内容不同'))
    return undefined
  }
  const selected = latest[0]
  if (selected === undefined) return undefined
  for (const value of values) if (value !== selected) output.push(toPreviewCandidate(value.candidate, undefined, 'duplicate', '同一 URL 的较旧重复版本'))
  return selected
}

function toPreviewCandidate(candidate: ImportCandidate, disposition: ImportPreviewCandidate['disposition'], reasonOrCode: string, maybeReason?: string): ImportPreviewCandidate {
  const source = candidate.source
  const normalized = (source ?? {}) as Record<string, unknown>
  const sourceId = typeof normalized.bookSourceUrl === 'string' ? normalized.bookSourceUrl : `invalid:${candidate.id}`
  const name = typeof normalized.bookSourceName === 'string' && normalized.bookSourceName.length > 0 ? normalized.bookSourceName : sourceId
  const group = typeof normalized.bookSourceGroup === 'string' ? normalized.bookSourceGroup : undefined
  const reason = maybeReason ?? reasonOrCode
  const reasonCode = maybeReason === undefined ? undefined : reasonOrCode as ImportPreviewCandidate['skippedReason']
  const value: ImportPreviewCandidate = { id: candidate.id, sourceId, name, ...(group === undefined ? {} : { group }), fingerprint: candidate.sourceFingerprint ?? '', normalizedSource: normalized, rawSource: candidate.raw.parsed ?? normalized, reason }
  const time = sourceUpdateTime(normalized)
  if (time !== undefined) value.lastUpdateTime = time
  if (disposition !== undefined) value.disposition = disposition
  else if (reasonCode !== undefined) value.skippedReason = reasonCode
  return value
}

function diagnosticMessage(candidate: ImportCandidate): string { return candidate.error?.message ?? candidate.diagnostics[0]?.message ?? '书源格式无效' }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]))
  return value
}
