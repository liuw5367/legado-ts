import { createContext, type RefObject } from 'react'
import type { Location } from 'react-router-dom'
import type { ReadingPositionQueue } from './reading-position-queue.ts'

export interface PageNavigation {
  userId: string
  versions: ReadonlyMap<string, number>
  back: (fallback: { to: string; state: unknown }) => void
  rootTarget: (path: string) => string
  bookListSnapshots?: Map<string, import('./book-list-state.ts').BookListPageSnapshot>
  positions: ReadingPositionQueue
}
export const NavigationContext = createContext<PageNavigation | null>(null)
export interface PageContextValue { active: boolean; id: string; location: Location; root: RefObject<HTMLDivElement | null>; restored: boolean }
export const PageContext = createContext<PageContextValue | null>(null)
