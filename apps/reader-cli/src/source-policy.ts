import type { NormalizedSource } from '@legado/source-core'
import type { SourceEntry } from './source-catalog.ts'
import type { SourceHealthState, SourceStateRecord } from './storage-model.ts'

export const SOURCE_FAILURE_THRESHOLD = 3

export function sourceStateDefaults(source: NormalizedSource, fingerprint: string): SourceStateRecord {
  return {
    fingerprint,
    enabled: source.enabled !== false,
    enabledExplore: source.enabledExplore !== false,
    customOrder: integerField(source.customOrder, 0),
    weight: integerField(source.weight, 0),
    searchHealth: { fingerprint, consecutiveFailures: 0 },
  }
}

export function applySourceState(source: NormalizedSource, state: SourceStateRecord): NormalizedSource {
  return {
    ...source,
    enabled: state.enabled,
    enabledExplore: state.enabledExplore,
    customOrder: state.customOrder,
    weight: state.weight,
  }
}

export function orderedSearchSources(entries: readonly SourceEntry[], selectedIds?: readonly string[]): SourceEntry[] {
  const selected = selectedIds === undefined ? undefined : new Set(selectedIds)
  return entries
    .filter((entry) => entry.state === 'available' && (selected === undefined || selected.has(entry.id) || selected.has(entry.source.bookSourceUrl)))
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftDegraded = (left.entry.searchHealth?.consecutiveFailures ?? 0) >= SOURCE_FAILURE_THRESHOLD ? 1 : 0
      const rightDegraded = (right.entry.searchHealth?.consecutiveFailures ?? 0) >= SOURCE_FAILURE_THRESHOLD ? 1 : 0
      return leftDegraded - rightDegraded || (left.entry.customOrder ?? 0) - (right.entry.customOrder ?? 0) || left.index - right.index
    })
    .map(({ entry }) => entry)
}

export function nextSearchHealth(current: SourceHealthState, fingerprint: string, outcome: 'success' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'): SourceHealthState {
  if (current.fingerprint !== fingerprint) return { fingerprint, consecutiveFailures: outcome === 'failed' ? 1 : 0 }
  if (outcome === 'success' || outcome === 'partial' || outcome === 'empty') return { fingerprint, consecutiveFailures: 0 }
  if (outcome !== 'failed') return { ...current, fingerprint }
  return { fingerprint, consecutiveFailures: Math.min(SOURCE_FAILURE_THRESHOLD, current.consecutiveFailures + 1) }
}

function integerField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}
