import { anchorFromViewport } from './reader-pagination.ts'
import { comparePoints, type MarkAnchor, type ReadingMarkSummary, type TextPoint } from '../../shared/reading-annotations.ts'
import { textFingerprint } from '../../shared/reading-text.ts'
export { textFingerprint }

export function paragraphTexts(root: HTMLElement): string[] { return [...root.querySelectorAll<HTMLElement>('[data-paragraph]')].map((p) => p.textContent ?? '') }
export { createAnchor, resolveAnchor } from '../../shared/reading-text.ts'
import { createAnchor } from '../../shared/reading-text.ts'
function boundaryPoint(root: HTMLElement, node: Node, offset: number): TextPoint | null {
  const element = node instanceof Element ? node : node.parentElement
  const paragraph = element?.closest<HTMLElement>('[data-paragraph]')
  if (!paragraph || !root.contains(paragraph)) return null
  const range = document.createRange(); range.selectNodeContents(paragraph); range.setEnd(node, offset)
  return { paragraphIndex: Number(paragraph.dataset.paragraph), offset: range.toString().length }
}
export function selectedAnchor(root: HTMLElement, hash: string): { anchor: MarkAnchor; rect: DOMRect } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = boundaryPoint(root, range.startContainer, range.startOffset); const end = boundaryPoint(root, range.endContainer, range.endOffset)
  if (!start || !end || comparePoints(start, end) >= 0) return null
  const anchor = createAnchor(paragraphTexts(root), start, end, hash)
  if (!anchor.exact.trim()) return null
  return { anchor, rect: range.getBoundingClientRect() }
}
export function rangeForAnchor(root: HTMLElement, anchor: MarkAnchor): Range | null {
  function boundary(point: TextPoint): { node: Node; offset: number } | null {
    const p = root.querySelector<HTMLElement>(`[data-paragraph="${point.paragraphIndex}"]`)
    if (!p) return null
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let node: Node | null; let remaining = point.offset
    while ((node = walker.nextNode())) { const length = node.textContent?.length ?? 0; if (remaining <= length) return { node, offset: remaining }; remaining -= length }
    return null
  }
  const a = boundary(anchor.start); const b = boundary(anchor.end)
  if (!a || !b) return null
  const range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); return range
}
export interface TextFragment { text: string; mark?: Pick<ReadingMarkSummary, 'id' | 'color' | 'anchor' | 'note'> }
export function markedFragments(text: string, paragraphIndex: number, marks: Pick<ReadingMarkSummary, 'id' | 'color' | 'anchor' | 'note'>[]): TextFragment[] {
  const ranges = marks.flatMap((mark) => {
    const { start, end } = mark.anchor
    if (paragraphIndex < start.paragraphIndex || paragraphIndex > end.paragraphIndex) return []
    const from = start.paragraphIndex === paragraphIndex ? start.offset : 0; const to = end.paragraphIndex === paragraphIndex ? end.offset : text.length
    return to > from ? [{ from, to, mark }] : []
  }).sort((a, b) => a.from - b.from)
  const result: TextFragment[] = []; let offset = 0
  for (const range of ranges) { if (range.from < offset) continue; if (range.from > offset) result.push({ text: text.slice(offset, range.from) }); result.push({ text: text.slice(range.from, range.to), mark: range.mark }); offset = range.to }
  if (offset < text.length) result.push({ text: text.slice(offset) })
  return result
}
/** 滚动阅读按可视窗口查找首字；分页阅读沿用多列位置计算。 */
export function visibleTextPoint(root: HTMLElement, paged: boolean): TextPoint | undefined {
  if (paged) return anchorFromViewport(root, true)
  const top = 24; const bottom = window.innerHeight - 24
  const paragraph = [...root.querySelectorAll<HTMLElement>('[data-paragraph]')].find((p) => { if (!p.textContent?.trim()) return false; const rect = p.getBoundingClientRect(); return rect.bottom > top && rect.top < bottom })
  if (!paragraph) return undefined
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT); const range = document.createRange(); let node: Node | null; let offset = 0
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0
    let low = 0; let high = length
    while (low < high) { const mid = Math.floor((low + high) / 2); range.setStart(node, mid); range.setEnd(node, mid + 1); if (range.getBoundingClientRect().bottom <= top) low = mid + 1; else high = mid }
    if (low < length) { range.setStart(node, low); range.setEnd(node, low + 1); const rect = range.getBoundingClientRect(); if (rect.bottom > top && rect.top < bottom) return { paragraphIndex: Number(paragraph.dataset.paragraph), offset: offset + low } }
    offset += length
  }
  return undefined
}
