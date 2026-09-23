import type { SearchOperationResult, SearchProgress, SearchResultGroup, OpenBookResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import type { ActionMenuItem } from './action-menu.ts'
import { sanitizeTerminalText, layoutContent } from './content-layout.ts'
import { moveIndex, pageIndexForKey } from './viewport.ts'
import { layoutFooter, type FooterAction } from './ui-actions.ts'

export type Page = 'config' | 'home' | 'search' | 'results' | 'detail' | 'toc' | 'reader' | 'sources' | 'mapping' | 'help' | 'diagnostics'
export type SearchUiState = 'idle' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error'
export type OperationKind = 'search' | 'source-search' | 'task'

export interface NavigationFrame {
  page: Page
  selected: number
  listStart: number
  pageScroll: number
  homeArea: number
  query: string
  readerLine: number
  tocSelected?: number
  tocQuery?: string
  tocSearchActive?: boolean
  bookId?: string
  editionKey?: string
}

export function pushNavigationFrame(stack: readonly NavigationFrame[], frame: NavigationFrame): NavigationFrame[] {
  if (stack.at(-1)?.page === frame.page && stack.at(-1)?.bookId === frame.bookId && stack.at(-1)?.editionKey === frame.editionKey) {
    return [...stack.slice(0, -1), frame]
  }
  return [...stack, frame]
}

export function popNavigationFrame<T extends NavigationFrame>(stack: readonly T[], updatePrevious?: (frame: T) => T): T[] {
  if (stack.length <= 1) return [...stack]
  const next = stack.slice(0, -1)
  if (updatePrevious !== undefined) next[next.length - 1] = updatePrevious(next.at(-1)!)
  return next
}

export function refreshOnHomeEntry(page: Page, refresh: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
  if (page !== 'home' || !isCurrent()) return Promise.resolve()
  return refresh()
}

export function helpLines(page: Page, homeArea: number): string[] {
  const current: Partial<Record<Page, string[]>> = {
    home: ['↑/↓ 或 j/k 选择，Enter 打开', '1/2/3 切换书架、最近阅读、搜索记录', ...(homeArea === 2 ? [] : ['o 打开书籍操作'])],
    search: ['输入书名，Enter 搜索', '退格删除，Esc 返回'],
    results: ['↑/↓ 或 j/k 选择，Enter 详情', 't 打开目录，o 书籍操作', '搜索中按 Esc 取消'],
    detail: ['Enter 阅读，t 目录', 's 书源，a 书架'],
    toc: ['↑/↓ 或 j/k 选择，Enter 阅读', '/ 按章节名筛选，Home/End 首尾'],
    reader: ['↑/↓ 或 j/k 翻页，←/→ 或 h/l 切换章节', 'PgUp/PgDn 或空格翻页，i 书籍信息，t 目录，s 书源，a 书架，r 刷新'],
    sources: ['↑/↓ 或 j/k 选择书源', 't 查看目录，Enter 切换，m 搜索更多'],
    mapping: ['Enter 确认切换，Esc 取消'],
    config: ['查看当前来源配置与诊断', 'd 打开诊断，q 退出'],
    diagnostics: ['↑/↓ 或 j/k 滚动查看，Esc 返回'],
  }
  return [...(current[page] ?? []), 'Esc 返回 · Ctrl+K 搜书', 'q 退出 · ? 关闭帮助']
}

export function filterChapterIndices(chapters: readonly { title: string }[], query: string): number[] {
  const normalizedQuery = query.normalize('NFKC').toLowerCase()
  return chapters.flatMap((chapter, index) => chapter.title.normalize('NFKC').toLowerCase().includes(normalizedQuery) ? [index] : [])
}

export function chapterIndexForSelection(chapters: readonly { title: string }[], query: string, selected: number, fallback = 0): number {
  return filterChapterIndices(chapters, query)[selected] ?? fallback
}

export interface UiOperation {
  id: number
  kind: OperationKind
  controller: AbortController
  promise?: Promise<unknown>
}

export type MenuTarget =
  | { kind: 'search'; groupKey: string }
  | { kind: 'book'; bookId: string }

export interface MenuState {
  target: MenuTarget
  items: ActionMenuItem[]
  index: number
}

export interface InputKey {
  downArrow?: boolean
  upArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  pageDown?: boolean
  pageUp?: boolean
  home?: boolean
  end?: boolean
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
}

export function homeItemsForArea(items: readonly HomeBookView[], area: number): HomeBookView[] {
  if (area === 0) return items.filter((item) => item.isOnBookshelf)
  if (area === 1) return items.filter((item) => item.reading !== undefined)
  return [...items]
}

export function navigationIndex(index: number, total: number, input: string, key: InputKey, visible: number): number {
  if (input === 'j' || key.downArrow) return moveIndex(index, total, 1)
  if (input === 'k' || key.upArrow) return moveIndex(index, total, -1)
  if (key.pageDown || key.rightArrow) return pageIndexForKey(index, total, visible, 'next')
  if (key.pageUp || key.leftArrow) return pageIndexForKey(index, total, visible, 'previous')
  if (key.home) return 0
  if (key.end) return Math.max(0, total - 1)
  return index
}

export function navigationPage(scroll: number, total: number, input: string, key: InputKey, visible: number): number {
  if (input === 'j' || key.downArrow) return Math.min(Math.max(0, total - visible), scroll + 1)
  if (input === 'k' || key.upArrow) return Math.max(0, scroll - 1)
  if (key.pageDown || key.rightArrow) return Math.min(Math.max(0, total - visible), scroll + Math.max(1, visible - 1))
  if (key.pageUp || key.leftArrow) return Math.max(0, scroll - Math.max(1, visible - 1))
  if (key.home) return 0
  if (key.end) return Math.max(0, total - visible)
  return scroll
}

export type ReaderNavigationAction = 'previous-page' | 'next-page' | 'previous-chapter' | 'next-chapter'

export function readerNavigation(input: string, key: InputKey): ReaderNavigationAction | undefined {
  if (key.downArrow || input === 'j') return 'next-page'
  if (key.upArrow || input === 'k') return 'previous-page'
  if (key.leftArrow || input === 'h') return 'previous-chapter'
  if (key.rightArrow || input === 'l') return 'next-chapter'
  return undefined
}

export function selectedGroupIndex(search: SearchOperationResult, selected: number): number {
  return Math.max(0, Math.min(Math.max(0, search.groups.length - 1), selected))
}

export function restoreGroupSelection(groups: readonly SearchResultGroup[], selected: number, key: string | undefined): number {
  if (key !== undefined) {
    const index = groups.findIndex((group) => group.key === key)
    if (index >= 0) return index
  }
  return Math.max(0, Math.min(Math.max(0, groups.length - 1), selected))
}

export function activeReadingChapter(book: OpenBookResult | undefined): string {
  if (book?.reading === undefined) return '尚未开始阅读'
  const edition = book.reading.activeEditionKey ?? book.book.activeEditionKey
  return edition === undefined ? '尚未开始阅读' : book.reading.positions[edition]?.title ?? '尚未开始阅读'
}

export function detailLineCount(book: OpenBookResult | undefined, width: number): number {
  const introLines = layoutContent(book?.book.intro ?? '书源未返回简介', Math.max(8, width - 10)).lines.length
  return 7 + introLines
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未知'
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`
}

export function display(value: string): string {
  return sanitizeTerminalText(value)
}

export function formatProgress(progress: SearchProgress): string {
  const active = progress.activeSources.length === 0 ? '等待调度' : progress.activeSources.map(display).join('、')
  return `搜索进度 ${progress.completed}/${progress.total} 个书源 · 当前：${active} · 已发现 ${progress.candidates} 本 · 总耗时 ${formatDuration(progress.elapsedMs)}`
}

export function searchHeaderStatus(state: SearchUiState, progress: SearchProgress | undefined, elapsedMs: number, resultCount: number, message: string): string {
  const duration = formatDuration(elapsedMs)
  if (state === 'running' || state === 'cancelling') {
    return progress === undefined ? `搜索中 · ${duration}` : `${progress.completed}/${progress.total}源 · ${duration} · ${progress.candidates}本`
  }
  if (state === 'error') return message.length === 0 ? `搜索失败 · ${duration}` : `失败 · ${duration} · ${message}`
  if (state === 'cancelled') {
    const summary = `${resultCount}本 · ${duration} · 已取消`
    return message.length > 0 && message !== '搜索已取消，已保留已返回结果' ? `${message} · ${summary}` : summary
  }
  if (state === 'complete') {
    const summary = `${resultCount}本 · ${duration}`
    return message.length > 0 && message !== `找到 ${resultCount} 本书` ? `${message} · ${summary}` : summary
  }
  return message
}

export function searchMatchLabel(rank: SearchResultGroup['rank']): string {
  return rank === 'exact' ? '完全匹配' : rank === 'contains' ? '包含关键词' : '其他'
}

// Chapter mapping ignores punctuation and spacing so equivalent source titles can be aligned.
export function normalizeChapterTitle(value: string): string {
  return display(value).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function pageLabel(page: Page): string {
  return ({ config: '配置', home: '首页', search: '搜索', results: '搜索结果', detail: '详情', toc: '目录', reader: '阅读', sources: '已知书源', mapping: '章节映射', help: '帮助', diagnostics: '诊断' } as Record<Page, string>)[page]
}

export function homeAreaLabel(homeArea: number): string {
  return (['书架', '最近阅读', '搜索记录'] as const)[homeArea] ?? '书架'
}

export function previousPage(page: Page): Page {
  return page === 'config' ? 'config' : page === 'home' ? 'home' : page === 'search' ? 'home' : page === 'results' ? 'search' : page === 'detail' ? 'results' : page === 'toc' ? 'detail' : page === 'reader' ? 'toc' : page === 'sources' ? 'detail' : page === 'mapping' ? 'sources' : 'home'
}

export function sourceState(value: KnownSourceView['state']): string {
  return value === 'available' ? '可用' : value === 'stale' ? '需要重新搜索' : value === 'removed' ? '书源已移除' : '定义冲突'
}

export function activeEditionKey(book: OpenBookResult | undefined): string | undefined {
  return book?.reading?.activeEditionKey ?? book?.book.activeEditionKey
}

export function footer(page: Page, busy: boolean, columns: number, searchState: SearchUiState, sourceSearchState: SearchUiState, menuOpen: boolean, homeArea: number, tocSearchActive = false, tocHasQuery = false): string {
  if (menuOpen) return layoutFooter([
    { keys: 'Enter', label: '执行', priority: 0 },
    { keys: 'Esc', label: '关闭', priority: -1 },
  ], columns)
  const common: FooterAction[] = [
    { keys: 'Esc', label: '返回', priority: -1 },
    { keys: '?', label: '帮助', priority: 8 },
    { keys: 'd', label: '诊断', priority: 9 },
    { keys: 'q', label: '退出', priority: 10 },
  ]
  if (page === 'home') return layoutFooter([
    { keys: 'Enter', label: homeArea === 2 ? '重复搜索' : '打开', priority: 0 },
    ...(homeArea === 2 ? [] : [{ keys: 'o', label: '操作', priority: 1 }]),
    ...common.slice(1),
  ], columns)
  if (page === 'search') return layoutFooter([
    { keys: 'Enter', label: '搜索', priority: 0 },
    { keys: 'Esc', label: '返回', priority: -1 },
  ], columns)
  if (page === 'results') return layoutFooter([
    ...(searchState === 'running' || searchState === 'cancelling' ? [{ keys: 'Esc', label: '取消搜索', priority: -1 }] : [{ keys: 'Enter', label: '详情', priority: 0 }, { keys: 't', label: '目录', priority: 1 }]),
    { keys: 'o', label: '操作', priority: 2 },
    ...(searchState === 'running' || searchState === 'cancelling' ? common.slice(1) : common),
  ], columns)
  if (page === 'sources') {
    const searching = sourceSearchState === 'running' || sourceSearchState === 'cancelling'
    return layoutFooter([
      ...(searching ? [{ keys: 'Esc', label: '取消搜索', priority: -1 }] : [{ keys: 'Enter', label: '切换', priority: 0 }, { keys: 't', label: '目录', priority: 1 }, { keys: 'm', label: '搜索更多', priority: 2 }]),
      ...(searching ? common.slice(1) : common),
    ], columns)
  }
  if (busy) return layoutFooter([{ keys: 'Esc', label: '取消处理中', priority: -1 }, ...common.slice(1)], columns)
  if (page === 'detail') return layoutFooter([
    { keys: 'Enter', label: '阅读', priority: 0 },
    { keys: 't', label: '目录', priority: 1 },
    { keys: 's', label: '换源', priority: 1 },
    { keys: 'a', label: '书架', priority: 1 },
    ...common,
  ], columns)
  if (page === 'toc') return layoutFooter(tocSearchActive
    ? [{ keys: 'Enter', label: '完成', priority: 0 }, { keys: 'Esc', label: '清除', priority: -1 }]
    : [{ keys: 'Enter', label: '阅读', priority: 0 }, { keys: '/', label: '筛章节', priority: 1 }, ...(tocHasQuery ? [{ keys: 'Esc', label: '清除筛选', priority: -1 }] : common)], columns)
  if (page === 'reader') return layoutFooter([
    { keys: 'i', label: '信息', priority: 1 },
    { keys: 't', label: '目录', priority: 1 },
    { keys: 's', label: '换源', priority: 1 },
    { keys: 'a', label: '书架', priority: 1 },
    { keys: 'r', label: '刷新正文', priority: 1 },
    ...common,
  ], columns)
  if (page === 'mapping') return layoutFooter([
    { keys: 'Enter', label: '确认切换', priority: 0 },
    { keys: 'Esc', label: '取消', priority: -1 },
    ...common.slice(1),
  ], columns)
  return layoutFooter(common, columns)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError'
}
