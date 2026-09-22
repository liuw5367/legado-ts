import type { KnownSourceView } from './storage.ts'

/**
 * 当前书源固定置顶；其余书源按本次搜索耗时升序排列，缺少耗时的记录放在最后。
 * 原始索引用于保证耗时相同或都未知时的稳定顺序。
 */
export function orderSourceViews(items: readonly KnownSourceView[], activeEditionKey: string | undefined): KnownSourceView[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const currentOrder = Number(right.item.editionKey === activeEditionKey) - Number(left.item.editionKey === activeEditionKey)
      if (currentOrder !== 0) return currentOrder
      const leftDuration = durationValue(left.item)
      const rightDuration = durationValue(right.item)
      if (leftDuration === rightDuration) return left.index - right.index
      if (!Number.isFinite(leftDuration)) return 1
      if (!Number.isFinite(rightDuration)) return -1
      return leftDuration - rightDuration
    })
    .map(({ item }) => item)
}

function durationValue(item: KnownSourceView): number {
  return item.searchDurationMs !== undefined && Number.isFinite(item.searchDurationMs) && item.searchDurationMs >= 0
    ? item.searchDurationMs
    : Number.POSITIVE_INFINITY
}
