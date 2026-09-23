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
  type MenuState,
  type Page,
  type SearchUiState,
} from './ui-model.ts'
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
}

export function pageHeader(page: Page, state: RenderState): { left: string; right: string } {
  const bookName = state.book?.book.name ?? ''
  const chapterName = state.toc?.chapters[state.chapterIndex]?.title ?? ''
  const readerTitle = `${bookName} · ${chapterName} · ${state.chapterIndex + 1}/${state.toc?.chapters.length ?? 0} 章`
  const pageName = page === 'home' ? `首页 · ${homeAreaLabel(state.homeArea)}` : page === 'config' ? '书源配置' : page === 'search' ? '搜索书籍' : page === 'results' ? `搜索 · ${state.query}` : page === 'detail' ? bookName || '书籍信息' : page === 'toc' ? `目录 · ${bookName}` : page === 'reader' ? readerTitle : page === 'sources' ? `${bookName} / 书源` : page === 'mapping' ? `${bookName} / 章节映射` : page === 'help' ? `帮助 · ${pageLabel(state.helpPage)}` : page === 'diagnostics' ? '诊断' : '配置'
  const left = page === 'reader' || page === 'toc' || page === 'home' || page === 'results' ? pageName : `Legado Reader · ${pageName}`
  let right = ''
  if (page === 'home') right = `${state.catalog.entries.filter((entry) => entry.state === 'available').length}/${state.catalog.entries.length} 个书源可用`
  if (right.length === 0 && page === 'results') right = searchHeaderStatus(state.searchState, state.searchProgress, state.searchElapsedMs, state.search?.groups.length ?? 0, state.message)
  if (right.length === 0 && page === 'toc') {
    const matches = filterChapterIndices(state.toc?.chapters ?? [], state.tocQuery)
    const sourceMode = state.toc?.edition.editionKey === activeEditionKey(state.book) ? '当前' : '预览'
    right = `${sourceMode} · ${state.toc?.source.source.bookSourceName ?? ''} · ${matches.length} 项${state.tocQuery.length > 0 ? ` · ${state.tocQuery}` : ''}`
  }
  if (right.length === 0 && page === 'reader') {
    const pageCount = pagePosition(state.readerLine, state.contentLines.length, state.bodyHeight)
    right = `${pageCount.current}/${pageCount.total} 页 · ${state.chapterCharacters.toLocaleString('zh-CN')} 字`
  }
  if (right.length === 0 && page === 'sources') right = `${state.sources.length} 个来源`
  if (page !== 'results') {
    if (right.length === 0 || !['reader', 'toc'].includes(page)) {
      if (state.message.length > 0) right = state.message
    } else if (state.message.length > 0) right = `${right} · ${state.message}`
  }
  return { left, right }
}

export function renderPage(page: Page, state: RenderState): React.ReactElement {
  if (page === 'config') return renderConfig(state.catalog, state.pageScroll, state.bodyHeight)
  if (page === 'home') return renderHome(state.home, state.history, state.homeArea, state.selected, state.listStart, state.bodyHeight)
  if (page === 'search') return <Text dimColor>在底部输入书名，按 Enter 搜索。</Text>
  if (page === 'results') return renderResults(state.search, state.selected, state.listStart, state.bodyHeight, state.searchState)
  if (page === 'detail') return renderDetail(state.book, state.pageScroll, state.bodyHeight, state.columns)
  if (page === 'toc') return renderToc(state.toc, state.tocSelected, state.tocQuery, state.listStart, state.bodyHeight)
  if (page === 'reader') return renderReader(state.contentLines, state.contentLineKinds, state.readerLine, state.bodyHeight)
  if (page === 'sources') return renderSources(state.sources, state.book, state.selected, state.listStart, state.sourceSearch, state.sourceSearchState, state.sourceSearchStart, state.sourceSearchSelected, state.bodyHeight, state.searchProgress)
  if (page === 'mapping') return renderMapping(state.toc, state.chapterIndex, state.mappingToc, state.mappingIndex, state.mappingTarget, state.pageScroll, state.bodyHeight)
  if (page === 'help') return renderHelp(state.helpPage, state.homeArea, state.pageScroll, state.bodyHeight)
  return renderDiagnostics(state.catalog.diagnostics, state.pageScroll, state.bodyHeight)
}

function renderConfig(catalog: SourceCatalogResult, scroll: number, height: number): React.ReactElement {
  const lines = ['使用 legado-reader --source <文件、目录或 HTTP(S) JSON 地址>', '或设置 LEGADO_READER_SOURCE 后重新启动。', ...catalog.diagnostics.map((item) => `[!] ${item}`)]
  return renderLineViewport(lines, scroll, height)
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
    return <Box key={item.editionKey} flexDirection="column"><Text wrap="truncate-end" color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {badges} {display(item.sourceName ?? item.name ?? item.sourceId)}</Text><Text wrap="truncate-end" dimColor>     最新章节：{display(item.lastChapter ?? '未知')} · 更新时间：{formatSourceTime(item.updateTime)} · 搜索耗时：{item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)}</Text></Box>
  })
  const matchedRows = sourceSearch?.results.map((item, index) => <Box key={`${item.candidate.sourceId}:${item.candidate.bookUrl}`} flexDirection="column"><Text wrap="truncate-end" color={index === sourceSearchSelected ? 'yellow' : 'green'}>{index === sourceSearchSelected ? '> ' : '+ '}{index + 1}. [可用] {display(item.source.source.bookSourceName)} · {display(item.candidate.name ?? '未知')} · {display(item.candidate.author ?? '未知')}</Text><Text wrap="truncate-end" dimColor>     最新章节：{display(item.candidate.lastChapter ?? '未知')} · 更新时间：{formatSourceTime(item.candidate.updateTime)} · 搜索耗时：{item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)}</Text></Box>) ?? []
  const matched = sourceSearch?.results.length ?? 0
  const unmatched = progress === undefined ? 0 : Math.max(0, progress.candidates - matched)
  const searchLines = sourceSearch === undefined ? [] : [searching ? `${progress === undefined ? '搜索更多书源…' : formatProgress(progress)} · 已匹配 ${matched} 个 · 未匹配 ${unmatched} 个` : `已匹配 ${matched} 个候选 · 总耗时 ${formatDuration(sourceSearch.elapsedMs)}`]
  const matchedRange = viewportFor(sourceSearchSelected, matchedRows.length, Math.max(1, Math.floor((height - 2) / 2)), sourceSearchStart)
  const visibleMatchedRows = matchedRows.slice(matchedRange.start, matchedRange.end)
  const visibleBody = searching ? [] : body
  return <Box flexDirection="column">{searchLines.map((item) => <Text key={item} color="cyan">{item}</Text>)}{searching ? visibleMatchedRows : null}{visibleBody.length === 0 && visibleMatchedRows.length === 0 ? <Text>{sourceSearch === undefined ? '尚未搜索到书源。' : '没有书名和作者都完整匹配的候选。'}</Text> : visibleBody}</Box>
}

function renderMapping(toc: TocResult | undefined, index: number, targetToc: TocResult | undefined, targetIndex: number, target: KnownSourceView | undefined, scroll: number, height: number): React.ReactElement {
  const lines = [`原源  ${toc?.source.source.bookSourceName ?? ''}`, `目标源  ${target?.sourceName ?? target?.name ?? ''}`, `当前章节  ${toc?.chapters[index]?.title ?? '尚未选择章节'}`, `目标章节  ${targetToc?.chapters[targetIndex]?.title ?? '未找到，需要手动选择'}`]
  return renderLineViewport(lines, scroll, height)
}

function renderHelp(page: Page, homeArea: number, scroll: number, height: number): React.ReactElement {
  return renderLineViewport(helpLines(page, homeArea), scroll, height)
}

function renderDiagnostics(items: readonly string[], scroll: number, height: number): React.ReactElement {
  return renderLineViewport(items.length === 0 ? ['没有诊断信息。'] : items.map((item) => `[!] ${item}`), scroll, height)
}

function renderLineViewport(lines: readonly string[], scroll: number, height: number): React.ReactElement {
  const allLines = lines
  const range = viewportFor(scroll, allLines.length, Math.max(1, height), scroll)
  return <Box flexDirection="column">{allLines.slice(range.start, range.end).map((line, index) => {
    const absolute = range.start + index
    return <Text key={`${absolute}-${line}`}>{display(line)}</Text>
  })}</Box>
}

export function renderActionMenu(menu: MenuState, columns: number, rows: number): React.ReactElement {
  const maxLabelWidth = Math.max(0, ...menu.items.map((item) => actionMenuLabel(item).length))
  const width = Math.max(8, Math.min(Math.max(32, maxLabelWidth + 6), Math.max(8, columns - 4)))
  const contentTop = 1
  const contentHeight = Math.max(1, rows - contentTop - 2)
  const height = Math.min(contentHeight, menu.items.length + 3)
  const top = contentTop + Math.max(0, Math.floor((contentHeight - height) / 2))
  const left = Math.max(0, Math.floor((columns - width) / 2))
  return <Box position="absolute" top={top} left={left} width={width} height={height} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} backgroundColor="black" overflow="hidden">
    <Text bold color="cyan">操作</Text>
    {menu.items.map((item, index) => <Text key={item.action} wrap="truncate-end" color={index === menu.index ? 'yellow' : item.enabled ? 'white' : 'gray'}>{index === menu.index ? '> ' : '  '}{display(actionMenuLabel(item))}</Text>)}
  </Box>
}
