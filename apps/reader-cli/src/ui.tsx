import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import { ReaderApplication } from './application.ts'
import type { OpenBookResult, SearchOperationResult, SearchProgress, SearchResultGroup, TocResult, SourceCheckProgress, SourceCheckResult } from './application.ts'
import type { HomeBookView, KnownSourceView, ReadingPosition, ReaderSettings } from './storage.ts'
import { layoutContent, layoutFormattedContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from './content-layout.ts'
import { countChapterCharacters, formatChapterContent } from './content-format.ts'
import type { FormattedContent } from './content-format.ts'
import { actionMenuItems } from './action-menu.ts'
import type { ReaderAction } from './action-menu.ts'
import { clampContentLine, keepIndexVisible, terminalLayout } from './viewport.ts'
import { layoutCommandLine, layoutContextLine, tailTerminalText, terminalWidth } from './ui-actions.ts'
import { pageHeader, renderPage, type RenderState } from './ui-pages.tsx'
import { ActionMenuView } from './action-menu-view.tsx'
import { useUiOperation } from './use-ui-operation.ts'
import {
  activeEditionKey,
  chapterIndexForSelection,
  detailLineCount,
  display,
  errorMessage,
  footerLayout,
  filterChapterIndices,
  homeItemsForArea,
  isAbortError,
  helpLines,
  navigationIndex,
  navigationPage,
  normalizeChapterTitle,
  popNavigationFrame,
  pushNavigationFrame,
  readerNavigation,
  refreshOnHomeEntry,
  restoreGroupSelection,
  selectedGroupIndex,
  sourceManagerEntries,
  type InputKey,
  HELP_PAGES,
  type NavigationFrame,
  type MenuTarget,
  type MenuState,
  type Page,
  type SearchUiState,
} from './ui-model.ts'
import { READER_SETTING_FIELDS, READER_SETTINGS_DEFAULTS, isReaderSettingValue, type ReaderSettingKey } from './reader-settings.ts'
import { orderSourceViews } from './source-order.ts'
import type { DebugCapture } from './debug-capture.ts'
import type { DebugRunner } from './debug-runner.ts'
import { copyDebugPanel, exportDebugSession, panelText } from './debug-export.ts'

export interface ReaderUiProps {
  application: ReaderApplication
  catalog: SourceCatalogResult
}

export { homeItemsForArea } from './ui-model.ts'

interface NavigationSnapshot extends NavigationFrame {
  tocReversed: boolean
  tocSelected: number
  tocQuery: string
  tocSearchActive: boolean
  tocSearchOrigin: number
  chapterIndex: number
  book?: OpenBookResult
  toc?: TocResult
  content?: string
  formattedContent?: FormattedContent
  sources: KnownSourceView[]
  sourceSearch?: SearchOperationResult
  sourceSearchState: SearchUiState
  sourceSearchStart: number
  sourceSearchSelected: number
  mappingTarget?: KnownSourceView
  mappingToc?: TocResult
  mappingIndex: number
}

/** 展示层排序只变更章节数组的显示顺序，保留工作流索引、修订和章节身份。 */
function orderedToc(toc: TocResult, reversed: boolean): TocResult {
  return reversed ? { ...toc, chapters: [...toc.chapters].reverse() } : toc
}

function PageShell({ columns, rows, bodyHeight, separator, supported, header, command, content, menu }: {
  columns: number
  rows: number
  bodyHeight: number
  separator: boolean
  supported: boolean
  header: { left: string; right: string }
  command: { left: string; right: string }
  content: React.ReactElement
  menu: React.ReactElement | undefined
}): React.ReactElement {
  if (!supported) return <Box width={columns} height={rows}><Text color="yellow">终端至少需要 40 列 × 12 行，当前 {columns} × {rows}</Text></Box>
  return <Box position="relative" flexDirection="column" width={columns} height={rows} overflow="hidden">
    <Text color="cyan">{layoutContextLine(display(header.left), display(header.right), columns)}</Text>
    <Box height={bodyHeight} overflow="hidden" flexDirection="column">{content}</Box>
    {separator ? <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text> : null}
    <CommandBar columns={columns} left={command.left} right={command.right} />
    {menu}
  </Box>
}

function CommandBar({ columns, left, right }: { columns: number; left: string; right: string }): React.ReactElement {
  return <Text dimColor>{layoutCommandLine(display(left), display(right), columns)}</Text>
}

export function ReaderUi({ application, catalog }: ReaderUiProps): React.ReactElement {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const initialPage: Page = catalog.entries.length === 0 ? 'config' : 'home'
  const [page, setPageState] = useState<Page>(initialPage)
  const [home, setHome] = useState<HomeBookView[]>([])
  const [history, setHistory] = useState<Awaited<ReturnType<ReaderApplication['searchHistory']>>>([])
  const [homeArea, setHomeArea] = useState(0)
  const [query, setQuery] = useState('')
  const [searchPrecision, setSearchPrecision] = useState(false)
  const [search, setSearch] = useState<SearchOperationResult>()
  const [searchState, setSearchState] = useState<SearchUiState>('idle')
  const [sourceSearch, setSourceSearch] = useState<SearchOperationResult>()
  const [sourceSearchState, setSourceSearchState] = useState<SearchUiState>('idle')
  const [selected, setSelected] = useState(0)
  const [listStart, setListStart] = useState(0)
  const [pageScroll, setPageScroll] = useState(0)
  const [tocSelected, setTocSelected] = useState(0)
  const [tocQuery, setTocQuery] = useState('')
  const [tocSearchActive, setTocSearchActive] = useState(false)
  const [tocSearchOrigin, setTocSearchOrigin] = useState(0)
  const [tocReversed, setTocReversed] = useState(false)
  const [book, setBook] = useState<OpenBookResult>()
  const [toc, setToc] = useState<TocResult>()
  const [chapterIndex, setChapterIndex] = useState(0)
  const [content, setContent] = useState<string>()
  const [formattedContent, setFormattedContent] = useState<FormattedContent>()
  const [readerLine, setReaderLine] = useState(0)
  const [sources, setSources] = useState<KnownSourceView[]>([])
  const [sourceSearchStart, setSourceSearchStart] = useState(0)
  const [sourceSearchSelected, setSourceSearchSelected] = useState(0)
  const [mappingTarget, setMappingTarget] = useState<KnownSourceView>()
  const [mappingToc, setMappingToc] = useState<TocResult>()
  const [mappingIndex, setMappingIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessageState] = useState('')
  const [messageOwner, setMessageOwner] = useState<Page>(catalog.entries.length === 0 ? 'config' : 'home')
  const [searchProgress, setSearchProgress] = useState<SearchProgress>()
  const [searchElapsedMs, setSearchElapsedMs] = useState(0)
  const [searchClockStartedAt, setSearchClockStartedAt] = useState<number>()
  const [menu, setMenu] = useState<MenuState>()
  const [debugRunner, setDebugRunner] = useState<DebugRunner>()
  const [debugCapture, setDebugCapture] = useState<DebugCapture>()
  const [debugPanel, setDebugPanel] = useState<'flow' | 'requests' | 'response' | 'parsed'>('parsed')
  const [debugRequestSelected, setDebugRequestSelected] = useState(0)
  const [debugResultSelected, setDebugResultSelected] = useState(0)
  const [debugFilter, setDebugFilter] = useState('')
  const [debugFilterActive, setDebugFilterActive] = useState(false)
  const [debugKeyword, setDebugKeyword] = useState('')
  const [debugKeywordActive, setDebugKeywordActive] = useState(false)
  const [sourceManagerSelected, setSourceManagerSelected] = useState(0)
  const [sourceManagerSelectedIds, setSourceManagerSelectedIds] = useState<string[]>([])
  const [sourceManagerFilter, setSourceManagerFilter] = useState('')
  const [sourceManagerFilterMode, setSourceManagerFilterMode] = useState(0)
  const [sourceManagerFilterActive, setSourceManagerFilterActive] = useState(false)
  const [sourceManagerOrderValue, setSourceManagerOrderValue] = useState('')
  const [sourceManagerOrderActive, setSourceManagerOrderActive] = useState(false)
  const [sourceCheckProgress, setSourceCheckProgress] = useState<SourceCheckProgress>()
  const [sourceCheckResults, setSourceCheckResults] = useState<SourceCheckResult[]>([])
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(() => application.readerSettings)
  const [settingsSelected, setSettingsSelected] = useState(0)
  const [settingsEditing, setSettingsEditing] = useState(false)
  const [settingsValue, setSettingsValue] = useState('')
  const [settingsCursor, setSettingsCursor] = useState(0)
  const [settingsResetConfirm, setSettingsResetConfirm] = useState(false)
  const [helpTab, setHelpTab] = useState<Page>('home')
  const [helpScrolls, setHelpScrolls] = useState<Partial<Record<Page, number>>>({})
  const [, setDebugTick] = useState(0)
  const selectedGroupKeyRef = useRef<string | undefined>(undefined)
  const homeRefreshRequestRef = useRef(0)
  const searchStartedAtRef = useRef<number | undefined>(undefined)
  const pageRef = useRef(page)
  const sourceCommitRef = useRef<string | undefined>(undefined)
  const navigationRef = useRef<NavigationSnapshot[]>([{ page: initialPage, selected: 0, listStart: 0, pageScroll: 0, homeArea: 0, query: '', readerLine: 0, tocReversed: false, tocSelected: 0, tocQuery: '', tocSearchActive: false, tocSearchOrigin: 0, chapterIndex: 0, sources: [], sourceSearchState: 'idle', sourceSearchStart: 0, sourceSearchSelected: 0, mappingIndex: 0 }])
  const resizeAnchorRef = useRef({ width: Math.max(8, columns), height: terminalLayout(columns, rows).bodyHeight, readerLine })
  const skipPositionSaveRef = useRef(false)

  const captureNavigationFrame = (framePage: Page): NavigationSnapshot => {
    const editionKey = toc?.edition.editionKey ?? activeEditionKey(book)
    return {
    page: framePage,
    selected,
    listStart,
    pageScroll,
    homeArea,
    query,
    readerLine,
    tocReversed,
    tocSelected,
    tocQuery,
    tocSearchActive,
    tocSearchOrigin,
    chapterIndex,
    ...(book === undefined ? {} : { book }),
    ...(toc === undefined ? {} : { toc }),
    ...(content === undefined ? {} : { content }),
    ...(formattedContent === undefined ? {} : { formattedContent }),
    sources,
    ...(sourceSearch === undefined ? {} : { sourceSearch }),
    sourceSearchState,
    sourceSearchStart,
    sourceSearchSelected,
    ...(mappingTarget === undefined ? {} : { mappingTarget }),
    ...(mappingToc === undefined ? {} : { mappingToc }),
    mappingIndex,
    ...(book === undefined ? {} : { bookId: book.book.bookId }),
    ...(editionKey === undefined ? {} : { editionKey }),
    }
  }

  const setMessage = (text: string): void => {
    setMessageState(text)
    setMessageOwner(pageRef.current)
  }

  const setPage = (next: Page): void => {
    if (next === pageRef.current) return
    const current = captureNavigationFrame(pageRef.current)
    const stack = [...navigationRef.current]
    stack[stack.length - 1] = current
    const nextFrame: NavigationSnapshot = { ...current, page: next, selected: 0, listStart: 0, pageScroll: 0, ...(next === 'search' ? {} : { query }) }
    navigationRef.current = pushNavigationFrame(stack, nextFrame) as NavigationSnapshot[]
    pageRef.current = next
    setMessageState('')
    setMessageOwner(next)
    setPageState(next)
    setSelected(0)
    setListStart(0)
    setPageScroll(0)
  }

  const goBack = (updatedBook?: OpenBookResult, updatedSources?: KnownSourceView[]): void => {
    if (navigationRef.current.length <= 1) return
    navigationRef.current = popNavigationFrame(navigationRef.current, (frame) => {
      if (updatedBook === undefined) return frame
      const editionKey = activeEditionKey(updatedBook)
      const previous = { ...frame, book: updatedBook, sources: updatedSources ?? frame.sources, ...(editionKey === undefined ? {} : { editionKey }) }
      if (editionKey === undefined) delete previous.editionKey
      delete previous.toc
      delete previous.content
      delete previous.formattedContent
      return previous
    })
    const previous = navigationRef.current.at(-1)!
    pageRef.current = previous.page
    setPageState(previous.page)
    setSelected(previous.selected)
    setListStart(previous.listStart)
    setPageScroll(previous.pageScroll)
    setHomeArea(previous.homeArea)
    setQuery(previous.query)
    setReaderLine(previous.readerLine)
    setTocReversed(previous.tocReversed)
    setTocSelected(previous.tocSelected)
    setTocQuery(previous.tocQuery)
    setTocSearchActive(previous.tocSearchActive)
    setTocSearchOrigin(previous.tocSearchOrigin)
    setChapterIndex(previous.chapterIndex)
    setBook(previous.book)
    setToc(previous.toc)
    setContent(previous.content)
    setFormattedContent(previous.formattedContent)
    const keepLiveSourceSearch = previous.sourceSearchState === 'running' || previous.sourceSearchState === 'cancelling'
    if (!keepLiveSourceSearch) {
      setSources(previous.sources)
      setSourceSearch(previous.sourceSearch)
      setSourceSearchState(previous.sourceSearchState)
    }
    setSourceSearchStart(previous.sourceSearchStart)
    setSourceSearchSelected(previous.sourceSearchSelected)
    setMappingTarget(previous.mappingTarget)
    setMappingToc(previous.mappingToc)
    setMappingIndex(previous.mappingIndex)
    setMenu(undefined)
    setMessageState('')
    setMessageOwner(previous.page)
  }

  const { operationRef, mountedRef, beginOperation, isCurrent, finishOperation, cancelOperation, cancelActiveSearch, cancelActiveSourceCheck } = useUiOperation({
    setBusy,
    setSearchProgress,
    setSearchState,
    setSourceSearchState,
    setMessage,
  })

  const terminal = terminalLayout(columns, rows)
  const bodyHeight = terminal.bodyHeight

  const startSearchClock = (): void => {
    const startedAt = Date.now()
    searchStartedAtRef.current = startedAt
    setSearchClockStartedAt(startedAt)
    setSearchElapsedMs(0)
  }

  const stopSearchClock = (elapsedMs?: number): void => {
    const startedAt = searchStartedAtRef.current
    searchStartedAtRef.current = undefined
    setSearchClockStartedAt(undefined)
    if (elapsedMs !== undefined) setSearchElapsedMs(elapsedMs)
    else if (startedAt !== undefined) setSearchElapsedMs(Date.now() - startedAt)
  }

  const openEvidence = (context: string): void => {
    const capture = application.evidenceFor(context)
    if (capture === undefined || capture.requests.length === 0 && capture.processes.length === 0) {
      setMessage('本次操作没有可查看的网络记录')
      return
    }
    setDebugRunner(undefined)
    setDebugCapture(capture)
    setDebugPanel('requests')
    setDebugRequestSelected(Math.max(0, capture.requests.length - 1))
    setDebugFilter('')
    setDebugFilterActive(false)
    setPage('debug')
    setMessage('已打开最近操作记录')
  }

  const runDebugSearch = (runner: DebugRunner, keywordOverride?: string): void => {
    const operation = beginOperation('task')
    setMessage(`正在调试书源“${display(runner.source.source.bookSourceName)}”…`)
    runner.setKeyword(keywordOverride ?? (debugKeyword || runner.state.keyword))
    void runner.search(runner.state.keyword, operation.controller.signal).then((result) => {
      if (!isCurrent(operation)) return
      setDebugTick((value) => value + 1)
      setDebugResultSelected(0)
      setDebugRequestSelected(Math.max(0, runner.capture.requests.length - 1))
      setDebugPanel('parsed')
      setMessage(result.status === 'success' || result.status === 'partial' ? `搜索完成，候选 ${result.value?.items.length ?? 0} 个` : `搜索${result.status}`)
    }).catch((error: unknown) => {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    }).finally(() => finishOperation(operation))
  }

  const runDebugQuickCheck = (runner: DebugRunner, keywordOverride?: string): void => {
    const operation = beginOperation('task')
    setMessage(`正在快速检查书源“${display(runner.source.source.bookSourceName)}”…`)
    runner.setKeyword(keywordOverride ?? (debugKeyword || runner.state.keyword))
    const signal = operation.controller.signal
    void (async () => {
      const searchResult = await runner.search(runner.state.keyword, signal)
      if (!isCurrent(operation) || searchResult.value?.items[0] === undefined) return
      const detailResult = await runner.detail(0, signal)
      if (!isCurrent(operation) || detailResult.value?.items[0] === undefined) return
      const tocResult = await runner.toc(signal)
      if (!isCurrent(operation) || tocResult.value?.items[0] === undefined) return
      await runner.content(0, signal)
      if (!isCurrent(operation)) return
      setDebugTick((tick) => tick + 1)
      setDebugPanel('parsed')
      setDebugRequestSelected(Math.max(0, runner.capture.requests.length - 1))
      const state = runner.state
      setMessage(`快速检查完成：搜索 ${state.candidates.length} 个候选、目录 ${state.chapters.length} 章、正文 ${state.content?.cleaned.length ?? 0} 字`)
    })()
      .catch((error: unknown) => {
        if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      })
      .finally(() => finishOperation(operation))
  }

  const openDebugForSource = (sourceId: string, quickCheck = false): void => {
    const runner = application.createDebugRunner(sourceId)
    if (runner === undefined) { setMessage('该书源不可用，无法调试'); return }
    setDebugRunner(runner)
    setDebugCapture(undefined)
    setDebugPanel('parsed')
    setDebugRequestSelected(0)
    setDebugResultSelected(0)
    setDebugFilter('')
    setDebugFilterActive(false)
    const keyword = runner.state.keyword
    runner.setKeyword(keyword)
    setDebugKeyword(keyword)
    setDebugKeywordActive(false)
    setPage('debug')
    if (quickCheck) runDebugQuickCheck(runner, keyword)
    else runDebugSearch(runner, keyword)
  }

  const runDebugStage = (task: () => Promise<unknown>, success: string): void => {
    const runner = debugRunner
    if (runner === undefined || busy) return
    const operation = beginOperation('task')
    setMessage('正在执行调试阶段…')
    void task().then(() => {
      if (!isCurrent(operation)) return
      setDebugTick((value) => value + 1)
      setDebugRequestSelected(Math.max(0, runner.capture.requests.length - 1))
      setDebugPanel('parsed')
      setMessage(success)
    }).catch((error: unknown) => {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    }).finally(() => finishOperation(operation))
  }

  const handleDebugInput = (input: string, key: InputKey): void => {
    const capture = debugRunner?.capture ?? debugCapture
    if (key.ctrl && (input === 'a' || input === 'e')) {
      if (capture !== undefined && debugPanel === 'requests') {
        const records = debugFilter.length === 0 ? [...capture.requests] : capture.requests.filter((item) => `${item.sequence} ${item.stage} ${item.sourceId} ${item.sourceName ?? ''} ${item.method} ${item.url} ${item.status ?? ''} ${item.error ?? ''}`.toLowerCase().includes(debugFilter.toLowerCase()))
        const next = navigationIndex(debugRequestSelected, records.length, input, key, Math.max(1, bodyHeight - 3))
        if (next !== debugRequestSelected) { setDebugRequestSelected(next); setDebugPanel('response') }
        return
      }
      const stage = debugRunner?.state.stage
      if (debugPanel === 'parsed' && debugRunner !== undefined && (stage === 'search' || stage === 'toc')) {
        const total = stage === 'search' ? debugRunner.state.candidates.length : debugRunner.state.chapters.length
        setDebugResultSelected(navigationIndex(debugResultSelected, total, input, key, Math.max(1, bodyHeight - 3)))
        return
      }
      handlePageScroll(input, key)
      return
    }
    if (input === 'l') { setDebugPanel('flow'); return }
    if (input === 'n') { setDebugPanel('requests'); return }
    if (input === 'r') { setDebugPanel('response'); return }
    if (input === 'p') { setDebugPanel('parsed'); return }
    if (input === 'i' && debugRunner !== undefined && !busy) { setDebugKeyword(debugRunner.state.keyword); setDebugKeywordActive(true); return }
    if (input === '/' && !busy && debugPanel !== 'parsed') { setDebugFilter(''); setDebugRequestSelected(0); setDebugFilterActive(true); return }
    if (input === 'y' && capture !== undefined) {
      const visibleRequests = debugFilter.length === 0 ? [...capture.requests] : capture.requests.filter((item) => `${item.sequence} ${item.stage} ${item.sourceId} ${item.sourceName ?? ''} ${item.method} ${item.url} ${item.status ?? ''} ${item.error ?? ''}`.toLowerCase().includes(debugFilter.toLowerCase()))
      const selectedRequest = visibleRequests[debugRequestSelected]
      const selectedRequestIndex = selectedRequest === undefined ? undefined : capture.requests.indexOf(selectedRequest)
      void copyDebugPanel(panelText(capture, debugPanel, selectedRequestIndex, debugFilter)).then((result) => setMessage(result.message))
      return
    }
    if (input === 'e' && capture !== undefined) {
      void exportDebugSession(capture).then((result) => setMessage(`已导出：${result.markdownPath}；${result.jsonPath}`)).catch((error: unknown) => setMessage(`导出失败：${errorMessage(error)}`))
      return
    }
    if (capture !== undefined && debugPanel === 'requests') {
      const records = debugFilter.length === 0 ? [...capture.requests] : capture.requests.filter((item) => `${item.sequence} ${item.stage} ${item.sourceId} ${item.sourceName ?? ''} ${item.method} ${item.url} ${item.status ?? ''} ${item.error ?? ''}`.toLowerCase().includes(debugFilter.toLowerCase()))
      const next = navigationIndex(debugRequestSelected, records.length, input, key, Math.max(1, bodyHeight - 3))
      if (next !== debugRequestSelected) { setDebugRequestSelected(next); setDebugPanel('response') }
      if (key.return || key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') return
    }
    if (debugPanel === 'flow' || debugPanel === 'response') {
      if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') handlePageScroll(input, key)
      return
    }
    const runner = debugRunner
    if (runner === undefined) return
    const stage = runner.state.stage
    const total = stage === 'search' ? runner.state.candidates.length : stage === 'toc' ? runner.state.chapters.length : 0
    if (stage === 'search' || stage === 'toc') {
      const next = navigationIndex(debugResultSelected, total, input, key, Math.max(1, bodyHeight - 3))
      if (next !== debugResultSelected) setDebugResultSelected(next)
    }
    if (key.return && !busy) {
      if (stage === 'search' && runner.state.candidates.length > 0) runDebugStage(() => runner.detail(debugResultSelected), '书籍信息调试完成')
      else if (stage === 'book-info') runDebugStage(() => runner.toc(), '目录调试完成')
      else if (stage === 'toc' && runner.state.chapters.length > 0) runDebugStage(() => runner.content(debugResultSelected), '正文调试完成')
    }
  }

  useEffect(() => {
    const startedAt = searchClockStartedAt
    if (!busy || startedAt === undefined) return
    const updateElapsed = (): void => {
      if (searchStartedAtRef.current !== startedAt) return
      const elapsedMs = Date.now() - startedAt
      setSearchElapsedMs(elapsedMs)
      setSearchProgress((progress) => progress === undefined ? progress : { ...progress, elapsedMs })
    }
    updateElapsed()
    const timer = setInterval(updateElapsed, 250)
    return () => clearInterval(timer)
  }, [busy, searchClockStartedAt])

  const currentLayout = useMemo(() => content === undefined ? layoutContent('', Math.max(8, columns)) : formattedContent === undefined ? layoutContent(sanitizeTerminalText(content), Math.max(8, columns)) : layoutFormattedContent(formattedContent, Math.max(8, columns)), [columns, content, formattedContent])
  const currentLines = currentLayout.lines
  const visibleReaderLine = clampContentLine(readerLine, currentLines.length, bodyHeight)

  useEffect(() => {
    pageRef.current = page
    setMenu(undefined)
  }, [page])

  useEffect(() => {
    const committedEdition = sourceCommitRef.current
    if (page !== 'reader' || book === undefined || toc === undefined || committedEdition !== toc.edition.editionKey) return
    const current = captureNavigationFrame('reader')
    navigationRef.current = navigationRef.current.map((frame) => {
      if (frame.bookId !== book.book.bookId) return frame
      const refreshed = { ...frame, book, sources }
      if (frame.page === 'reader' && frame.editionKey !== committedEdition) {
        return { ...current, selected: frame.selected, listStart: frame.listStart, pageScroll: frame.pageScroll, homeArea: frame.homeArea, query: frame.query }
      }
      return refreshed
    })
    sourceCommitRef.current = undefined
  }, [book, page, sources, toc])

  const refreshHome = async (isCurrent: () => boolean = () => true): Promise<void> => {
    const request = ++homeRefreshRequestRef.current
    const [books, searches] = await Promise.all([application.home(), application.searchHistory()])
    if (request !== homeRefreshRequestRef.current || !isCurrent()) return
    setHome(books)
    setHistory(searches)
  }

  useEffect(() => {
    let active = true
    if (page === 'home') {
      setMessageState('正在更新首页…')
      setMessageOwner('home')
    }
    void refreshOnHomeEntry(page, () => refreshHome(() => active), () => active).then(() => {
      if (active) setMessageState((current) => current === '正在更新首页…' ? '' : current)
    }).catch((error: unknown) => {
      if (!active) return
      setMessageState(errorMessage(error))
      setMessageOwner(page)
    })
    return () => { active = false }
  }, [application, page])

  useEffect(() => {
    const width = Math.max(8, columns)
    const previous = resizeAnchorRef.current
    const resized = previous.width !== width || previous.height !== bodyHeight
    if (page === 'reader' && resized && content !== undefined) {
      const previousLayout = formattedContent === undefined ? layoutContent(sanitizeTerminalText(content), previous.width) : layoutFormattedContent(formattedContent, previous.width)
      const anchor = paragraphOffsetAtLine(previousLayout, previous.readerLine, previous.width)
      const nextLine = lineAtParagraphOffset(currentLayout, anchor.paragraphIndex, anchor.offset, width)
      skipPositionSaveRef.current = true
      setReaderLine(clampContentLine(nextLine, currentLayout.lines.length, bodyHeight))
    }
    resizeAnchorRef.current = { width, height: bodyHeight, readerLine: visibleReaderLine }
  }, [bodyHeight, columns, content, currentLayout, formattedContent, page, visibleReaderLine])

  useEffect(() => {
    if (page !== 'reader' || book === undefined || toc === undefined || content === undefined) return
    if (skipPositionSaveRef.current) { skipPositionSaveRef.current = false; return }
    const chapter = toc.chapters[chapterIndex]
    if (chapter === undefined) return
    const width = Math.max(8, columns)
    const anchor = paragraphOffsetAtLine(currentLayout, visibleReaderLine, width)
    const timer = setTimeout(() => {
      void application.saveReadingPosition(book.book.bookId, chapter, toc.edition, anchor.paragraphIndex, anchor.offset, toc.revision).catch((error: unknown) => {
        if (mountedRef.current && pageRef.current === 'reader') setMessage(errorMessage(error))
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [application, book, chapterIndex, columns, content, currentLayout, formattedContent, page, visibleReaderLine, toc])

  const submitSearch = async (): Promise<void> => {
    if (query.trim().length === 0) { setMessage('请输入书名'); return }
    const operation = beginOperation('search')
    startSearchClock()
    setSearch(undefined)
    setSearchState('running')
    selectedGroupKeyRef.current = undefined
    setSearchProgress(undefined)
    setMessage(`正在${searchPrecision ? '精准' : ''}搜索“${display(query.trim())}”…`)
    setPage('results')
    const request = application.search(query, undefined, operation.controller.signal, (progress) => {
      if (isCurrent(operation)) setSearchProgress(progress)
    }, (snapshot) => {
      if (!isCurrent(operation)) return
      setSearch((current) => {
        const previousKey = current?.groups[selectedGroupIndex(current, selected)]?.key ?? selectedGroupKeyRef.current
        if (previousKey !== undefined) selectedGroupKeyRef.current = previousKey
        return snapshot
      })
    }, { precision: searchPrecision })
    operation.promise = request
    try {
      const result = await request
      if (!isCurrent(operation)) return
      stopSearchClock(result.elapsedMs)
      setSearch(result)
      setSearchState(result.cancelled ? 'cancelled' : 'complete')
      setSelected((current) => restoreGroupSelection(result.groups, current, selectedGroupKeyRef.current))
      setMessage(result.cancelled ? '搜索已取消，已保留已返回结果' : `找到 ${result.groups.length} 本书`)
      void refreshHome().catch((refreshError: unknown) => {
        if (mountedRef.current && isCurrent(operation)) setMessage(errorMessage(refreshError))
      })
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) {
        stopSearchClock()
        setSearchState('error')
        setMessage(errorMessage(error))
      }
    } finally {
      if (isCurrent(operation)) stopSearchClock()
      finishOperation(operation)
    }
  }

  const openSearchGroup = async (group: SearchResultGroup, navigate = true): Promise<OpenBookResult | undefined> => {
    const operation = beginOperation('task')
    setMessage('正在加载书籍详情…')
    try {
      const opened = await application.openSearchResult(group.candidates[0]!, group.candidates, operation.controller.signal)
      if (!isCurrent(operation)) return undefined
      setBook(opened)
      setToc(undefined)
      if (navigate) setPage('detail')
      setMessage(opened.metadata === undefined ? '详情没有返回完整字段' : '详情已加载')
      await refreshHome()
      return opened
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      return undefined
    } finally {
      finishOperation(operation)
    }
  }

  const openSelected = async (navigate = true): Promise<OpenBookResult | undefined> => {
    const group = search?.groups[selected]
    if (group === undefined) return undefined
    if (operationRef.current?.kind === 'search') await cancelActiveSearch()
    if (operationRef.current !== undefined) return undefined
    return openSearchGroup(group, navigate)
  }

  const loadToc = async (edition?: string, bookOverride?: OpenBookResult, navigate = true, options: { refresh?: boolean; preserveSelection?: boolean } = {}): Promise<TocResult | undefined> => {
    const currentBook = bookOverride ?? book
    if (currentBook === undefined) return undefined
    const previousToc = toc
    const previousMatches = filterChapterIndices(previousToc?.chapters ?? [], tocQuery)
    const previousSelectedIndex = previousMatches[tocSelected]
    const previousSelectedUrl = previousToc === undefined || previousSelectedIndex === undefined ? undefined : previousToc.chapters[previousSelectedIndex]?.chapterUrl
    const previousReadingUrl = previousToc?.chapters[chapterIndex]?.chapterUrl
    const previousSearchOriginUrl = previousToc?.chapters[tocSearchOrigin]?.chapterUrl
    const previousQuery = tocQuery
    const previousSearchActive = tocSearchActive
    const operation = beginOperation('task')
    setMessage(options.refresh === true ? '正在刷新目录…' : '正在加载目录…')
    try {
      const requestedEdition = edition ?? currentBook.reading?.activeEditionKey ?? currentBook.book.activeEditionKey
      const loaded = await application.loadToc(currentBook.book.bookId, requestedEdition, operation.controller.signal, options.refresh === true ? { refresh: true } : {})
      if (!isCurrent(operation)) return undefined
      const result = orderedToc(loaded, tocReversed)
      setBook(currentBook)
      setToc(result)
      const saved = currentBook.reading?.positions[result.edition.editionKey]
      const savedIndex = saved === undefined ? -1 : result.chapters.findIndex((item) => item.chapterUrl === saved.chapterUrl)
      // 请求完成后以下标定位会受新增、删除和排序影响，因此按章节 URL 恢复阅读章和焦点。
      const previousReadingIndex = options.preserveSelection === true && previousReadingUrl !== undefined
        ? result.chapters.findIndex((item) => item.chapterUrl === previousReadingUrl)
        : -1
      const resumeIndex = previousReadingIndex >= 0 ? previousReadingIndex : savedIndex
      setChapterIndex(resumeIndex >= 0 ? resumeIndex : 0)
      if (options.preserveSelection === true) {
        const matches = filterChapterIndices(result.chapters, previousQuery)
        const selectedMatch = previousSelectedUrl === undefined ? -1 : matches.findIndex((index) => result.chapters[index]?.chapterUrl === previousSelectedUrl)
        const resumeMatch = matches.indexOf(resumeIndex >= 0 ? resumeIndex : 0)
        const nextSelected = selectedMatch >= 0 ? selectedMatch : resumeMatch >= 0 ? resumeMatch : 0
        const searchOrigin = previousSearchOriginUrl === undefined ? -1 : result.chapters.findIndex((item) => item.chapterUrl === previousSearchOriginUrl)
        setTocSelected(nextSelected)
        setTocQuery(previousQuery)
        setTocSearchActive(previousSearchActive)
        setTocSearchOrigin(searchOrigin >= 0 ? searchOrigin : (matches[nextSelected] ?? 0))
        setListStart(keepIndexVisible(nextSelected, matches.length, Math.max(1, bodyHeight), 0).start)
      } else {
        setTocSelected(resumeIndex >= 0 ? resumeIndex : 0)
        setTocQuery('')
        setTocSearchActive(false)
        if (navigate) setListStart(0)
      }
      if (navigate) setPage('toc')
      setMessage(`${result.chapters.length} 章${options.refresh === true ? ' · 目录已刷新' : resumeIndex >= 0 ? ' · 已定位到上次阅读章节' : ''}`)
      return result
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      return undefined
    } finally {
      finishOperation(operation)
    }
  }

  const loadChapter = async (index: number, options: { book?: OpenBookResult; toc?: TocResult; refresh?: boolean } = {}): Promise<void> => {
    // 命名选项：`refresh` 只能显式传入。位置参数曾让 returnToReader 落到 refresh 上，
    // 于是「更新并返回阅读页」变成了绕过缓存刷新 + 跳过保存阅读位置。
    const currentBook = options.book ?? book
    const currentToc = options.toc ?? toc
    const refresh = options.refresh === true
    if (currentBook === undefined || currentToc === undefined) return
    const chapter = currentToc.chapters[index]
    if (chapter === undefined) return
    const operation = beginOperation('task')
    setMessage(refresh ? '正在刷新当前章节…' : `正在加载第 ${index + 1} 章…`)
    try {
      // 下一章地址用于正文分页护栏：命中时停止抓取，避免把下一章正文并入本章。
      const nextChapter = currentToc.chapters[index + 1] ?? currentToc.chapters[0]
      const result = await application.loadContent(currentBook.book.bookId, chapter, currentToc.edition.editionKey, operation.controller.signal, { refresh, ...(nextChapter === undefined ? {} : { nextChapterUrl: nextChapter.chapterUrl }) })
      if (!isCurrent(operation)) return
      const width = Math.max(8, columns)
      const formatted = formatChapterContent(result.content.cleaned, result.content.contentType)
      const layout = layoutFormattedContent(formatted, width)
      const saved = currentBook.reading?.positions[currentToc.edition.editionKey]
      const sameSavedChapter = saved?.chapterUrl === chapter.chapterUrl
      const resumeLine = refresh ? clampContentLine(readerLine, layout.lines.length, bodyHeight) : sameSavedChapter ? lineAtParagraphOffset(layout, saved.paragraphIndex, saved.offset, width) : 0
      let openedBook = currentBook
      let partialCommit = false
      if (!refresh) {
        await application.saveReadingPosition(currentBook.book.bookId, chapter, result.edition, sameSavedChapter ? saved.paragraphIndex : 0, sameSavedChapter ? saved.offset : 0, currentToc.revision)
        try {
          openedBook = await application.openStoredBook(currentBook.book.bookId)
          if (result.edition.editionKey !== activeEditionKey(openedBook)) {
            try { openedBook = await application.switchSource(currentBook.book.bookId, result.edition.editionKey, operation.controller.signal) }
            catch { partialCommit = true }
          }
        } catch (error) {
          partialCommit = true
          const timestamp = new Date().toISOString()
          const position: ReadingPosition = { editionKey: result.edition.editionKey, sourceId: chapter.sourceId, bookUrl: chapter.bookUrl, chapterUrl: chapter.chapterUrl, index: chapter.index, title: chapter.title, tocRevision: currentToc.revision, paragraphIndex: sameSavedChapter ? saved?.paragraphIndex ?? 0 : 0, offset: sameSavedChapter ? saved?.offset ?? 0 : 0, lastReadAt: timestamp }
          const reading = currentBook.reading ?? { bookId: currentBook.book.bookId, positions: {}, updatedAt: timestamp }
          openedBook = { ...currentBook, book: { ...currentBook.book, activeEditionKey: result.edition.editionKey }, source: result.source, reading: { ...reading, positions: { ...reading.positions, [result.edition.editionKey]: position }, activeEditionKey: result.edition.editionKey, lastReadAt: timestamp, updatedAt: timestamp } }
        }
      }
      if (result.edition.editionKey !== activeEditionKey(currentBook)) {
        try { setSources(await application.knownSources(currentBook.book.bookId)) }
        catch { partialCommit = true }
      }
      const previousFrame = navigationRef.current.at(-2)
      const returnToReader = pageRef.current === 'detail'
        && previousFrame?.page === 'reader'
        && previousFrame.bookId === currentBook.book.bookId
        && previousFrame.editionKey === result.edition.editionKey
      if (returnToReader) {
        goBack()
        const restored = navigationRef.current.at(-1)
        if (restored !== undefined) {
          navigationRef.current[navigationRef.current.length - 1] = {
            ...restored,
            book: openedBook,
            toc: currentToc,
            content: formatted.text,
            formattedContent: formatted,
            chapterIndex: index,
            readerLine: resumeLine,
            tocSelected: index,
            tocQuery: '',
            tocSearchActive: false,
            bookId: openedBook.book.bookId,
            editionKey: result.edition.editionKey,
          }
        }
      }
      setBook(openedBook)
      setToc(currentToc)
      setChapterIndex(index)
      setContent(formatted.text)
      setFormattedContent(formatted)
      setReaderLine(resumeLine)
      setTocSelected(index)
      setTocQuery('')
      setTocSearchActive(false)
      if (result.edition.editionKey !== activeEditionKey(currentBook)) sourceCommitRef.current = result.edition.editionKey
      if (!returnToReader) setPage('reader')
      setMessage(partialCommit ? '阅读位置已保存，书籍信息待同步' : formatted.text.length === 0 ? '章节内容为空 · 阅读位置已保存' : `${refresh ? '正文已刷新' : '正文已加载'}${resumeLine > 0 && !refresh ? ' · 已恢复上次位置' : ''}`)
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    } finally {
      finishOperation(operation)
    }
  }

  const showSources = async (bookOverride?: OpenBookResult): Promise<void> => {
    const currentBook = bookOverride ?? book
    if (currentBook === undefined) return
    const operation = beginOperation('task')
    setMessage('正在读取本地书源记录…')
    try {
      const items = await application.knownSources(currentBook.book.bookId)
      if (!isCurrent(operation)) return
      setBook(currentBook)
      setSources(items)
      setSourceSearch(undefined)
      setSourceSearchState('idle')
      setSourceSearchStart(0)
      setSourceSearchSelected(0)
      setPage('sources')
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    } finally {
      finishOperation(operation)
    }
  }

  const resolveMenuBook = async (target: MenuTarget, navigate = true): Promise<OpenBookResult | undefined> => {
    if (target.kind === 'book') {
      if (book?.book.bookId === target.bookId) return book
      const operation = beginOperation('task')
      try {
        const opened = await application.openStoredBook(target.bookId, operation.controller.signal)
        if (!isCurrent(operation)) return undefined
        setBook(opened)
        return opened
      } catch (error) {
        if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
        return undefined
      } finally {
        finishOperation(operation)
      }
    }
    if (operationRef.current?.kind === 'search') await cancelActiveSearch()
    if (operationRef.current !== undefined) return undefined
    const group = search?.groups.find((item) => item.key === target.groupKey)
    if (group === undefined) return undefined
    return openSearchGroup(group, navigate)
  }

  const runMenuAction = async (action: ReaderAction): Promise<void> => {
    const state = menu
    if (state === undefined) return
    const item = state.items.find((candidate) => candidate.action === action)
    if (item === undefined || !item.enabled) {
      setMessage(item?.reason ?? '当前动作不可用')
      return
    }
    setMenu(undefined)
    const opened = await resolveMenuBook(state.target, action === 'detail')
    if (opened === undefined) return
    if (action === 'detail') {
      setBook(opened)
      setToc(undefined)
      setPage('detail')
      return
    }
    if (action === 'sources') {
      await showSources(opened)
      return
    }
    const loadedToc = await loadToc(undefined, opened)
    if (loadedToc === undefined) return
    if (action === 'read') {
      const saved = opened.reading?.positions[loadedToc.edition.editionKey]
      const resumeIndex = saved === undefined ? 0 : Math.max(0, loadedToc.chapters.findIndex((item) => item.chapterUrl === saved.chapterUrl))
      await loadChapter(resumeIndex, { book: opened, toc: loadedToc })
    }
  }

  const openMenu = (): void => {
    let target: MenuTarget | undefined
    let hasSources = false
    let hasBook = book !== undefined
    if (page === 'results') {
      const group = search?.groups[selected]
      if (group !== undefined) {
        target = { kind: 'search', groupKey: group.key }
        hasBook = true
        hasSources = group.candidates.length > 0
      }
    } else if (page === 'detail' && book !== undefined) {
      target = { kind: 'book', bookId: book.book.bookId }
      hasSources = book.sources.length > 0 || sources.length > 0
    } else if (page === 'home') {
      if (homeArea === 2) return
      const item = homeItemsForArea(home, homeArea)[selected]
      if (item !== undefined) {
        target = { kind: 'book', bookId: item.book.bookId }
        hasBook = true
        hasSources = true
      }
    }
    if (target === undefined) return
    const menuPage = page === 'home' || page === 'results' || page === 'detail' ? page : 'detail'
    // 已返回候选的搜索结果可以在搜索中打开菜单；执行动作会先取消并等待剩余来源。
    const searchCanOpenReturnedCandidate = page === 'results' && target.kind === 'search' && operationRef.current?.kind === 'search'
    const items = actionMenuItems({ hasBook, hasSources, hasToc: hasBook, page: menuPage, busy: busy && !searchCanOpenReturnedCandidate })
    setMenu({ target, items, index: 0 })
  }

  const startReading = async (bookOverride?: OpenBookResult): Promise<void> => {
    const currentBook = bookOverride ?? book
    if (currentBook === undefined) return
    const previousFrame = pageRef.current === 'detail' ? navigationRef.current.at(-2) : undefined
    const loaded = await loadToc(undefined, currentBook, false)
    if (loaded === undefined) return
    const saved = currentBook.reading?.positions[loaded.edition.editionKey]
    const savedIndex = saved === undefined ? -1 : loaded.chapters.findIndex((item) => item.chapterUrl === saved.chapterUrl)
    const previousChapterUrl = previousFrame?.page === 'reader' && previousFrame.bookId === currentBook.book.bookId
      ? previousFrame.toc?.chapters[previousFrame.chapterIndex]?.chapterUrl
      : undefined
    const previousChapterIndex = previousChapterUrl === undefined ? -1 : loaded.chapters.findIndex((item) => item.chapterUrl === previousChapterUrl)
    const returnToReader = previousFrame?.page === 'reader'
      && previousFrame.bookId === currentBook.book.bookId
      && previousFrame.editionKey === loaded.edition.editionKey
      && previousChapterIndex >= 0
    const resumeIndex = returnToReader ? previousChapterIndex : savedIndex < 0 ? 0 : savedIndex
    await loadChapter(resumeIndex, { book: currentBook, toc: loaded })
  }

  const toggleShelf = (): void => {
    if (book === undefined) return
    const operation = beginOperation('task')
    void application.toggleBookshelf(book.book.bookId).then((onShelf) => {
      if (!isCurrent(operation)) return
      setBook((current) => current === undefined ? current : { ...current, onBookshelf: onShelf })
      setMessage(onShelf ? '已加入书架' : '已移出书架')
      return refreshHome()
    }).catch((error: unknown) => {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    }).finally(() => finishOperation(operation))
  }

  const visibleSourceManagerEntries = (): SourceCatalogResult['entries'] => sourceManagerEntries(catalog, sourceManagerFilter, sourceManagerFilterMode)

  const toggleSourceManagerSelection = (): void => {
    const entry = visibleSourceManagerEntries()[sourceManagerSelected]
    if (entry === undefined) return
    setSourceManagerSelectedIds((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id])
  }

  const selectAllSourceManagerEntries = (): void => {
    const visible = visibleSourceManagerEntries().map((entry) => entry.id)
    if (visible.length === 0) return
    setSourceManagerSelectedIds((current) => visible.every((id) => current.includes(id)) ? current.filter((id) => !visible.includes(id)) : [...new Set([...current, ...visible])])
  }

  const setSelectedSourcesEnabled = (enabled: boolean): void => {
    if (busy) return
    if (sourceManagerSelectedIds.length === 0) { setMessage('请先选择书源'); return }
    const operation = beginOperation('task')
    void application.setSourcesEnabled(sourceManagerSelectedIds, enabled).then(() => {
      if (isCurrent(operation)) setMessage(enabled ? `已启用 ${sourceManagerSelectedIds.length} 个书源` : `已禁用 ${sourceManagerSelectedIds.length} 个书源`)
    }).catch((error: unknown) => { if (isCurrent(operation)) setMessage(errorMessage(error)) }).finally(() => finishOperation(operation))
  }

  const startSourceCheck = (): void => {
    if (busy) return
    if (sourceManagerSelectedIds.length === 0) { setMessage('请先选择要检测的书源'); return }
    const ids = [...sourceManagerSelectedIds]
    const operation = beginOperation('source-check')
    setSourceCheckProgress({ total: ids.length, completed: 0, passed: 0, failed: 0, cancelled: 0, activeSources: [] })
    setSourceCheckResults([])
    setMessage(`正在检测 ${ids.length} 个书源…`)
    const request = application.checkSources(ids, undefined, operation.controller.signal, (progress) => { if (isCurrent(operation)) setSourceCheckProgress(progress) })
    operation.promise = request
    void request.then((results) => {
      if (!isCurrent(operation)) return
      setSourceCheckResults(results)
      const failed = results.filter((item) => item.status === 'failed').length
      setMessage(failed > 0 ? `检测结束，已发现 ${failed} 个失败书源，可按 f 选择后禁用` : '检测结束，没有确认失败的书源')
    }).catch((error: unknown) => { if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error)) }).finally(() => {
      if (isCurrent(operation)) setSourceCheckProgress(undefined)
      finishOperation(operation)
    })
  }

  const selectFailedSourceResults = (): void => {
    const failedIds = sourceCheckResults.filter((item) => item.status === 'failed').map((item) => item.sourceId)
    if (failedIds.length === 0) { setMessage('本次没有已确认失败的书源'); return }
    setSourceManagerSelectedIds(failedIds)
    setSourceManagerFilterMode(3)
    setSourceManagerSelected(0)
    setPageScroll(0)
    setMessage(`已选择本次失败的 ${failedIds.length} 个书源，按 x 禁用`)
  }

  const moveSourceManagerSelection = (input: string, key: InputKey): void => {
    const entries = visibleSourceManagerEntries()
    const next = navigationIndex(sourceManagerSelected, entries.length, input, key, Math.max(1, bodyHeight - 3))
    if (next !== sourceManagerSelected) {
      setSourceManagerSelected(next)
      setPageScroll((scroll) => keepIndexVisible(next, entries.length, Math.max(1, bodyHeight - 3), scroll).start)
    }
  }

  const handleSourceManagerInput = (input: string, key: InputKey): void => {
    if (sourceManagerFilterActive || sourceManagerOrderActive) return
    moveSourceManagerSelection(input, key)
    if (key.ctrl && (input === 'a' || input === 'e')) return
    if (input === ' ') { toggleSourceManagerSelection(); return }
    if (input === 'a') { selectAllSourceManagerEntries(); return }
    if (input === 'c') { startSourceCheck(); return }
    if (input === 'x') { setSelectedSourcesEnabled(false); return }
    if (input === 'e') { setSelectedSourcesEnabled(true); return }
    if (input === 'f') { selectFailedSourceResults(); return }
    if (input === '/' && !busy) { setSourceManagerFilterActive(true); return }
    if (input === 'p' && !busy) {
      const entry = visibleSourceManagerEntries()[sourceManagerSelected]
      if (entry !== undefined) { setSourceManagerOrderValue(String(entry.customOrder ?? 0)); setSourceManagerOrderActive(true) }
    }
  }

  const selectedReaderSettingKey = (): ReaderSettingKey => READER_SETTING_FIELDS[Math.max(0, Math.min(READER_SETTING_FIELDS.length - 1, settingsSelected))]!.key

  const beginReaderSettingEdit = (): void => {
    const key = selectedReaderSettingKey()
    const value = String(readerSettings[key])
    setSettingsValue(value)
    setSettingsCursor(value.length)
    setSettingsEditing(true)
    setSettingsResetConfirm(false)
  }

  const saveReaderSettingValue = (): void => {
    const key = selectedReaderSettingKey()
    const value = Number(settingsValue)
    if (!isReaderSettingValue(value)) {
      setMessage(`设置值必须是 ${1}–${32} 的整数`)
      return
    }
    const next: ReaderSettings = { ...readerSettings, [key]: value }
    const operation = beginOperation('task')
    void application.saveReaderSettings(next).then(() => {
      if (!isCurrent(operation)) return
      setReaderSettings(application.readerSettings)
      setSettingsEditing(false)
      setMessage('设置已保存，下次批量操作生效')
    }).catch((error: unknown) => {
      if (isCurrent(operation)) setMessage(errorMessage(error))
    }).finally(() => finishOperation(operation))
  }

  const resetReaderSettings = (): void => {
    if (!settingsResetConfirm) {
      setSettingsResetConfirm(true)
      return
    }
    const operation = beginOperation('task')
    void application.saveReaderSettings(READER_SETTINGS_DEFAULTS).then(() => {
      if (!isCurrent(operation)) return
      setReaderSettings(application.readerSettings)
      setSettingsSelected(0)
      setSettingsCursor(0)
      setSettingsResetConfirm(false)
      setMessage('已恢复默认设置')
    }).catch((error: unknown) => {
      if (isCurrent(operation)) setMessage(errorMessage(error))
    }).finally(() => finishOperation(operation))
  }

  const handleSettingsInput = (input: string, key: InputKey): void => {
    if (settingsResetConfirm) {
      if (key.escape) { setSettingsResetConfirm(false); return }
      if (key.return) { if (!busy) resetReaderSettings(); return }
      return
    }
    if (settingsEditing) {
      if (key.escape) { setSettingsEditing(false); return }
      if (key.return) { if (!busy) saveReaderSettingValue(); return }
      if (key.leftArrow) { setSettingsCursor((cursor) => Math.max(0, cursor - 1)); return }
      if (key.rightArrow) { setSettingsCursor((cursor) => Math.min(settingsValue.length, cursor + 1)); return }
      if (key.home || key.ctrl && input === 'a') { setSettingsCursor(0); return }
      if (key.end || key.ctrl && input === 'e') { setSettingsCursor(settingsValue.length); return }
      if (key.backspace) {
        if (settingsCursor > 0) {
          const cursor = settingsCursor
          setSettingsValue((value) => value.slice(0, cursor - 1) + value.slice(cursor))
          setSettingsCursor(cursor - 1)
        }
        return
      }
      if (key.delete) {
        const cursor = settingsCursor
        if (cursor < settingsValue.length) setSettingsValue((value) => value.slice(0, cursor) + value.slice(cursor + 1))
        return
      }
      if (!key.ctrl && !key.meta && /^\d$/u.test(input)) {
        const cursor = settingsCursor
        setSettingsValue((value) => value.slice(0, cursor) + input + value.slice(cursor))
        setSettingsCursor(cursor + 1)
      }
      return
    }
    const next = navigationIndex(settingsSelected, READER_SETTING_FIELDS.length, input, key, READER_SETTING_FIELDS.length)
    if (next !== settingsSelected) setSettingsSelected(next)
    if (key.return && !busy) beginReaderSettingEdit()
    if (input === 'r' && !busy) resetReaderSettings()
  }

  const handleHelpInput = (input: string, key: InputKey): void => {
    const currentIndex = Math.max(0, HELP_PAGES.indexOf(helpTab))
    if (key.shift && key.tab) {
      setHelpTab(HELP_PAGES[(currentIndex - 1 + HELP_PAGES.length) % HELP_PAGES.length]!)
      return
    }
    if (key.tab || input === '\t' || key.rightArrow) {
      setHelpTab(HELP_PAGES[(currentIndex + 1) % HELP_PAGES.length]!)
      return
    }
    if (key.leftArrow) {
      setHelpTab(HELP_PAGES[(currentIndex - 1 + HELP_PAGES.length) % HELP_PAGES.length]!)
      return
    }
    const currentScroll = helpScrolls[helpTab] ?? 0
    const next = navigationPage(currentScroll, helpLines(helpTab, homeArea, columns).length, input, key, Math.max(1, bodyHeight - 2))
    if (next !== currentScroll) setHelpScrolls((scrolls) => ({ ...scrolls, [helpTab]: next }))
  }

  const handleHomeInput = (input: string, key: InputKey): void => {
    if (input === '1' || input === '2' || input === '3') { setHomeArea(Number(input) - 1); setSelected(0); setListStart(0); return }
    const visible = homeItemsForArea(home, homeArea)
    const total = homeArea === 2 ? history.length : visible.length
    const rowVisible = homeArea === 2 ? Math.max(1, bodyHeight - 2) : Math.max(1, Math.floor((bodyHeight - 2) / 2))
    const next = navigationIndex(selected, total, input, key, rowVisible)
    if (next !== selected) {
      setSelected(next)
      setListStart((start) => keepIndexVisible(next, total, rowVisible, start).start)
    }
    if (key.return && !busy) {
      if (homeArea === 2) {
        const item = history[selected]
        if (item !== undefined) { setQuery(item.keyword); setPage('search'); setMessage('') }
      } else {
        const item = visible[selected]
        if (item !== undefined) {
          const operation = beginOperation('task')
          setMessage('正在打开阅读记录…')
          void application.openStoredBook(item.book.bookId, operation.controller.signal).then((opened) => {
            if (!isCurrent(operation)) return
            void startReading(opened)
          }).catch((error: unknown) => {
            if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
          }).finally(() => finishOperation(operation))
        }
      }
    }
  }

  const handleResultsInput = (input: string, key: InputKey): void => {
    const groups = search?.groups ?? []
    const rowVisible = Math.max(1, bodyHeight - 2)
    const next = navigationIndex(selected, groups.length, input, key, rowVisible)
    if (next !== selected) {
      selectedGroupKeyRef.current = groups[next]?.key
      setSelected(next)
      setListStart((start) => keepIndexVisible(next, groups.length, rowVisible, start).start)
    }
    if (key.return && !busy && searchState !== 'running' && searchState !== 'cancelling') void openSelected()
    if (input === 't' && !busy && searchState !== 'running' && searchState !== 'cancelling') {
      void (async () => {
        const opened = await openSelected(false)
        if (opened !== undefined) await loadToc(undefined, opened)
      })()
    }
  }

  const handleDetailInput = (input: string, key: InputKey): void => {
    if (key.return && !busy) void startReading()
    if (!key.ctrl && !key.meta && input === 'a' && !busy) toggleShelf()
    if (input === 't' && !busy) void loadToc()
    if (input === 's' && !busy) void showSources()
  }

  const handleTocInput = (input: string, key: InputKey): void => {
    if (input === 'r' && !busy && toc !== undefined) {
      void loadToc(toc.edition.editionKey, book, false, { refresh: true, preserveSelection: true })
      return
    }
    if (input === 's' && !busy) {
      toggleTocOrder()
      return
    }
    const matches = filterChapterIndices(toc?.chapters ?? [], tocQuery)
    const visible = Math.max(1, bodyHeight)
    const next = navigationIndex(tocSelected, matches.length, input, key, visible)
    if (next !== tocSelected) {
      setTocSelected(next)
      setListStart((start) => keepIndexVisible(next, matches.length, visible, start).start)
    }
    if (key.return && !busy) {
      const chapter = matches[tocSelected]
      if (chapter !== undefined) void loadChapter(chapter)
      else setMessage('没有匹配的章节')
    }
  }

  const updateTocSearch = (nextQuery: string): void => {
    const chapters = toc?.chapters ?? []
    const previousMatches = filterChapterIndices(chapters, tocQuery)
    const selectedChapter = previousMatches[tocSelected] ?? tocSearchOrigin
    const matches = filterChapterIndices(chapters, nextQuery)
    const keptIndex = matches.indexOf(selectedChapter)
    const nextSelected = keptIndex >= 0 ? keptIndex : 0
    setTocQuery(nextQuery)
    setTocSelected(nextSelected)
    setListStart((start) => keepIndexVisible(nextSelected, matches.length, Math.max(1, bodyHeight), start).start)
  }

  const clearTocSearch = (): void => {
    const chapters = toc?.chapters ?? []
    const restored = Math.max(0, Math.min(Math.max(0, chapters.length - 1), tocSearchOrigin))
    setTocQuery('')
    setTocSearchActive(false)
    setTocSelected(restored)
    setListStart(keepIndexVisible(restored, chapters.length, Math.max(1, bodyHeight), 0).start)
  }

  const toggleTocOrder = (): void => {
    if (toc === undefined || busy) return
    const selectedIndex = filterChapterIndices(toc.chapters, tocQuery)[tocSelected]
    const selectedUrl = selectedIndex === undefined ? undefined : toc.chapters[selectedIndex]?.chapterUrl
    const readingUrl = toc.chapters[chapterIndex]?.chapterUrl
    const searchOriginUrl = toc.chapters[tocSearchOrigin]?.chapterUrl
    const chapters = [...toc.chapters].reverse()
    const matches = filterChapterIndices(chapters, tocQuery)
    const nextSelected = selectedUrl === undefined ? -1 : matches.findIndex((index) => chapters[index]?.chapterUrl === selectedUrl)
    const nextReading = readingUrl === undefined ? -1 : chapters.findIndex((chapter) => chapter.chapterUrl === readingUrl)
    const nextSearchOrigin = searchOriginUrl === undefined ? -1 : chapters.findIndex((chapter) => chapter.chapterUrl === searchOriginUrl)
    const selected = nextSelected >= 0 ? nextSelected : 0
    setToc({ ...toc, chapters })
    setTocReversed(!tocReversed)
    setTocSelected(selected)
    setChapterIndex(nextReading >= 0 ? nextReading : 0)
    setTocSearchOrigin(nextSearchOrigin >= 0 ? nextSearchOrigin : (matches[selected] ?? 0))
    setListStart(keepIndexVisible(selected, matches.length, Math.max(1, bodyHeight), 0).start)
    setMessage(`已切换为${tocReversed ? '正序' : '倒序'}`)
  }

  const handleReaderInput = (input: string, key: InputKey): void => {
    const height = Math.max(1, bodyHeight)
    const navigation = readerNavigation(input, key)
    if (key.home || key.ctrl && input === 'a') setReaderLine(0)
    if (key.end || key.ctrl && input === 'e') setReaderLine(clampContentLine(Number.MAX_SAFE_INTEGER, currentLines.length, height))
    if (input === ' ' || key.pageDown || navigation === 'next-page') setReaderLine((value) => clampContentLine(value + height, currentLines.length, height))
    if (key.pageUp || navigation === 'previous-page') setReaderLine((value) => clampContentLine(value - height, currentLines.length, height))
    if (input === 'r' && !busy) void loadChapter(chapterIndex, { refresh: true })
    if (input === 'i' && !busy) setPage('detail')
    if (navigation === 'previous-chapter' && chapterIndex > 0 && !busy) void loadChapter(chapterIndex - 1)
    if (navigation === 'next-chapter' && toc !== undefined && chapterIndex < toc.chapters.length - 1 && !busy) void loadChapter(chapterIndex + 1)
    if (input === 't' && !busy) setPage('toc')
    if (input === 's' && !busy) void showSources()
    if (!key.ctrl && !key.meta && input === 'a' && !busy) toggleShelf()
  }

  const handleSourcesInput = (input: string, key: InputKey): void => {
    if (input === 'm' && book !== undefined && !busy) {
      const operation = beginOperation('source-search')
      startSearchClock()
      const before = new Set(sources.map((item) => item.editionKey))
      setSourceSearch(undefined)
      setSourceSearchState('running')
      setSourceSearchStart(0)
      setSourceSearchSelected(0)
      setMessage('正在搜索更多书源…')
      const request = application.searchMoreSources(book.book.bookId, operation.controller.signal, (progress) => {
        if (isCurrent(operation)) setSearchProgress(progress)
      }, (snapshot) => {
        if (isCurrent(operation)) setSourceSearch(snapshot)
      })
      operation.promise = request
      void request.then(async (result) => {
        if (!isCurrent(operation)) return
        stopSearchClock(result.elapsedMs)
        const items = await application.knownSources(book.book.bookId)
        if (!isCurrent(operation)) return
        setSources(items)
        setSourceSearch(result)
        setSourceSearchState(result.cancelled ? 'cancelled' : 'complete')
        const added = items.filter((item) => !before.has(item.editionKey)).length
        setMessage(result.cancelled ? `搜索已取消，保留 ${added} 个已匹配书源` : `已搜索 ${result.sources.length} 个书源，新增 ${added} 个严格匹配书源`)
        void refreshHome().catch((refreshError: unknown) => {
          if (mountedRef.current && isCurrent(operation)) setMessage(errorMessage(refreshError))
        })
      }).catch((error: unknown) => {
        if (!isCurrent(operation)) return
        stopSearchClock()
        if (isAbortError(error)) {
          setSourceSearchState('cancelled')
          setMessage('搜索已取消，保留已有书源')
        } else {
          setSourceSearchState('error')
          setMessage(errorMessage(error))
        }
      }).finally(() => {
        if (isCurrent(operation)) stopSearchClock()
        finishOperation(operation)
      })
      return
    }
    if (sourceSearchState === 'running' || sourceSearchState === 'cancelling') {
      const matchedCount = sourceSearch?.results.length ?? 0
      const visible = Math.max(1, Math.floor((bodyHeight - 2) / 2))
      const next = navigationIndex(sourceSearchSelected, matchedCount, input, key, visible)
      if (next !== sourceSearchSelected) {
        setSourceSearchSelected(next)
        setSourceSearchStart((start) => keepIndexVisible(next, matchedCount, visible, start).start)
      }
      return
    }
    const sourceItems = orderSourceViews(sources, activeEditionKey(book))
    const total = sourceItems.length
    const visible = Math.max(1, Math.floor((bodyHeight - (sourceSearch === undefined ? 1 : 2)) / 2))
    const next = navigationIndex(selected, total, input, key, visible)
    if (next !== selected) { setSelected(next); setListStart((start) => keepIndexVisible(next, total, visible, start).start) }
    if (input === 't' && !busy) {
      const target = sourceItems[selected]
      if (target?.state === 'available') void loadToc(target.editionKey)
      else setMessage(target === undefined ? '没有选中的书源' : '此书源不可用，无法读取目录')
      return
    }
    if (key.return && !busy) {
      const target = sourceItems[selected]
      if (target?.state === 'available' && book !== undefined) {
        if (target.editionKey === activeEditionKey(book)) {
          void loadToc(target.editionKey)
          return
        }
        if (toc?.chapters[chapterIndex] !== undefined) {
          const operation = beginOperation('task')
          setMessage('正在加载目标书源目录以计算章节映射…')
          void application.loadToc(book.book.bookId, target.editionKey, operation.controller.signal).then((targetToc) => {
            if (!isCurrent(operation)) return
            const orderedTargetToc = orderedToc(targetToc, tocReversed)
            const current = toc.chapters[chapterIndex]!
            const normalized = normalizeChapterTitle(current.title)
            const targetIndex = orderedTargetToc.chapters.findIndex((item) => normalizeChapterTitle(item.title) === normalized)
            setMappingTarget(target)
            setMappingToc(orderedTargetToc)
            setMappingIndex(targetIndex >= 0 ? targetIndex : Math.min(chapterIndex, Math.max(0, orderedTargetToc.chapters.length - 1)))
            setPage('mapping')
            setMessage(targetIndex < 0 ? '未找到同名章节，将使用目录范围内的索引回退，请确认' : '已按章节标题找到目标章节，请确认')
          }).catch((error: unknown) => {
            if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
          }).finally(() => finishOperation(operation))
        } else {
          const operation = beginOperation('task')
          setMessage('正在切换书源…')
          void application.switchSource(book.book.bookId, target.editionKey, operation.controller.signal).then(async (opened) => {
            if (!isCurrent(operation)) return
            let updatedSources = sources
            try { updatedSources = await application.knownSources(book.book.bookId) }
            catch { /* The active book can still be shown; a later visit will reload source status. */ }
            if (!isCurrent(operation)) return
            if (navigationRef.current.at(-2)?.page === 'detail') {
              goBack(opened, updatedSources)
              setMessage('书源已切换')
            } else {
              setBook(opened)
              setSources(updatedSources)
              setMessage('书源已切换，目录需要重新加载')
              setToc(undefined)
              setPage('detail')
            }
          }).catch((error: unknown) => {
            if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
          }).finally(() => finishOperation(operation))
        }
      }
    }
  }

  const handleMappingInput = (input: string, key: InputKey): void => {
    if (key.return && book !== undefined && mappingTarget !== undefined && !busy) {
      const operation = beginOperation('task')
      setMessage('正在确认切换书源…')
      void application.switchSource(book.book.bookId, mappingTarget.editionKey, operation.controller.signal).then((opened) => {
        if (!isCurrent(operation)) return
        setBook(opened)
        if (mappingToc !== undefined) { setToc(mappingToc); setChapterIndex(mappingIndex); setTocSelected(mappingIndex); setTocQuery(''); setTocSearchActive(false); setPage('toc') } else { setToc(undefined); setPage('detail') }
        setMessage('书源已切换，请从目标目录继续阅读')
      }).catch((error: unknown) => {
        if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      }).finally(() => finishOperation(operation))
    }
    if (input === 't') setPage('toc')
  }

  const debugLineCount = (): number => {
    const capture = debugRunner?.capture ?? debugCapture
    if (capture === undefined) return 3
    const snapshot = capture.snapshot()
    if (debugPanel === 'flow') return snapshot.processes.length + 4
    const requestMatches = (item: { sequence: number; stage: string; sourceId: string; sourceName?: string; method: string; url: string; status?: number; error?: string }): boolean => debugFilter.length === 0 || `${item.sequence} ${item.stage} ${item.sourceId} ${item.sourceName ?? ''} ${item.method} ${item.url} ${item.status ?? ''} ${item.error ?? ''}`.toLowerCase().includes(debugFilter.toLowerCase())
    if (debugPanel === 'requests') return snapshot.requests.filter(requestMatches).length + 4
    if (debugPanel === 'response') {
      const requests = snapshot.requests.filter(requestMatches)
      const body = requests[debugRequestSelected]?.responseText?.split('\n').length ?? 1
      return body + 20
    }
    return snapshot.stages.length * 4 + (debugRunner?.state.candidates.length ?? 0) + (debugRunner?.state.chapters.length ?? 0) + 8
  }

  const handleMenuInput = (input: string, key: InputKey): boolean => {
    if (menu === undefined) return false
    if (key.escape) { setMenu(undefined); return true }
    const next = navigationIndex(menu.index, menu.items.length, input, key, menu.items.length)
    if (next !== menu.index) setMenu((current) => current === undefined ? current : { ...current, index: next })
    const shortcut = menu.items.find((item) => item.shortcut === input)
    if (shortcut !== undefined) { setMenu((current) => current === undefined ? current : { ...current, index: menu.items.indexOf(shortcut) }); void runMenuAction(shortcut.action); return true }
    if (key.return) { void runMenuAction(menu.items[menu.index]?.action ?? 'detail'); return true }
    return true
  }

  const handlePageScroll = (input: string, key: InputKey): void => {
    const lines = page === 'help' ? helpLines(helpTab, homeArea, columns).length : page === 'detail' ? detailLineCount(book, columns) : page === 'mapping' ? 8 : page === 'config' ? catalog.diagnostics.length + 4 : page === 'diagnostics' ? catalog.entries.length + catalog.diagnostics.length + 8 : page === 'source-manager' ? sourceManagerEntries(catalog, sourceManagerFilter, sourceManagerFilterMode).length * 2 + 6 : page === 'debug' ? debugLineCount() : 6
    const next = navigationPage(pageScroll, lines, input, key, bodyHeight)
    if (next !== pageScroll) setPageScroll(next)
  }

  useInput((input, key) => {
    if (handleMenuInput(input, key)) return
    if (page === 'debug' && (debugFilterActive || debugKeywordActive)) {
      if (key.escape) { setDebugFilterActive(false); setDebugKeywordActive(false); return }
      if (key.return) {
        if (debugKeywordActive && debugRunner !== undefined && !busy) { setDebugKeywordActive(false); runDebugSearch(debugRunner) }
        else setDebugFilterActive(false)
        return
      }
      if (key.backspace || key.delete) {
        if (debugKeywordActive) setDebugKeyword((value) => Array.from(value).slice(0, -1).join(''))
        else setDebugFilter((value) => Array.from(value).slice(0, -1).join(''))
        return
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        if (debugKeywordActive) setDebugKeyword((value) => value + input)
        else setDebugFilter((value) => value + input)
        return
      }
    }
    if (page === 'source-manager' && (sourceManagerFilterActive || sourceManagerOrderActive)) {
      if (key.escape) { setSourceManagerFilterActive(false); setSourceManagerOrderActive(false); return }
      if (key.return) {
        if (sourceManagerOrderActive) {
          const value = Number.parseInt(sourceManagerOrderValue, 10)
          const entry = visibleSourceManagerEntries()[sourceManagerSelected]
          if (entry === undefined || !Number.isSafeInteger(value)) setMessage('优先级必须是整数')
          else {
            const operation = beginOperation('task')
            void application.setSourceOrder(entry.id, value).then(() => { if (isCurrent(operation)) setMessage('优先级已保存') }).catch((error: unknown) => { if (isCurrent(operation)) setMessage(errorMessage(error)) }).finally(() => finishOperation(operation))
          }
        }
        setSourceManagerFilterActive(false); setSourceManagerOrderActive(false); return
      }
      if (key.backspace || key.delete) {
        if (sourceManagerOrderActive) setSourceManagerOrderValue((value) => Array.from(value).slice(0, -1).join(''))
        else setSourceManagerFilter((value) => Array.from(value).slice(0, -1).join(''))
        return
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        if (sourceManagerOrderActive && /^[-+\d]$/u.test(input)) setSourceManagerOrderValue((value) => value + input)
        else if (sourceManagerFilterActive) setSourceManagerFilter((value) => value + input)
        return
      }
    }
    if (page === 'search') {
      if (key.ctrl && (input === 'p' || input === 'P')) { setSearchPrecision((value) => !value); setMessage(searchPrecision ? '精准搜索已关闭' : '精准搜索已开启'); return }
      if (key.escape) { goBack(); return }
      if (key.return) { void submitSearch(); return }
      if (key.backspace || key.delete) { setQuery((value) => Array.from(value).slice(0, -1).join('')); return }
      if (!key.ctrl && !key.meta && input.length > 0) setQuery((value) => value + input)
      return
    }
    if (page === 'toc' && tocSearchActive) {
      if (key.escape) { clearTocSearch(); return }
      if (key.return) { setTocSearchActive(false); return }
      if (key.backspace || key.delete) { updateTocSearch(Array.from(tocQuery).slice(0, -1).join('')); return }
      if (!key.ctrl && !key.meta && input.length > 0) updateTocSearch(tocQuery + input)
      return
    }
    if (key.ctrl && input === 'c') { cancelOperation('正在退出…'); exit(); return }
    if (page === 'settings' && (settingsEditing || settingsResetConfirm)) {
      handleSettingsInput(input, key)
      return
    }
    if (input === 'q') { cancelOperation('正在退出…'); exit(); return }
    if (input === '?' ) { if (page === 'help') goBack(); else { setHelpTab(page); setPage('help') }; return }
    if (page === 'settings') {
      if (key.escape && !settingsEditing && !settingsResetConfirm) { goBack(); return }
      handleSettingsInput(input, key)
      return
    }
    if (page === 'help') {
      if (key.escape) { goBack(); return }
      handleHelpInput(input, key)
      return
    }
    if (input === 'd') { if (page !== 'diagnostics') setPage('diagnostics'); return }
    if (input === 'm' && page === 'home' && !busy) { setPage('source-manager'); setMessage(''); return }
    if (input === 's' && (page === 'home' || page === 'config') && !busy) { setPage('settings'); setMessage(''); return }
    if (key.ctrl && input === 'k') { setPage('search'); setMessage(''); return }
    if (key.escape) {
      if (page === 'toc' && tocQuery.length > 0) { clearTocSearch(); return }
      if (busy && (operationRef.current?.kind === 'search' || operationRef.current?.kind === 'source-search')) { cancelActiveSearch(); return }
      if (busy && operationRef.current?.kind === 'source-check') { void cancelActiveSourceCheck(); return }
      if (busy) { cancelOperation(); return }
      goBack()
      return
    }
    if (input === 'o' && ['home', 'results'].includes(page)) { openMenu(); return }
    if (page === 'toc' && input === '/') {
      const selectedChapter = chapterIndexForSelection(toc?.chapters ?? [], tocQuery, tocSelected, chapterIndex)
      setTocSearchOrigin(selectedChapter)
      setTocQuery('')
      setTocSearchActive(true)
      setTocSelected(selectedChapter)
      setListStart((start) => keepIndexVisible(selectedChapter, toc?.chapters.length ?? 0, Math.max(1, bodyHeight), start).start)
      return
    }
    if (input === 'v' && !busy) {
      const context = page === 'results' ? 'search' : page === 'detail' ? 'detail' : page === 'sources' ? 'sources' : page === 'toc' ? `toc:${book?.book.bookId ?? ''}:${toc?.edition.editionKey ?? ''}` : page === 'reader' ? `content:${book?.book.bookId ?? ''}:${toc?.edition.editionKey ?? ''}` : ''
      if (context.length > 0) { openEvidence(context); return }
    }
    if (page === 'diagnostics' && input === 'g' && !busy) {
      const target = catalog.entries[selected]
      if (target !== undefined) { openDebugForSource(target.id); return }
    }
    if (page === 'diagnostics' && input === 'r' && !busy) {
      const target = catalog.entries[selected]
      if (target !== undefined) { openDebugForSource(target.id, true); return }
    }
    if (page === 'home') handleHomeInput(input, key)
    else if (page === 'results') handleResultsInput(input, key)
    else if (page === 'detail') { handleDetailInput(input, key); if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || key.ctrl && (input === 'a' || input === 'e') || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'toc') handleTocInput(input, key)
    else if (page === 'reader') handleReaderInput(input, key)
    else if (page === 'sources') handleSourcesInput(input, key)
    else if (page === 'mapping') { handleMappingInput(input, key); if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || key.ctrl && (input === 'a' || input === 'e') || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'debug') handleDebugInput(input, key)
    else if (page === 'source-manager') handleSourceManagerInput(input, key)
    else if (page === 'diagnostics' || page === 'config') {
      if (page === 'diagnostics') {
        const next = navigationIndex(selected, catalog.entries.length, input, key, Math.max(1, bodyHeight - 5))
        if (next !== selected) { setSelected(next); setPageScroll((scroll) => keepIndexVisible(next, catalog.entries.length, Math.max(1, bodyHeight - 5), scroll).start) }
        if (key.return && catalog.entries[selected] !== undefined) setMessage(`${catalog.entries[selected]!.source.bookSourceName}：按 g 进入调试`)
      }
      handlePageScroll(input, key)
    }
  })

  const visibleMessage = messageOwner === page ? message : ''
  const state: RenderState = { catalog, columns, home, history, homeArea, selected, listStart, bodyHeight, tocSelected, tocQuery, tocReversed, query, search, searchState, searchProgress, searchElapsedMs, book, toc, chapterIndex, contentLines: currentLines, contentLineKinds: currentLayout.lineKinds, readerLine: visibleReaderLine, sources, sourceSearch, sourceSearchState, sourceSearchStart, sourceSearchSelected, mappingToc, mappingIndex, mappingTarget, pageScroll: page === 'help' ? helpScrolls[helpTab] ?? 0 : pageScroll, message: visibleMessage, helpPage: helpTab, chapterCharacters: formattedContent === undefined ? 0 : countChapterCharacters(formattedContent), separator: terminal.separator, readerSettings, settingsSelected, settingsEditing, settingsValue, settingsCursor, settingsResetConfirm, ...(debugRunner === undefined ? {} : { debugRunner }), ...(debugCapture === undefined ? {} : { debugCapture }), debugPanel, debugRequestSelected, debugResultSelected, debugFilter, sourceManagerSelected, sourceManagerSelectedIds, sourceManagerFilter, sourceManagerFilterMode, ...(sourceCheckProgress === undefined ? {} : { sourceCheckProgress }), sourceCheckResults }
  const visiblePage = renderPage(page, state)
  const inputMode = page === 'search' || page === 'toc' && tocSearchActive || page === 'debug' && (debugFilterActive || debugKeywordActive) || page === 'source-manager' && (sourceManagerFilterActive || sourceManagerOrderActive)
  const commandActions = footerLayout(page, busy, columns, searchState, sourceSearchState, menu !== undefined, homeArea, tocSearchActive, tocQuery.length > 0, tocReversed, { textInput: inputMode, settingsEditing, settingsResetConfirm })
  const inputLabel = page === 'search' ? `搜索${searchPrecision ? ' [精准]' : ''} › ` : page === 'toc' && tocSearchActive ? '章节 › ' : page === 'debug' && debugKeywordActive ? '关键词 › ' : page === 'debug' && debugFilterActive ? '过滤 › ' : page === 'source-manager' && sourceManagerOrderActive ? '优先级 › ' : page === 'source-manager' && sourceManagerFilterActive ? '筛选 › ' : ''
  const inputValue = page === 'search' ? query : page === 'toc' ? tocQuery : debugKeywordActive ? debugKeyword : debugFilterActive ? debugFilter : sourceManagerOrderActive ? sourceManagerOrderValue : sourceManagerFilter
  const inputWidth = Math.max(0, columns - terminalWidth(commandActions.right) - 1 - terminalWidth(inputLabel) - 1)
  const commandInput = inputMode ? `${inputLabel}${tailTerminalText(inputValue, inputWidth)}█` : ''
  const pageContext = pageHeader(page, state)
  const preservePageStats = page === 'reader' || page === 'toc' || page === 'results'
  const header = { ...pageContext, right: preservePageStats ? pageContext.right : visibleMessage || (busy ? '处理中' : pageContext.right) }
  return <PageShell columns={columns} rows={rows} bodyHeight={bodyHeight} separator={terminal.separator} supported={terminal.supported} header={header} command={{ left: inputMode ? commandInput : commandActions.left, right: commandActions.right }} content={visiblePage} menu={menu === undefined ? undefined : <ActionMenuView menu={menu} columns={columns} rows={rows} />} />
}
