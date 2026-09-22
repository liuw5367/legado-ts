import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import type { SourceCatalogResult } from './source-catalog.ts'
import { ReaderApplication } from './application.ts'
import type { OpenBookResult, SearchOperationResult, SearchProgress, TocResult } from './application.ts'
import type { HomeBookView, KnownSourceView } from './storage.ts'
import { layoutContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from './content-layout.ts'

type Page = 'config' | 'home' | 'search' | 'results' | 'detail' | 'toc' | 'reader' | 'sources' | 'mapping' | 'help' | 'diagnostics'

export interface ReaderUiProps {
  application: ReaderApplication
  catalog: SourceCatalogResult
}

interface UiOperation {
  id: number
  controller: AbortController
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
  const [selected, setSelected] = useState(0)
  const [book, setBook] = useState<OpenBookResult>()
  const [toc, setToc] = useState<TocResult>()
  const [chapterIndex, setChapterIndex] = useState(0)
  const [content, setContent] = useState<string>()
  const [readerLine, setReaderLine] = useState(0)
  const [sources, setSources] = useState<KnownSourceView[]>([])
  const [mappingTarget, setMappingTarget] = useState<KnownSourceView>()
  const [mappingToc, setMappingToc] = useState<TocResult>()
  const [mappingIndex, setMappingIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [searchProgress, setSearchProgress] = useState<SearchProgress>()
  const operationRef = useRef<UiOperation | undefined>(undefined)
  const nextOperationId = useRef(0)
  const pageRef = useRef(page)
  const mountedRef = useRef(true)

  useEffect(() => {
    pageRef.current = page
  }, [page])

  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  const beginOperation = (): UiOperation => {
    operationRef.current?.controller.abort()
    const operation: UiOperation = { id: nextOperationId.current + 1, controller: new AbortController() }
    nextOperationId.current = operation.id
    operationRef.current = operation
    setBusy(true)
    return operation
  }

  const isCurrent = (operation: UiOperation): boolean => operationRef.current?.id === operation.id

  const finishOperation = (operation: UiOperation): void => {
    if (isCurrent(operation)) {
      operationRef.current = undefined
      setBusy(false)
      setSearchProgress(undefined)
    }
  }

  const cancelOperation = (text = '操作已取消'): void => {
    const hadOperation = operationRef.current !== undefined
    operationRef.current?.controller.abort()
    operationRef.current = undefined
    setBusy(false)
    setSearchProgress(undefined)
    if (hadOperation) setMessage(text)
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

  useInput((input, key) => {
    if (page === 'search') {
      if (key.escape) {
        cancelOperation('搜索已取消')
        setPage('home')
        return
      }
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
    if (key.escape) { cancelOperation(); setPage(previousPage(page)); return }
    if (page === 'home') handleHomeInput(input, key)
    else if (page === 'results') handleResultsInput(input, key)
    else if (page === 'detail') handleDetailInput(input)
    else if (page === 'toc') handleTocInput(input, key)
    else if (page === 'reader') handleReaderInput(input, key)
    else if (page === 'sources') handleSourcesInput(input, key)
    else if (page === 'mapping') handleMappingInput(input, key)
    else if (page === 'help' || page === 'diagnostics') { if (key.escape || input === 'q') setPage('home') }
  })

  const submitSearch = async (): Promise<void> => {
    if (query.trim().length === 0) { setMessage('请输入书名'); return }
    const operation = beginOperation()
    setSearchProgress(undefined)
    setMessage(`正在搜索“${display(query.trim())}”…`)
    try {
      const result = await application.search(query, undefined, operation.controller.signal, (progress) => {
        if (isCurrent(operation)) setSearchProgress(progress)
      })
      if (!isCurrent(operation)) return
      setSearch(result)
      setSelected(0)
      setPage('results')
      setMessage(result.cancelled ? '搜索已取消' : `找到 ${result.results.length} 条候选`)
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    } finally {
      finishOperation(operation)
    }
  }

  const openSelected = async (): Promise<void> => {
    const item = search?.results[selected]
    if (item === undefined) return
    const operation = beginOperation()
    setMessage('正在加载书籍详情…')
    try {
      const opened = await application.openSearchResult(item, search?.results ?? [], operation.controller.signal)
      if (!isCurrent(operation)) return
      setBook(opened)
      setToc(undefined)
      setPage('detail')
      setMessage(opened.metadata === undefined ? '详情没有返回完整字段' : '详情已加载')
      await refreshHome()
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    } finally {
      finishOperation(operation)
    }
  }

  const loadToc = async (edition?: string): Promise<void> => {
    if (book === undefined) return
    const operation = beginOperation()
    setMessage('正在加载目录…')
    try {
      const requestedEdition = edition ?? book.reading?.activeEditionKey ?? book.book.activeEditionKey
      const result = await application.loadToc(book.book.bookId, requestedEdition, operation.controller.signal)
      if (!isCurrent(operation)) return
      setToc(result)
      const saved = book.reading?.positions[result.edition.editionKey]
      const resumeIndex = saved === undefined ? -1 : result.chapters.findIndex((item) => item.chapterUrl === saved.chapterUrl)
      setChapterIndex(resumeIndex >= 0 ? resumeIndex : 0)
      setPage('toc')
      setMessage(`${result.chapters.length} 章${resumeIndex >= 0 ? ' · 已定位到上次阅读章节' : ''}`)
    } catch (error) {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    } finally {
      finishOperation(operation)
    }
  }

  const loadChapter = async (index: number): Promise<void> => {
    if (book === undefined || toc === undefined) return
    const chapter = toc.chapters[index]
    if (chapter === undefined) return
    const operation = beginOperation()
    setMessage(`正在加载第 ${index + 1} 章…`)
    try {
      const result = await application.loadContent(book.book.bookId, chapter, toc.edition.editionKey, operation.controller.signal)
      if (!isCurrent(operation)) return
      const width = Math.max(8, columns - 4)
      const layout = layoutContent(sanitizeTerminalText(result.content.cleaned), width)
      const saved = book.reading?.positions[toc.edition.editionKey]
      const resumeLine = saved?.chapterUrl === chapter.chapterUrl ? lineAtParagraphOffset(layout, saved.paragraphIndex, saved.offset, width) : 0
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

  const showSources = (): void => {
    if (book === undefined) return
    const operation = beginOperation()
    setMessage('正在读取本地书源记录…')
    void application.knownSources(book.book.bookId).then((items) => {
      if (!isCurrent(operation)) return
      setSources(items)
      setSelected(0)
      setPage('sources')
    }).catch((error: unknown) => {
      if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
    }).finally(() => finishOperation(operation))
  }

  const handleHomeInput = (input: string, key: { downArrow?: boolean; upArrow?: boolean; return?: boolean }): void => {
    if (input === '1' || input === '2' || input === '3') { setHomeArea(Number(input) - 1); setSelected(0); return }
    const visible = homeItemsForArea(home, homeArea)
    if (input === 'j' || key.downArrow) setSelected((value) => Math.min(Math.max(0, (homeArea === 2 ? history.length : visible.length) - 1), value + 1))
    if (input === 'k' || key.upArrow) setSelected((value) => Math.max(0, value - 1))
    if (key.return) {
      if (homeArea === 2) {
        const item = history[selected]
        if (item !== undefined) { setQuery(item.keyword); setPage('search'); setMessage('') }
      } else {
        const item = visible[selected]
        if (item !== undefined) {
          const operation = beginOperation()
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

  const handleResultsInput = (input: string, key: { downArrow?: boolean; upArrow?: boolean; return?: boolean }): void => {
    if (input === 'j' || key.downArrow) setSelected((value) => Math.min((search?.results.length ?? 1) - 1, value + 1))
    if (input === 'k' || key.upArrow) setSelected((value) => Math.max(0, value - 1))
    if (key.return && !busy) void openSelected()
  }

  const handleDetailInput = (input: string): void => {
    if (input === 'a' && book !== undefined) {
      const operation = beginOperation()
      void application.toggleBookshelf(book.book.bookId).then((onShelf) => {
        if (!isCurrent(operation)) return
        setBook((current) => current === undefined ? current : { ...current, onBookshelf: onShelf })
        setMessage(onShelf ? '已加入书架' : '已移出书架')
        return refreshHome()
      }).catch((error: unknown) => {
        if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      }).finally(() => finishOperation(operation))
    }
    if (input === 't') void loadToc()
    if (input === 's') showSources()
  }

  const handleTocInput = (input: string, key: { downArrow?: boolean; upArrow?: boolean; return?: boolean }): void => {
    if (input === 'j' || key.downArrow) setChapterIndex((value) => Math.min((toc?.chapters.length ?? 1) - 1, value + 1))
    if (input === 'k' || key.upArrow) setChapterIndex((value) => Math.max(0, value - 1))
    if (key.return && !busy) void loadChapter(chapterIndex)
  }

  const handleReaderInput = (input: string, key: { downArrow?: boolean; upArrow?: boolean; pageDown?: boolean; pageUp?: boolean }): void => {
    const height = Math.max(4, rows - 8)
    if (input === 'j' || key.downArrow) setReaderLine((value) => value + 1)
    if (input === 'k' || key.upArrow) setReaderLine((value) => Math.max(0, value - 1))
    if (input === ' ' || key.pageDown) setReaderLine((value) => value + height - 2)
    if (input === 'b' || key.pageUp) setReaderLine((value) => Math.max(0, value - height + 2))
    if (input === '[' && chapterIndex > 0) void loadChapter(chapterIndex - 1)
    if (input === ']' && toc !== undefined && chapterIndex < toc.chapters.length - 1) void loadChapter(chapterIndex + 1)
    if (input === 't') setPage('toc')
    if (input === 's') showSources()
    if (input === 'a' && book !== undefined) handleDetailInput('a')
  }

  const handleSourcesInput = (input: string, key: { return?: boolean }): void => {
    if (input === 'm' && book !== undefined && !busy) {
      const operation = beginOperation()
      const before = new Set(sources.map((item) => item.editionKey))
      setMessage('正在搜索更多书源…')
      void application.searchMoreSources(book.book.bookId, operation.controller.signal, (progress) => {
        if (isCurrent(operation)) setSearchProgress(progress)
      }).then(async (result) => {
        if (!isCurrent(operation)) return
        const items = await application.knownSources(book.book.bookId)
        if (!isCurrent(operation)) return
        setSources(items)
        const added = items.filter((item) => !before.has(item.editionKey)).length
        setMessage(`已搜索 ${result.sources.length} 个未记录书源，新增 ${added} 个匹配书源`)
      }).catch((error: unknown) => {
        if (isCurrent(operation) && !isAbortError(error)) setMessage(errorMessage(error))
      }).finally(() => finishOperation(operation))
    }
    if (key.return) {
      const target = sources[selected]
      if (target?.state === 'available' && book !== undefined && !busy) {
        if (toc?.chapters[chapterIndex] !== undefined) {
          const operation = beginOperation()
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
          const operation = beginOperation()
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
    if (input === 'j') setSelected((value) => Math.min(Math.max(0, sources.length - 1), value + 1))
    if (input === 'k') setSelected((value) => Math.max(0, value - 1))
  }

  const handleMappingInput = (input: string, key: { return?: boolean }): void => {
    if (key.return && book !== undefined && mappingTarget !== undefined && !busy) {
      const operation = beginOperation()
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

  const currentLines = content === undefined ? [] : layoutContent(sanitizeTerminalText(content), Math.max(8, columns - 4)).lines
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Text color="cyan" bold>Legado Reader  ·  {pageLabel(page)}</Text>
      <Text dimColor>{display(catalog.sourceLocation || '未配置书源')} · {catalog.entries.filter((entry) => entry.state === 'available').length}/{catalog.entries.length} 个可用 · {busy ? '处理中' : '就绪'}</Text>
      <Text>{'─'.repeat(Math.max(8, Math.min(columns, 120)))}</Text>
      {page === 'config' && renderConfig(catalog, message)}
      {page === 'home' && renderHome(home, history, homeArea, selected, message)}
      {page === 'search' && renderSearch(query, searchProgress, message)}
      {page === 'results' && renderResults(search, selected, message)}
      {page === 'detail' && renderDetail(book, message)}
      {page === 'toc' && renderToc(toc, chapterIndex, message)}
      {page === 'reader' && renderReader(book, toc, chapterIndex, currentLines, readerLine, rows, message)}
      {page === 'sources' && renderSources(sources, selected, searchProgress, message)}
      {page === 'mapping' && renderMapping(book, toc, chapterIndex, mappingToc, mappingIndex, mappingTarget, message)}
      {page === 'help' && renderHelp()}
      {page === 'diagnostics' && renderDiagnostics(catalog.diagnostics, message)}
      <Text>{'─'.repeat(Math.max(8, Math.min(columns, 120)))}</Text>
      <Text dimColor>{footer(page, busy, columns)}</Text>
    </Box>
  )
}

export function homeItemsForArea(items: readonly HomeBookView[], area: number): HomeBookView[] {
  if (area === 0) return items.filter((item) => item.isOnBookshelf)
  if (area === 1) return items.filter((item) => item.reading !== undefined)
  return [...items]
}

function renderConfig(catalog: SourceCatalogResult, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>需要配置书源</Text><Text>使用 legado-reader --source &lt;文件、目录或 HTTP(S) JSON 地址&gt;</Text><Text>或设置 LEGADO_READER_SOURCE 后重新启动。</Text>{catalog.diagnostics.map((item) => <Text key={item} color="yellow">[!] {display(item)}</Text>)}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function renderHome(items: HomeBookView[], history: Awaited<ReturnType<ReaderApplication['searchHistory']>>, area: number, selected: number, message: string): React.ReactElement {
  const books = homeItemsForArea(items, area)
  const body = area === 2 ? history.slice(0, 10).map((item, index) => <Text key={item.id} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.keyword)} · {item.summary.candidates} 个结果</Text>) : books.slice(0, 10).map((item, index) => <Text key={item.book.bookId} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.book.name)} {item.isOnBookshelf ? '[书架]' : item.reading === undefined ? '' : '[未加入]'} {item.lastReadAt === undefined ? '尚未开始阅读' : display(item.lastReadAt)}</Text>)
  return <Box flexDirection="column"><Text bold>[1] 书架   [2] 最近阅读   [3] 搜索记录</Text>{body.length === 0 ? <Text>{area === 0 ? '书架为空，可按 Ctrl+K 搜索书籍。' : area === 1 ? '还没有阅读记录。' : '还没有搜索记录。'}</Text> : body}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderSearch(query: string, progress: SearchProgress | undefined, message: string): React.ReactElement {
  return <Box flexDirection="column"><Text bold>搜索书籍</Text><Text>书名  {display(query)}█</Text>{progress === undefined ? <Text>{message || 'Enter 提交搜索，Esc 返回。'}</Text> : <Text color="cyan">{formatProgress(progress)}</Text>}{message.length > 0 && progress !== undefined ? <Text color="yellow">{display(message)}</Text> : null}</Box>
}

function renderResults(search: SearchOperationResult | undefined, selected: number, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>搜索结果 · {display(search?.keyword ?? '')}</Text>{(search?.results ?? []).slice(0, 100).map((item, index) => <Text key={`${item.candidate.sourceId}:${item.candidate.bookUrl}`} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.candidate.name ?? item.candidate.bookUrl)} · {display(item.candidate.author ?? '作者未知')} · {display(item.source.source.bookSourceName)}</Text>)}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function renderDetail(book: OpenBookResult | undefined, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>{display(book?.book.name ?? '书籍详情')}</Text><Text>作者  {display(book?.book.author ?? '未知')}</Text><Text>书源  {display(book?.source.source.bookSourceName ?? '未知')}</Text><Text>书架  {book?.onBookshelf === true ? '已加入' : '未加入'} · 阅读记录 {book?.reading?.lastReadAt === undefined ? '暂无' : display(book.reading.lastReadAt)}</Text><Text>简介  {display(book?.book.intro ?? '书源未返回简介')}</Text>{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function renderToc(toc: TocResult | undefined, selected: number, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>章节目录 · {toc?.chapters.length ?? 0} 章</Text>{(toc?.chapters ?? []).slice(Math.max(0, selected - 8), selected + 12).map((chapter, offset) => { const index = Math.max(0, selected - 8) + offset; return <Text key={chapter.chapterUrl} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{index + 1}. {display(chapter.title)}</Text> })}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function renderReader(book: OpenBookResult | undefined, toc: TocResult | undefined, index: number, lines: string[], line: number, rows: number, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>{display(book?.book.name ?? '')} · {display(toc?.chapters[index]?.title ?? '')}</Text>{lines.slice(line, line + Math.max(1, rows - 8)).map((value, offset) => <Text key={`${line + offset}-${value}`}>{display(value)}</Text>)}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function renderSources(items: KnownSourceView[], selected: number, progress: SearchProgress | undefined, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>已知书源 · 本地记录</Text>{progress === undefined ? null : <Text color="cyan">{formatProgress(progress)}</Text>}{items.map((item, index) => <Text key={item.editionKey} color={index === selected ? 'yellow' : 'white'}>{index === selected ? '> ' : '  '}{display(item.sourceName ?? item.name ?? item.sourceId)} · {sourceState(item.state)}</Text>)}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function renderMapping(book: OpenBookResult | undefined, toc: TocResult | undefined, index: number, targetToc: TocResult | undefined, targetIndex: number, target: KnownSourceView | undefined, message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>确认切换书源</Text><Text>书籍  {display(book?.book.name ?? '')}</Text><Text>原源  {display(toc?.source.source.bookSourceName ?? book?.source.source.bookSourceName ?? '')}</Text><Text>目标源  {display(target?.sourceName ?? target?.name ?? '')}</Text><Text>当前章节  {display(toc?.chapters[index]?.title ?? '尚未选择章节')}</Text><Text>目标章节  {display(targetToc?.chapters[targetIndex]?.title ?? '未找到，需要手动选择')}</Text><Text>{display(message)}</Text><Text color="yellow">Enter 确认，t 返回目录，Esc 取消</Text></Box> }

function renderHelp(): React.ReactElement { return <Box flexDirection="column"><Text bold>帮助</Text><Text>Ctrl+K 搜索书籍，j/k 移动，Enter 确认，Esc 返回，d 查看诊断。</Text><Text>阅读页：空格/PageDown 翻页，b/PageUp 回退，[ ] 切章，t 目录，s 书源，a 书架。</Text><Text>已知书源页：Enter 使用已记录书源，m 手动搜索更多书源。</Text></Box> }

function renderDiagnostics(items: readonly string[], message: string): React.ReactElement { return <Box flexDirection="column"><Text bold>诊断</Text>{items.length === 0 ? <Text>没有诊断信息。</Text> : items.map((item) => <Text key={item} color="yellow">[!] {display(item)}</Text>)}{message.length > 0 ? <Text color="yellow">{display(message)}</Text> : null}</Box> }

function formatProgress(progress: SearchProgress): string {
  const active = progress.activeSources.length === 0 ? '等待调度' : progress.activeSources.map(display).join('、')
  return `搜索进度 ${progress.completed}/${progress.total} 个书源 · 当前：${active} · 已发现 ${progress.candidates} 本`
}

function display(value: string): string { return sanitizeTerminalText(value) }
function normalizeChapterTitle(value: string): string { return display(value).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '') }
function pageLabel(page: Page): string { return ({ config: '配置', home: '首页', search: '搜索', results: '搜索结果', detail: '详情', toc: '目录', reader: '阅读', sources: '已知书源', mapping: '章节映射', help: '帮助', diagnostics: '诊断' } as Record<Page, string>)[page] }
function previousPage(page: Page): Page { return page === 'config' ? 'config' : page === 'home' ? 'home' : page === 'search' || page === 'results' ? 'home' : page === 'detail' ? 'results' : page === 'toc' ? 'detail' : page === 'reader' ? 'toc' : page === 'sources' ? 'detail' : page === 'mapping' ? 'sources' : 'home' }
function sourceState(value: KnownSourceView['state']): string { return value === 'available' ? '可用' : value === 'stale' ? '需要重新搜索' : value === 'removed' ? '书源已移除' : '定义冲突' }
function footer(page: Page, busy: boolean, columns: number): string { if (columns < 48) return busy ? '处理中 · Esc 取消' : 'Esc 返回 · ? 帮助 · d 诊断 · q 退出'; return page === 'reader' ? '[ ] 上下章  [t] 目录  [s] 书源  [a] 书架  [d] 诊断  [?] 帮助  [q] 退出' : busy ? '处理中 · Esc 取消' : '[Enter] 确认  [Esc] 返回  [d] 诊断  [?] 帮助  [q] 退出' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError' }
