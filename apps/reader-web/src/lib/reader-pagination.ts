import { isReaderTap, type ReaderTapPoint } from './reader-interactions.ts'

export type ReaderPageAction = 'previous' | 'toggle-controls' | 'next'

export interface PageLayout {
  pageWidth: number
  pageCount: number
}

export interface ReaderAnchor {
  paragraphIndex: number
  offset: number
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

export function pageActionForTap(start: ReaderTapPoint | null, end: ReaderTapPoint, selectedText: string, clientX: number, viewportLeft: number, viewportWidth: number): ReaderPageAction | null {
  if (!isReaderTap(start, end, selectedText) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return null
  const relativeX = clientX - viewportLeft
  if (relativeX < 0 || relativeX > viewportWidth) return null
  if (relativeX < viewportWidth / 3) return 'previous'
  if (relativeX >= viewportWidth * 2 / 3) return 'next'
  return 'toggle-controls'
}

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
  return pageIndexForElement(element, viewport, layout)
}

export function anchorFromViewport(viewport: HTMLElement | null): ReaderAnchor | undefined {
  const paragraphIndex = firstVisibleParagraphIndex(viewport)
  return paragraphIndex === undefined ? undefined : { paragraphIndex, offset: 0 }
}
