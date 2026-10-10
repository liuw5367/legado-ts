import type { ApiCandidate } from './api.ts'

/** 选择属于候选身份，不能绑定流式排序中不断变化的数组下标。 */
export function candidateSelectionKey(item: ApiCandidate): string {
  return JSON.stringify([item.sourceId, item.sourceFingerprint, item.candidate.bookUrl])
}

export function selectedCandidateIndex(items: Array<{ item: ApiCandidate; index: number }>, selection: string | undefined): number | undefined {
  return items.find(({ item }) => candidateSelectionKey(item) === selection)?.index ?? items[0]?.index
}
