import { searchMatchRank } from '@legado/source-core'
import type { SearchCandidateFields } from '@legado/source-core'

/** 与 CLI 相同的搜索阶段早期过滤，只依赖书名、作者和分类字段。 */
export function acceptsPrecisionSearchFields(keyword: string, fields: SearchCandidateFields): boolean {
  return fields.name.includes(keyword) || fields.author?.includes(keyword) === true || fields.kind?.includes(keyword) === true
}

/** 匹配等级和来源数沿用核心归并规则，来源数只计算一次，避免排序比较器重复构造大 Set。 */
export function orderSearchCandidates<T extends { sourceId: string; sourceOrder?: number; candidate: { sourceId: string; bookUrl: string; name?: string; author?: string; kind?: string } }>(keyword: string, candidates: readonly T[], precision = false, sourceRank?: ReadonlyMap<string, number>): T[] {
  const groups = new Map<string, { rank: number; first: number; sources: Set<string>; candidates: T[] }>()
  const ranks = { exact: 0, kind: 1, contains: 2, other: 3 }
  let index = 0
  for (const stored of candidates) {
    const candidate = stored.candidate
    const rank = searchMatchRank(keyword, candidate.name, candidate.author, candidate.kind)
    if (precision && rank === 'other') continue
    const key = JSON.stringify([rank, candidate.name ?? null, candidate.author ?? null])
    const group = groups.get(key) ?? { rank: ranks[rank], first: sourceRank?.get(stored.sourceId) ?? stored.sourceOrder ?? index, sources: new Set<string>(), candidates: [] }
    group.candidates.push(stored); group.sources.add(stored.sourceId)
    group.first = Math.min(group.first, sourceRank?.get(stored.sourceId) ?? stored.sourceOrder ?? index)
    groups.set(key, group); index++
  }
  if (sourceRank || candidates.some((candidate) => candidate.sourceOrder !== undefined)) for (const group of groups.values()) group.candidates.sort((left, right) => (sourceRank?.get(left.sourceId) ?? left.sourceOrder ?? 0) - (sourceRank?.get(right.sourceId) ?? right.sourceOrder ?? 0) || left.candidate.bookUrl.localeCompare(right.candidate.bookUrl))
  return [...groups.values()].sort((left, right) => left.rank - right.rank || right.sources.size - left.sources.size || left.first - right.first).flatMap((group) => group.candidates)
}
