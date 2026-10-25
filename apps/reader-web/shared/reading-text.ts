import { comparePoints, type MarkAnchor, type TextPoint } from './reading-annotations.ts'
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
