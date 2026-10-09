import type { NavigationFrame, Page } from './ui-model.ts'

export type NavigationMode = 'standard' | 'singleTop' | 'singleTask' | 'replace'

export interface NavigationRequest<T extends NavigationFrame> {
  mode: NavigationMode
  key: string
  keyOf: (frame: T) => string
}

export function navigationKey(page: string, ...parts: Array<string | undefined>): string {
  return JSON.stringify([page, ...parts])
}

export function navigationModeForPage(page: Page): NavigationMode {
  if (page === 'home' || page === 'config' || page === 'settings' || page === 'help' || page === 'diagnostics' || page === 'source-manager' || page === 'debug') return 'singleTask'
  if (page === 'reader') return 'singleTop'
  return 'standard'
}

export function navigationFrameKey(frame: NavigationFrame): string {
  if (frame.navigationKey !== undefined) return frame.navigationKey
  if (frame.page === 'reader') return navigationKey(frame.page, frame.bookId, frame.editionKey)
  return navigationKey(frame.page)
}

export function navigationKeyForPage(page: Page, frame: NavigationFrame): string {
  if (page === 'reader') return navigationKey(page, frame.bookId, frame.editionKey)
  return navigationKey(page)
}

export function currentNavigationFrame<T>(stack: readonly T[]): T | undefined {
  return stack.at(-1)
}

export function previousNavigationFrame<T>(stack: readonly T[]): T | undefined {
  return stack.at(-2)
}

export function findNavigationFrameIndex<T extends NavigationFrame>(stack: readonly T[], key: string, keyOf: (frame: T) => string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (keyOf(stack[index]!) === key) return index
  }
  return -1
}

export function navigateNavigationFrame<T extends NavigationFrame>(stack: readonly T[], frame: T, request: NavigationRequest<T>): T[] {
  if (stack.length === 0) return [frame]
  if (request.mode === 'replace') return [...stack.slice(0, -1), frame]
  if (request.mode === 'singleTop' && request.keyOf(stack.at(-1)!) === request.key) return [...stack.slice(0, -1), frame]
  if (request.mode === 'singleTask') {
    const existingIndex = findNavigationFrameIndex(stack, request.key, request.keyOf)
    if (existingIndex >= 0) {
      const below = stack.slice(0, existingIndex).filter((item) => request.keyOf(item) !== request.key)
      return [...below, frame]
    }
  }
  return [...stack, frame]
}

export function popNavigationFrame<T extends NavigationFrame>(stack: readonly T[], updatePrevious?: (frame: T) => T): T[] {
  if (stack.length <= 1) return [...stack]
  const next = stack.slice(0, -1)
  if (updatePrevious !== undefined) next[next.length - 1] = updatePrevious(next.at(-1)!)
  return next
}

export function popToNavigationFrame<T extends NavigationFrame>(stack: readonly T[], key: string, keyOf: (frame: T) => string, updateTarget?: (frame: T) => T): T[] {
  const targetIndex = findNavigationFrameIndex(stack, key, keyOf)
  if (targetIndex < 0) return [...stack]
  const target = updateTarget === undefined ? stack[targetIndex]! : updateTarget(stack[targetIndex]!)
  return [...stack.slice(0, targetIndex), target]
}

export function updateNavigationFrames<T>(stack: readonly T[], update: (frame: T) => T): T[] {
  return stack.map(update)
}
