export interface ViewportRange {
  start: number
  end: number
}

/** 让选中项始终落在列表视口内，并在 resize 后保留尽可能接近的锚点。 */
export function keepIndexVisible(index: number, total: number, visible: number, start: number): ViewportRange {
  const safeTotal = Math.max(0, total)
  const safeVisible = Math.max(1, visible)
  const maxStart = Math.max(0, safeTotal - safeVisible)
  const safeIndex = Math.max(0, Math.min(Math.max(0, safeTotal - 1), index))
  let nextStart = Math.max(0, Math.min(maxStart, start))
  if (safeIndex < nextStart) nextStart = safeIndex
  if (safeIndex >= nextStart + safeVisible) nextStart = safeIndex - safeVisible + 1
  return { start: nextStart, end: Math.min(safeTotal, nextStart + safeVisible) }
}

export function moveIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(total - 1, index + delta))
}

export function pageIndex(index: number, total: number, visible: number, direction: -1 | 1): number {
  return moveIndex(index, total, Math.max(1, visible - 1) * direction)
}

/**
 * Lists use the same page movement for PageUp/PageDown and the left/right
 * arrows. Keeping the alias here prevents individual pages from drifting.
 */
export function pageIndexForKey(
  index: number,
  total: number,
  visible: number,
  direction: 'previous' | 'next',
): number {
  return pageIndex(index, total, visible, direction === 'previous' ? -1 : 1)
}

export function viewportFor(index: number, total: number, visible: number, start: number): ViewportRange {
  return keepIndexVisible(index, total, visible, start)
}
