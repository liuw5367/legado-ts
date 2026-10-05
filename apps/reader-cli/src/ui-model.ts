import type { SearchOperationResult, SearchProgress, SearchResultGroup, OpenBookResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import type { SourceCatalogResult, SourceEntry } from './source-catalog.ts'
import type { ActionMenuItem } from './action-menu.ts'
import { sanitizeTerminalText, layoutContent } from './content-layout.ts'
import { moveIndex, pageIndexForKey } from './viewport.ts'
import { layoutFooter, terminalWidth, type FooterAction, type FooterLayout } from './ui-actions.ts'

export type Page = 'config' | 'home' | 'search' | 'results' | 'detail' | 'toc' | 'reader' | 'sources' | 'mapping' | 'help' | 'settings' | 'diagnostics' | 'debug' | 'source-manager'
export type SearchUiState = 'idle' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error'
export type OperationKind = 'search' | 'source-search' | 'source-check' | 'task'

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

export interface HelpSection {
  title: string
  entries: Array<{ keys: string; description: string }>
}

export function helpSections(page: Page, homeArea: number): HelpSection[] {
  const current: Partial<Record<Page, HelpSection>> = {
    home: { title: '当前页面 · 首页', entries: [{ keys: '↑/↓  j/k', description: '移动选择' }, { keys: '↵', description: '打开或重复搜索' }, { keys: '1/2/3', description: '切换书架、最近阅读、搜索记录' }, { keys: 'm', description: '书源管理' }, { keys: 's', description: '打开设置' }, ...(homeArea === 2 ? [] : [{ keys: 'o', description: '打开书籍操作' }])] },
    search: { title: '当前页面 · 搜索', entries: [{ keys: '输入文字', description: '填写书名' }, { keys: 'Ctrl+P', description: '切换精准搜索' }, { keys: '↵', description: '开始搜索' }, { keys: '退格', description: '删除输入' }] },
    results: { title: '当前页面 · 搜索结果', entries: [{ keys: '↑/↓  j/k', description: '移动选择' }, { keys: 'n', description: '加载下一页' }, { keys: '↵', description: '打开书籍详情' }, { keys: 't', description: '直接打开目录' }, { keys: 'o', description: '书籍操作' }, { keys: '⎋', description: '搜索中取消任务' }] },
    detail: { title: '当前页面 · 书籍信息', entries: [{ keys: '↵', description: '开始阅读' }, { keys: 't', description: '打开目录' }, { keys: 's', description: '查看书源' }, { keys: 'a', description: '加入或移出书架' }] },
    toc: { title: '当前页面 · 目录', entries: [{ keys: '↑/↓  j/k', description: '移动章节' }, { keys: '↵', description: '阅读选中章节' }, { keys: '/', description: '搜索章节' }, { keys: 'r', description: '刷新目录' }, { keys: 's', description: '切换正序/倒序' }, { keys: 'Home/End  Ctrl+A/E', description: '跳到开头或结尾' }] },
    reader: { title: '当前页面 · 阅读', entries: [{ keys: '↑/↓  j/k', description: '翻页' }, { keys: '←/→  h/l', description: '切换章节' }, { keys: 'PgUp/PgDn  空格', description: '整页翻页' }, { keys: 'i', description: '书籍信息' }, { keys: 't', description: '目录' }, { keys: 's', description: '切换书源' }, { keys: 'a', description: '书架' }, { keys: 'r', description: '刷新正文' }] },
    sources: { title: '当前页面 · 书源切换', entries: [{ keys: '↑/↓  j/k', description: '移动书源' }, { keys: '↵', description: '切换书源' }, { keys: 't', description: '查看目录' }, { keys: 'm', description: '搜索更多书源' }] },
    mapping: { title: '当前页面 · 章节映射', entries: [{ keys: '↵', description: '确认切换' }, { keys: '⎋', description: '取消' }] },
    config: { title: '当前页面 · 配置', entries: [{ keys: 'd', description: '打开诊断' }, { keys: 's', description: '打开设置' }] },
    settings: { title: '当前页面 · 设置', entries: [{ keys: '↑/↓  j/k', description: '选择设置项' }, { keys: '↵', description: '编辑或保存' }, { keys: 'r', description: '恢复默认值' }, { keys: '⎋', description: '返回或取消编辑' }] },
    diagnostics: { title: '当前页面 · 诊断', entries: [{ keys: '↑/↓  j/k', description: '选择书源' }, { keys: '↵', description: '查看书源诊断' }, { keys: 'r', description: '执行快速检查' }] },
    'source-manager': { title: '当前页面 · 书源管理', entries: [{ keys: '↑/↓  j/k', description: '移动书源' }, { keys: '空格', description: '选择当前书源' }, { keys: 'a', description: '全选或清除选择' }, { keys: 'c', description: '检测所选书源' }, { keys: 'x/e', description: '批量禁用/启用' }, { keys: 'f', description: '选择本次失败项' }, { keys: 'p', description: '设置优先级' }, { keys: '⎋', description: '取消检测或返回' }] },
    debug: { title: '当前页面 · 书源调试', entries: [{ keys: 'i', description: '修改搜索关键词' }, { keys: 'l', description: '处理流程' }, { keys: 'n', description: '请求列表' }, { keys: 'r', description: '原始响应' }, { keys: 'p', description: '解析摘要' }] },
  }
  const evidenceEntries = ['results', 'detail', 'sources', 'toc', 'reader'].includes(page) ? [{ keys: 'v', description: '查看当前页面最近请求' }] : page === 'diagnostics' ? [{ keys: 'g', description: '进入书源调试' }] : page === 'debug' ? [{ keys: 'y', description: '复制当前面板' }, { keys: 'e', description: '导出 Markdown 与 JSON' }] : []
  return [
    { title: '全局导航', entries: [{ keys: '↑/↓  j/k', description: '移动或滚动' }, { keys: 'Home/End  Ctrl+A/E', description: '跳到开头或结尾' }, { keys: '↵', description: '确认或打开' }, { keys: '⎋', description: '返回或取消' }, { keys: 'Ctrl+K', description: '搜索书籍' }, { keys: 'q', description: '退出' }, { keys: '?', description: '打开或关闭帮助' }] },
    ...(current[page] === undefined ? [] : [current[page]!]),
    ...(evidenceEntries.length === 0 ? [] : [{ title: '请求与解析查看', entries: evidenceEntries }]),
  ]
}

export function helpLines(page: Page, homeArea: number, columns = 80): string[] {
  const lines: string[] = []
  for (const section of helpSections(page, homeArea)) {
    const prefix = `── ${section.title} `
    lines.push(`${prefix}${'─'.repeat(Math.max(2, columns - terminalWidth(prefix)))}`.slice(0, Math.max(1, columns)))
    for (const entry of section.entries) lines.push(`  ${entry.keys.padEnd(16, ' ')}${entry.description}`)
    lines.push('')
  }
  return lines
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
  shift?: boolean
  tab?: boolean
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
  if (key.home || key.ctrl && input === 'a') return 0
  if (key.end || key.ctrl && input === 'e') return Math.max(0, total - 1)
  return index
}

export function navigationPage(scroll: number, total: number, input: string, key: InputKey, visible: number): number {
  if (input === 'j' || key.downArrow) return Math.min(Math.max(0, total - visible), scroll + 1)
  if (input === 'k' || key.upArrow) return Math.max(0, scroll - 1)
  if (key.pageDown || key.rightArrow) return Math.min(Math.max(0, total - visible), scroll + Math.max(1, visible - 1))
  if (key.pageUp || key.leftArrow) return Math.max(0, scroll - Math.max(1, visible - 1))
  if (key.home || key.ctrl && input === 'a') return 0
  if (key.end || key.ctrl && input === 'e') return Math.max(0, total - visible)
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
  return rank === 'exact' ? '完全匹配' : rank === 'kind' ? '分类命中' : rank === 'contains' ? '包含关键词' : '其他'
}

// Chapter mapping ignores punctuation and spacing so equivalent source titles can be aligned.
export function normalizeChapterTitle(value: string): string {
  return display(value).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export const HELP_PAGES: readonly Page[] = ['config', 'home', 'search', 'results', 'detail', 'toc', 'reader', 'sources', 'mapping', 'settings', 'diagnostics', 'debug', 'source-manager']

export function pageLabel(page: Page): string {
  return ({ config: '配置', home: '首页', search: '搜索', results: '搜索结果', detail: '详情', toc: '目录', reader: '阅读', sources: '已知书源', mapping: '章节映射', help: '帮助', settings: '设置', diagnostics: '诊断', debug: '书源调试', 'source-manager': '书源管理' } as Record<Page, string>)[page]
}

export function homeAreaLabel(homeArea: number): string {
  return (['书架', '最近阅读', '搜索记录'] as const)[homeArea] ?? '书架'
}

export function previousPage(page: Page): Page {
  return page === 'config' ? 'config' : page === 'home' ? 'home' : page === 'search' ? 'home' : page === 'results' ? 'search' : page === 'detail' ? 'results' : page === 'toc' ? 'detail' : page === 'reader' ? 'toc' : page === 'sources' ? 'detail' : page === 'mapping' ? 'sources' : page === 'settings' ? 'home' : 'home'
}

export function sourceState(value: KnownSourceView['state']): string {
  return value === 'available' ? '可用' : value === 'stale' ? '需要重新搜索' : value === 'removed' ? '书源已移除' : '定义冲突'
}

export function activeEditionKey(book: OpenBookResult | undefined): string | undefined {
  return book?.reading?.activeEditionKey ?? book?.book.activeEditionKey
}

export interface FooterOptions {
  textInput?: boolean
  settingsEditing?: boolean
  settingsResetConfirm?: boolean
}

export function footerLayout(page: Page, busy: boolean, columns: number, searchState: SearchUiState, sourceSearchState: SearchUiState, menuOpen: boolean, homeArea: number, tocSearchActive = false, tocHasQuery = false, tocReversed = false, options: FooterOptions = {}): FooterLayout {
  const right: FooterAction[] = [
    { keys: '?', label: '帮助', priority: 1 },
    { keys: '⎋', label: '返回', priority: 0 },
    { keys: 'q', label: '退出', priority: 2 },
  ]
  let left: FooterAction[] = []
  let rightActions = page === 'home' || page === 'config' ? right.filter((item) => item.keys !== '⎋') : right
  if (menuOpen) {
    left = [{ keys: '↵', label: '执行', priority: 0 }]
    rightActions = [{ keys: '⎋', label: '关闭', priority: 0 }]
  }
  else if (page === 'home') left = [{ keys: '↵', label: homeArea === 2 ? '重复搜索' : '阅读', priority: 0 }, ...(homeArea === 2 ? [] : [{ keys: 'o', label: '操作', priority: 1 }]), { keys: 'm', label: '书源', priority: 2 }, { keys: 's', label: '设置', priority: 3 }]
  else if (page === 'settings') left = [{ keys: '↵', label: '编辑', priority: 0 }, { keys: 'r', label: '恢复默认', priority: 1 }]
  else if (page === 'search') left = [{ keys: '↵', label: '搜索', priority: 0 }]
  else if (page === 'results') {
    const searching = searchState === 'running' || searchState === 'cancelling'
    left = searching ? [{ keys: '⎋', label: '取消搜索', priority: 0 }] : [{ keys: '↵', label: '详情', priority: 0 }, { keys: 't', label: '目录', priority: 1 }, { keys: 'o', label: '操作', priority: 2 }]
    if (searching) rightActions = right.filter((item) => item.keys !== '⎋')
  } else if (page === 'sources') {
    const searching = sourceSearchState === 'running' || sourceSearchState === 'cancelling'
    left = searching ? [{ keys: '⎋', label: '取消搜索', priority: 0 }] : [{ keys: '↵', label: '切换', priority: 0 }, { keys: 't', label: '目录', priority: 1 }, { keys: 'm', label: '搜索更多', priority: 2 }]
    if (searching) rightActions = right.filter((item) => item.keys !== '⎋')
  } else if (page === 'source-manager' && busy) {
    left = [{ keys: '⎋', label: '取消检测', priority: 0 }]
    rightActions = right.filter((item) => item.keys !== '⎋')
  } else if (busy) {
    left = [{ keys: '⎋', label: '取消处理中', priority: 0 }]
    rightActions = right.filter((item) => item.keys !== '⎋')
  } else if (page === 'detail') left = [{ keys: '↵', label: '阅读', priority: 0 }, { keys: 't', label: '目录', priority: 1 }, { keys: 's', label: '换源', priority: 1 }, { keys: 'a', label: '书架', priority: 1 }]
  else if (page === 'toc') left = tocSearchActive ? [{ keys: '↵', label: '完成', priority: 0 }, { keys: '⎋', label: '清除', priority: 1 }] : [{ keys: '↵', label: '阅读', priority: 0 }, { keys: '/', label: '搜索', priority: 1 }, { keys: 'r', label: '刷新', priority: 2 }, { keys: 's', label: tocReversed ? '正序' : '倒序', priority: 3 }, ...(tocHasQuery ? [{ keys: '⎋', label: '清除筛选', priority: 4 }] : [])]
  else if (page === 'reader') left = [{ keys: 'i', label: '信息', priority: 0 }, { keys: 't', label: '目录', priority: 1 }, { keys: 's', label: '换源', priority: 1 }, { keys: 'a', label: '书架', priority: 1 }, { keys: 'r', label: '刷新', priority: 1 }]
  else if (page === 'mapping') left = [{ keys: '↵', label: '确认切换', priority: 0 }, { keys: '⎋', label: '取消', priority: 1 }]
  else if (page === 'source-manager') left = [{ keys: '空格', label: '选择', priority: 0 }, { keys: 'c', label: '检测', priority: 1 }, { keys: 'x', label: '禁用', priority: 2 }, { keys: 'e', label: '启用', priority: 3 }, { keys: 'f', label: '失败项', priority: 4 }]
  else if (page === 'config') left = [{ keys: 's', label: '设置', priority: 0 }]
  if (options.settingsResetConfirm) {
    left = [{ keys: '↵', label: '确认', priority: 0 }]
    rightActions = [{ keys: '⎋', label: '取消', priority: 0 }]
  } else if (options.settingsEditing) {
    left = [{ keys: '↵', label: '保存', priority: 0 }, { keys: '⎋', label: '取消', priority: 1 }]
    rightActions = []
  }
  if (options.textInput) {
    rightActions = rightActions.filter((item) => item.keys !== '?' && item.keys !== 'q').map((item) => item.keys === '⎋' ? { ...item, label: page === 'search' ? '返回' : page === 'toc' ? '清除' : '取消' } : item)
  } else if (left.some((item) => item.keys === '⎋')) rightActions = rightActions.filter((item) => item.keys !== '⎋')
  const leftText = layoutFooter(left, columns)
  const availableRight = Math.max(1, columns - terminalWidth(leftText) - (leftText.length > 0 ? 3 : 0))
  return { left: leftText, right: layoutFooter(rightActions, availableRight) }
}

/** 兼容纯文本调用方；渲染层使用 footerLayout 以实现左右分栏。 */
export function footer(...args: Parameters<typeof footerLayout>): string {
  const value = footerLayout(...args)
  return [value.left, value.right].filter((item) => item.length > 0).join('   ')
}

export function sourceManagerEntries(catalog: SourceCatalogResult, filter: string, filterMode: number): SourceEntry[] {
  const query = filter.trim().toLocaleLowerCase('zh-Hans')
  return catalog.entries.filter((entry) => {
    const text = `${entry.source.bookSourceName} ${entry.source.bookSourceUrl} ${String(entry.source.bookSourceGroup ?? '')}`.toLocaleLowerCase('zh-Hans')
    const match = query.length === 0 || text.includes(query)
    const modeMatch = filterMode === 1 ? entry.state === 'available' : filterMode === 2 ? entry.state === 'disabled' : filterMode === 3 ? entry.check?.status === 'failed' : true
    return match && modeMatch
  })
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError'
}
