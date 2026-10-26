import { comparePoints, type CachedChapter, type MarkAnchor, type TextPoint } from './reading-annotations.ts'
/** 文本版本标识只用于检测正文变化，不用于安全或授权。 */
export function textFingerprint(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return value.length + ':' + (hash >>> 0).toString(16)
}

function absolutePoint(texts: string[], point: TextPoint) { return texts.slice(0, point.paragraphIndex).reduce((n, s) => n + s.length + 1, 0) + point.offset }
function pointAt(texts: string[], offset: number): TextPoint {
  for (let i = 0; i < texts.length; i++) { if (offset <= texts[i]!.length) return { paragraphIndex: i, offset }; offset -= texts[i]!.length + 1 }
  return { paragraphIndex: Math.max(0, texts.length - 1), offset: texts.at(-1)?.length ?? 0 }
}
export function createAnchor(texts: string[], start: TextPoint, end: TextPoint, hash: string): MarkAnchor {
  const text = texts.join('\n'); const from = absolutePoint(texts, start); const to = absolutePoint(texts, end)
  return { start, end, exact: text.slice(from, to), prefix: text.slice(Math.max(0, from - 32), from), suffix: text.slice(to, to + 32), contentHash: hash }
}
export function createCachedChapter(texts: string[], anchor: MarkAnchor, limit = 2000, paragraphBreaks: number[] = []): CachedChapter {
  const sourceText = texts.join('\n'); const sourceStart = absolutePoint(texts, anchor.start); const sourceEnd = absolutePoint(texts, anchor.end)
  const breaks = [...new Set(paragraphBreaks)].filter((offset) => offset > 0 && offset < sourceText.length).sort((a, b) => a - b)
  let text = sourceText; let markStart = sourceStart; let markEnd = sourceEnd
  if (breaks.length > 0) {
    // 预览补入段落换行时，同步映射选区偏移，原文锚点本身保持不变。
    let previous = 0
    const parts: string[] = []
    for (const offset of breaks) { parts.push(sourceText.slice(previous, offset), '\n'); previous = offset }
    parts.push(sourceText.slice(previous)); text = parts.join('')
    markStart = sourceStart + breaks.filter((offset) => offset <= sourceStart).length
    markEnd = sourceEnd + breaks.filter((offset) => offset < sourceEnd).length
  }
  const maxLength = Math.min(2000, Math.max(1, Math.trunc(limit)))
  let from = 0; let to = text.length
  if (text.length > maxLength) {
    const center = (markStart + markEnd) / 2
    from = Math.max(0, Math.min(text.length - maxLength, Math.floor(center - maxLength / 2)))
    to = from + maxLength
  }
  const snippet = text.slice(from, to); const paragraphs = snippet.split('\n')
  const clippedMarkStart = Math.max(0, Math.min(snippet.length, markStart - from)); const clippedMarkEnd = Math.max(clippedMarkStart, Math.min(snippet.length, markEnd - from))
  return { paragraphs, start: pointAt(paragraphs, clippedMarkStart), end: pointAt(paragraphs, clippedMarkEnd), truncatedBefore: from > 0, truncatedAfter: to < text.length }
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

export function validTextAnchor(texts: string[], anchor: MarkAnchor, hash: string): boolean {
  const validPoint = (point: TextPoint) => point.paragraphIndex < texts.length && point.offset <= texts[point.paragraphIndex]!.length
  if (!validPoint(anchor.start) || !validPoint(anchor.end) || comparePoints(anchor.start, anchor.end) >= 0) return false
  return JSON.stringify(createAnchor(texts, anchor.start, anchor.end, hash)) === JSON.stringify(anchor)
}
export const REMOVED_CHAPTER_TAGS = ['audio', 'embed', 'form', 'iframe', 'object', 'script', 'style', 'svg', 'video'] as const
