import assert from 'node:assert/strict'
import test from 'node:test'
import type { BookCandidate } from '@legado/source-core'
import type { SearchResult } from '../src/application-model.ts'
import { filterSearchSnapshot, groupSearchResults, isAuthorMatch, isBookTitleMatch } from '../src/search-results.ts'

const source = { source: { bookSourceName: '测试书源' } } as SearchResult['source']

function result(name: string, author: string | undefined, arrivalIndex: number, sourceId = 'source-a'): SearchResult {
  return {
    candidate: { sourceId, bookUrl: `https://source.test/${arrivalIndex}`, name, ...(author === undefined ? {} : { author }), rawFields: {}, traceRef: `test:${arrivalIndex}` } as BookCandidate,
    source,
    searchId: 'search-1',
    arrivalIndex,
  }
}

test('搜索结果分组精确匹配优先，缺失作者不合并', () => {
  const sameBook = result('三体', '刘慈欣', 1)
  const sameBookFromAnotherSource = result(' 三体！', '刘慈欣', 2, 'source-b')
  const missingAuthor = result('三体', undefined, 3, 'source-c')
  const groups = groupSearchResults('三体', [missingAuthor, sameBookFromAnotherSource, sameBook])

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.candidates.length, 2)
  assert.equal(groups[0]?.candidate.bookUrl, sameBook.candidate.bookUrl)
  assert.equal(groups[1]?.candidate.bookUrl, missingAuthor.candidate.bookUrl)
})

test('严格换源匹配要求规范化后的书名和作者都非空', () => {
  assert.equal(isBookTitleMatch(' 三体！', '三体'), true)
  assert.equal(isBookTitleMatch('', '三体'), false)
  assert.equal(isAuthorMatch(' 刘慈欣 ', '刘慈欣'), true)
  assert.equal(isAuthorMatch(undefined, '刘慈欣'), false)

  const matching = result('三体', '刘慈欣', 1)
  const nonMatching = result('三体', '其他作者', 2, 'source-b')
  const snapshot = {
    searchId: 'search-1',
    keyword: '三体',
    results: [matching, nonMatching],
    sources: [{ source, status: 'success' as const, candidates: [matching, nonMatching], durationMs: 1 }],
    groups: groupSearchResults('三体', [matching, nonMatching]),
    elapsedMs: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
    cancelled: false,
  }
  const filtered = filterSearchSnapshot(snapshot, '三体', '刘慈欣')
  assert.deepEqual(filtered.results, [matching])
  assert.deepEqual(filtered.sources[0]?.candidates, [matching])
})
