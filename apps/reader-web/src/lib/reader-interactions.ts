/** 正文字符数排除空白，按Unicode码点计数，标题和原始HTML不参与。 */
export function chapterCharacterCount(text: string): number {
  // Unicode空白包含换行、全角空格和普通空格。
  return [...text.replace(/\s/gu, '')].length
}
/** 拖动、滚动或选字结束不应触发工具栏显隐。 */
export function isReaderTap(start: { x: number; y: number; scrollY: number } | null, end: { x: number; y: number; scrollY: number }, selectedText: string): boolean {
  return selectedText.length === 0 && (start === null || (Math.hypot(end.x - start.x, end.y - start.y) < 8 && end.scrollY === start.scrollY))
}
