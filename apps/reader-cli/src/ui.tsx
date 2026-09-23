import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import { ReaderApplication } from './application.ts'
import type { OpenBookResult, SearchOperationResult, SearchProgress, SearchResultGroup, TocResult } from './application.ts'
import type { HomeBookView, KnownSourceView, ReadingPosition } from './storage.ts'
import { layoutContent, layoutFormattedContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from './content-layout.ts'
import { countChapterCharacters, formatChapterContent } from './content-format.ts'
import type { FormattedContent } from './content-format.ts'
import { actionMenuItems } from './action-menu.ts'
import type { ReaderAction } from './action-menu.ts'
import { clampContentLine, keepIndexVisible, terminalLayout } from './viewport.ts'
import { layoutCommandLine, layoutContextLine, tailTerminalText, terminalWidth } from './ui-actions.ts'
import { pageHeader, renderActionMenu, renderPage, type RenderState } from './ui-pages.tsx'
import { useUiOperation } from './use-ui-operation.ts'
import {
  activeEditionKey,
  chapterIndexForSelection,
  detailLineCount,
  display,
  errorMessage,
  footer,
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
  type InputKey,
  type NavigationFrame,
  type MenuTarget,
  type MenuState,
  type Page,
  type SearchUiState,
} from './ui-model.ts'
import { orderSourceViews } from './source-order.ts'

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

  const { operationRef, mountedRef, beginOperation, isCurrent, finishOperation, cancelOperation, cancelActiveSearch } = useUiOperation({
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
    setMessage(`正在搜索“${display(query.trim())}”…`)
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
    })
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
      const nextChapter = currentToc.chapters[index + 1]
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
    const item = state.items[state.index]
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
    if (input === 'a' && !busy) toggleShelf()
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
    if (input === ' ' || key.pageDown || navigation === 'next-page') setReaderLine((value) => clampContentLine(value + height, currentLines.length, height))
    if (key.pageUp || navigation === 'previous-page') setReaderLine((value) => clampContentLine(value - height, currentLines.length, height))
    if (input === 'r' && !busy) void loadChapter(chapterIndex, { refresh: true })
    if (input === 'i' && !busy) setPage('detail')
    if (navigation === 'previous-chapter' && chapterIndex > 0 && !busy) void loadChapter(chapterIndex - 1)
    if (navigation === 'next-chapter' && toc !== undefined && chapterIndex < toc.chapters.length - 1 && !busy) void loadChapter(chapterIndex + 1)
    if (input === 't' && !busy) setPage('toc')
    if (input === 's' && !busy) void showSources()
    if (input === 'a' && !busy) toggleShelf()
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

  const handleMenuInput = (input: string, key: InputKey): boolean => {
    if (menu === undefined) return false
    if (key.escape) { setMenu(undefined); return true }
    const next = navigationIndex(menu.index, menu.items.length, input, key, menu.items.length)
    if (next !== menu.index) setMenu((current) => current === undefined ? current : { ...current, index: next })
    if (key.return) { void runMenuAction(menu.items[menu.index]?.action ?? 'detail'); return true }
    return true
  }

  const handlePageScroll = (input: string, key: InputKey): void => {
    const helpPage = navigationRef.current.at(-2)?.page ?? 'home'
    const lines = page === 'help' ? helpLines(helpPage, homeArea).length : page === 'detail' ? detailLineCount(book, columns) : page === 'mapping' ? 8 : page === 'config' ? catalog.diagnostics.length + 4 : page === 'diagnostics' ? catalog.diagnostics.length + 2 : 6
    const next = navigationPage(pageScroll, lines, input, key, bodyHeight)
    if (next !== pageScroll) setPageScroll(next)
  }

  useInput((input, key) => {
    if (handleMenuInput(input, key)) return
    if (page === 'search') {
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
    if (input === 'q') { cancelOperation('正在退出…'); exit(); return }
    if (input === '?' ) { if (page === 'help') goBack(); else setPage('help'); return }
    if (input === 'd') { if (page !== 'diagnostics') setPage('diagnostics'); return }
    if (key.ctrl && input === 'k') { setPage('search'); setMessage(''); return }
    if (key.escape) {
      if (page === 'toc' && tocQuery.length > 0) { clearTocSearch(); return }
      if (busy && (operationRef.current?.kind === 'search' || operationRef.current?.kind === 'source-search')) { cancelActiveSearch(); return }
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
    if (page === 'home') handleHomeInput(input, key)
    else if (page === 'results') handleResultsInput(input, key)
    else if (page === 'detail') { handleDetailInput(input, key); if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'toc') handleTocInput(input, key)
    else if (page === 'reader') handleReaderInput(input, key)
    else if (page === 'sources') handleSourcesInput(input, key)
    else if (page === 'mapping') { handleMappingInput(input, key); if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'help' || page === 'diagnostics' || page === 'config') handlePageScroll(input, key)
  })

  const visibleMessage = messageOwner === page ? message : ''
  const helpPage = navigationRef.current.at(-2)?.page ?? 'home'
  const state: RenderState = { catalog, columns, home, history, homeArea, selected, listStart, bodyHeight, tocSelected, tocQuery, tocReversed, query, search, searchState, searchProgress, searchElapsedMs, book, toc, chapterIndex, contentLines: currentLines, contentLineKinds: currentLayout.lineKinds, readerLine: visibleReaderLine, sources, sourceSearch, sourceSearchState, sourceSearchStart, sourceSearchSelected, mappingToc, mappingIndex, mappingTarget, pageScroll, message: visibleMessage, helpPage, chapterCharacters: formattedContent === undefined ? 0 : countChapterCharacters(formattedContent), separator: terminal.separator }
  const visiblePage = renderPage(page, state)
  const commandActions = footer(page, busy, columns, searchState, sourceSearchState, menu !== undefined, homeArea, tocSearchActive, tocQuery.length > 0, tocReversed)
  const inputMode = page === 'search' || page === 'toc' && tocSearchActive
  const inputLabel = page === 'search' ? '搜索 › ' : page === 'toc' && tocSearchActive ? '章节 › ' : ''
  const inputValue = page === 'search' ? query : tocQuery
  const inputWidth = Math.max(0, columns - terminalWidth(commandActions) - 1 - terminalWidth(inputLabel) - 1)
  const commandInput = inputMode ? `${inputLabel}${tailTerminalText(inputValue, inputWidth)}█` : ''
  const pageContext = pageHeader(page, state)
  const preservePageStats = page === 'reader' || page === 'toc' || page === 'results'
  const header = { ...pageContext, right: preservePageStats ? pageContext.right : visibleMessage || (busy ? '处理中' : pageContext.right) }
  return <PageShell columns={columns} rows={rows} bodyHeight={bodyHeight} separator={terminal.separator} supported={terminal.supported} header={header} command={{ left: commandInput, right: commandActions }} content={visiblePage} menu={menu === undefined ? undefined : renderActionMenu(menu, columns, rows)} />
}
