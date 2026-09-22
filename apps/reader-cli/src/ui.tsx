import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import { ReaderApplication } from './application.ts'
import type { OpenBookResult, SearchOperationResult, SearchProgress, SearchResultGroup, TocResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import { layoutContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from './content-layout.ts'
import { actionMenuItems, actionMenuLabel } from './action-menu.ts'
import type { ActionMenuItem, ReaderAction } from './action-menu.ts'
import { keepIndexVisible, moveIndex, pageIndex, viewportFor } from './viewport.ts'

type Page = 'config' | 'home' | 'search' | 'results' | 'detail' | 'toc' | 'reader' | 'sources' | 'mapping' | 'help' | 'diagnostics'
type SearchUiState = 'idle' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error'
type OperationKind = 'search' | 'source-search' | 'task'

export interface ReaderUiProps {
  application: ReaderApplication
  catalog: SourceCatalogResult
}

interface UiOperation {
  id: number
  kind: OperationKind
  controller: AbortController
  promise?: Promise<unknown>
}

type MenuTarget =
  | { kind: 'search'; groupKey: string }
  | { kind: 'book'; bookId: string }

interface MenuState {
  target: MenuTarget
  items: ActionMenuItem[]
  index: number
}

interface InputKey {
  downArrow?: boolean
  upArrow?: boolean
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

export function ReaderUi({ application, catalog }: ReaderUiProps): React.ReactElement {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [page, setPage] = useState<Page>(catalog.entries.length === 0 ? 'config' : 'home')
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
  const [book, setBook] = useState<OpenBookResult>()
  const [toc, setToc] = useState<TocResult>()
  const [chapterIndex, setChapterIndex] = useState(0)
  const [content, setContent] = useState<string>()
  const [readerLine, setReaderLine] = useState(0)
  const [sources, setSources] = useState<KnownSourceView[]>([])
  const [sourceSearchStart, setSourceSearchStart] = useState(0)
  const [mappingTarget, setMappingTarget] = useState<KnownSourceView>()
  const [mappingToc, setMappingToc] = useState<TocResult>()
  const [mappingIndex, setMappingIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [searchProgress, setSearchProgress] = useState<SearchProgress>()
  const [menu, setMenu] = useState<MenuState>()
  const operationRef = useRef<UiOperation | undefined>(undefined)
  const nextOperationId = useRef(0)
  const selectedGroupKeyRef = useRef<string | undefined>(undefined)
  const pageRef = useRef(page)
  const mountedRef = useRef(true)

  const bodyHeight = Math.max(4, rows - 7)

  useEffect(() => {
    pageRef.current = page
    setSelected(0)
    setListStart(0)
    setPageScroll(0)
    setMenu(undefined)
  }, [page])

  useEffect(() => () => {
    mountedRef.current = false
    operationRef.current?.controller.abort()
  }, [])

  const beginOperation = (kind: OperationKind): UiOperation => {
    operationRef.current?.controller.abort()
    const operation: UiOperation = { id: nextOperationId.current + 1, kind, controller: new AbortController() }
    nextOperationId.current = operation.id
    operationRef.current = operation
    setBusy(true)
    return operation
  }

  const isCurrent = (operation: UiOperation): boolean => operationRef.current?.id === operation.id

  const finishOperation = (operation: UiOperation): void => {
    if (!isCurrent(operation)) return
    operationRef.current = undefined
    if (!mountedRef.current) return
    setBusy(false)
    setSearchProgress(undefined)
  }

  const cancelOperation = (text = '操作已取消'): void => {
    const operation = operationRef.current
    operation?.controller.abort()
    operationRef.current = undefined
    setBusy(false)
    setSearchProgress(undefined)
    if (operation !== undefined) setMessage(text)
  }

  const cancelActiveSearch = (): void => {
    const operation = operationRef.current
    if (operation?.kind !== 'search' && operation?.kind !== 'source-search') return
    operation.controller.abort()
    setBusy(true)
    setMessage('正在取消搜索，等待书源请求释放…')
    if (operation.kind === 'search') setSearchState('cancelling')
    else setSourceSearchState('cancelling')
  }

  const refreshHome = async (): Promise<void> => {
    const [books, searches] = await Promise.all([application.home(), application.searchHistory()])
    setHome(books)
    setHistory(searches)
  }

  useEffect(() => {
    void refreshHome().catch((error: unknown) => setMessage(errorMessage(error)))
  }, [])

  useEffect(() => {
    if (page !== 'reader' || book === undefined || toc === undefined || content === undefined) return
    const chapter = toc.chapters[chapterIndex]
    if (chapter === undefined) return
    const width = Math.max(8, columns - 4)
    const layout = layoutContent(sanitizeTerminalText(content), width)
    const anchor = paragraphOffsetAtLine(layout, readerLine, width)
    const timer = setTimeout(() => {
      void application.saveReadingPosition(book.book.bookId, chapter, toc.edition, anchor.paragraphIndex, anchor.offset, toc.revision).catch((error: unknown) => {
        if (mountedRef.current && pageRef.current === 'reader') setMessage(errorMessage(error))
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [application, book, chapterIndex, columns, content, page, readerLine, toc])

  const submitSearch = async (): Promise<void> => {
    if (query.trim().length === 0) { setMessage('请输入书名'); return }
    const operation = beginOperation('search')
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
      setSearch(result)
      setSearchState(result.cancelled ? 'cancelled' : 'complete')
      setSelected((current) => restoreGroupSelection(result.groups, current, selectedGroupKeyRef.current))
      setMessage(result.cancelled ? '搜索已取消，已保留已返回结果' : `找到 ${result.groups.length} 本书`)
      void refreshHome().catch((refreshError: unknown) => {
        if (mountedRef.current && isCurrent(operation)) setMessage(errorMessage(refreshError))
      })
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) {
        setSearchState('error')
        setMessage(errorMessage(error))
      }
    } finally {
      finishOperation(operation)
    }
  }

  const openSearchGroup = async (group: SearchResultGroup): Promise<OpenBookResult | undefined> => {
    const operation = beginOperation('task')
    setMessage('正在加载书籍详情…')
    try {
      const opened = await application.openSearchResult(group.candidates[0]!, group.candidates, operation.controller.signal)
      if (!isCurrent(operation)) return undefined
      setBook(opened)
      setToc(undefined)
      setPage('detail')
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

  const openSelected = async (): Promise<OpenBookResult | undefined> => {
    const group = search?.groups[selected]
    if (group === undefined || busy || searchState === 'running' || searchState === 'cancelling') return undefined
    return openSearchGroup(group)
  }

  const loadToc = async (edition?: string, bookOverride?: OpenBookResult): Promise<TocResult | undefined> => {
    const currentBook = bookOverride ?? book
    if (currentBook === undefined) return undefined
    const operation = beginOperation('task')
    setMessage('正在加载目录…')
    try {
      const requestedEdition = edition ?? currentBook.reading?.activeEditionKey ?? currentBook.book.activeEditionKey
      const result = await application.loadToc(currentBook.book.bookId, requestedEdition, operation.controller.signal)
      if (!isCurrent(operation)) return undefined
      setBook(currentBook)
      setToc(result)
      const saved = currentBook.reading?.positions[result.edition.editionKey]
      const resumeIndex = saved === undefined ? -1 : result.chapters.findIndex((item) => item.chapterUrl === saved.chapterUrl)
      setChapterIndex(resumeIndex >= 0 ? resumeIndex : 0)
      setPage('toc')
      setMessage(`${result.chapters.length} 章${resumeIndex >= 0 ? ' · 已定位到上次阅读章节' : ''}`)
      return result
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      return undefined
    } finally {
      finishOperation(operation)
    }
  }

  const loadChapter = async (index: number, bookOverride?: OpenBookResult, tocOverride?: TocResult): Promise<void> => {
    const currentBook = bookOverride ?? book
    const currentToc = tocOverride ?? toc
    if (currentBook === undefined || currentToc === undefined) return
    const chapter = currentToc.chapters[index]
    if (chapter === undefined) return
    const operation = beginOperation('task')
    setMessage(`正在加载第 ${index + 1} 章…`)
    try {
      const result = await application.loadContent(currentBook.book.bookId, chapter, currentToc.edition.editionKey, operation.controller.signal)
      if (!isCurrent(operation)) return
      const width = Math.max(8, columns - 4)
      const layout = layoutContent(sanitizeTerminalText(result.content.cleaned), width)
      const saved = currentBook.reading?.positions[currentToc.edition.editionKey]
      const resumeLine = saved?.chapterUrl === chapter.chapterUrl ? lineAtParagraphOffset(layout, saved.paragraphIndex, saved.offset, width) : 0
      setBook(currentBook)
      setChapterIndex(index)
      setContent(result.content.cleaned)
      setReaderLine(resumeLine)
      setPage('reader')
      setMessage(`${result.content.contentType === 'html' ? '正文已加载，HTML 已清洗为文本' : '正文已加载'}${resumeLine > 0 ? ' · 已恢复上次位置' : ''}`)
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
      setPage('sources')
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    } finally {
      finishOperation(operation)
    }
  }

  const resolveMenuBook = async (target: MenuTarget): Promise<OpenBookResult | undefined> => {
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
    const group = search?.groups.find((item) => item.key === target.groupKey)
    if (group === undefined || searchState === 'running' || searchState === 'cancelling') return undefined
    return openSearchGroup(group)
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
    const opened = await resolveMenuBook(state.target)
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
      await loadChapter(resumeIndex, opened, loadedToc)
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
    } else if (book !== undefined && ['detail', 'toc', 'reader', 'sources', 'mapping'].includes(page)) {
      target = { kind: 'book', bookId: book.book.bookId }
      hasSources = book.sources.length > 0 || sources.length > 0
    } else if (page === 'home') {
      const item = homeItemsForArea(home, homeArea)[selected]
      if (item !== undefined) {
        target = { kind: 'book', bookId: item.book.bookId }
        hasBook = true
        hasSources = true
      }
    }
    if (target === undefined) return
    const menuPage = page === 'home' || page === 'results' || page === 'detail' || page === 'toc' || page === 'reader' || page === 'sources' || page === 'mapping' ? page : 'detail'
    const items = actionMenuItems({ hasBook, hasSources, hasToc: hasBook, page: menuPage, busy })
    setMenu({ target, items, index: 0 })
  }

  const startReading = async (): Promise<void> => {
    if (book === undefined) return
    const loaded = await loadToc()
    if (loaded === undefined) return
    const saved = book.reading?.positions[loaded.edition.editionKey]
    const resumeIndex = saved === undefined ? 0 : Math.max(0, loaded.chapters.findIndex((item) => item.chapterUrl === saved.chapterUrl))
    await loadChapter(resumeIndex, book, loaded)
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
            setBook(opened); setToc(undefined); setPage('detail')
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
        const opened = await openSelected()
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
    const total = toc?.chapters.length ?? 0
    const visible = Math.max(1, bodyHeight - 1)
    const next = navigationIndex(chapterIndex, total, input, key, visible)
    if (next !== chapterIndex) {
      setChapterIndex(next)
      setListStart((start) => keepIndexVisible(next, total, visible, start).start)
    }
    if (key.return && !busy) void loadChapter(chapterIndex)
  }

  const handleReaderInput = (input: string, key: InputKey): void => {
    const height = Math.max(4, rows - 8)
    if (input === 'j' || key.downArrow) setReaderLine((value) => value + 1)
    if (input === 'k' || key.upArrow) setReaderLine((value) => Math.max(0, value - 1))
    if (input === ' ' || key.pageDown) setReaderLine((value) => value + height - 2)
    if (input === 'b' || key.pageUp) setReaderLine((value) => Math.max(0, value - height + 2))
    if (input === '[' && chapterIndex > 0 && !busy) void loadChapter(chapterIndex - 1)
    if (input === ']' && toc !== undefined && chapterIndex < toc.chapters.length - 1 && !busy) void loadChapter(chapterIndex + 1)
    if (input === 't' && !busy) setPage('toc')
    if (input === 's' && !busy) void showSources()
    if (input === 'a' && !busy) toggleShelf()
  }

  const handleSourcesInput = (input: string, key: InputKey): void => {
    if (input === 'm' && book !== undefined && !busy) {
      const operation = beginOperation('source-search')
      const before = new Set(sources.map((item) => item.editionKey))
      setSourceSearch(undefined)
      setSourceSearchState('running')
      setSourceSearchStart(0)
      setMessage('正在搜索更多书源…')
      const request = application.searchMoreSources(book.book.bookId, operation.controller.signal, (progress) => {
        if (isCurrent(operation)) setSearchProgress(progress)
      }, (snapshot) => {
        if (isCurrent(operation)) setSourceSearch(snapshot)
      })
      operation.promise = request
      void request.then(async (result) => {
        if (!isCurrent(operation)) return
        const items = await application.knownSources(book.book.bookId)
        if (!isCurrent(operation)) return
        setSources(items)
        setSourceSearch(result)
        setSourceSearchState(result.cancelled ? 'cancelled' : 'complete')
        const added = items.filter((item) => !before.has(item.editionKey)).length
        setMessage(result.cancelled ? `搜索已取消，保留 ${added} 个已匹配书源` : `已搜索 ${result.sources.length} 个书源，新增 ${added} 个严格匹配书源`)
      }).catch((error: unknown) => {
        if (isCurrent(operation) && !isAbortError(error)) { setSourceSearchState('error'); setMessage(errorMessage(error)) }
      }).finally(() => finishOperation(operation))
      return
    }
    if (sourceSearchState === 'running' || sourceSearchState === 'cancelling') {
      const matchedCount = sourceSearch?.results.length ?? 0
      const visible = Math.max(1, bodyHeight - 3)
      const next = navigationPage(sourceSearchStart, matchedCount, input, key, visible)
      if (next !== sourceSearchStart) setSourceSearchStart(next)
      return
    }
    const total = sources.length
    const visible = Math.max(1, bodyHeight - (sourceSearch === undefined ? 1 : 2))
    const next = navigationIndex(selected, total, input, key, visible)
    if (next !== selected) { setSelected(next); setListStart((start) => keepIndexVisible(next, total, visible, start).start) }
    if (key.return && !busy) {
      const target = sources[selected]
      if (target?.state === 'available' && book !== undefined) {
        if (toc?.chapters[chapterIndex] !== undefined) {
          const operation = beginOperation('task')
          setMessage('正在加载目标书源目录以计算章节映射…')
          void application.loadToc(book.book.bookId, target.editionKey, operation.controller.signal).then((targetToc) => {
            if (!isCurrent(operation)) return
            const current = toc.chapters[chapterIndex]!
            const normalized = normalizeChapterTitle(current.title)
            const targetIndex = targetToc.chapters.findIndex((item) => normalizeChapterTitle(item.title) === normalized)
            setMappingTarget(target)
            setMappingToc(targetToc)
            setMappingIndex(targetIndex >= 0 ? targetIndex : Math.min(chapterIndex, Math.max(0, targetToc.chapters.length - 1)))
            setPage('mapping')
            setMessage(targetIndex < 0 ? '未找到同名章节，将使用目录范围内的索引回退，请确认' : '已按章节标题找到目标章节，请确认')
          }).catch((error: unknown) => {
            if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
          }).finally(() => finishOperation(operation))
        } else {
          const operation = beginOperation('task')
          setMessage('正在切换书源…')
          void application.switchSource(book.book.bookId, target.editionKey, operation.controller.signal).then((opened) => {
            if (!isCurrent(operation)) return
            setBook(opened); setMessage('书源已切换，目录需要重新加载'); setToc(undefined); setPage('detail')
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
        if (mappingToc !== undefined) { setToc(mappingToc); setChapterIndex(mappingIndex); setPage('toc') } else { setToc(undefined); setPage('detail') }
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
    const lines = page === 'detail' ? detailLineCount(book, columns, message) : page === 'mapping' ? 8 : page === 'config' ? catalog.diagnostics.length + 4 : page === 'diagnostics' ? catalog.diagnostics.length + 2 : 6
    const next = navigationPage(pageScroll, lines, input, key, bodyHeight)
    if (next !== pageScroll) setPageScroll(next)
  }

  useInput((input, key) => {
    if (handleMenuInput(input, key)) return
    if (page === 'search') {
      if (key.escape) { setPage('home'); setMessage(''); return }
      if (key.return) { void submitSearch(); return }
      if (key.backspace || key.delete) { setQuery((value) => value.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && input.length > 0) setQuery((value) => value + input)
      return
    }
    if (key.ctrl && input === 'c') { cancelOperation('正在退出…'); exit(); return }
    if (input === 'q') { cancelOperation('正在退出…'); exit(); return }
    if (input === '?' ) { cancelOperation(); setPage('help'); return }
    if (input === 'd') { cancelOperation(); setPage('diagnostics'); return }
    if (key.ctrl && input === 'k') { cancelOperation(); setPage('search'); setMessage(''); return }
    if (key.escape) {
      if (busy && (operationRef.current?.kind === 'search' || operationRef.current?.kind === 'source-search')) { cancelActiveSearch(); return }
      cancelOperation()
      setPage(previousPage(page))
      return
    }
    if (input === 'o' && ['home', 'results', 'detail', 'toc', 'reader', 'sources', 'mapping'].includes(page)) { openMenu(); return }
    if (page === 'home') handleHomeInput(input, key)
    else if (page === 'results') handleResultsInput(input, key)
    else if (page === 'detail') { handleDetailInput(input, key); if (key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'toc') handleTocInput(input, key)
    else if (page === 'reader') handleReaderInput(input, key)
    else if (page === 'sources') handleSourcesInput(input, key)
    else if (page === 'mapping') handleMappingInput(input, key)
    else if (page === 'help' || page === 'diagnostics' || page === 'config') handlePageScroll(input, key)
  })

  const currentLines = content === undefined ? [] : layoutContent(sanitizeTerminalText(content), Math.max(8, columns - 4)).lines
  const state: RenderState = { catalog, columns, home, history, homeArea, selected, listStart, bodyHeight, query, search, searchState, searchProgress, book, toc, chapterIndex, contentLines: currentLines, readerLine, rows, sources, sourceSearch, sourceSearchState, sourceSearchStart, mappingToc, mappingIndex, mappingTarget, pageScroll, message }
  const visiblePage = menu === undefined ? renderPage(page, state) : renderActionMenu(menu)
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Text color="cyan" bold>Legado Reader  ·  {pageLabel(page)}</Text>
      <Text dimColor>{display(catalog.sourceLocation || '未配置书源')} · {catalog.entries.filter((entry) => entry.state === 'available').length}/{catalog.entries.length} 个可用 · {busy ? '处理中' : '就绪'}</Text>
      <Text>{'─'.repeat(Math.max(8, Math.min(columns, 120)))}</Text>
      {visiblePage}
      <Text>{'─'.repeat(Math.max(8, Math.min(columns, 120)))}</Text>
      <Text dimColor>{footer(page, busy, columns, searchState, sourceSearchState, menu !== undefined)}</Text>
    </Box>
  )
}

interface RenderState {
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
  readerLine: number
  rows: number
  sources: KnownSourceView[]
  sourceSearch: SearchOperationResult | undefined
  sourceSearchState: SearchUiState
  sourceSearchStart: number
  mappingToc: TocResult | undefined
  mappingIndex: number
  mappingTarget: KnownSourceView | undefined
  pageScroll: number
  message: string
}

function renderPage(page: Page, state: RenderState): React.ReactElement {
  if (page === 'config') return renderConfig(state.catalog, state.message, state.pageScroll, state.bodyHeight)
  if (page === 'home') return renderHome(state.home, state.history, state.homeArea, state.selected, state.listStart, state.bodyHeight, state.message)
  if (page === 'search') return renderSearch(state.query, state.searchProgress, state.message)
  if (page === 'results') return renderResults(state.search, state.selected, state.listStart, state.bodyHeight, state.searchState, state.searchProgress, state.message)
  if (page === 'detail') return renderDetail(state.book, state.pageScroll, state.bodyHeight, state.columns, state.message)
  if (page === 'toc') return renderToc(state.toc, state.chapterIndex, state.listStart, state.bodyHeight, state.message)
  if (page === 'reader') return renderReader(state.book, state.toc, state.chapterIndex, state.contentLines, state.readerLine, state.rows, state.message)
  if (page === 'sources') return renderSources(state.sources, state.selected, state.listStart, state.sourceSearch, state.sourceSearchState, state.sourceSearchStart, state.bodyHeight, state.searchProgress, state.message)
  if (page === 'mapping') return renderMapping(state.book, state.toc, state.chapterIndex, state.mappingToc, state.mappingIndex, state.mappingTarget, state.pageScroll, state.bodyHeight, state.message)
  if (page === 'help') return renderHelp(state.pageScroll, state.bodyHeight)
  return renderDiagnostics(state.catalog.diagnostics, state.pageScroll, state.bodyHeight, state.message)
}

export function homeItemsForArea(items: readonly HomeBookView[], area: number): HomeBookView[] {
  if (area === 0) return items.filter((item) => item.isOnBookshelf)
  if (area === 1) return items.filter((item) => item.reading !== undefined)
  return [...items]
}

function renderConfig(catalog: SourceCatalogResult, message: string, scroll: number, height: number): React.ReactElement {
  const lines = ['需要配置书源', '使用 legado-reader --source <文件、目录或 HTTP(S) JSON 地址>', '或设置 LEGADO_READER_SOURCE 后重新启动。', ...catalog.diagnostics.map((item) => `[!] ${item}`), ...(message.length > 0 ? [message] : [])]
  return renderLineViewport(lines, scroll, height)
}

function renderHome(items: HomeBookView[], history: Awaited<ReturnType<ReaderApplication['searchHistory']>>, area: number, selected: number, start: number, height: number, message: string): React.ReactElement {
  const books = homeItemsForArea(items, area)
  const title = '[1] 书架   [2] 最近阅读   [3] 搜索记录'
  if (area === 2) {
    const range = viewportFor(selected, history.length, Math.max(1, height - 2), start)
    const body = history.slice(range.start, range.end).map((item, offset) => {
      const index = range.start + offset
      return <Text key={item.id} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.keyword)} · {formatSearchTime(item)} · {item.summary.candidates} 个结果</Text>
    })
    return <Box flexDirection="column"><Text bold>{title}</Text>{body.length === 0 ? <Text>还没有搜索记录。</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
  }
  const visible = Math.max(1, Math.floor((height - 2) / 2))
  const range = viewportFor(selected, books.length, visible, start)
  const body = books.slice(range.start, range.end).map((item, offset) => {
    const index = range.start + offset
    return <Box key={item.book.bookId} flexDirection="column"><Text color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.book.name)} · {display(item.book.author ?? '作者未知')} {item.isOnBookshelf ? '[书架]' : item.reading === undefined ? '' : '[未加入]'}</Text><Text dimColor>  当前章节：{display(item.currentChapter ?? '尚未开始阅读')} · 上次阅读：{display(item.lastReadAt ?? '—')}</Text></Box>
  })
  return <Box flexDirection="column"><Text bold>{title}</Text>{body.length === 0 ? <Text>{area === 0 ? '书架为空，可按 Ctrl+K 搜索书籍。' : '还没有阅读记录。'}</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderSearch(query: string, progress: SearchProgress | undefined, message: string): React.ReactElement {
  return <Box flexDirection="column"><Text bold>搜索书籍</Text><Text>书名  {display(query)}█</Text>{progress === undefined ? <Text>{message || 'Enter 提交搜索，Esc 返回。'}</Text> : <Text color="cyan">{formatProgress(progress)}</Text>}{message.length > 0 && progress !== undefined ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderResults(search: SearchOperationResult | undefined, selected: number, start: number, height: number, state: SearchUiState, progress: SearchProgress | undefined, message: string): React.ReactElement {
  const groups = search?.groups ?? []
  const range = viewportFor(selected, groups.length, Math.max(1, height - 2), start)
  const body = groups.slice(range.start, range.end).map((group, offset) => {
    const index = range.start + offset
    const first = group.candidates[0]
    const sourceCount = group.candidates.length > 1 ? ` · +${group.candidates.length - 1} 个书源` : ''
    const duration = first?.searchDurationMs === undefined ? '耗时未知' : `耗时 ${formatDuration(first.searchDurationMs)}`
    return <Text key={group.key} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(group.candidate.name ?? group.candidate.bookUrl)} · {display(group.candidate.author ?? '作者未知')} · {display(group.source.source.bookSourceName)}{sourceCount} · {searchMatchLabel(group.rank)} · {duration}</Text>
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
    `更新时间   ${active?.updateTime ?? book?.metadata?.updateTime ?? '未知'}`,
    `书架       ${book?.onBookshelf === true ? '已加入 · [a] 移出书架' : '未加入 · [a] 加入书架'}`,
    `阅读记录   ${book?.reading?.lastReadAt ?? '暂无'} · 当前章节：${activeReadingChapter(book)}`,
    '简介',
    ...introLines.map((line) => `  ${line}`),
    ...(message.length > 0 ? [message] : []),
  ]
  return renderLineViewport(lines, scroll, height)
}

function renderToc(toc: TocResult | undefined, selected: number, start: number, height: number, message: string): React.ReactElement {
  const chapters = toc?.chapters ?? []
  const range = viewportFor(selected, chapters.length, Math.max(1, height - 1), start)
  const body = chapters.slice(range.start, range.end).map((chapter, offset) => {
    const index = range.start + offset
    return <Text key={chapter.chapterUrl} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(chapter.title)}</Text>
  })
  return <Box flexDirection="column"><Text bold>章节目录 · {chapters.length} 章</Text>{body.length === 0 ? <Text>目录为空。</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderReader(book: OpenBookResult | undefined, toc: TocResult | undefined, index: number, lines: string[], line: number, rows: number, message: string): React.ReactElement {
  return <Box flexDirection="column"><Text bold>{display(book?.book.name ?? '')} · {display(toc?.chapters[index]?.title ?? '')}</Text>{lines.slice(line, line + Math.max(1, rows - 8)).map((value, offset) => <Text key={`${line + offset}-${value}`}>{display(value)}</Text>)}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderSources(items: KnownSourceView[], selected: number, start: number, sourceSearch: SearchOperationResult | undefined, state: SearchUiState, sourceSearchStart: number, height: number, progress: SearchProgress | undefined, message: string): React.ReactElement {
  const searching = state === 'running' || state === 'cancelling'
  const range = viewportFor(selected, items.length, Math.max(1, height - (sourceSearch === undefined ? 1 : 2)), start)
  const body = items.slice(range.start, range.end).map((item, offset) => {
    const index = range.start + offset
    return <Text key={item.editionKey} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.sourceName ?? item.name ?? item.sourceId)} · {sourceState(item.state)} · 搜索耗时 {item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)} · 最新章节：{display(item.lastChapter ?? '未知')} · 更新时间：{display(item.updateTime ?? '未知')}</Text>
  })
  const matchedRows = sourceSearch?.results.map((item) => <Text key={`${item.candidate.sourceId}:${item.candidate.bookUrl}`} color="green">+ {display(item.source.source.bookSourceName)} · {display(item.candidate.name ?? '未知')} · {display(item.candidate.author ?? '未知')} · 搜索耗时 {item.searchDurationMs === undefined ? '未知' : formatDuration(item.searchDurationMs)} · 最新章节：{display(item.candidate.lastChapter ?? '未知')} · 更新时间：{display(item.candidate.updateTime ?? '未知')}</Text>) ?? []
  const matched = sourceSearch?.results.length ?? 0
  const unmatched = progress === undefined ? 0 : Math.max(0, progress.candidates - matched)
  const searchLines = sourceSearch === undefined ? [] : [searching ? `${progress === undefined ? '搜索更多书源…' : formatProgress(progress)} · 已匹配 ${matched} 个 · 未匹配 ${unmatched} 个` : `已匹配 ${matched} 个候选 · 总耗时 ${formatDuration(sourceSearch.elapsedMs)}`]
  const matchedRange = viewportFor(sourceSearchStart, matchedRows.length, Math.max(1, height - 3), sourceSearchStart)
  const visibleMatchedRows = matchedRows.slice(matchedRange.start, matchedRange.end)
  const visibleBody = searching ? [] : body
  return <Box flexDirection="column"><Text bold>已知书源 · 本地记录</Text>{searchLines.map((item) => <Text key={item} color="cyan">{item}</Text>)}{searching ? visibleMatchedRows : null}{visibleBody.length === 0 && visibleMatchedRows.length === 0 ? <Text>{sourceSearch === undefined ? '尚未搜索到书源。' : '没有书名和作者都完整匹配的候选。'}</Text> : visibleBody}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderMapping(book: OpenBookResult | undefined, toc: TocResult | undefined, index: number, targetToc: TocResult | undefined, targetIndex: number, target: KnownSourceView | undefined, scroll: number, height: number, message: string): React.ReactElement {
  const lines = ['确认切换书源', `书籍  ${book?.book.name ?? ''}`, `原源  ${toc?.source.source.bookSourceName ?? book?.source.source.bookSourceName ?? ''}`, `目标源  ${target?.sourceName ?? target?.name ?? ''}`, `当前章节  ${toc?.chapters[index]?.title ?? '尚未选择章节'}`, `目标章节  ${targetToc?.chapters[targetIndex]?.title ?? '未找到，需要手动选择'}`, message]
  return renderLineViewport(lines, scroll, height)
}

function renderHelp(scroll: number, height: number): React.ReactElement {
  return renderLineViewport(['帮助', 'Ctrl+K 搜索书籍，j/k 或方向键移动，Enter 确认，Esc 返回，d 查看诊断。', '书籍页面按 o 打开操作菜单：继续阅读、书籍信息、章节列表、书源切换。', '阅读页：空格/PageDown 翻页，b/PageUp 回退，[ ] 切章，t 目录，s 书源，a 书架。', '已知书源页：Enter 使用已记录书源，m 手动搜索更多书源；搜索过程中 Esc 只取消任务。'], scroll, height)
}

function renderDiagnostics(items: readonly string[], scroll: number, height: number, message: string): React.ReactElement {
  return renderLineViewport(['诊断', ...(items.length === 0 ? ['没有诊断信息。'] : items.map((item) => `[!] ${item}`)), ...(message.length > 0 ? [message] : [])], scroll, height)
}

function renderLineViewport(lines: readonly string[], scroll: number, height: number): React.ReactElement {
  const range = viewportFor(scroll, lines.length, Math.max(1, height), scroll)
  return <Box flexDirection="column">{lines.slice(range.start, range.end).map((line, index) => <Text key={`${range.start + index}-${line}`}>{display(line)}</Text>)}</Box>
}

function renderActionMenu(menu: MenuState): React.ReactElement {
  return <Box flexDirection="column"><Text bold>操作</Text>{menu.items.map((item, index) => <Text key={item.action} color={index === menu.index ? 'yellow' : item.enabled ? 'white' : 'gray'}>{index === menu.index ? '> ' : '  '}{display(actionMenuLabel(item))}</Text>)}</Box>
}

function navigationIndex(index: number, total: number, input: string, key: InputKey, visible: number): number {
  if (input === 'j' || key.downArrow) return moveIndex(index, total, 1)
  if (input === 'k' || key.upArrow) return moveIndex(index, total, -1)
  if (key.pageDown) return pageIndex(index, total, visible, 1)
  if (key.pageUp) return pageIndex(index, total, visible, -1)
  if (key.home) return 0
  if (key.end) return Math.max(0, total - 1)
  return index
}

function navigationPage(scroll: number, total: number, input: string, key: InputKey, visible: number): number {
  if (input === 'j' || key.downArrow) return Math.min(Math.max(0, total - visible), scroll + 1)
  if (input === 'k' || key.upArrow) return Math.max(0, scroll - 1)
  if (key.pageDown) return Math.min(Math.max(0, total - visible), scroll + Math.max(1, visible - 1))
  if (key.pageUp) return Math.max(0, scroll - Math.max(1, visible - 1))
  if (key.home) return 0
  if (key.end) return Math.max(0, total - visible)
  return scroll
}

function selectedGroupIndex(search: SearchOperationResult, selected: number): number {
  return Math.max(0, Math.min(Math.max(0, search.groups.length - 1), selected))
}

function restoreGroupSelection(groups: readonly SearchResultGroup[], selected: number, key: string | undefined): number {
  if (key !== undefined) {
    const index = groups.findIndex((group) => group.key === key)
    if (index >= 0) return index
  }
  return Math.max(0, Math.min(Math.max(0, groups.length - 1), selected))
}

function activeReadingChapter(book: OpenBookResult | undefined): string {
  if (book?.reading === undefined) return '尚未开始阅读'
  const edition = book.reading.activeEditionKey ?? book.book.activeEditionKey
  return edition === undefined ? '尚未开始阅读' : book.reading.positions[edition]?.title ?? '尚未开始阅读'
}

function detailLineCount(book: OpenBookResult | undefined, width: number, message: string): number {
  if (book === undefined) return 1 + (message.length > 0 ? 1 : 0)
  const introLines = layoutContent(book.book.intro ?? '书源未返回简介', Math.max(8, width - 10)).lines.length
  return 9 + introLines + (message.length > 0 ? 1 : 0)
}

function formatSearchTime(item: { completedAt?: string; startedAt: string }): string {
  const value = item.completedAt ?? item.startedAt
  return value.replace('T', ' ').slice(0, 16)
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未知'
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`
}

function formatProgress(progress: SearchProgress): string {
  const active = progress.activeSources.length === 0 ? '等待调度' : progress.activeSources.map(display).join('、')
  return `搜索进度 ${progress.completed}/${progress.total} 个书源 · 当前：${active} · 已发现 ${progress.candidates} 本 · 总耗时 ${formatDuration(progress.elapsedMs)}`
}

function display(value: string): string { return sanitizeTerminalText(value) }
function searchMatchLabel(rank: SearchResultGroup['rank']): string { return rank === 'exact' ? '完全匹配' : rank === 'contains' ? '包含关键词' : '其他' }
// Chapter mapping ignores punctuation and spacing so equivalent source titles can be aligned.
function normalizeChapterTitle(value: string): string { return display(value).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '') }
function pageLabel(page: Page): string { return ({ config: '配置', home: '首页', search: '搜索', results: '搜索结果', detail: '详情', toc: '目录', reader: '阅读', sources: '已知书源', mapping: '章节映射', help: '帮助', diagnostics: '诊断' } as Record<Page, string>)[page] }
function previousPage(page: Page): Page { return page === 'config' ? 'config' : page === 'home' ? 'home' : page === 'search' || page === 'results' ? 'home' : page === 'detail' ? 'results' : page === 'toc' ? 'detail' : page === 'reader' ? 'toc' : page === 'sources' ? 'detail' : page === 'mapping' ? 'sources' : 'home' }
function sourceState(value: KnownSourceView['state']): string { return value === 'available' ? '可用' : value === 'stale' ? '需要重新搜索' : value === 'removed' ? '书源已移除' : '定义冲突' }
function footer(page: Page, busy: boolean, columns: number, searchState: SearchUiState, sourceSearchState: SearchUiState, menuOpen: boolean): string {
  if (menuOpen) return '[Enter] 执行  [j/k] 选择  [Esc] 关闭'
  if (columns < 48) return busy ? '处理中 · Esc 取消' : 'Esc 返回 · ? 帮助 · d 诊断 · q 退出'
  if (page === 'home') return '[Enter] 打开  [o] 操作  [j/k] 移动  [Esc] 返回'
  if (page === 'search') return '[Enter] 搜索  [Esc] 返回'
  if (page === 'results') return searchState === 'running' || searchState === 'cancelling' ? '[Esc] 取消搜索  [o] 操作  [j/k] 移动' : '[Enter] 详情  [t] 目录  [o] 操作  [Esc] 返回'
  if (page === 'sources' && (sourceSearchState === 'running' || sourceSearchState === 'cancelling')) return '[Esc] 取消搜索  [j/k] 滚动已匹配书源'
  if (busy) return '处理中 · Esc 取消'
  if (page === 'detail') return '[Enter] 开始/继续阅读  [t] 目录  [s] 换源  [a] 加入/移出书架  [o] 操作'
  if (page === 'toc') return '[Enter] 阅读  [o] 操作  [j/k] 移动  [Esc] 返回'
  if (page === 'reader') return '[ ] 上下章  [t] 目录  [s] 换源  [a] 书架  [o] 操作'
  if (page === 'sources') return '[Enter] 换源  [m] 搜索更多  [o] 操作  [Esc] 返回'
  if (page === 'mapping') return '[Enter] 确认切换  [o] 操作  [Esc] 取消'
  return '[j/k] 滚动  [Esc] 返回  [d] 诊断  [?] 帮助  [q] 退出'
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError' }
