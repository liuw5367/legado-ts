export interface ViewportRange {
  start: number
  end: number
}

export interface TerminalLayout {
  bodyHeight: number
  separator: boolean
  supported: boolean
}

/** 保证不同状态不改变内容视口高度，并为不可用尺寸返回提示布局。 */
export function terminalLayout(columns: number, rows: number): TerminalLayout {
  const supported = columns >= 40 && rows >= 12
  const separator = supported && rows >= 18
  const fixedRows = 2 + Number(separator)
  return { bodyHeight: Math.max(1, rows - fixedRows), separator, supported }
}

/** 将正文视口首行限制在正文范围内，末页允许不足一个完整视口。 */
export function clampContentLine(line: number, totalLines: number, _pageHeight: number): number {
  const maxLine = Math.max(0, Math.max(0, totalLines) - 1)
  return Math.max(0, Math.min(maxLine, line))
}

/** 返回正文最后一页的首行；最后一页可以只有部分内容。 */
export function lastContentPageStart(totalLines: number, pageHeight: number): number {
  const total = Math.max(0, totalLines)
  if (total === 0) return 0
  const height = Math.max(1, pageHeight)
  return Math.floor((total - 1) / height) * height
}

/** 将任意正文行映射到它所在页的首行。 */
export function contentPageStart(line: number, totalLines: number, pageHeight: number): number {
  const total = Math.max(0, totalLines)
  if (total === 0) return 0
  const height = Math.max(1, pageHeight)
  const safeLine = clampContentLine(line, total, height)
  return Math.min(Math.floor(safeLine / height) * height, lastContentPageStart(total, height))
}

export function nextContentPageStart(line: number, totalLines: number, pageHeight: number): number {
  const height = Math.max(1, pageHeight)
  return Math.min(contentPageStart(line, totalLines, height) + height, lastContentPageStart(totalLines, height))
}

export function previousContentPageStart(line: number, totalLines: number, pageHeight: number): number {
  const height = Math.max(1, pageHeight)
  return Math.max(0, contentPageStart(line, totalLines, height) - height)
}

export function pagePosition(line: number, totalLines: number, pageHeight: number): { current: number; total: number } {
  const height = Math.max(1, pageHeight)
  const safeLine = contentPageStart(line, totalLines, height)
  const total = Math.max(1, Math.ceil(Math.max(0, totalLines) / height))
  return { current: Math.min(total, Math.ceil((safeLine + height) / height)), total }
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
