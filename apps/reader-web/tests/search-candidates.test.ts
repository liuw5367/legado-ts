import assert from 'node:assert/strict'
import test from 'node:test'
import type { BookCandidate } from '@legado/source-core'
import { acceptsPrecisionSearchFields, orderSearchCandidates } from '../server/runtime/search-candidates.ts'
import type { StoredCandidate } from '../server/domain/types.ts'

function stored(name: string, sourceId: string, author?: string, kind?: string): StoredCandidate {
  const candidate: BookCandidate = { sourceId, bookUrl: `https://books.example.test/${sourceId}/${name}`, name, ...(author === undefined ? {} : { author }), ...(kind === undefined ? {} : { kind }), rawFields: {}, traceRef: sourceId }
  return { sourceId, sourceFingerprint: `${sourceId}-fingerprint`, candidate }
}

test('precision field policy matches CLI name, author, or kind semantics', () => {
  assert.equal(acceptsPrecisionSearchFields('目标', { name: '目标书', author: '作者', kind: '分类' }), true)
  assert.equal(acceptsPrecisionSearchFields('目标', { name: '其他', author: '目标作者' }), true)
  assert.equal(acceptsPrecisionSearchFields('目标', { name: '其他', kind: '目标分类' }), true)
  assert.equal(acceptsPrecisionSearchFields('目标', { name: '其他', author: '作者', kind: '分类' }), false)
})

test('candidate ordering groups matches and precision drops other results without losing source identity', () => {
  const candidates = [stored('无关', 'source-a', '作者', '其他'), stored('目标书', 'source-b', '作者'), stored('目标书', 'source-a', '作者')]
  const ordered = orderSearchCandidates('目标', candidates)
  assert.deepEqual(ordered.map((item) => item.sourceId), ['source-b', 'source-a', 'source-a'])
  assert.deepEqual(orderSearchCandidates('目标', candidates, true).map((item) => item.sourceId), ['source-b', 'source-a'])
})
