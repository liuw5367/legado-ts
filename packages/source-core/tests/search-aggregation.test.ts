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

test('跨源归并按匹配组和原始书名作者，作者缺失也遵循 Android 的空值相等语义', () => {
  const first = item('三体', '刘慈欣', 'source-a', 1)
  const sameBook = item(' 三体！', '刘慈欣', 'source-b', 2)
  const missingAuthorA = item('三体', undefined, 'source-c', 3)
  const missingAuthorB = item('三体', undefined, 'source-d', 4)

  const groups = groupSearchCandidates('三体', [missingAuthorB, sameBook, missingAuthorA, first])
  assert.equal(groups.length, 3)
  assert.deepEqual(groups.find((group) => group.candidate === first.candidate)?.candidates, [first])
  assert.deepEqual(groups.find((group) => group.candidate === sameBook.candidate)?.candidates, [sameBook])
  assert.deepEqual(groups.find((group) => group.candidate === missingAuthorA.candidate)?.candidates, [missingAuthorA, missingAuthorB])
})

test('相关性排序按 exact、kind、contains、other 四组，并按来源数稳定排序', () => {
  const exactFirst = item('三体', '作者甲', 'source-a', 1)
  const exactMerged = item('三体', '作者甲', 'source-b', 2)
  const exactOther = item('三体', '作者乙', 'source-c', 3)
  const kindFirst = { ...item('银河', '作者丙', 'source-d', 4), candidate: { ...item('银河', '作者丙', 'source-d', 4).candidate, kind: '三体科幻' } }
  const kindMerged = { ...item('银河', '作者丙', 'source-e', 5), candidate: { ...item('银河', '作者丙', 'source-e', 5).candidate, kind: '三体科幻' } }
  const contains = item('银河三体', '作者丁', 'source-f', 6)
  const other = item('银河', '作者戊', 'source-g', 7)

  const groups = groupSearchCandidates('三体', [contains, exactOther, kindFirst, other, exactMerged, kindMerged, exactFirst])
  assert.deepEqual(groups.map((group) => group.rank), ['exact', 'exact', 'kind', 'contains', 'other'])
  assert.deepEqual(groups.map((group) => group.candidates.length), [2, 1, 2, 1, 1])
  assert.equal(groups[0]?.candidate, exactFirst.candidate)
  assert.equal(groups[2]?.candidate.name, '银河')
  assert.equal(groups[2]?.candidate.author, '作者丙')
})

test('precision 模式丢弃 other 组，严格换源比较仍使用独立规范化规则', () => {
  const exact = item('三体', '作者', 'source-a', 1)
  const kind = { ...item('银河', '作者', 'source-b', 2), candidate: { ...item('银河', '作者', 'source-b', 2).candidate, kind: '三体科幻' } }
  const other = item('银河', '作者', 'source-c', 3)
  const groups = groupSearchCandidates('三体', [other, kind, exact], true)
  assert.deepEqual(groups.map((group) => group.rank), ['exact', 'kind'])

  assert.equal(isBookTitleMatch(' 三体！', '三体'), true)
  assert.equal(isBookTitleMatch('', '三体'), false)
  assert.equal(isAuthorMatch(' 刘慈欣 ', '刘慈欣'), true)
  assert.equal(isAuthorMatch(undefined, '刘慈欣'), false)
})
