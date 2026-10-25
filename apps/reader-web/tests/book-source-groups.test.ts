import assert from 'node:assert/strict'
import test from 'node:test'
import { groupBookSourcesByDomain } from '../src/lib/book-source-groups.ts'
import type { BookSourceItem } from '../shared/book-sources.ts'
import type { ManagedSourceSummary } from '../shared/source-management.ts'

function managedSource(sourceId: string, enabled: boolean, customOrder: number): ManagedSourceSummary {
  return { sourceId, name: sourceId, fingerprint: 'fingerprint', enabled, customOrder, sourceRevision: 'revision', origin: 'account' }
}

test('book source groups include every implementation for domains represented by search results', () => {
  const managedSources = [
    managedSource('https://book.example/current', true, 1),
    managedSource('https://book.example/alternate', false, 2),
    managedSource('https://search.example/current', true, 1),
    managedSource('https://search.example/alternate', false, 2),
    managedSource('https://unrelated.example/source', true, 1),
  ]
  const bookSources: BookSourceItem[] = [{ sourceId: 'https://book.example/current', sourceFingerprint: 'fingerprint', name: '本书来源', bookUrl: 'https://book.example/book', sourceEnabled: true, status: 'saved', editionKey: 'edition' }]
  const groups = groupBookSourcesByDomain(managedSources, bookSources, [{ sourceId: 'https://search.example/current', index: 7, item: { bookUrl: 'https://search.example/book' } }])
  const searchGroup = groups.find((group) => group.domain === 'search.example')

  assert.deepEqual(groups.map((group) => group.domain), ['book.example', 'search.example'])
  assert.deepEqual(searchGroup?.versions.map((version) => [version.source.sourceId, version.isAccountDefault, version.searchResults.map((result) => [result.index, result.item.bookUrl])]), [
    ['https://search.example/current', true, [[7, 'https://search.example/book']]],
    ['https://search.example/alternate', false, []],
  ])
})

test('current book source stays first while other domains and implementations follow live duration', () => {
  const managedSources = [
    managedSource('https://slow.example/default', true, 0),
    managedSource('https://fast.example/default', true, 1),
    managedSource('https://current.example/default', true, 2),
    managedSource('https://current.example/active', false, 3),
    managedSource('https://current.example/slow', false, 4),
    managedSource('https://current.example/fast', false, 5),
    managedSource('https://unknown.example/default', true, 6),
  ]
  const bookSources: BookSourceItem[] = [
    { sourceId: 'https://current.example/active', sourceFingerprint: 'fingerprint', name: '当前实现', bookUrl: '/book', sourceEnabled: false, status: 'saved', editionKey: 'active', searchDurationMs: 200 },
    { sourceId: 'https://unknown.example/default', sourceFingerprint: 'fingerprint', name: '未知耗时', bookUrl: '/book', sourceEnabled: true, status: 'saved', editionKey: 'other' },
  ]
  const results = [
    { sourceId: 'https://slow.example/default', index: 0, searchDurationMs: 100 },
    { sourceId: 'https://fast.example/default', index: 1, searchDurationMs: 0 },
    { sourceId: 'https://current.example/active', index: 2, searchDurationMs: 300 },
    { sourceId: 'https://current.example/slow', index: 3, searchDurationMs: 70 },
    { sourceId: 'https://current.example/fast', index: 4, searchDurationMs: 20 },
  ]
  const groups = groupBookSourcesByDomain(managedSources, bookSources, results, 'active')
  assert.deepEqual(groups.map((group) => group.domain), ['current.example', 'fast.example', 'slow.example', 'unknown.example'])
  assert.deepEqual(groups[0]?.versions.map((version) => version.source.sourceId), [
    'https://current.example/active', 'https://current.example/fast', 'https://current.example/slow', 'https://current.example/default',
  ])
  assert.equal(groups[0]?.versions[0]?.searchDurationMs, 300, 'live timing replaces cached timing')
  assert.equal(groups[0]?.versions[0]?.isCurrentBookEdition, true)
  assert.equal(groups[1]?.versions[0]?.searchDurationMs, 0)
})
