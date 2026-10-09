import { groupSearchCandidates } from '@legado/source-core'
import type { SearchCandidateFields } from '@legado/source-core'
import type { StoredCandidate } from '../domain/types.ts'

/** 与 CLI 相同的搜索阶段早期过滤，只依赖书名、作者和分类字段。 */
export function acceptsPrecisionSearchFields(keyword: string, fields: SearchCandidateFields): boolean {
  return fields.name.includes(keyword) || fields.author?.includes(keyword) === true || fields.kind?.includes(keyword) === true
}

/** 保留每个书源候选的稳定身份，但按核心的匹配等级和跨源分组顺序展平。 */
export function orderSearchCandidates(keyword: string, candidates: readonly StoredCandidate[], precision = false): StoredCandidate[] {
  const indexed = candidates.map((stored, arrivalIndex) => ({ stored, candidate: stored.candidate, arrivalIndex }))
  return groupSearchCandidates(keyword, indexed, precision).flatMap((group) => group.candidates.map((item) => item.stored))
}
