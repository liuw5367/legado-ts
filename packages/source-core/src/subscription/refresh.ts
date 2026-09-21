import { diagnostic } from '../diagnostics/diagnostics.ts'
import { importSources } from '../codec/import.ts'
import { stableJson, topLevelDiff } from '../codec/stable.ts'
import type { ImportLimits, NormalizedSource, SourceDiff, SubscriptionRefreshInput, SubscriptionRefreshPlan, SubscriptionSourceSnapshot } from '../model/types.ts'

const defaultLimits: ImportLimits = { maxCandidates: 1000, maxBytes: 4 * 1024 * 1024, maxSourceUrls: 32 }

function byId(items: readonly SubscriptionSourceSnapshot[]): Map<string, SubscriptionSourceSnapshot> {
  return new Map(items.map((item) => [item.sourceId, item]))
}

function compareOne(base: SubscriptionSourceSnapshot | undefined, remote: SubscriptionSourceSnapshot | undefined, local: SubscriptionSourceSnapshot | undefined): SourceDiff {
  if (remote === undefined && base !== undefined) return { sourceId: base.sourceId, kind: 'remote-missing', fields: [] }
  if (remote === undefined) return { sourceId: local?.sourceId ?? 'unknown', kind: 'remote-missing', fields: [] }
  if (base === undefined) return { sourceId: remote.sourceId, kind: 'added', fields: topLevelDiff({}, remote.source) }
  const remoteChanges = topLevelDiff(base.source, remote.source)
  const localChanges = local === undefined ? [] : topLevelDiff(base.source, local.source)
  if (remoteChanges.length === 0) return { sourceId: remote.sourceId, kind: 'unchanged', fields: [] }
  if (local === undefined || localChanges.length === 0) return { sourceId: remote.sourceId, kind: 'updated', fields: remoteChanges }
  const overlap = remoteChanges.filter((field) => localChanges.includes(field) && stableJson(remote.source[field]) !== stableJson(local.source[field]))
  if (overlap.length > 0) return { sourceId: remote.sourceId, kind: 'conflict', fields: [...new Set([...remoteChanges, ...localChanges])].sort() }
  return { sourceId: remote.sourceId, kind: 'updated', fields: [...new Set([...remoteChanges, ...localChanges])].sort() }
}

function planWith(remoteSources: readonly NormalizedSource[], input: SubscriptionRefreshInput): SubscriptionRefreshPlan {
  const baseline = byId(input.baseline)
  const local = byId(input.local)
  const remote = new Map<string, SubscriptionSourceSnapshot>()
  const diagnostics = []
  for (const source of remoteSources) {
    const sourceId = source.bookSourceUrl
    if (remote.has(sourceId)) diagnostics.push(diagnostic('duplicate-source-id', 'conflict', `远程源重复：${sourceId}`, { path: sourceId }))
    remote.set(sourceId, { sourceId, source })
  }
  const ids = new Set([...baseline.keys(), ...remote.keys(), ...local.keys()])
  const diffs = [...ids].map((sourceId) => compareOne(baseline.get(sourceId), remote.get(sourceId), local.get(sourceId))).sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  const hasConflict = diffs.some((item) => item.kind === 'conflict') || diagnostics.length > 0
  const changed = diffs.filter((item) => item.kind === 'added' || item.kind === 'updated').map((item) => item.sourceId)
  const expected = diffs.filter((item) => item.kind === 'added' || item.kind === 'updated' || item.kind === 'conflict').map((item) => item.sourceId)
  return {
    subscriptionId: input.subscriptionId,
    operationId: input.operationId,
    baseSubscriptionRevision: input.baseSubscriptionRevision,
    outcome: hasConflict ? 'conflict' : changed.length === 0 ? 'unchanged' : 'updated',
    diffs,
    commitPlan: {
      sourceIds: changed,
      expectedSourceRevisions: Object.fromEntries(expected.map((sourceId) => [sourceId, local.get(sourceId)?.sourceRevision])),
      requiresConfirmation: changed.length > 0 || hasConflict,
    },
    diagnostics,
  }
}

export async function refreshSubscription(input: SubscriptionRefreshInput): Promise<SubscriptionRefreshPlan> {
  if (input.signal?.aborted === true) return { subscriptionId: input.subscriptionId, operationId: input.operationId, baseSubscriptionRevision: input.baseSubscriptionRevision, outcome: 'cancelled', diffs: [], commitPlan: { sourceIds: [], expectedSourceRevisions: {}, requiresConfirmation: false }, diagnostics: [diagnostic('cancelled', 'fetch', '订阅刷新已取消', { retryable: true })] }
  if (input.remoteSources !== undefined) return planWith(input.remoteSources, input)
  if (input.url === undefined || input.reader === undefined) return { subscriptionId: input.subscriptionId, operationId: input.operationId, baseSubscriptionRevision: input.baseSubscriptionRevision, outcome: 'failed', diffs: [], commitPlan: { sourceIds: [], expectedSourceRevisions: {}, requiresConfirmation: false }, diagnostics: [diagnostic(input.url === undefined ? 'reader-missing' : 'reader-missing', 'fetch', '订阅刷新缺少 URL 或受控读取端口', { retryable: false })] }
  const importOptions = input.signal === undefined
    ? { reader: input.reader, limits: { ...defaultLimits, ...input.limits } }
    : { reader: input.reader, signal: input.signal, limits: { ...defaultLimits, ...input.limits } }
  const result = await importSources({ kind: 'uri', uri: input.url, origin: { kind: 'subscription', location: input.url } }, importOptions)
  const valid = result.filter((candidate) => candidate.source !== undefined && candidate.writable).map((candidate) => candidate.source as NormalizedSource)
  const diagnostics = result.flatMap((candidate) => candidate.diagnostics)
  if (valid.length === 0) return { subscriptionId: input.subscriptionId, operationId: input.operationId, baseSubscriptionRevision: input.baseSubscriptionRevision, outcome: input.signal?.aborted ? 'cancelled' : 'failed', diffs: [], commitPlan: { sourceIds: [], expectedSourceRevisions: {}, requiresConfirmation: false }, diagnostics }
  const plan = planWith(valid, input)
  return { ...plan, diagnostics: [...diagnostics, ...plan.diagnostics] }
}
