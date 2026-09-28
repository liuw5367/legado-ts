import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSearchHealth, orderedSearchSources, SOURCE_FAILURE_THRESHOLD } from '../src/source-policy.ts'
import type { SourceEntry } from '../src/source-catalog.ts'

function entry(id: string, customOrder: number, consecutiveFailures = 0): SourceEntry {
  return {
    id,
    source: { bookSourceUrl: `https://${id}.test`, bookSourceName: id, bookSourceType: 0, enabled: true },
    candidate: {} as SourceEntry['candidate'],
    fingerprint: `fingerprint-${id}`,
    state: 'available',
    customOrder,
    searchHealth: { fingerprint: `fingerprint-${id}`, consecutiveFailures },
  }
}

test('连续失败书源延后，优先级和原始顺序仍稳定', () => {
  const entries = [entry('degraded', -100, SOURCE_FAILURE_THRESHOLD), entry('later', 2), entry('first', 1)]
  assert.deepEqual(orderedSearchSources(entries).map((item) => item.id), ['first', 'later', 'degraded'])
  assert.deepEqual(orderedSearchSources(entries, ['degraded', 'first']).map((item) => item.id), ['first', 'degraded'])
})

test('搜索健康状态只累计失败，成功或新指纹会清零', () => {
  const current = { fingerprint: 'fingerprint-a', consecutiveFailures: 2 }
  assert.deepEqual(nextSearchHealth(current, 'fingerprint-a', 'failed'), { fingerprint: 'fingerprint-a', consecutiveFailures: 3 })
  assert.deepEqual(nextSearchHealth({ ...current, consecutiveFailures: 3 }, 'fingerprint-a', 'failed'), { fingerprint: 'fingerprint-a', consecutiveFailures: 3 })
  assert.deepEqual(nextSearchHealth({ ...current, consecutiveFailures: 3 }, 'fingerprint-a', 'success'), { fingerprint: 'fingerprint-a', consecutiveFailures: 0 })
  assert.deepEqual(nextSearchHealth({ ...current, consecutiveFailures: 3 }, 'fingerprint-b', 'failed'), { fingerprint: 'fingerprint-b', consecutiveFailures: 1 })
})
