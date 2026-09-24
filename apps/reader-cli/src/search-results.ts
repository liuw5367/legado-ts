import { groupSearchCandidates, isAuthorMatch, isBookTitleMatch, normalizeSearchAuthor, searchMatchRank } from '@legado/source-core'
import type { SearchMatchRank } from '@legado/source-core'
import type { SearchOperationResult, SearchResult, SearchResultGroup } from './application-model.ts'

export { isAuthorMatch, isBookTitleMatch, searchMatchRank }
export const normalizeAuthor = normalizeSearchAuthor

export function groupSearchResults(keyword: string, results: readonly SearchResult[]): SearchResultGroup[] {
  return groupSearchCandidates(keyword, results).map((group) => ({
    key: group.key,
    candidate: group.candidate,
    source: group.first.source,
    candidates: group.candidates,
    rank: group.rank,
    firstArrivalIndex: group.firstArrivalIndex,
  }))
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
