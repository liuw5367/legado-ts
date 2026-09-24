import type { FontMapping } from './contracts.ts'

/** 按 Android replaceFont 语义将错误字体文字映射为正确文字。 */
export function replaceFont(text: string, error: FontMapping | null, correct: FontMapping | null, filter = false): string {
  if (error === null || correct === null) return text
  const result: string[] = []
  for (const character of text) {
    const unicode = character.codePointAt(0)!
    if (error.isBlankUnicode(unicode)) { result.push(character); continue }
    let glyph = error.glyphByUnicode(unicode)
    if (error.glyphIdByUnicode(unicode) === 0) glyph = undefined
    if (filter && glyph === undefined) continue
    const replacement = correct.unicodeByGlyph(glyph)
    result.push(replacement === 0 ? character : String.fromCodePoint(replacement))
  }
  return result.join('')
}
