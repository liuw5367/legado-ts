import assert from 'node:assert/strict'
import test from 'node:test'
import type { BookCandidate } from '../src/index.ts'
import { groupSearchCandidates, isAuthorMatch, isBookTitleMatch } from '../src/index.ts'

function item(name: string, author: string | undefined, sourceId: string, arrivalIndex: number) {
  return {
    candidate: {
      sourceId,
      bookUrl: `https://${sourceId}.test/${arrivalIndex}`,
      name,
      ...(author === undefined ? {} : { author }),
      rawFields: {},
      traceRef: `${sourceId}:${arrivalIndex}`,
    } as BookCandidate,
    arrivalIndex,
  }
}

test('跨源归并按规范化书名和作者，作者缺失时保留书源版本边界', () => {
  const first = item('三体', '刘慈欣', 'source-a', 1)
  const sameBook = item(' 三体！', '刘慈欣', 'source-b', 2)
  const missingAuthorA = item('三体', undefined, 'source-c', 3)
  const missingAuthorB = item('三体', undefined, 'source-d', 4)

  const groups = groupSearchCandidates('三体', [missingAuthorB, sameBook, missingAuthorA, first])
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0]?.candidates, [first, sameBook])
  assert.equal(groups[0]?.candidate, first.candidate)
  assert.deepEqual(groups.slice(1).map((group) => group.candidates), [[missingAuthorA], [missingAuthorB]])
})

test('相关性排序按 exact、contains、other 分组，并保持组内最早到达顺序', () => {
  const containsFirst = item('三体前传', '作者甲', 'source-a', 1)
  const exactLater = item('三体', '作者乙', 'source-b', 2)
  const containsLater = item('银河三体', '作者丙', 'source-c', 3)
  const exactEarlier = item('三体', '作者丁', 'source-d', 4)
  const other = item('银河', '作者戊', 'source-e', 5)

  const groups = groupSearchCandidates('三体', [containsFirst, exactLater, containsLater, exactEarlier, other])
  assert.deepEqual(groups.map((group) => group.first), [exactLater, exactEarlier, containsFirst, containsLater, other])
  assert.deepEqual(groups.map((group) => group.rank), ['exact', 'exact', 'contains', 'contains', 'other'])
})

test('精确标题和作者比较使用核心规范化规则，并拒绝空值', () => {
  assert.equal(isBookTitleMatch(' 三体！', '三体'), true)
  assert.equal(isBookTitleMatch('', '三体'), false)
  assert.equal(isAuthorMatch(' 刘慈欣 ', '刘慈欣'), true)
  assert.equal(isAuthorMatch(undefined, '刘慈欣'), false)
})
