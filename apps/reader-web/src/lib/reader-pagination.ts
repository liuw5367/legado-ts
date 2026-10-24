import { isReaderTap, type ReaderTapPoint } from './reader-interactions.ts'
import { DEFAULT_PAGE_TAP_ZONES, type ApiPageTapZones } from './api.ts'

export type ReaderPageAction = 'previous' | 'toggle-controls' | 'next'

export interface PageLayout {
  pageWidth: number
  pageCount: number
}

export interface ReaderAnchor {
  paragraphIndex: number
  /** 段落 textContent 中的 UTF-16 偏移，定位跨页段落内的首个可见字符。 */
  offset: number
}

export type PageTapZoneBoundary = 'left-center' | 'center-right' | 'center-top' | 'center-bottom'

export function normalizePageTapZones(value: unknown): ApiPageTapZones {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PAGE_TAP_ZONES
  const zones = value as Record<string, unknown>
  const { leftWidthPercent, centerWidthPercent, centerTopHeightPercent, centerMiddleHeightPercent, centerTopAction, centerBottomAction } = zones
  if (!isZonePercent(leftWidthPercent) || !isZonePercent(centerWidthPercent) || !isZonePercent(centerTopHeightPercent) || !isZonePercent(centerMiddleHeightPercent) || leftWidthPercent + centerWidthPercent > 82 || centerTopHeightPercent + centerMiddleHeightPercent > 82 || !isPageTapAction(centerTopAction) || !isPageTapAction(centerBottomAction)) return DEFAULT_PAGE_TAP_ZONES
  return { leftWidthPercent, centerWidthPercent, centerTopHeightPercent, centerMiddleHeightPercent, centerTopAction, centerBottomAction }
}

export function pageTapZoneBoundaryRange(zones: ApiPageTapZones, boundary: PageTapZoneBoundary): { value: number; min: number; max: number } {
  if (boundary === 'left-center') {
    const right = 100 - zones.leftWidthPercent - zones.centerWidthPercent
    return { value: zones.leftWidthPercent, min: 18, max: 82 - right }
  }
  if (boundary === 'center-right') return { value: zones.leftWidthPercent + zones.centerWidthPercent, min: zones.leftWidthPercent + 18, max: 82 }
  if (boundary === 'center-top') {
    const bottom = 100 - zones.centerTopHeightPercent - zones.centerMiddleHeightPercent
    return { value: zones.centerTopHeightPercent, min: 18, max: 82 - bottom }
  }
  return { value: zones.centerTopHeightPercent + zones.centerMiddleHeightPercent, min: zones.centerTopHeightPercent + 18, max: 82 }
}

export function resizePageTapZones(zones: ApiPageTapZones, boundary: PageTapZoneBoundary, targetPercent: number): ApiPageTapZones {
  const range = pageTapZoneBoundaryRange(zones, boundary)
  const value = Math.round(Math.min(range.max, Math.max(range.min, targetPercent)))
  if (boundary === 'left-center') {
    const right = 100 - zones.leftWidthPercent - zones.centerWidthPercent
    return { ...zones, leftWidthPercent: value, centerWidthPercent: 100 - right - value }
  }
  if (boundary === 'center-right') return { ...zones, centerWidthPercent: value - zones.leftWidthPercent }
  if (boundary === 'center-top') {
    const bottom = 100 - zones.centerTopHeightPercent - zones.centerMiddleHeightPercent
    return { ...zones, centerTopHeightPercent: value, centerMiddleHeightPercent: 100 - bottom - value }
  }
  return { ...zones, centerMiddleHeightPercent: value - zones.centerTopHeightPercent }
}

export function pageCountFromScrollWidth(scrollWidth: number, pageWidth: number): number {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(pageWidth) || scrollWidth <= 0 || pageWidth <= 0) return 0
  return Math.max(1, Math.ceil((scrollWidth - 0.5) / pageWidth))
}

export function clampPageIndex(pageIndex: number, pageCount: number): number {
  const lastPage = Math.max(0, pageCount - 1)
  return Math.min(lastPage, Math.max(0, Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0))
}

export function pageLabel(pageIndex: number, pageCount: number): string {
  const count = Math.max(1, Math.trunc(pageCount))
  return `${clampPageIndex(pageIndex, count) + 1}/${count}`
}

export function pageActionForTap(start: ReaderTapPoint | null, end: ReaderTapPoint, selectedText: string, clientX: number, viewportLeft: number, viewportWidth: number, zones?: ApiPageTapZones, clientY = end.y, viewportTop = 0, viewportHeight = Number.POSITIVE_INFINITY): ReaderPageAction | null {
  if (!isReaderTap(start, end, selectedText) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return null
  const relativeX = clientX - viewportLeft
  if (relativeX < 0 || relativeX > viewportWidth) return null
  if (zones === undefined) {
    if (relativeX < viewportWidth / 3) return 'previous'
    if (relativeX >= viewportWidth * 2 / 3) return 'next'
    return 'toggle-controls'
  }
  if (relativeX < viewportWidth * zones.leftWidthPercent / 100) return 'previous'
  if (relativeX >= viewportWidth * (zones.leftWidthPercent + zones.centerWidthPercent) / 100) return 'next'
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return null
  const relativeY = (clientY - viewportTop) / viewportHeight * 100
  if (relativeY < 0 || relativeY > 100) return null
  if (relativeY < zones.centerTopHeightPercent) return zones.centerTopAction
  if (relativeY < zones.centerTopHeightPercent + zones.centerMiddleHeightPercent) return 'toggle-controls'
  return zones.centerBottomAction
}

function isZonePercent(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 18 && value <= 64 }
function isPageTapAction(value: unknown): value is 'previous' | 'next' { return value === 'previous' || value === 'next' }

export function pageIndexForElement(element: HTMLElement | null, viewport: HTMLElement | null, layout: PageLayout): number {
  if (element === null || viewport === null || layout.pageWidth <= 0 || layout.pageCount <= 0) return 0
  const elementRect = element.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  const absoluteLeft = elementRect.left - viewportRect.left + viewport.scrollLeft
  return clampPageIndex(Math.floor(Math.max(0, absoluteLeft) / layout.pageWidth), layout.pageCount)
}

export function firstVisibleParagraphIndex(viewport: HTMLElement | null): number | undefined {
  if (viewport === null) return undefined
  const viewportRect = viewport.getBoundingClientRect()
  const left = viewportRect.left + 1
  const right = viewportRect.right - 1
  const top = viewportRect.top + 8
  const bottom = viewportRect.bottom - 8
  const visible = [...viewport.querySelectorAll<HTMLElement>('[data-paragraph]')].find((element) => {
    const rect = element.getBoundingClientRect()
    return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
  })
  if (visible === undefined) return undefined
  const index = Number(visible.dataset.paragraph)
  return Number.isInteger(index) && index >= 0 ? index : undefined
}

export function pageIndexForAnchor(viewport: HTMLElement | null, anchor: ReaderAnchor | null, layout: PageLayout): number {
  if (viewport === null || anchor === null) return 0
  const element = viewport.querySelector<HTMLElement>(`[data-paragraph="${anchor.paragraphIndex}"]`)
  if (element !== null && anchor.offset > 0) {
    const walker = element.ownerDocument.createTreeWalker(element, 4)
    let remaining = anchor.offset
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining < length) {
        const range = element.ownerDocument.createRange()
        range.setStart(node, remaining)
        range.setEnd(node, remaining + 1)
        const rect = range.getBoundingClientRect()
        const left = rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft
        return clampPageIndex(Math.floor(Math.max(0, left) / layout.pageWidth), layout.pageCount)
      }
      remaining -= length
    }
  }
  return pageIndexForElement(element, viewport, layout)
}

export function anchorFromViewport(viewport: HTMLElement | null): ReaderAnchor | undefined {
  const paragraphIndex = firstVisibleParagraphIndex(viewport)
  if (paragraphIndex === undefined || viewport === null) return undefined
  const element = viewport.querySelector<HTMLElement>(`[data-paragraph="${paragraphIndex}"]`)
  if (element === null) return undefined
  const viewportRect = viewport.getBoundingClientRect()
  const walker = element.ownerDocument.createTreeWalker(element, 4)
  const range = element.ownerDocument.createRange()
  let offset = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    // 多栏中的同一段落可跨页；逐文本节点二分查找当前栏首字符，不能使用段落整体矩形定位。
    let low = 0
    let high = length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      range.setStart(node, middle)
      range.setEnd(node, middle + 1)
      if (range.getBoundingClientRect().right <= viewportRect.left + 1) low = middle + 1
      else high = middle
    }
    if (low < length) {
      range.setStart(node, low)
      range.setEnd(node, low + 1)
      const rect = range.getBoundingClientRect()
      if (rect.right > viewportRect.left + 1 && rect.left < viewportRect.right - 1 && rect.bottom > viewportRect.top + 8 && rect.top < viewportRect.bottom - 8) return { paragraphIndex, offset: offset + low }
    }
    offset += length
  }
  return { paragraphIndex, offset: 0 }
}
