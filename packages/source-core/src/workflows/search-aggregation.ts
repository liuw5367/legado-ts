import type { BookCandidate } from './types.ts'

export type SearchMatchRank = 'exact' | 'kind' | 'contains' | 'other'

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

/** 按 Android SearchModel 的四组规则归并跨源候选；precision 为 true 时丢弃 other 组。 */
export function groupSearchCandidates<T extends SearchAggregationItem>(keyword: string, results: readonly T[], precision = false): SearchAggregationGroup<T>[] {
  const groups = new Map<string, SearchAggregationGroup<T>>()
  for (const result of [...results].sort((left, right) => left.arrivalIndex - right.arrivalIndex)) {
    const rank = searchMatchRank(keyword, result.candidate.name, result.candidate.author, result.candidate.kind)
    if (precision && rank === 'other') continue
    const key = searchGroupKey(rank, result.candidate.name, result.candidate.author)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        candidate: result.candidate,
        first: result,
        candidates: [result],
        rank,
        firstArrivalIndex: result.arrivalIndex,
      })
    } else existing.candidates.push(result)
  }
  return [...groups.values()].sort((left, right) => rankValue(left.rank) - rankValue(right.rank) || right.candidates.length - left.candidates.length || left.firstArrivalIndex - right.firstArrivalIndex)
}

export function searchMatchRank(keyword: string, name: string | undefined, author?: string, kind?: string): SearchMatchRank {
  if (keyword.length > 0 && (name === keyword || author === keyword)) return 'exact'
  if (keyword.length > 0 && kind?.includes(keyword) === true) return 'kind'
  if (keyword.length > 0 && (name?.includes(keyword) === true || author?.includes(keyword) === true)) return 'contains'
  return 'other'
}

function searchGroupKey(rank: SearchMatchRank, name: string | undefined, author: string | undefined): string {
  return JSON.stringify([rank, name ?? null, author ?? null])
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
  return rank === 'exact' ? 0 : rank === 'kind' ? 1 : rank === 'contains' ? 2 : 3
}
