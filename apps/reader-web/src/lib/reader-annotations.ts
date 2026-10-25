import { anchorFromViewport } from './reader-pagination.ts'
import { comparePoints, type MarkAnchor, type ReadingMark, type TextPoint } from '../../shared/reading-annotations.ts'
import { textFingerprint } from '../../shared/reading-text.ts'
export { textFingerprint }

export function paragraphTexts(root: HTMLElement): string[] { return [...root.querySelectorAll<HTMLElement>('[data-paragraph]')].map((p) => p.textContent ?? '') }
function absolutePoint(texts: string[], point: TextPoint) { return texts.slice(0, point.paragraphIndex).reduce((n, s) => n + s.length + 1, 0) + point.offset }
function pointAt(texts: string[], offset: number): TextPoint {
  for (let i = 0; i < texts.length; i++) { if (offset <= texts[i]!.length) return { paragraphIndex: i, offset }; offset -= texts[i]!.length + 1 }
  return { paragraphIndex: Math.max(0, texts.length - 1), offset: texts.at(-1)?.length ?? 0 }
}
export function createAnchor(texts: string[], start: TextPoint, end: TextPoint, hash: string): MarkAnchor {
  const text = texts.join('\n'); const from = absolutePoint(texts, start); const to = absolutePoint(texts, end)
  return { start, end, exact: text.slice(from, to), prefix: text.slice(Math.max(0, from - 32), from), suffix: text.slice(to, to + 32), contentHash: hash }
}
export function resolveAnchor(texts: string[], anchor: MarkAnchor, hash: string): MarkAnchor | null {
  const text = texts.join('\n'); const from = absolutePoint(texts, anchor.start); const to = absolutePoint(texts, anchor.end)
  if (anchor.contentHash === hash && text.slice(from, to) === anchor.exact) return anchor
  let position = text.indexOf(anchor.exact); const matches: number[] = []
  while (position >= 0) {
    if ((!anchor.prefix || text.slice(Math.max(0, position - anchor.prefix.length), position) === anchor.prefix) && (!anchor.suffix || text.slice(position + anchor.exact.length, position + anchor.exact.length + anchor.suffix.length) === anchor.suffix)) matches.push(position)
    position = text.indexOf(anchor.exact, position + 1)
  }
  if (matches.length !== 1) return null
  const index = matches[0]!
  return { ...anchor, start: pointAt(texts, index), end: pointAt(texts, index + anchor.exact.length), contentHash: hash }
}
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
export interface TextFragment { text: string; mark?: ReadingMark }
export function markedFragments(text: string, paragraphIndex: number, marks: ReadingMark[]): TextFragment[] {
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
/** 只在清洗过的 HTML 副本上添加标记，保留嵌套标签及 textContent 偏移。 */
export function markedHtml(html: string, marks: ReadingMark[]): string {
  if (!marks.length) return html
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html'); const root = doc.body.firstElementChild!
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; let node: Node | null
  while ((node = walker.nextNode())) nodes.push(node as Text)
  let offset = 0
  for (const node of nodes) {
    const text = node.data; const start = offset; offset += text.length
    const adjusted = marks.map((m) => ({ ...m, anchor: { ...m.anchor, start: { paragraphIndex: 0, offset: Math.max(0, m.anchor.start.offset - start) }, end: { paragraphIndex: 0, offset: Math.min(text.length, m.anchor.end.offset - start) } } })).filter((m) => m.anchor.end.offset > m.anchor.start.offset)
    const fragment = doc.createDocumentFragment()
    for (const part of markedFragments(text, 0, adjusted)) {
      if (!part.mark) fragment.append(doc.createTextNode(part.text))
      else { const span = doc.createElement('span'); span.className = 'reader-mark'; span.dataset.markId = part.mark.id; span.dataset.color = part.mark.color; span.setAttribute('role', 'button'); span.tabIndex = 0; span.setAttribute('aria-label', part.mark.note ? '编辑想法' : '编辑标记'); span.textContent = part.text; fragment.append(span) }
    }
    node.replaceWith(fragment)
  }
  return root.innerHTML
}

/** 滚动阅读按可视窗口查找首字；分页阅读沿用多列位置计算。 */
export function visibleTextPoint(root: HTMLElement, paged: boolean): TextPoint | undefined {
  if (paged) return anchorFromViewport(root)
  const top = 24; const bottom = window.innerHeight - 24
  const paragraph = [...root.querySelectorAll<HTMLElement>('[data-paragraph]')].find((p) => { const rect = p.getBoundingClientRect(); return rect.bottom > top && rect.top < bottom })
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
