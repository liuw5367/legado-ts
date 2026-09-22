import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import { ReaderApplication } from './application.ts'
import type { OpenBookResult, SearchOperationResult, SearchProgress, SearchResultGroup, TocResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import { layoutContent, layoutFormattedContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from './content-layout.ts'
import { formatChapterContent } from './content-format.ts'
import type { ContentBlockKind, FormattedContent } from './content-format.ts'
import { actionMenuItems } from './action-menu.ts'
import type { ReaderAction } from './action-menu.ts'
import { keepIndexVisible } from './viewport.ts'
import { renderActionMenu, renderPage, type RenderState } from './ui-pages.tsx'
import { useUiOperation } from './use-ui-operation.ts'
import {
  HELP_LINES,
  activeEditionKey,
  detailLineCount,
  display,
  errorMessage,
  footer,
  homeItemsForArea,
  isAbortError,
  navigationIndex,
  navigationPage,
  normalizeChapterTitle,
  pageLabel,
  previousPage,
  restoreGroupSelection,
  selectedGroupIndex,
  type InputKey,
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

export function ReaderUi({ application, catalog }: ReaderUiProps): React.ReactElement {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [page, setPageState] = useState<Page>(catalog.entries.length === 0 ? 'config' : 'home')
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
  const [menu, setMenu] = useState<MenuState>()
  const selectedGroupKeyRef = useRef<string | undefined>(undefined)
  const pageRef = useRef(page)

  const setMessage = (text: string): void => {
    setMessageState(text)
    setMessageOwner(pageRef.current)
  }

  const setPage = (next: Page): void => {
    pageRef.current = next
    setMessageState('')
    setMessageOwner(next)
    setPageState(next)
  }

  const { operationRef, mountedRef, beginOperation, isCurrent, finishOperation, cancelOperation, cancelActiveSearch } = useUiOperation({
    setBusy,
    setSearchProgress,
    setSearchState,
    setSourceSearchState,
    setMessage,
  })

  const bodyHeight = Math.max(4, rows - 7)

  useEffect(() => {
    pageRef.current = page
    setSelected(0)
    setListStart(0)
    setPageScroll(0)
    setMenu(undefined)
  }, [page])

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
    const layout = formattedContent === undefined ? layoutContent(sanitizeTerminalText(content), width) : layoutFormattedContent(formattedContent, width)
    const anchor = paragraphOffsetAtLine(layout, readerLine, width)
    const timer = setTimeout(() => {
      void application.saveReadingPosition(book.book.bookId, chapter, toc.edition, anchor.paragraphIndex, anchor.offset, toc.revision).catch((error: unknown) => {
        if (mountedRef.current && pageRef.current === 'reader') setMessage(errorMessage(error))
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [application, book, chapterIndex, columns, content, formattedContent, page, readerLine, toc])

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
    if (group === undefined) return undefined
    if (operationRef.current?.kind === 'search') await cancelActiveSearch()
    if (operationRef.current !== undefined) return undefined
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

  const loadChapter = async (index: number, bookOverride?: OpenBookResult, tocOverride?: TocResult, refresh = false): Promise<void> => {
    const currentBook = bookOverride ?? book
    const currentToc = tocOverride ?? toc
    if (currentBook === undefined || currentToc === undefined) return
    const chapter = currentToc.chapters[index]
    if (chapter === undefined) return
    const operation = beginOperation('task')
    setMessage(refresh ? '正在刷新当前章节…' : `正在加载第 ${index + 1} 章…`)
    try {
      const result = await application.loadContent(currentBook.book.bookId, chapter, currentToc.edition.editionKey, operation.controller.signal, { refresh })
      if (!isCurrent(operation)) return
      const width = Math.max(8, columns - 4)
      const formatted = formatChapterContent(result.content.cleaned, result.content.contentType)
      const layout = layoutFormattedContent(formatted, width)
      const saved = currentBook.reading?.positions[currentToc.edition.editionKey]
      const resumeLine = refresh ? Math.min(readerLine, Math.max(0, layout.lines.length - 1)) : saved?.chapterUrl === chapter.chapterUrl ? lineAtParagraphOffset(layout, saved.paragraphIndex, saved.offset, width) : 0
      setBook(currentBook)
      setChapterIndex(index)
      setContent(formatted.text)
      setFormattedContent(formatted)
      setReaderLine(resumeLine)
      setPage('reader')
      setMessage(`${refresh ? '正文已刷新' : result.content.contentType === 'html' ? '正文已加载，已按段落排版' : '正文已加载'}${resumeLine > 0 && !refresh ? ' · 已恢复上次位置' : ''}`)
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
    if (operationRef.current?.kind === 'search') await cancelActiveSearch()
    if (operationRef.current !== undefined) return undefined
    const group = search?.groups.find((item) => item.key === target.groupKey)
    if (group === undefined) return undefined
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
    if (input === ' ' || key.pageDown || key.rightArrow) setReaderLine((value) => value + height - 2)
    if (input === 'b' || key.pageUp || key.leftArrow) setReaderLine((value) => Math.max(0, value - height + 2))
    if (input === 'r' && !busy) void loadChapter(chapterIndex, undefined, undefined, true)
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
        if (isAbortError(error)) {
          setSourceSearchState('cancelled')
          setMessage('搜索已取消，保留已有书源')
        } else {
          setSourceSearchState('error')
          setMessage(errorMessage(error))
        }
      }).finally(() => finishOperation(operation))
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
    const lines = page === 'help' ? HELP_LINES.length : page === 'detail' ? detailLineCount(book, columns, message) : page === 'mapping' ? 8 : page === 'config' ? catalog.diagnostics.length + 4 : page === 'diagnostics' ? catalog.diagnostics.length + 2 : 6
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
    if (input === 'o' && ['home', 'results', 'detail'].includes(page)) { openMenu(); return }
    if (page === 'home') handleHomeInput(input, key)
    else if (page === 'results') handleResultsInput(input, key)
    else if (page === 'detail') { handleDetailInput(input, key); if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'toc') handleTocInput(input, key)
    else if (page === 'reader') handleReaderInput(input, key)
    else if (page === 'sources') handleSourcesInput(input, key)
    else if (page === 'mapping') { handleMappingInput(input, key); if (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp || key.home || key.end || input === 'j' || input === 'k') handlePageScroll(input, key) }
    else if (page === 'help' || page === 'diagnostics' || page === 'config') handlePageScroll(input, key)
  })

  const currentLayout = content === undefined ? { lines: [], lineKinds: [] as Array<ContentBlockKind | undefined> } : formattedContent === undefined ? layoutContent(sanitizeTerminalText(content), Math.max(8, columns - 4)) : layoutFormattedContent(formattedContent, Math.max(8, columns - 4))
  const currentLines = currentLayout.lines
  const visibleMessage = messageOwner === page ? message : ''
  const state: RenderState = { catalog, columns, home, history, homeArea, selected, listStart, bodyHeight, query, search, searchState, searchProgress, book, toc, chapterIndex, contentLines: currentLines, contentLineKinds: currentLayout.lineKinds, readerLine, rows, sources, sourceSearch, sourceSearchState, sourceSearchStart, sourceSearchSelected, mappingToc, mappingIndex, mappingTarget, pageScroll, message: visibleMessage }
  const visiblePage = renderPage(page, state)
  return (
    <Box position="relative" flexDirection="column" width={columns} height={rows}>
      <Text color="cyan" bold>Legado Reader  ·  {pageLabel(page)}</Text>
      <Text dimColor>{display(catalog.sourceLocation || '未配置书源')} · {catalog.entries.filter((entry) => entry.state === 'available').length}/{catalog.entries.length} 个可用 · {busy ? '处理中' : '就绪'}</Text>
      <Text>{'─'.repeat(Math.max(8, Math.min(columns, 120)))}</Text>
      {visiblePage}
      {menu === undefined ? null : renderActionMenu(menu, columns, rows)}
      <Text>{'─'.repeat(Math.max(8, Math.min(columns, 120)))}</Text>
      <Text dimColor>{footer(page, busy, columns, searchState, sourceSearchState, menu !== undefined, homeArea)}</Text>
    </Box>
  )
}
