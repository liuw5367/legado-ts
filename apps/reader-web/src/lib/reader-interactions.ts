/** 正文字符数排除空白，按Unicode码点计数，标题和原始HTML不参与。 */
export function chapterCharacterCount(text: string): number {
  // Unicode空白包含换行、全角空格和普通空格。
  return [...text.replace(/\s/gu, '')].length
}
/** 拖动、滚动或选字结束不应触发工具栏显隐。 */
export interface ReaderTapPoint {
  x: number; y: number; scrollY: number
  /** 分页手势开始前已有的选中文字，用于区分旧选区与本次选字。 */
  selectedText?: string
}
export function isReaderTap(start: ReaderTapPoint | null, end: ReaderTapPoint, selectedText: string): boolean {
  const selectingText = selectedText.length > 0 && selectedText !== start?.selectedText
  return !selectingText && (start === null || (Math.hypot(end.x - start.x, end.y - start.y) < 8 && end.scrollY === start.scrollY))
}

/** x/y 使用 CSS px，time 使用事件 timeStamp 的毫秒值。 */
type GesturePoint = { x: number; y: number; time: number }
export interface ReaderGesture {
  start: GesturePoint
  width: number
  direction: -1 | 0 | 1
  furthest: number
  leftOrigin: boolean
  swipeCancelled: boolean
  clickBlocked: boolean
}

const TAP_DISTANCE = 8
const DIRECTION_DISTANCE = 12
const DIRECTION_RATIO = 1.5
const LONG_PRESS_MS = 300
const MAX_SWIPE_MS = 800
const MAX_RETRACTION = 20

/** 选区和屏幕边缘只取消滑动资格，静止点击仍沿用原有分区行为。 */
export function startReaderGesture(point: GesturePoint, width: number, swipeAllowed: boolean): ReaderGesture {
  return { start: point, width, direction: 0, furthest: 0, leftOrigin: false, swipeCancelled: !swipeAllowed, clickBlocked: false }
}

/** 输入取消或本次选字后，滑动和随后生成的点击都不能执行。 */
export function cancelReaderGesture(gesture: ReaderGesture): void {
  gesture.swipeCancelled = true
  gesture.clickBlocked = true
}

export function moveReaderGesture(gesture: ReaderGesture, point: GesturePoint): void {
  const dx = point.x - gesture.start.x
  const dy = point.y - gesture.start.y
  const distance = Math.hypot(dx, dy)
  if (distance >= TAP_DISTANCE) gesture.clickBlocked = true
  // 以首次离开起始范围的时刻判断长按；慢速滑动开始后不再被长按门槛取消。
  if (!gesture.leftOrigin && point.time - gesture.start.time >= LONG_PRESS_MS) gesture.swipeCancelled = true
  if (distance >= DIRECTION_DISTANCE) gesture.leftOrigin = true
  if (gesture.swipeCancelled || !gesture.leftOrigin) return
  if (gesture.direction === 0) {
    if (Math.abs(dy) >= Math.abs(dx) * DIRECTION_RATIO) { gesture.swipeCancelled = true; return }
    if (Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) return
    gesture.direction = dx < 0 ? -1 : 1
  }
  const progress = dx * gesture.direction
  gesture.furthest = Math.max(gesture.furthest, progress)
  if (gesture.furthest - progress > MAX_RETRACTION) gesture.swipeCancelled = true
}

export function finishReaderGesture(gesture: ReaderGesture, point: GesturePoint): 'previous' | 'next' | null {
  moveReaderGesture(gesture, point)
  const dx = point.x - gesture.start.x
  const dy = point.y - gesture.start.y
  const elapsed = point.time - gesture.start.time
  if (gesture.swipeCancelled || gesture.direction === 0 || elapsed <= 0 || elapsed > MAX_SWIPE_MS
    || dx * gesture.direction <= 0 || Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) return null
  const distance = Math.abs(dx)
  const normalSwipe = distance >= Math.max(40, Math.min(72, gesture.width * 0.12))
  const quickSwipe = distance >= 28 && elapsed <= 300 && distance / elapsed >= 0.35
  return normalSwipe || quickSwipe ? gesture.direction < 0 ? 'next' : 'previous' : null
}
/** 目录响应必须同时属于当前书籍和书源版本，避免切换期间复用旧章节链接。 */
export function isCurrentToc(toc: { bookId: string; editionKey: string } | null, bookId: string, editionKey: string): boolean {
  return toc !== null && toc.bookId === bookId && toc.editionKey === editionKey
}

/** 外部网页入口仅接受HTTP(S)，不把脚本URL交给浏览器。 */
export function browserUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}
