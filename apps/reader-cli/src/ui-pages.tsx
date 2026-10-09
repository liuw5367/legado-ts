import React from 'react'
import { Box, Text } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import type { ReaderApplication, OpenBookResult, SearchOperationResult, SearchProgress, TocResult } from './application.ts'
import type { HomeBookView, KnownSourceView, ReaderSettings } from './storage.ts'
import { layoutContent } from './content-layout.ts'
import type { ContentBlockKind } from './content-format.ts'
import type { DebugCapture, DebugStage, ProcessRecord, RequestRecord } from './debug-capture.ts'
import type { DebugRunner } from './debug-runner.ts'
import type { SourceCheckProgress, SourceCheckResult } from './application-model.ts'
import { READER_SETTING_FIELDS, readerSettingDisplayValue } from './reader-settings.ts'
import { formatReaderHeader } from './reader-header.ts'
import { formatDisplayTime, formatSourceTime } from './time-format.ts'
import { orderSourceViews } from './source-order.ts'
import {
  activeEditionKey,
  activeReadingChapter,
  display,
  formatDuration,
  formatProgress,
  helpLines,
  homeAreaLabel,
  homeItemsForArea,
  pageLabel,
  filterChapterIndices,
  searchHeaderStatus,
  searchMatchLabel,
  sourceState,
  sourceManagerEntries,
  type Page,
  type SearchUiState,
  HELP_PAGES,
} from './ui-model.ts'
import { clipTerminalText, terminalWidth } from './ui-actions.ts'
import { pagePosition, viewportFor } from './viewport.ts'

export interface RenderState {
  catalog: SourceCatalogResult
  columns: number
  home: HomeBookView[]
  history: Awaited<ReturnType<ReaderApplication['searchHistory']>>
  homeArea: number
  selected: number
  listStart: number
  bodyHeight: number
  tocSelected: number
  tocQuery: string
  tocReversed: boolean
  query: string
  search: SearchOperationResult | undefined
  searchState: SearchUiState
  searchProgress: SearchProgress | undefined
  searchElapsedMs: number
  book: OpenBookResult | undefined
  toc: TocResult | undefined
  chapterIndex: number
  contentLines: string[]
  contentLineKinds: Array<ContentBlockKind | undefined> | undefined
  readerLine: number
  sources: KnownSourceView[]
  sourceSearch: SearchOperationResult | undefined
  sourceSearchState: SearchUiState
  sourceSearchStart: number
  sourceSearchSelected: number
  mappingToc: TocResult | undefined
  mappingIndex: number
  mappingTarget: KnownSourceView | undefined
  pageScroll: number
  message: string
  helpPage: Page
  chapterCharacters: number
  separator: boolean
  debugRunner?: DebugRunner
  debugCapture?: DebugCapture
  debugPanel: 'flow' | 'requests' | 'response' | 'parsed'
  debugRequestSelected: number
  debugResultSelected: number
  debugFilter: string
  sourceManagerSelected: number
  sourceManagerSelectedIds: readonly string[]
  sourceManagerFilter: string
  sourceManagerFilterMode: number
  sourceCheckProgress?: SourceCheckProgress
  sourceCheckResults: readonly SourceCheckResult[]
  readerSettings: ReaderSettings
  settingsSelected: number
  settingsStart: number
  settingsEditing: boolean
  settingsValue: string
  settingsCursor: number
  settingsResetConfirm: boolean
}

export interface PageHeader {
  left: string
  right: string
  separator: string
  rightSegments?: readonly string[]
}

export function pageHeader(page: Page, state: RenderState): PageHeader {
  const bookName = state.book?.book.name ?? ''
  const chapterName = state.toc?.chapters[state.chapterIndex]?.title ?? ''
  const readerPage = page === 'reader' ? pagePosition(state.readerLine, state.contentLines.length, state.bodyHeight) : undefined
  const readerHeader = page === 'reader' ? formatReaderHeader({
    bookName,
    chapterName,
    chapterIndex: state.chapterIndex,
    chapterTotal: state.toc?.chapters.length ?? 0,
    pageCurrent: readerPage?.current ?? 1,
    pageTotal: readerPage?.total ?? 1,
    chapterCharacters: state.chapterCharacters,
    message: state.message,
    settings: state.readerSettings,
  }) : undefined
  const readerTitle = readerHeader?.left ?? `${bookName} · ${chapterName} · ${state.chapterIndex + 1}/${state.toc?.chapters.length ?? 0} 章`
  const pageName = page === 'home' ? `首页 · ${homeAreaLabel(state.homeArea)}` : page === 'config' ? '书源配置' : page === 'settings' ? '设置' : page === 'search' ? '搜索书籍' : page === 'results' ? `搜索 · ${state.query}` : page === 'detail' ? bookName || '书籍信息' : page === 'toc' ? `目录 · ${bookName}` : page === 'reader' ? readerTitle : page === 'sources' ? `${bookName} / 书源` : page === 'mapping' ? `${bookName} / 章节映射` : page === 'help' ? `帮助 · ${pageLabel(state.helpPage)}` : page === 'diagnostics' ? '诊断' : page === 'debug' ? `书源调试 · ${state.debugRunner?.source.source.bookSourceName ?? state.debugCapture?.sourceName ?? '最近操作'}` : page === 'source-manager' ? '书源管理' : '配置'
  const left = page === 'reader' || page === 'toc' || page === 'home' || page === 'results' ? pageName : `Legado Reader · ${pageName}`
  let right = ''
  if (page === 'home') right = `${state.catalog.entries.filter((entry) => entry.state === 'available').length}/${state.catalog.entries.length} 个书源可用`
  if (page === 'source-manager') right = `${state.sourceManagerSelectedIds.length} 个已选 · ${state.catalog.entries.length} 个书源`
  if (right.length === 0 && page === 'results') right = searchHeaderStatus(state.searchState, state.searchProgress, state.searchElapsedMs, state.search?.groups.length ?? 0, state.message)
  if (right.length === 0 && page === 'toc') {
    const matches = filterChapterIndices(state.toc?.chapters ?? [], state.tocQuery)
    const sourceMode = state.toc?.edition.editionKey === activeEditionKey(state.book) ? '当前' : '预览'
    right = `${sourceMode} · ${state.tocReversed ? '倒序' : '正序'} · ${state.toc?.source.source.bookSourceName ?? ''} · ${matches.length} 项${state.tocQuery.length > 0 ? ` · ${state.tocQuery}` : ''}`
  }
  if (right.length === 0 && page === 'reader') {
    right = readerHeader?.right ?? ''
  }
  if (right.length === 0 && page === 'sources') right = `${state.sources.length} 个来源`
  if (page !== 'results' && page !== 'reader') {
    if (right.length === 0 || !['toc'].includes(page)) {
      if (state.message.length > 0) right = state.message
    } else if (state.message.length > 0) right = `${right} · ${state.message}`
  }
  return {
    left: page === 'reader' ? display(left) : left,
    right: page === 'reader' ? display(right) : right,
    separator: readerHeader?.separator ?? ' · ',
    ...(readerHeader === undefined ? {} : { rightSegments: readerHeader.rightParts.map(display) }),
  }
}

export function renderPage(page: Page, state: RenderState): React.ReactElement {
  if (page === 'config') return renderConfig(state.catalog, state.pageScroll, state.bodyHeight)
  if (page === 'settings') return renderSettings(state.readerSettings, state.settingsSelected, state.settingsStart, state.bodyHeight, state.settingsEditing, state.settingsValue, state.settingsCursor, state.settingsResetConfirm)
  if (page === 'home') return renderHome(state.home, state.history, state.homeArea, state.selected, state.listStart, state.bodyHeight)
  if (page === 'source-manager') return renderSourceManager(state)
  if (page === 'search') return <Text dimColor>在底部输入书名，按 ↵ 搜索。</Text>
  if (page === 'results') return renderResults(state.search, state.selected, state.listStart, state.bodyHeight, state.searchState)
  if (page === 'detail') return renderDetail(state.book, state.pageScroll, state.bodyHeight, state.columns)
  if (page === 'toc') return renderToc(state.toc, state.tocSelected, state.tocQuery, state.listStart, state.bodyHeight)
  if (page === 'reader') return renderReader(state.contentLines, state.contentLineKinds, state.readerLine, state.bodyHeight)
  if (page === 'sources') return renderSources(state.sources, state.book, state.selected, state.listStart, state.sourceSearch, state.sourceSearchState, state.sourceSearchStart, state.sourceSearchSelected, state.bodyHeight, state.searchProgress)
  if (page === 'mapping') return renderMapping(state.toc, state.chapterIndex, state.mappingToc, state.mappingIndex, state.mappingTarget, state.pageScroll, state.bodyHeight)
  if (page === 'help') return renderHelp(state.helpPage, state.homeArea, state.columns, state.pageScroll, state.bodyHeight)
  if (page === 'diagnostics') return renderDiagnostics(state.catalog, state.selected, state.pageScroll, state.bodyHeight)
  return renderDebug(state.debugRunner, state.debugCapture, state.debugPanel, state.debugRequestSelected, state.debugResultSelected, state.debugFilter, state.pageScroll, state.bodyHeight)
}

function renderConfig(catalog: SourceCatalogResult, scroll: number, height: number): React.ReactElement {
  const lines = ['使用 legado-reader --source <文件、目录或 HTTP(S) JSON 地址>', '或设置 LEGADO_READER_SOURCE 后重新启动。', ...catalog.diagnostics.map((item) => `[!] ${item}`)]
  return renderLineViewport(lines, scroll, height)
}

function renderSettings(settings: ReaderSettings, selected: number, start: number, height: number, editing: boolean, value: string, cursor: number, resetConfirm: boolean): React.ReactElement {
  const visible = Math.max(1, Math.floor(Math.max(1, height - 2) / 2))
  const range = viewportFor(selected, READER_SETTING_FIELDS.length, visible, start)
  const rows = READER_SETTING_FIELDS.slice(range.start, range.end).map((field, offset) => {
    const index = range.start + offset
    const raw = index === selected && editing ? value : String(settings[field.key])
    const position = Math.max(0, Math.min(cursor, raw.length))
    const editingValue = field.kind === 'number' && index === selected && editing ? raw.slice(0, position) + '█' + raw.slice(position) : readerSettingDisplayValue(field, raw)
    const shown = index === selected && editing && field.kind === 'number' ? editingValue : readerSettingDisplayValue(field, index === selected && editing ? value : String(settings[field.key]))
    return <Box key={field.key} flexDirection="column"><Text color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{field.label}：{shown}</Text><Text dimColor>     {field.description}{field.kind === 'number' ? `（范围 ${1}–${32}）` : ''}</Text></Box>
  })
  const rangeHint = READER_SETTING_FIELDS.length > visible ? `（${range.start + 1}–${range.end}/${READER_SETTING_FIELDS.length}）` : ''
  return <Box flexDirection="column"><Text bold>应用设置{rangeHint}</Text>{rows}<Text dimColor>保存后对下一次批量操作生效，当前操作不会改变。</Text>{resetConfirm ? <Text color="yellow">确认恢复默认值？按 Enter 确认，Esc 取消。</Text> : null}</Box>
}

function renderHome(items: HomeBookView[], history: Awaited<ReturnType<ReaderApplication['searchHistory']>>, area: number, selected: number, start: number, height: number): React.ReactElement {
  const books = homeItemsForArea(items, area)
  const title = '[1] 书架   [2] 最近阅读   [3] 搜索记录'
  if (area === 2) {
    const range = viewportFor(selected, history.length, Math.max(1, height - 1), start)
    const body = history.slice(range.start, range.end).map((item, offset) => {
      const index = range.start + offset
      return <Text key={item.id} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(item.keyword)} · {formatDisplayTime(item.completedAt ?? item.startedAt)} · {item.summary.candidates} 个结果</Text>
    })
    return <Box flexDirection="column"><Text bold>{title}</Text>{body.length === 0 ? <Text>还没有搜索记录。</Text> : body}</Box>
  }
  const visible = Math.max(1, Math.floor((height - 1) / 2))
  const range = viewportFor(selected, books.length, visible, start)
  const body = books.slice(range.start, range.end).map((item, offset) => {
    const index = range.start + offset
    return <Box key={item.book.bookId} flexDirection="column"><Text wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(item.book.name)} · {display(item.book.author ?? '作者未知')} {item.isOnBookshelf ? '[书架]' : item.reading === undefined ? '' : '[未加入]'}</Text><Text wrap="truncate-end" dimColor>  当前章节：{display(item.currentChapter ?? '尚未开始阅读')} · 上次阅读：{item.lastReadAt === undefined ? '—' : formatDisplayTime(item.lastReadAt)}</Text></Box>
  })
  return <Box flexDirection="column"><Text bold>{title}</Text>{body.length === 0 ? <Text>{area === 0 ? '书架为空，可按 Ctrl+K 搜索书籍。' : '还没有阅读记录。'}</Text> : body}</Box>
}

function renderResults(search: SearchOperationResult | undefined, selected: number, start: number, height: number, state: SearchUiState): React.ReactElement {
  const groups = search?.groups ?? []
  const range = viewportFor(selected, groups.length, Math.max(1, height), start)
  const body = groups.slice(range.start, range.end).map((group, offset) => {
    const index = range.start + offset
    const first = group.candidates[0]
    const sourceCount = group.candidates.length > 1 ? ` · +${group.candidates.length - 1} 个书源` : ''
    const duration = first?.searchDurationMs === undefined ? '耗时未知' : `耗时 ${formatDuration(first.searchDurationMs)}`
    return <Text key={group.key} wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(group.candidate.name ?? group.candidate.bookUrl)} · {display(group.candidate.author ?? '作者未知')} · {display(group.source.source.bookSourceName)}{sourceCount} · {searchMatchLabel(group.rank)} · {duration}</Text>
  })
  return <Box flexDirection="column">{body.length === 0 ? <Text>{state === 'running' || state === 'cancelling' ? '等待第一个书源返回…' : '没有匹配结果。'}</Text> : body}</Box>
}

function renderDetail(book: OpenBookResult | undefined, scroll: number, height: number, width: number): React.ReactElement {
  const active = book?.sources.find((item) => item.editionKey === (book.reading?.activeEditionKey ?? book.book.activeEditionKey)) ?? book?.sources[0]
  const introLines = layoutContent(book?.book.intro ?? '书源未返回简介', Math.max(8, width - 10)).lines
  const lines = [
    `作者       ${book?.book.author ?? '未知'}`,
    `当前书源   ${book?.source.source.bookSourceName ?? '未知'} · 搜索耗时 ${active?.searchDurationMs === undefined ? '未知' : formatDuration(active.searchDurationMs)}`,
    `最新章节   ${active?.lastChapter ?? book?.metadata?.lastChapter ?? '未知'}`,
    `更新时间   ${formatSourceTime(active?.updateTime ?? book?.metadata?.updateTime)}`,
    `书架       ${book?.onBookshelf === true ? '已加入' : '未加入'}`,
    `阅读记录   ${book?.reading?.lastReadAt === undefined ? '暂无' : formatDisplayTime(book.reading.lastReadAt)} · 当前章节：${activeReadingChapter(book)}`,
    '简介',
    ...introLines.map((line) => `  ${line}`),
  ]
  return renderLineViewport(lines, scroll, height)
}

function renderToc(toc: TocResult | undefined, selected: number, query: string, start: number, height: number): React.ReactElement {
  const chapters = toc?.chapters ?? []
  const matches = filterChapterIndices(chapters, query).map((index) => ({ chapter: chapters[index]!, index }))
  const range = viewportFor(selected, matches.length, Math.max(1, height), start)
  const body = matches.slice(range.start, range.end).map(({ chapter, index }, offset) => {
    const isSelected = range.start + offset === selected
    return <Text key={chapter.chapterUrl} wrap="truncate-end" color={isSelected ? 'yellow' : 'white'}>{isSelected ? '> ' : '  '}{index + 1}. {display(chapter.title)}</Text>
  })
  return <Box flexDirection="column">{body.length === 0 ? <Text>{query.length === 0 ? '目录为空。' : '没有匹配的章节。'}</Text> : body}</Box>
}

function renderReader(lines: string[], lineKinds: Array<ContentBlockKind | undefined> | undefined, line: number, height: number): React.ReactElement {
  if (lines.length === 0 || lines.every((value) => value.trim().length === 0)) return <Text>章节内容为空。</Text>
  return <Box flexDirection="column">{lines.slice(line, line + Math.max(1, height)).map((value, offset) => {
    const kind = lineKinds?.[line + offset]
    const style = kind === 'heading' ? { bold: true, color: 'cyan' as const } : kind === 'quote' ? { color: 'cyan' as const } : kind === 'preformatted' ? { color: 'gray' as const } : kind === 'separator' ? { dimColor: true } : {}
    return <Text key={`${line + offset}-${value}`} {...style}>{display(value)}</Text>
  })}</Box>
}

function renderSources(items: KnownSourceView[], book: OpenBookResult | undefined, selected: number, start: number, sourceSearch: SearchOperationResult | undefined, state: SearchUiState, sourceSearchStart: number, sourceSearchSelected: number, height: number, progress: SearchProgress | undefined): React.ReactElement {
  const searching = state === 'running' || state === 'cancelling'
  const orderedItems = orderSourceViews(items, activeEditionKey(book))
  const visibleItems = Math.max(1, Math.floor((height - (sourceSearch === undefined ? 1 : 2)) / 2))
  const range = viewportFor(selected, orderedItems.length, visibleItems, start)
  const body = orderedItems.slice(range.start, range.end).map((item, offset) => {
    const index = range.start + offset
    const current = item.editionKey === activeEditionKey(book)
    const status = current ? '[当前]' : item.state === 'available' ? '[可用]' : `[${sourceState(item.state)}]`
    const badges = status
    return <Box key={item.editionKey} flexDirection="column"><Text wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {badges} {display(item.sourceName ?? item.name ?? item.sourceId)}</Text><Text wrap="truncate-end" dimColor>     最新章节：{chapterTitle(item.lastChapter)} · 更新时间：{formatSourceTime(item.updateTime)} · 搜索耗时：{item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)}</Text></Box>
  })
  const matchedRows = sourceSearch?.results.map((item, index) => <Box key={`${item.candidate.sourceId}:${item.candidate.bookUrl}`} flexDirection="column"><Text wrap="truncate-end" color={index === sourceSearchSelected ? 'yellow' : 'green'}>{index === sourceSearchSelected ? '> ' : '+ '}{index + 1}. [可用] {display(item.source.source.bookSourceName)} · {display(item.candidate.name ?? '未知')} · {display(item.candidate.author ?? '未知')}</Text><Text wrap="truncate-end" dimColor>     最新章节：{chapterTitle(item.candidate.lastChapter)} · 更新时间：{formatSourceTime(item.candidate.updateTime)} · 搜索耗时：{item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)}</Text></Box>) ?? []
  const matched = sourceSearch?.results.length ?? 0
  const unmatched = progress === undefined ? 0 : Math.max(0, progress.candidates - matched)
  const searchLines = sourceSearch === undefined ? [] : [searching ? `${progress === undefined ? '搜索更多书源…' : formatProgress(progress)} · 已匹配 ${matched} 个 · 未匹配 ${unmatched} 个` : `已匹配 ${matched} 个候选 · 总耗时 ${formatDuration(sourceSearch.elapsedMs)}`]
  const matchedRange = viewportFor(sourceSearchSelected, matchedRows.length, Math.max(1, Math.floor((height - 2) / 2)), sourceSearchStart)
  const visibleMatchedRows = matchedRows.slice(matchedRange.start, matchedRange.end)
  const visibleBody = searching ? [] : body
  return <Box flexDirection="column">{searchLines.map((item) => <Text key={item} color="cyan">{item}</Text>)}{searching ? visibleMatchedRows : null}{visibleBody.length === 0 && visibleMatchedRows.length === 0 ? <Text>{sourceSearch === undefined ? '尚未搜索到书源。' : '没有书名和作者都完整匹配的候选。'}</Text> : visibleBody}</Box>
}

const chapterTitleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function chapterTitle(value: string | undefined): string {
  const title = display(value ?? '未知')
  return Array.from(chapterTitleSegmenter.segment(title), (item) => item.segment).slice(0, 20).join('')
}

function renderMapping(toc: TocResult | undefined, index: number, targetToc: TocResult | undefined, targetIndex: number, target: KnownSourceView | undefined, scroll: number, height: number): React.ReactElement {
  const lines = [`原源  ${toc?.source.source.bookSourceName ?? ''}`, `目标源  ${target?.sourceName ?? target?.name ?? ''}`, `当前章节  ${toc?.chapters[index]?.title ?? '尚未选择章节'}`, `目标章节  ${targetToc?.chapters[targetIndex]?.title ?? '未找到，需要手动选择'}`]
  return renderLineViewport(lines, scroll, height)
}

function renderHelp(page: Page, homeArea: number, columns: number, scroll: number, height: number): React.ReactElement {
  const index = Math.max(0, HELP_PAGES.indexOf(page))
  const tabTokens = HELP_PAGES.map((item, itemIndex) => itemIndex === index ? `[${pageLabel(item)}]` : pageLabel(item))
  const tabs: string[] = []
  for (let offset = 0; offset < tabTokens.length; offset += 1) {
    const itemIndex = (index + offset) % tabTokens.length
    const token = tabTokens[itemIndex]!
    const candidate = tabs.length === 0 ? token : `${tabs.join('  ')}  ${token}`
    if (terminalWidth(candidate) > Math.max(8, columns - 4)) break
    tabs.push(token)
  }
  const hasMore = tabs.length < tabTokens.length
  const tabLine = `${index > 0 ? '‹ ' : ''}${tabs.join('  ')}${hasMore ? ' ›' : ''}`
  const lines = helpLines(page, homeArea, columns)
  return <Box flexDirection="column"><Text bold color="cyan" wrap="truncate-end">{clipTerminalText(tabLine, columns)}</Text><Text dimColor>Tab/Shift+Tab 或 ←/→ 切换页面 · ↑/↓ 滚动 · Ctrl+A/E 首尾</Text>{renderLineViewport(lines, scroll, Math.max(1, height - 2))}</Box>
}

function renderDiagnostics(catalog: SourceCatalogResult, selected: number, scroll: number, height: number): React.ReactElement {
  const entries = catalog.entries
  const lines = [
    `来源 ${entries.filter((item) => item.state === 'available').length} 可用 · ${entries.filter((item) => item.state === 'disabled').length} 禁用 · ${entries.filter((item) => item.state === 'unsupported').length} 不支持 · ${entries.filter((item) => item.state === 'conflict').length} 冲突`,
    `位置：${catalog.sourceLocation || '未配置'}`,
    '',
    '书源列表',
    ...entries.map((entry, index) => `${index === selected ? '> ' : '  '}${index + 1}. [${entry.state}] ${entry.source.bookSourceName} · ${entry.source.bookSourceUrl}${entry.reason === undefined ? '' : ` · ${entry.reason}`}`),
    '',
    '加载诊断',
    ...(catalog.diagnostics.length === 0 ? ['没有加载诊断。'] : catalog.diagnostics.map((item) => `[!] ${item}`)),
  ]
  return renderLineViewport(lines, scroll, height)
}

function renderSourceManager(state: RenderState): React.ReactElement {
  const entries = sourceManagerEntries(state.catalog, state.sourceManagerFilter, state.sourceManagerFilterMode)
  const range = viewportFor(state.sourceManagerSelected, entries.length, Math.max(1, state.bodyHeight - 3), state.pageScroll)
  const rows = entries.slice(range.start, range.end).map((entry, offset) => {
    const index = range.start + offset
    const selected = state.sourceManagerSelectedIds.includes(entry.id)
    const focused = index === state.sourceManagerSelected
    const status = entry.state === 'available' ? '启用' : entry.state === 'disabled' ? '禁用' : entry.state === 'unsupported' ? '不支持' : '冲突'
    const check = entry.check === undefined ? '未检测' : entry.check.status === 'passed' ? '通过' : entry.check.status === 'failed' ? `失败:${entry.check.failedStages.join('/') || '请求'}` : entry.check.status === 'cancelled' ? '已取消' : entry.check.status
    return <Box key={entry.id} flexDirection="column"><Text wrap="truncate-end" color={focused ? 'yellow' : selected ? 'cyan' : 'white'}>{focused ? '> ' : selected ? '* ' : '  '}{index + 1}. [{status}] {display(entry.source.bookSourceName)} · 优先级 {entry.customOrder ?? 0} · {check}</Text><Text wrap="truncate-end" dimColor>    {display(entry.source.bookSourceUrl)} · 连续失败 {entry.searchHealth?.consecutiveFailures ?? 0}</Text></Box>
  })
  const failed = state.sourceCheckResults.filter((item) => item.status === 'failed')
  const summary = state.sourceCheckResults.length === 0 ? [] : ['', `本次检测：${state.sourceCheckResults.filter((item) => item.status === 'passed' || item.status === 'failed').length}/${state.sourceCheckResults.length} 已完成 · 失败 ${failed.length}`, ...failed.map((item) => `失败：${display(item.sourceName)} · ${display(item.detail ?? item.failedStages.join('、'))}`)]
  const progress = state.sourceCheckProgress === undefined ? [] : [`检测进度：${state.sourceCheckProgress.completed}/${state.sourceCheckProgress.total} · 通过 ${state.sourceCheckProgress.passed} · 失败 ${state.sourceCheckProgress.failed}${state.sourceCheckProgress.currentStage === undefined ? '' : ` · ${state.sourceCheckProgress.currentStage}`}`]
  return <Box flexDirection="column"><Text bold>书源管理　[空格]选择 [a]全选 [c]检测 [x]禁用 [e]启用 [f]选择本次失败 [p]优先级</Text><Text dimColor>筛选：{state.sourceManagerFilter || '全部'} · 可见 {entries.length} · 已选 {state.sourceManagerSelectedIds.length}{state.sourceCheckProgress === undefined ? '' : ' · 检测中'}</Text>{progress}{rows.length === 0 ? <Text>没有匹配的书源。</Text> : rows}{summary.map((line) => <Text key={line} wrap="truncate-end" color={line.startsWith('失败：') ? 'red' : 'cyan'}>{line}</Text>)}</Box>
}

function renderDebug(runner: DebugRunner | undefined, capture: DebugCapture | undefined, panel: 'flow' | 'requests' | 'response' | 'parsed', selected: number, resultSelected: number, filter: string, scroll: number, height: number): React.ReactElement {
  const active = runner?.capture ?? capture
  if (active === undefined) return renderLineViewport(['没有可查看的调试记录。', '', '可从诊断页按 g 开始书源调试。'], scroll, height)
  const snapshot = active.snapshot()
  const stage = runner?.state.stage
  const header = [`面板：${panelLabel(panel)} · 请求 ${snapshot.requests.length} · 流程 ${snapshot.processes.length}${snapshot.truncated ? ' · 有截断' : ''}`, stage === undefined ? '' : `阶段：${stage} · 关键词：${runner?.state.keyword ?? ''} · 书源：${runner?.source.source.bookSourceName ?? ''}`, filter.length === 0 ? '' : `过滤：${filter}`].filter((line) => line.length > 0)
  const visibleRequests = filterRequests(snapshot.requests, filter)
  const body = panel === 'flow' ? processLines(snapshot.processes, filter) : panel === 'requests' ? requestLines(visibleRequests, selected) : panel === 'response' ? responseLines(visibleRequests[selected], filter) : parsedLines(snapshot.stages, runner, resultSelected)
  return renderLineViewport([...header, '', ...body], scroll, height)
}

function panelLabel(panel: 'flow' | 'requests' | 'response' | 'parsed'): string {
  return panel === 'flow' ? '处理流程' : panel === 'requests' ? '请求列表' : panel === 'response' ? '原始响应' : '解析摘要'
}

function processLines(items: readonly ProcessRecord[], filter: string): string[] {
  const visible = filter.length === 0 ? items : items.filter((item) => `${item.stage} ${item.kind} ${item.target} ${item.outputSummary ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  return visible.length === 0 ? ['没有匹配的处理记录。'] : visible.map((item) => `${String(item.sequence).padStart(3, ' ')} [${item.stage}] ${item.state.padEnd(9, ' ')} ${item.kind.padEnd(15, ' ')} ${display(item.target)}${item.requestId === undefined ? '' : ` · 请求 ${item.requestId}`}${item.inputSummary === undefined ? '' : ` · 输入 ${display(item.inputSummary)}`}${item.outputSummary === undefined ? '' : ` · 输出 ${display(item.outputSummary)}`}`)
}

function requestLines(items: readonly RequestRecord[], selected: number): string[] {
  return items.length === 0 ? ['没有匹配的请求。'] : items.map((item, index) => {
    const source = item.sourceName === undefined ? item.sourceId : item.sourceName
    const attempt = item.kind === 'bridge' ? ' · bridge' : item.attempt > 0 ? ` · 重试 ${item.attempt}` : ''
    return `${index === selected ? '> ' : '  '}${String(item.sequence).padStart(3, ' ')} [${item.stage}] ${display(source)} · ${item.status === undefined ? '----' : String(item.status).padStart(3, ' ')} ${String(item.durationMs).padStart(5, ' ')}ms ${item.method} ${display(item.url)}${attempt}${item.truncated ? ' · 截断' : ''}${item.error === undefined ? '' : ` · ${display(item.error)}`}`
  })
}

function filterRequests(items: readonly RequestRecord[], filter: string): RequestRecord[] {
  return filter.length === 0 ? [...items] : items.filter((item) => `${item.sequence} ${item.stage} ${item.sourceId} ${item.sourceName ?? ''} ${item.method} ${item.url} ${item.status ?? ''} ${item.error ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
}

function responseLines(item: RequestRecord | undefined, filter: string): string[] {
  if (item === undefined) return ['没有选中的请求。']
  const body = (item.responseText ?? '（没有可显示的响应正文）').split('\n')
  const matched = filter.length === 0 ? body : body.filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
  return [`请求 #${item.sequence}`, `来源   ${display(item.sourceName ?? item.sourceId)}`, `阶段   ${item.stage}`, `方法   ${item.method}`, `地址   ${display(item.finalUrl ?? item.url)}`, `状态   ${item.status === undefined ? item.error ?? '未完成' : `HTTP ${item.status}`}`, `耗时   ${item.durationMs}ms`, `大小   ${item.responseBytes} bytes${item.truncated ? '（已截断）' : ''}`, `重定向 ${item.redirected === true ? '是' : '否'}`, ...headerLines('请求头', item.headers), ...(item.requestBody === undefined ? [] : ['请求体', `  ${display(item.requestBody)}`]), ...headerLines('响应头', item.responseHeaders), ...(filter.length === 0 ? [] : [`匹配 ${matched.length}/${body.length} 行`]), '', ...(matched.length === 0 ? ['没有匹配的响应内容。'] : matched)]
}

function headerLines(label: string, headers: Readonly<Record<string, string | string[]>> | undefined): string[] {
  if (headers === undefined || Object.keys(headers).length === 0) return [`${label}   （无）`]
  return [label, ...Object.entries(headers).map(([key, value]) => `  ${key}: ${Array.isArray(value) ? value.join(', ') : value}`)]
}

function parsedLines(stages: readonly { stage: DebugStage; status: string; durationMs?: number; summary: Record<string, unknown> }[], runner: DebugRunner | undefined, selected: number): string[] {
  const lines = stages.flatMap((item) => [`${item.stage.padEnd(9, ' ')} ${item.status}${item.durationMs === undefined ? '' : ` · ${item.durationMs}ms`}`, ...Object.entries(item.summary).map(([key, value]) => `  ${key}: ${Array.isArray(value) ? value.join(', ') : value}`)])
  const state = runner?.state
  if (state !== undefined) {
    if (state.candidates.length > 0) lines.push('', `候选 ${state.candidates.length} 个`, ...state.candidates.slice(0, 20).map((item, index) => `${index === selected ? '> ' : '  '}${index + 1}. ${display(item.name ?? item.bookUrl)} · ${display(item.author ?? '作者未知')}`))
    if (state.chapters.length > 0) lines.push('', `章节 ${state.chapters.length} 个`, ...state.chapters.slice(0, 20).map((item, index) => `${index === selected ? '> ' : '  '}${index + 1}. ${display(item.title)}`))
    if (state.content !== undefined) lines.push('', `正文 ${state.content.cleaned.length} 字`)
  }
  return lines.length === 0 ? ['暂无解析摘要。'] : lines
}

function renderLineViewport(lines: readonly string[], scroll: number, height: number): React.ReactElement {
  const allLines = lines
  const range = viewportFor(scroll, allLines.length, Math.max(1, height), scroll)
  return <Box flexDirection="column">{allLines.slice(range.start, range.end).map((line, index) => {
    const absolute = range.start + index
    return <Text key={`${absolute}-${line}`}>{display(line)}</Text>
  })}</Box>
}
