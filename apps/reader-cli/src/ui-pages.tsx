import React from 'react'
import { Box, Text } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import type { ReaderApplication, OpenBookResult, SearchOperationResult, SearchProgress, TocResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import { layoutContent } from './content-layout.ts'
import type { ContentBlockKind } from './content-format.ts'
import { actionMenuLabel } from './action-menu.ts'
import { formatDisplayTime, formatSourceTime } from './time-format.ts'
import { orderSourceViews } from './source-order.ts'
import {
  HELP_LINES,
  activeEditionKey,
  activeReadingChapter,
  display,
  formatDuration,
  formatProgress,
  homeItemsForArea,
  searchMatchLabel,
  sourceState,
  type MenuState,
  type Page,
  type SearchUiState,
} from './ui-model.ts'
import { viewportFor } from './viewport.ts'

export interface RenderState {
  catalog: SourceCatalogResult
  columns: number
  home: HomeBookView[]
  history: Awaited<ReturnType<ReaderApplication['searchHistory']>>
  homeArea: number
  selected: number
  listStart: number
  bodyHeight: number
  query: string
  search: SearchOperationResult | undefined
  searchState: SearchUiState
  searchProgress: SearchProgress | undefined
  book: OpenBookResult | undefined
  toc: TocResult | undefined
  chapterIndex: number
  contentLines: string[]
  contentLineKinds: Array<ContentBlockKind | undefined> | undefined
  readerLine: number
  rows: number
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
}

export function renderPage(page: Page, state: RenderState): React.ReactElement {
  if (page === 'config') return renderConfig(state.catalog, state.message, state.pageScroll, state.bodyHeight)
  if (page === 'home') return renderHome(state.home, state.history, state.homeArea, state.selected, state.listStart, state.bodyHeight, state.message)
  if (page === 'search') return renderSearch(state.query, state.searchProgress, state.message)
  if (page === 'results') return renderResults(state.search, state.selected, state.listStart, state.bodyHeight, state.searchState, state.searchProgress, state.message)
  if (page === 'detail') return renderDetail(state.book, state.pageScroll, state.bodyHeight, state.columns, state.message)
  if (page === 'toc') return renderToc(state.toc, state.chapterIndex, state.listStart, state.bodyHeight, state.message)
  if (page === 'reader') return renderReader(state.book, state.toc, state.chapterIndex, state.contentLines, state.contentLineKinds, state.readerLine, state.rows, state.message)
  if (page === 'sources') return renderSources(state.sources, state.book, state.selected, state.listStart, state.sourceSearch, state.sourceSearchState, state.sourceSearchStart, state.sourceSearchSelected, state.bodyHeight, state.searchProgress, state.message)
  if (page === 'mapping') return renderMapping(state.book, state.toc, state.chapterIndex, state.mappingToc, state.mappingIndex, state.mappingTarget, state.pageScroll, state.bodyHeight, state.message)
  if (page === 'help') return renderHelp(state.pageScroll, state.bodyHeight)
  return renderDiagnostics(state.catalog.diagnostics, state.pageScroll, state.bodyHeight, state.message)
}

function renderConfig(catalog: SourceCatalogResult, message: string, scroll: number, height: number): React.ReactElement {
  const lines = ['需要配置书源', '使用 legado-reader --source <文件、目录或 HTTP(S) JSON 地址>', '或设置 LEGADO_READER_SOURCE 后重新启动。', ...catalog.diagnostics.map((item) => `[!] ${item}`)]
  return renderLineViewport(lines, scroll, height, message)
}

function renderHome(items: HomeBookView[], history: Awaited<ReturnType<ReaderApplication['searchHistory']>>, area: number, selected: number, start: number, height: number, message: string): React.ReactElement {
  const books = homeItemsForArea(items, area)
  const title = '[1] 书架   [2] 最近阅读   [3] 搜索记录'
  if (area === 2) {
    const range = viewportFor(selected, history.length, Math.max(1, height - 2), start)
    const body = history.slice(range.start, range.end).map((item, offset) => {
      const index = range.start + offset
      return <Text key={item.id} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(item.keyword)} · {formatDisplayTime(item.completedAt ?? item.startedAt)} · {item.summary.candidates} 个结果</Text>
    })
    return <Box flexDirection="column"><Text bold>{title}</Text>{body.length === 0 ? <Text>还没有搜索记录。</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
  }
  const visible = Math.max(1, Math.floor((height - 2) / 2))
  const range = viewportFor(selected, books.length, visible, start)
  const body = books.slice(range.start, range.end).map((item, offset) => {
    const index = range.start + offset
    return <Box key={item.book.bookId} flexDirection="column"><Text wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(item.book.name)} · {display(item.book.author ?? '作者未知')} {item.isOnBookshelf ? '[书架]' : item.reading === undefined ? '' : '[未加入]'}</Text><Text wrap="truncate-end" dimColor>  当前章节：{display(item.currentChapter ?? '尚未开始阅读')} · 上次阅读：{item.lastReadAt === undefined ? '—' : formatDisplayTime(item.lastReadAt)}</Text></Box>
  })
  return <Box flexDirection="column"><Text bold>{title}</Text>{body.length === 0 ? <Text>{area === 0 ? '书架为空，可按 Ctrl+K 搜索书籍。' : '还没有阅读记录。'}</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderSearch(query: string, progress: SearchProgress | undefined, message: string): React.ReactElement {
  return <Box flexDirection="column"><Text bold>搜索书籍</Text><Text>书名  {display(query)}█</Text>{progress === undefined ? message.length > 0 ? <Text color="yellow">{display(message)}</Text> : <Text>Enter 提交搜索，Esc 返回。</Text> : <Text color="cyan">{formatProgress(progress)}</Text>}{message.length > 0 && progress !== undefined ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderResults(search: SearchOperationResult | undefined, selected: number, start: number, height: number, state: SearchUiState, progress: SearchProgress | undefined, message: string): React.ReactElement {
  const groups = search?.groups ?? []
  const range = viewportFor(selected, groups.length, Math.max(1, height - 2), start)
  const body = groups.slice(range.start, range.end).map((group, offset) => {
    const index = range.start + offset
    const first = group.candidates[0]
    const sourceCount = group.candidates.length > 1 ? ` · +${group.candidates.length - 1} 个书源` : ''
    const duration = first?.searchDurationMs === undefined ? '耗时未知' : `耗时 ${formatDuration(first.searchDurationMs)}`
    return <Text key={group.key} wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(group.candidate.name ?? group.candidate.bookUrl)} · {display(group.candidate.author ?? '作者未知')} · {display(group.source.source.bookSourceName)}{sourceCount} · {searchMatchLabel(group.rank)} · {duration}</Text>
  })
  const status = state === 'running' || state === 'cancelling' ? (progress === undefined ? '正在搜索…' : formatProgress(progress)) : state === 'cancelled' ? '搜索已取消，保留已返回结果' : `${search?.groups.length ?? 0} 本书 · 总耗时 ${search === undefined ? '未知' : formatDuration(search.elapsedMs)}`
  return <Box flexDirection="column"><Text bold>搜索结果 · {display(search?.keyword ?? '')}</Text><Text color="cyan">{status}</Text>{body.length === 0 ? <Text>{state === 'running' || state === 'cancelling' ? '等待第一个书源返回…' : '没有匹配结果。'}</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderDetail(book: OpenBookResult | undefined, scroll: number, height: number, width: number, message: string): React.ReactElement {
  const active = book?.sources.find((item) => item.editionKey === (book.reading?.activeEditionKey ?? book.book.activeEditionKey)) ?? book?.sources[0]
  const introLines = layoutContent(book?.book.intro ?? '书源未返回简介', Math.max(8, width - 10)).lines
  const lines = [
    book?.book.name ?? '书籍详情',
    `作者       ${book?.book.author ?? '未知'}`,
    `当前书源   ${book?.source.source.bookSourceName ?? '未知'} · 搜索耗时 ${active?.searchDurationMs === undefined ? '未知' : formatDuration(active.searchDurationMs)}`,
    `最新章节   ${active?.lastChapter ?? book?.metadata?.lastChapter ?? '未知'}`,
    `更新时间   ${formatSourceTime(active?.updateTime ?? book?.metadata?.updateTime)}`,
    `书架       ${book?.onBookshelf === true ? '已加入 · [a] 移出书架' : '未加入 · [a] 加入书架'}`,
    `阅读记录   ${book?.reading?.lastReadAt === undefined ? '暂无' : formatDisplayTime(book.reading.lastReadAt)} · 当前章节：${activeReadingChapter(book)}`,
    '简介',
    ...introLines.map((line) => `  ${line}`),
  ]
  return renderLineViewport(lines, scroll, height, message)
}

function renderToc(toc: TocResult | undefined, selected: number, start: number, height: number, message: string): React.ReactElement {
  const chapters = toc?.chapters ?? []
  const range = viewportFor(selected, chapters.length, Math.max(1, height - 1), start)
  const body = chapters.slice(range.start, range.end).map((chapter, offset) => {
    const index = range.start + offset
    return <Text key={chapter.chapterUrl} wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(chapter.title)}</Text>
  })
  return <Box flexDirection="column"><Text bold>章节目录 · {chapters.length} 章</Text>{body.length === 0 ? <Text>目录为空。</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderReader(book: OpenBookResult | undefined, toc: TocResult | undefined, index: number, lines: string[], lineKinds: Array<ContentBlockKind | undefined> | undefined, line: number, rows: number, message: string): React.ReactElement {
  return <Box flexDirection="column"><Text bold>{display(book?.book.name ?? '')} · {display(toc?.chapters[index]?.title ?? '')}</Text>{lines.slice(line, line + Math.max(1, rows - 8)).map((value, offset) => {
    const kind = lineKinds?.[line + offset]
    const style = kind === 'heading' ? { bold: true, color: 'cyan' as const } : kind === 'quote' ? { color: 'cyan' as const } : kind === 'preformatted' ? { color: 'gray' as const } : kind === 'separator' ? { dimColor: true } : {}
    return <Text key={`${line + offset}-${value}`} {...style}>{display(value)}</Text>
  })}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderSources(items: KnownSourceView[], book: OpenBookResult | undefined, selected: number, start: number, sourceSearch: SearchOperationResult | undefined, state: SearchUiState, sourceSearchStart: number, sourceSearchSelected: number, height: number, progress: SearchProgress | undefined, message: string): React.ReactElement {
  const searching = state === 'running' || state === 'cancelling'
  const orderedItems = orderSourceViews(items, activeEditionKey(book))
  const visibleItems = Math.max(1, Math.floor((height - (sourceSearch === undefined ? 1 : 2)) / 2))
  const range = viewportFor(selected, orderedItems.length, visibleItems, start)
  const body = orderedItems.slice(range.start, range.end).map((item, offset) => {
    const index = range.start + offset
    const current = item.editionKey === activeEditionKey(book)
    const status = item.state === 'available' ? '可用' : sourceState(item.state)
    const badges = [status, ...(current ? ['当前'] : [])].map((value) => `[${value}]`).join(' ')
    return <Box key={item.editionKey} flexDirection="column"><Text wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {badges} {display(item.sourceName ?? item.name ?? item.sourceId)}</Text><Text wrap="truncate-end" dimColor>     最新章节：{display(item.lastChapter ?? '未知')} · 更新时间：{formatSourceTime(item.updateTime)} · 搜索耗时：{item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)}</Text></Box>
  })
  const matchedRows = sourceSearch?.results.map((item, index) => <Box key={`${item.candidate.sourceId}:${item.candidate.bookUrl}`} flexDirection="column"><Text wrap="truncate-end" color={index === sourceSearchSelected ? 'yellow' : 'green'}>{index === sourceSearchSelected ? '> ' : '+ '}{index + 1}. [可用] {display(item.source.source.bookSourceName)} · {display(item.candidate.name ?? '未知')} · {display(item.candidate.author ?? '未知')}</Text><Text wrap="truncate-end" dimColor>     最新章节：{display(item.candidate.lastChapter ?? '未知')} · 更新时间：{formatSourceTime(item.candidate.updateTime)} · 搜索耗时：{item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)}</Text></Box>) ?? []
  const matched = sourceSearch?.results.length ?? 0
  const unmatched = progress === undefined ? 0 : Math.max(0, progress.candidates - matched)
  const searchLines = sourceSearch === undefined ? [] : [searching ? `${progress === undefined ? '搜索更多书源…' : formatProgress(progress)} · 已匹配 ${matched} 个 · 未匹配 ${unmatched} 个` : `已匹配 ${matched} 个候选 · 总耗时 ${formatDuration(sourceSearch.elapsedMs)}`]
  const matchedRange = viewportFor(sourceSearchSelected, matchedRows.length, Math.max(1, Math.floor((height - 2) / 2)), sourceSearchStart)
  const visibleMatchedRows = matchedRows.slice(matchedRange.start, matchedRange.end)
  const visibleBody = searching ? [] : body
  return <Box flexDirection="column"><Text bold>已知书源 · 本地记录</Text>{searchLines.map((item) => <Text key={item} color="cyan">{item}</Text>)}{searching ? visibleMatchedRows : null}{visibleBody.length === 0 && visibleMatchedRows.length === 0 ? <Text>{sourceSearch === undefined ? '尚未搜索到书源。' : '没有书名和作者都完整匹配的候选。'}</Text> : visibleBody}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderMapping(book: OpenBookResult | undefined, toc: TocResult | undefined, index: number, targetToc: TocResult | undefined, targetIndex: number, target: KnownSourceView | undefined, scroll: number, height: number, message: string): React.ReactElement {
  const lines = ['确认切换书源', `书籍  ${book?.book.name ?? ''}`, `原源  ${toc?.source.source.bookSourceName ?? book?.source.source.bookSourceName ?? ''}`, `目标源  ${target?.sourceName ?? target?.name ?? ''}`, `当前章节  ${toc?.chapters[index]?.title ?? '尚未选择章节'}`, `目标章节  ${targetToc?.chapters[targetIndex]?.title ?? '未找到，需要手动选择'}`]
  return renderLineViewport(lines, scroll, height, message)
}

function renderHelp(scroll: number, height: number): React.ReactElement {
  return renderLineViewport(HELP_LINES, scroll, height)
}

function renderDiagnostics(items: readonly string[], scroll: number, height: number, message: string): React.ReactElement {
  return renderLineViewport(['诊断', ...(items.length === 0 ? ['没有诊断信息。'] : items.map((item) => `[!] ${item}`))], scroll, height, message)
}

function renderLineViewport(lines: readonly string[], scroll: number, height: number, message = ''): React.ReactElement {
  const allLines = message.length > 0 ? [...lines, message] : [...lines]
  const range = viewportFor(scroll, allLines.length, Math.max(1, height), scroll)
  return <Box flexDirection="column">{allLines.slice(range.start, range.end).map((line, index) => {
    const absolute = range.start + index
    return <Text key={`${absolute}-${line}`} {...(message.length > 0 && absolute === allLines.length - 1 ? { color: 'yellow' as const } : {})}>{display(line)}</Text>
  })}</Box>
}

export function renderActionMenu(menu: MenuState, columns: number, rows: number): React.ReactElement {
  const maxLabelWidth = Math.max(0, ...menu.items.map((item) => actionMenuLabel(item).length))
  const width = Math.max(8, Math.min(Math.max(32, maxLabelWidth + 6), Math.max(8, columns - 4)))
  const contentTop = 3
  const contentHeight = Math.max(1, rows - contentTop - 2)
  const height = Math.min(contentHeight, menu.items.length + 3)
  const top = contentTop + Math.max(0, Math.floor((contentHeight - height) / 2))
  const left = Math.max(0, Math.floor((columns - width) / 2))
  return <Box position="absolute" top={top} left={left} width={width} height={height} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} backgroundColor="black" overflow="hidden">
    <Text bold color="cyan">操作</Text>
    {menu.items.map((item, index) => <Text key={item.action} wrap="truncate-end" color={index === menu.index ? 'yellow' : item.enabled ? 'white' : 'gray'}>{index === menu.index ? '> ' : '  '}{display(actionMenuLabel(item))}</Text>)}
  </Box>
}
