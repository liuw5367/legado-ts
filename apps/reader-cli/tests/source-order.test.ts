import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnownSourceView } from '../src/storage.ts'
import { orderSourceViews } from '../src/source-order.ts'

function source(editionKey: string, searchDurationMs?: number): KnownSourceView {
  return {
    editionKey,
    sourceId: `source-${editionKey}`,
    sourceFingerprint: `fingerprint-${editionKey}`,
    bookUrl: `https://example.test/${editionKey}`,
    rawFields: {},
    discoveredAt: '2026-01-01T00:00:00.000Z',
    matchKind: 'title-only',
    state: 'available',
    ...(searchDurationMs === undefined ? {} : { searchDurationMs }),
  }
}

test('当前书源置顶，其余书源按搜索耗时升序且稳定排序', () => {
  const result = orderSourceViews([
    source('slow', 800),
    source('unknown'),
    source('fast', 120),
    source('same-a', 120),
    source('current', 900),
    source('same-b', 120),
  ], 'current')
  assert.deepEqual(result.map((item) => item.editionKey), ['current', 'fast', 'same-a', 'same-b', 'slow', 'unknown'])
})

test('无效搜索耗时不会排在有效耗时之前', () => {
  const result = orderSourceViews([source('invalid', -1), source('valid', 0), source('nan', Number.NaN)], undefined)
  assert.deepEqual(result.map((item) => item.editionKey), ['valid', 'invalid', 'nan'])
})
