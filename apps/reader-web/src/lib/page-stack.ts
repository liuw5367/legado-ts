import { matchPath, type Location, type NavigationType } from 'react-router-dom'

export interface PageFrame { id: string; kind: 'root' | 'content' | 'reader' | 'temporary'; location: Location; visited: number }
interface Entry { key: string; frameId: string; location: Location }
export interface PageStackState { entries: Entry[]; index: number; frames: PageFrame[]; sequence: number; activeId: string }

export function readerIdentity(location: Pick<Location, 'pathname' | 'search'>): string | undefined {
  const match = matchPath('/books/:bookId/read/:chapterId?', location.pathname)
  return match === null ? undefined : JSON.stringify([match.params.bookId, new URLSearchParams(location.search).get('editionKey') ?? ''])
}
function rootKey(path: string) { return ['/', '/book-lists', '/account/settings'].includes(path) ? path : undefined }
function pageType(path: string) {
  for (const pattern of ['/books/:bookId/details', '/books/:bookId/toc', '/books/:bookId/sources']) if (matchPath(pattern, path)) return pattern
  return path
}
export function emptyPageStack(): PageStackState { return { entries: [], index: -1, frames: [], sequence: 0, activeId: '' } }

/** 历史只记录本次挂载观察到的连续区间；未知 POP 不猜测浏览器中的旧索引。 */
export function visitPage(previous: PageStackState, location: Location, action: NavigationType): PageStackState {
  if (previous.entries[previous.index]?.key === location.key) return previous
  let entries = [...previous.entries]
  let index = previous.index
  const known = entries.findIndex((entry) => entry.key === location.key)
  if (action === 'POP' && known >= 0) index = known
  else if (action === 'REPLACE' && index >= 0) { /* 替换当前项时必须保留浏览器已有的前进分支。 */ }
  else if (action === 'PUSH') { entries = entries.slice(0, index + 1); index++ }
  else { entries = []; index = 0 }

  const sequence = previous.sequence + 1
  const root = rootKey(location.pathname)
  const reading = readerIdentity(location)
  const temporary = location.pathname === '/account/password'
  let frames = previous.frames.filter((frame) => frame.kind !== 'temporary' && (frame.kind !== 'reader' || reading === undefined || readerIdentity(frame.location) === reading))
  const referenced = new Set(entries.map((entry) => entry.frameId))
  frames = frames.filter((frame) => frame.kind === 'root' || referenced.has(frame.id))
  const knownFrame = entries[index]?.key === location.key ? frames.find((frame) => frame.id === entries[index]?.frameId) : undefined
  const replacing = action === 'REPLACE' ? previous.frames.find((frame) => frame.id === previous.activeId && frame.kind === 'content' && pageType(frame.location.pathname) === pageType(location.pathname)) : undefined
  const reuse = knownFrame ?? (root === undefined ? reading === undefined ? replacing : previous.frames.find((frame) => frame.kind === 'reader' && readerIdentity(frame.location) === reading) : frames.find((frame) => frame.location.pathname === root))
  const frame: PageFrame = { id: reuse?.id ?? `page-${sequence}`, kind: temporary ? 'temporary' : root !== undefined ? 'root' : reading !== undefined ? 'reader' : 'content', location, visited: sequence }
  frames = [...frames.filter((item) => item.id !== frame.id), frame]
  const contents = frames.filter((item) => item.kind === 'content').sort((a, b) => b.visited - a.visited)
  const retained = new Set(contents.slice(0, 8).map((item) => item.id))
  frames = frames.filter((item) => item.kind !== 'content' || retained.has(item.id))
  entries[index] = { key: location.key, frameId: frame.id, location }
  const liveReferences = new Set(entries.map((entry) => entry.frameId))
  frames = frames.filter((item) => item.kind === 'root' || item.id === frame.id || liveReferences.has(item.id))
  // 淘汰历史元数据不修改真实历史；再次遇到旧条目会按 URL 重建。
  if (entries.length > 100) { const start = Math.max(0, index - 99); entries = entries.slice(start, start + 100); index -= start }
  return { entries, index, frames, sequence, activeId: frame.id }
}

export function previousPageDelta(state: PageStackState): number | undefined { return state.index > 0 ? -1 : undefined }
export function pageDelta(state: PageStackState, key: string): number | undefined {
  const index = state.entries.findIndex((entry) => entry.key === key)
  return index >= 0 && index < state.index ? index - state.index : undefined
}
