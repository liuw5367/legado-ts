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
