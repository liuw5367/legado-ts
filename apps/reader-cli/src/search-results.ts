import type { SearchMatchRank, SearchOperationResult, SearchResult, SearchResultGroup } from './application-model.ts'

export function groupSearchResults(keyword: string, results: readonly SearchResult[]): SearchResultGroup[] {
  const groups = new Map<string, SearchResultGroup>()
  for (const result of [...results].sort((left, right) => left.arrivalIndex - right.arrivalIndex)) {
    const title = normalizeTitle(result.candidate.name)
    const author = normalizeAuthor(result.candidate.author)
    // 作者缺失时只在同一书源同一 URL 内折叠，避免同名书被错误合并。
    const key = title.length > 0 && author.length > 0 ? `title-author:${title}\u0000${author}` : `edition:${result.candidate.sourceId}\u0000${result.candidate.bookUrl}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        candidate: result.candidate,
        source: result.source,
        candidates: [result],
        rank: searchMatchRank(keyword, result.candidate.name),
        firstArrivalIndex: result.arrivalIndex,
      })
      continue
    }
    existing.candidates.push(result)
  }
  return [...groups.values()].sort((left, right) => matchRankValue(left.rank) - matchRankValue(right.rank) || left.firstArrivalIndex - right.firstArrivalIndex)
}

export function searchMatchRank(keyword: string, name: string | undefined): SearchMatchRank {
  const expected = normalizeTitle(keyword)
  const actual = normalizeTitle(name)
  if (expected.length > 0 && actual === expected) return 'exact'
  if (expected.length > 0 && actual.includes(expected)) return 'contains'
  return 'other'
}

export function searchMatchRankLabel(rank: SearchMatchRank): string {
  return rank === 'exact' ? '完全匹配' : rank === 'contains' ? '包含关键词' : '其他'
}

export function filterSearchSnapshot(snapshot: SearchOperationResult, expectedTitle: string, expectedAuthor: string | undefined): SearchOperationResult {
  const results = snapshot.results.filter((item) => isBookTitleMatch(item.candidate.name, expectedTitle) && isAuthorMatch(item.candidate.author, expectedAuthor))
  const allowed = new Set(results)
  const sources = snapshot.sources.map((item) => ({ ...item, candidates: item.candidates.filter((candidate) => allowed.has(candidate)) }))
  return { ...snapshot, results, sources, groups: groupSearchResults(expectedTitle, results) }
}

function matchRankValue(rank: SearchMatchRank): number {
  return rank === 'exact' ? 0 : rank === 'contains' ? 1 : 2
}

function normalizeTitle(value: string | undefined): string {
  // Search identity ignores punctuation and spacing so full-width and half-width
  // forms can contribute candidates to one logical book without merging books.
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function isBookTitleMatch(candidate: string | undefined, expected: string | undefined): boolean {
  const left = normalizeTitle(candidate)
  const right = normalizeTitle(expected)
  return left.length > 0 && right.length > 0 && left === right
}

export function isAuthorMatch(candidate: string | undefined, expected: string | undefined): boolean {
  const left = normalizeAuthor(candidate)
  const right = normalizeAuthor(expected)
  return left.length > 0 && right.length > 0 && left === right
}

export function normalizeAuthor(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/\s+/gu, '')
}
