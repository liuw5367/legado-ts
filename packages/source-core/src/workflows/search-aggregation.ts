import type { BookCandidate } from './types.ts'

export type SearchMatchRank = 'exact' | 'contains' | 'other'

export interface SearchAggregationItem {
  candidate: BookCandidate
  /** 多源搜索中候选到达应用的顺序，用于稳定排序。 */
  arrivalIndex: number
}

export interface SearchAggregationGroup<T extends SearchAggregationItem> {
  key: string
  candidate: BookCandidate
  first: T
  candidates: T[]
  rank: SearchMatchRank
  firstArrivalIndex: number
}

/** 按 CLI 当前行为归并跨源候选；缺少作者时仅在同一来源、同一 URL 内归并。 */
export function groupSearchCandidates<T extends SearchAggregationItem>(keyword: string, results: readonly T[]): SearchAggregationGroup<T>[] {
  const groups = new Map<string, SearchAggregationGroup<T>>()
  for (const result of [...results].sort((left, right) => left.arrivalIndex - right.arrivalIndex)) {
    const title = normalizeSearchTitle(result.candidate.name)
    const author = normalizeSearchAuthor(result.candidate.author)
    const key = title.length > 0 && author.length > 0
      ? `title-author:${title}\u0000${author}`
      : `edition:${result.candidate.sourceId}\u0000${result.candidate.bookUrl}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        candidate: result.candidate,
        first: result,
        candidates: [result],
        rank: searchMatchRank(keyword, result.candidate.name),
        firstArrivalIndex: result.arrivalIndex,
      })
    } else existing.candidates.push(result)
  }
  return [...groups.values()].sort((left, right) => rankValue(left.rank) - rankValue(right.rank) || left.firstArrivalIndex - right.firstArrivalIndex)
}

export function searchMatchRank(keyword: string, name: string | undefined): SearchMatchRank {
  const expected = normalizeSearchTitle(keyword)
  const actual = normalizeSearchTitle(name)
  if (expected.length > 0 && actual === expected) return 'exact'
  if (expected.length > 0 && actual.includes(expected)) return 'contains'
  return 'other'
}

export function normalizeSearchTitle(value: string | undefined): string {
  // 标题身份忽略标点和空白，使全半角差异不影响同书归并。
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function normalizeSearchAuthor(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/\s+/gu, '')
}

export function isBookTitleMatch(candidate: string | undefined, expected: string | undefined): boolean {
  const left = normalizeSearchTitle(candidate)
  const right = normalizeSearchTitle(expected)
  return left.length > 0 && right.length > 0 && left === right
}

export function isAuthorMatch(candidate: string | undefined, expected: string | undefined): boolean {
  const left = normalizeSearchAuthor(candidate)
  const right = normalizeSearchAuthor(expected)
  return left.length > 0 && right.length > 0 && left === right
}

function rankValue(rank: SearchMatchRank): number {
  return rank === 'exact' ? 0 : rank === 'contains' ? 1 : 2
}
