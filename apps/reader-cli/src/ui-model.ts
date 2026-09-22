import type { SearchOperationResult, SearchProgress, SearchResultGroup, OpenBookResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import type { ActionMenuItem } from './action-menu.ts'
import { sanitizeTerminalText, layoutContent } from './content-layout.ts'
import { moveIndex, pageIndexForKey } from './viewport.ts'
import { layoutFooter, type FooterAction } from './ui-actions.ts'

export type Page = 'config' | 'home' | 'search' | 'results' | 'detail' | 'toc' | 'reader' | 'sources' | 'mapping' | 'help' | 'diagnostics'
export type SearchUiState = 'idle' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error'
export type OperationKind = 'search' | 'source-search' | 'task'

export const HELP_LINES = [
  '帮助',
  '全局：Ctrl+K 搜索书籍；Enter 确认，Esc 返回/取消，? 打开帮助，d 查看诊断，q 退出。',
  '列表：j/k、↑/↓ 移动；←/→、PageUp/PageDown 翻页；Home/End 跳到首尾。',
  '文本视口：j/k、↑/↓ 逐行滚动；←/→、PageUp/PageDown 翻页；Home/End 跳到首尾。',
  '正文：空格或 →/PageDown 下一页；b 或 ←/PageUp 上一页；[ ] 切换章节；t 目录；s 书源；a 书架；r 刷新正文。',
  '首页：1/2/3 切换书架、最近阅读、搜索记录；Enter 打开，o 打开操作菜单。',
  '搜索结果：Enter 详情，t 目录，o 操作；详情：Enter 阅读，t 目录，s 换源，a 书架，o 操作。',
  '章节目录：Enter 阅读；已知书源：Enter 换源，m 搜索更多；搜索中 Esc 只取消搜索。',
  '操作弹窗：j/k 或 ↑/↓ 选择，Enter 执行，Esc 关闭；弹窗会覆盖在当前页面中央。',
]

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

export function detailLineCount(book: OpenBookResult | undefined, width: number, message: string): number {
  if (book === undefined) return 1 + (message.length > 0 ? 1 : 0)
  const introLines = layoutContent(book.book.intro ?? '书源未返回简介', Math.max(8, width - 10)).lines.length
  return 9 + introLines + (message.length > 0 ? 1 : 0)
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

export function previousPage(page: Page): Page {
  return page === 'config' ? 'config' : page === 'home' ? 'home' : page === 'search' ? 'home' : page === 'results' ? 'search' : page === 'detail' ? 'results' : page === 'toc' ? 'detail' : page === 'reader' ? 'toc' : page === 'sources' ? 'detail' : page === 'mapping' ? 'sources' : 'home'
}

export function sourceState(value: KnownSourceView['state']): string {
  return value === 'available' ? '可用' : value === 'stale' ? '需要重新搜索' : value === 'removed' ? '书源已移除' : '定义冲突'
}

export function activeEditionKey(book: OpenBookResult | undefined): string | undefined {
  return book?.reading?.activeEditionKey ?? book?.book.activeEditionKey
}

export function footer(page: Page, busy: boolean, columns: number, searchState: SearchUiState, sourceSearchState: SearchUiState, menuOpen: boolean, homeArea: number): string {
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
      ...(searching ? [{ keys: 'Esc', label: '取消搜索', priority: -1 }] : [{ keys: 'Enter', label: '换源', priority: 0 }, { keys: 'm', label: '搜索更多', priority: 1 }]),
      ...(searching ? common.slice(1) : common),
    ], columns)
  }
  if (busy) return layoutFooter([{ keys: 'Esc', label: '取消处理中', priority: -1 }, ...common.slice(1)], columns)
  if (page === 'detail') return layoutFooter([
    { keys: 'Enter', label: '开始/继续阅读', priority: 0 },
    { keys: 't', label: '目录', priority: 1 },
    { keys: 's', label: '换源', priority: 1 },
    { keys: 'a', label: '加入/移出书架', priority: 1 },
    { keys: 'o', label: '操作', priority: 2 },
    ...common,
  ], columns)
  if (page === 'toc') return layoutFooter([
    { keys: 'Enter', label: '阅读', priority: 0 },
    ...common,
  ], columns)
  if (page === 'reader') return layoutFooter([
    { keys: '[ ]', label: '上下章', priority: 0 },
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
