import { ChevronLeft, CircleHelp, ExternalLink, Info, RefreshCw } from 'lucide-react'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { MoreMenu } from '../components/more-menu.tsx'
import { PageBackButton } from '../components/page-back-button.tsx'
import { ReaderIcon } from '../components/reader-icon.tsx'
import { browserUrl, chapterCharacterCount, isReaderTap } from '../lib/reader-interactions.ts'
import { pageReturnState, pageReturnTarget } from '../lib/page-navigation.ts'
import { anchorFromViewport, clampPageIndex, pageActionForTap, pageCountFromScrollWidth, pageIndexForAnchor, pageLabel, type PageLayout, type ReaderAnchor, type ReaderPageAction } from '../lib/reader-pagination.ts'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { apiFetch, type ApiChapter, type ApiContent, type ApiPosition, type ApiToc } from '../lib/api.ts'
import { useReaderSettings } from '../lib/settings-context.tsx'
import { safeResourceUrl, sanitizeChapterHtml } from '../lib/html-content.ts'

type ReaderPanel = 'toc' | 'settings' | null

export function ReaderPage() {
  const { bookId = '', chapterId = '' } = useParams()
  const cache = useBookCache()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const { settings, resolvedTheme, updateSettings, saving: settingsSaving, error: settingsError } = useReaderSettings()
  const [controlsVisible, setControlsVisible] = useState(false)
  const [pageGuideVisible, setPageGuideVisible] = useState(false)
  const [themeRetry, setThemeRetry] = useState<'light' | 'dark' | null>(null)
  const pointerStartRef = useRef<{ x: number; y: number; scrollY: number } | null>(null)
  const restoredPositionRef = useRef(false)
  const [content, setContent] = useState<ApiContent | null>(null)
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [position, setPosition] = useState<ApiPosition | null>(null)
  const [positionLoaded, setPositionLoaded] = useState(false)
  const [error, setError] = useState('')
  const [positionError, setPositionError] = useState('')
  const [panel, setPanel] = useState<ReaderPanel>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [pageLayout, setPageLayout] = useState<PageLayout>({ pageWidth: 0, pageCount: 0 })
  const [pageIndex, setPageIndex] = useState(0)
  const [paginationError, setPaginationError] = useState('')
  const refreshController = useRef<AbortController | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const pageGuideRef = useRef<HTMLButtonElement>(null)
  const latestPositionRef = useRef<ApiPosition | null>(null)
  const positionWriteQueueRef = useRef(Promise.resolve())
  const positionVersionRef = useRef(-1)
  const latestAnchorRef = useRef<ReaderAnchor | null>(null)
  const paginationAnchorRef = useRef<ReaderAnchor | null>(null)
  const readingModeRef = useRef(settings.readingMode)
  const requestIdRef = useRef(0)
  const liveToc = cache.get(bookId, editionKey)?.toc ?? toc

  useEffect(() => {
    const requestId = ++requestIdRef.current
    const cachedContent = cache.getContent(bookId, editionKey, chapterId)
    setControlsVisible(false); setPageGuideVisible(false); restoredPositionRef.current = false; setPanel(null); setContent(cachedContent ?? null); setToc(null); setPosition(null); setPositionLoaded(false); setError(''); setPositionError(''); setRefreshing(false); setRefreshError(''); setPageLayout({ pageWidth: 0, pageCount: 0 }); setPageIndex(0); setPaginationError('')
    latestPositionRef.current = null
    positionVersionRef.current = -1
    latestAnchorRef.current = null
    paginationAnchorRef.current = null
    let active = true
    const controller = new AbortController()
    const snapshotRequest = loadBookSnapshot(cache, bookId, editionKey)
    void Promise.all([
      snapshotRequest.then(() => apiFetch<{ content: { content: ApiContent } }>(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}?editionKey=${encodeURIComponent(editionKey)}`, { signal: controller.signal })),
      snapshotRequest,
      apiFetch<{ position: ApiPosition | null }>(`/api/books/${encodeURIComponent(bookId)}/position?editionKey=${encodeURIComponent(editionKey)}`, { signal: controller.signal }),
    ]).then(async ([contentResult, tocResult, positionResult]) => {
      if (!active || requestId !== requestIdRef.current) return
      if (editionKey.length > 0) await apiFetch(`/api/books/${encodeURIComponent(bookId)}/edition`, { method: 'PUT', signal: controller.signal, body: JSON.stringify({ editionKey }) })
      if (!active || requestId !== requestIdRef.current) return
      restoredPositionRef.current = positionResult.position?.chapterId !== chapterId
      const chapterPosition = positionResult.position?.chapterId === chapterId ? positionResult.position : null
      const chapterAnchor = chapterPosition === null ? null : { paragraphIndex: chapterPosition.paragraphIndex, offset: chapterPosition.offset }
      latestPositionRef.current = positionResult.position
      positionVersionRef.current = positionResult.position?.version ?? -1
      latestAnchorRef.current = chapterAnchor
      paginationAnchorRef.current = chapterAnchor
      cache.setContent(bookId, editionKey, chapterId, contentResult.content.content); setContent(contentResult.content.content); setToc(tocResult.toc); setPosition(positionResult.position); setPositionLoaded(true); cache.setPosition(bookId, editionKey, positionResult.position); window.scrollTo({ top: 0, behavior: 'auto' })
    }).catch((reason: unknown) => {
      if (!active || requestId !== requestIdRef.current) return
      const snapshot = cache.get(bookId, editionKey)
      if (snapshot !== undefined && !snapshot.toc.chapters.some((chapter) => chapter.chapterId === chapterId && chapter.isVolume !== true)) {
        navigate('/books/' + encodeURIComponent(bookId) + '/read?editionKey=' + encodeURIComponent(editionKey), { replace: true, state: location.state })
      } else setError(reason instanceof Error ? reason.message : '正文加载失败')
    })
    return () => { active = false; controller.abort(); refreshController.current?.abort(); requestIdRef.current += 1 }
  }, [bookId, chapterId, editionKey, retryNonce, cache])

  async function persistPosition(input: { paragraphIndex: number; offset: number; version: number }): Promise<void> {
    if (content === null || content.chapter.chapterId !== chapterId) return
    const requestId = requestIdRef.current
    const version = Math.max(input.version, positionVersionRef.current + 1)
    positionVersionRef.current = version
    setPositionError('')
    const write = async () => {
      if (requestId !== requestIdRef.current) return
      try {
        const result = await apiFetch<{ position: ApiPosition }>(`/api/books/${encodeURIComponent(bookId)}/position`, { method: 'POST', body: JSON.stringify({ editionKey, chapterId, chapterUrl: content.chapter.chapterUrl, chapterIndex: content.chapter.index, title: content.chapter.title ?? `第 ${content.chapter.index + 1} 章`, tocRevision: liveToc?.revision, paragraphIndex: input.paragraphIndex, offset: input.offset, version }) })
        if (requestId !== requestIdRef.current) return
        positionVersionRef.current = Math.max(positionVersionRef.current, result.position.version)
        latestPositionRef.current = result.position
        latestAnchorRef.current = { paragraphIndex: result.position.paragraphIndex, offset: result.position.offset }
        if (settings.readingMode === 'paged') paginationAnchorRef.current = latestAnchorRef.current
        setPosition(result.position); cache.setPosition(bookId, editionKey, result.position)
      } catch (reason) { if (requestId === requestIdRef.current) setPositionError(reason instanceof Error ? reason.message : '阅读位置保存失败') }
    }
    const request = positionWriteQueueRef.current.then(write, write)
    positionWriteQueueRef.current = request.then(() => undefined, () => undefined)
    await request
  }

  useEffect(() => {
    latestPositionRef.current = position
    if (position?.chapterId !== chapterId) return
    latestAnchorRef.current = { paragraphIndex: position.paragraphIndex, offset: position.offset }
    if (settings.readingMode === 'paged') paginationAnchorRef.current = latestAnchorRef.current
  }, [chapterId, position, settings.readingMode])
  useEffect(() => {
    if (content === null || content.chapter.chapterId !== chapterId || !positionLoaded || position?.chapterId === chapterId) return
    void persistPosition({ paragraphIndex: 0, offset: 0, version: (position?.version ?? -1) + 1 })
  }, [bookId, chapterId, editionKey, content, positionLoaded, position?.chapterId, position?.version, liveToc?.revision])
  useEffect(() => {
    if (settings.readingMode !== 'scroll' || content === null || content.chapter.chapterId !== chapterId || !positionLoaded) return
    let timer: number | undefined
    const readAnchor = (): ReaderAnchor | undefined => {
      if (articleRef.current === null) return
      const paragraphs = [...articleRef.current.querySelectorAll<HTMLElement>('[data-paragraph]')]
      const toolbarHeight = 0
      const firstVisible = paragraphs.find((paragraph) => paragraph.getBoundingClientRect().bottom > toolbarHeight + 16)
      const paragraphIndex = firstVisible === undefined ? 0 : Number(firstVisible.dataset.paragraph ?? 0)
      return { paragraphIndex, offset: 0 }
    }
    const persist = () => {
      const current = latestPositionRef.current
      const anchor = readAnchor()
      if (anchor === undefined) return
      latestAnchorRef.current = anchor
      if (current?.chapterId === chapterId && current.paragraphIndex === anchor.paragraphIndex) return
      const offset = current?.chapterId === chapterId ? current.offset : 0
      void persistPosition({ paragraphIndex: anchor.paragraphIndex, offset, version: (current?.version ?? -1) + 1 })
    }
    const onScroll = () => { const anchor = readAnchor(); if (anchor !== undefined) latestAnchorRef.current = anchor; if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => { timer = undefined; persist() }, 500) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); if (timer !== undefined) window.clearTimeout(timer) }
  }, [bookId, chapterId, editionKey, content, positionLoaded, liveToc?.revision, settings.readingMode])
  useEffect(() => {
    if (settings.readingMode !== 'scroll' || content === null || position?.chapterId !== chapterId || articleRef.current === null || restoredPositionRef.current) return
    const paragraph = articleRef.current.querySelector<HTMLElement>(`[data-paragraph="${position.paragraphIndex}"]`)
    if (paragraph === null) return
    restoredPositionRef.current = true
    const toolbarHeight = 0
    window.scrollTo({ top: window.scrollY + paragraph.getBoundingClientRect().top - toolbarHeight - 12, behavior: 'auto' })
  }, [chapterId, content, position?.chapterId, position?.paragraphIndex, settings.fontSize, settings.lineHeight, settings.readingMode])

  useEffect(() => {
    const previousMode = readingModeRef.current
    if (previousMode === settings.readingMode) return
    readingModeRef.current = settings.readingMode
    const anchor = latestAnchorRef.current
    paginationAnchorRef.current = anchor
    setPageLayout({ pageWidth: 0, pageCount: 0 })
    setPageIndex(0)
    setPaginationError('')
    setPageGuideVisible(false)
    if (settings.readingMode === 'scroll') {
      window.requestAnimationFrame(() => {
        if (articleRef.current === null) return
        const paragraph = anchor === null ? null : articleRef.current.querySelector<HTMLElement>(`[data-paragraph="${anchor.paragraphIndex}"]`)
        if (paragraph !== null) window.scrollTo({ top: window.scrollY + paragraph.getBoundingClientRect().top - 12, behavior: 'auto' })
      })
    }
  }, [settings.readingMode])

  useEffect(() => {
    if (pageGuideVisible) pageGuideRef.current?.focus()
  }, [pageGuideVisible])

  useEffect(() => {
    const viewport = articleRef.current
    if (settings.readingMode !== 'paged' || paginationError.length > 0 || content === null || viewport === null) return
    let active = true
    let attempts = 0
    let measuredWidth = 0
    let measured = false
    let frame: number | undefined
    const measure = () => {
      if (!active) return
      const pageWidth = viewport.clientWidth
      if (pageWidth <= 0) {
        attempts += 1
        if (attempts >= 6) setPaginationError('分页排版失败，请重试或切换为滚动阅读。')
        else schedule()
        return
      }
      // column-width 不接受百分比值；先把实际视口宽度注入为像素长度，浏览器才会创建横向多栏。
      const cssPageWidth = `${pageWidth}px`
      if (viewport.style.getPropertyValue('--reader-page-width') !== cssPageWidth) {
        viewport.style.setProperty('--reader-page-width', cssPageWidth)
        schedule()
        return
      }
      const pageCount = pageCountFromScrollWidth(viewport.scrollWidth, pageWidth)
      if (pageCount <= 0) {
        attempts += 1
        if (attempts >= 6) setPaginationError('分页排版失败，请重试或切换为滚动阅读。')
        else schedule()
        return
      }
      attempts = 0
      const layout = { pageWidth, pageCount }
      setPageLayout((current) => current.pageWidth === layout.pageWidth && current.pageCount === layout.pageCount ? current : layout)
      const targetPage = !measured || measuredWidth !== pageWidth
        ? pageIndexForAnchor(viewport, paginationAnchorRef.current ?? latestAnchorRef.current, layout)
        : clampPageIndex(Math.round(viewport.scrollLeft / pageWidth), pageCount)
      measuredWidth = pageWidth
      measured = true
      viewport.scrollLeft = targetPage * pageWidth
      viewport.scrollTo({ left: targetPage * pageWidth, top: 0, behavior: 'auto' })
      setPageIndex(targetPage)
      setPaginationError('')
    }
    const schedule = () => {
      if (!active) return
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => { frame = undefined; measure() })
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resizeObserver?.observe(viewport)
    const resources = [...viewport.querySelectorAll<HTMLImageElement>('img')]
    resources.forEach((image) => { image.addEventListener('load', schedule); image.addEventListener('error', schedule) })
    const fontsReady = document.fonts?.ready.then(schedule, schedule)
    schedule()
    return () => {
      active = false
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      resources.forEach((image) => { image.removeEventListener('load', schedule); image.removeEventListener('error', schedule) })
      void fontsReady
    }
  }, [content, paginationError, settings.fontSize, settings.lineHeight, settings.marginTop, settings.marginRight, settings.marginBottom, settings.marginLeft, settings.readingMode])

  const paragraphs = useMemo(() => content?.cleaned.split(/\n+/u).map((text) => text.trim()).filter(Boolean) ?? [], [content])
  const htmlContent = useMemo(() => content?.contentType === 'html' ? sanitizeChapterHtml(content.cleaned) : '', [content])
  const additionalResources = useMemo(() => {
    if (content?.contentType !== 'html') return []
    return content.resources.map((resource) => safeResourceUrl(resource.url, true)).filter((url): url is string => url !== undefined).filter((url) => !htmlContent.includes(url))
  }, [content, htmlContent])
  const siblings = liveToc?.chapters.filter((chapter) => chapter.isVolume !== true) ?? []
  const currentIndex = siblings.findIndex((chapter) => chapter.chapterId === chapterId)
  const previous = currentIndex > 0 ? siblings[currentIndex - 1] : undefined
  const next = currentIndex >= 0 ? siblings[currentIndex + 1] : undefined

  async function switchToScroll() {
    try {
      await updateSettings({ readingMode: 'scroll' })
    } catch (reason) {
      setPaginationError(reason instanceof Error ? reason.message : '切换滚动阅读失败')
    }
  }

  function turnPage(targetPage: number) {
    const viewport = articleRef.current
    if (viewport === null || pageLayout.pageWidth <= 0 || pageLayout.pageCount <= 0) return
    const nextPage = clampPageIndex(targetPage, pageLayout.pageCount)
    if (nextPage === pageIndex) return
    viewport.scrollTo({ left: nextPage * pageLayout.pageWidth, top: 0, behavior: 'auto' })
    setPageIndex(nextPage)
    const anchor = anchorFromViewport(viewport)
    if (anchor === undefined) return
    latestAnchorRef.current = anchor
    paginationAnchorRef.current = anchor
    const current = latestPositionRef.current
    void persistPosition({ paragraphIndex: anchor.paragraphIndex, offset: anchor.offset, version: (current?.version ?? -1) + 1 })
  }

  function handlePageAction(action: ReaderPageAction) {
    if (action === 'previous') turnPage(pageIndex - 1)
    else if (action === 'next') turnPage(pageIndex + 1)
    else setControlsVisible((value) => !value)
  }

  function closePageGuide() {
    setPageGuideVisible(false)
    window.requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }))
  }

  async function refreshChapter() {
    if (refreshing || content === null) return
    const requestId = requestIdRef.current
    const controller = new AbortController(); refreshController.current = controller
    const paged = settings.readingMode === 'paged'
    const nodes = [...articleRef.current?.querySelectorAll<HTMLElement>('[data-paragraph]') ?? []]
    const visible = nodes.find((node) => node.getBoundingClientRect().bottom > 16)
    const anchor = paged ? anchorFromViewport(articleRef.current) : { paragraphIndex: Number(visible?.dataset.paragraph ?? 0), offset: 0 }
    const paragraphIndex = anchor?.paragraphIndex ?? 0
    const top = visible?.getBoundingClientRect().top ?? 0
    setRefreshing(true); setRefreshError('')
    try {
      const result = await apiFetch<{ content: { content: ApiContent; tocRevision: string } }>('/api/books/' + encodeURIComponent(bookId) + '/chapters/' + encodeURIComponent(chapterId) + '?editionKey=' + encodeURIComponent(editionKey) + '&refresh=true', { signal: controller.signal })
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      if (result.content.tocRevision !== cache.get(bookId, editionKey)?.toc.revision) await loadBookSnapshot(cache, bookId, editionKey, true)
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      cache.setContent(bookId, editionKey, chapterId, result.content.content); setContent(result.content.content)
      if (paged) {
        paginationAnchorRef.current = anchor ?? latestAnchorRef.current
        setPageLayout({ pageWidth: 0, pageCount: 0 })
        setPageIndex(0)
        setPaginationError('')
        return
      }
      window.requestAnimationFrame(() => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return
        const paragraphs = [...articleRef.current?.querySelectorAll<HTMLElement>('[data-paragraph]') ?? []]
        const node = paragraphs[Math.min(paragraphIndex, paragraphs.length - 1)]
        if (node !== undefined) window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - top, behavior: 'auto' })
      })
    } catch (reason) { if (!controller.signal.aborted && requestId === requestIdRef.current) setRefreshError(reason instanceof Error ? reason.message : '刷新失败') }
    finally { if (requestId === requestIdRef.current) setRefreshing(false) }
  }
  const returnTarget = pageReturnTarget(location.state, location.pathname, '/')
  if (error.length > 0) return <section className="reader-error"><p className="error">{error}</p><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={() => setRetryNonce((value) => value + 1)}>重试</Button><PageBackButton /></div></section>
  if (content === null) return <section className="reader-loading"><p className="muted">正在读取正文…</p><PageBackButton /></section>
  const dark = resolvedTheme === 'dark'
  const paged = settings.readingMode === 'paged'
  const pageCounter = pageLayout.pageCount > 0 ? pageLabel(pageIndex, pageLayout.pageCount) : '排版中…'
  const wordCountLabel = `${chapterCharacterCount(content.cleaned).toLocaleString('zh-CN')} 字`
  const readerStyle = { fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight, '--reader-margin-top': `${settings.marginTop}px`, '--reader-margin-right': `${settings.marginRight}px`, '--reader-margin-bottom': `${settings.marginBottom}px`, '--reader-margin-left': `${settings.marginLeft}px` } as CSSProperties
  async function toggleTheme(target: 'light' | 'dark' = dark ? 'light' : 'dark') {
    setThemeRetry(null)
    try { await updateSettings({ theme: target }) } catch { setThemeRetry(target) }
  }
  const address = browserUrl(content.chapter.chapterUrl)
  return <section className={`reader-page${paged ? ' reader-page-paged' : ''}`} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      if (pageGuideVisible) closePageGuide()
      else if (panel === null) { setControlsVisible(false); articleRef.current?.focus({ preventScroll: true }) }
    }
  }}>
    <header className="reader-topbar" hidden={!controlsVisible}><Link className="reader-back" to={returnTarget.to} state={returnTarget.state} replace aria-label="返回上一页"><ChevronLeft aria-hidden="true" /><span>返回</span></Link><div className="reader-title"><strong title={content.chapter.title ?? ''}>{content.chapter.title ?? '正文'}</strong></div><div className="reader-tools"><MoreMenu label="更多阅读操作">
      {paged ? <button className="more-menu-item" type="button" onClick={() => setPageGuideVisible(true)}><CircleHelp aria-hidden="true" />翻页区域说明</button> : null}
      <Link className="more-menu-item" to={'/books/' + encodeURIComponent(bookId) + '/details?editionKey=' + encodeURIComponent(editionKey)} state={pageReturnState(location)}><Info aria-hidden="true" />书籍详情</Link>
      {address === undefined ? <span className="more-menu-note muted small">没有可用的原文地址</span> : <a className="more-menu-item" href={address} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />查看原文</a>}
      <button className="more-menu-item" type="button" disabled={refreshing} onClick={() => void refreshChapter()}><RefreshCw aria-hidden="true" />{refreshing ? '刷新中…' : '刷新内容'}</button>
    </MoreMenu></div></header>
    <article className={`reader-content${paged ? ' reader-content-paged' : ''}`} ref={articleRef} tabIndex={0} aria-label={paged ? '正文，左侧上一页，中间显示或隐藏操作栏，右侧下一页' : '正文，按回车显示或隐藏阅读操作'} style={readerStyle}
      onPointerDown={(event) => { articleRef.current?.focus({ preventScroll: true }); pointerStartRef.current = { x: event.clientX, y: event.clientY, scrollY: window.scrollY } }}
      onPointerCancel={() => { pointerStartRef.current = null }}
      onClick={(event) => {
        const start = pointerStartRef.current
        const selectedText = window.getSelection()?.toString() ?? ''
        const end = { x: event.clientX, y: event.clientY, scrollY: window.scrollY }
        const tap = isReaderTap(start, end, selectedText)
        pointerStartRef.current = null
        if (!tap) return
        if (paged && articleRef.current !== null) {
          const rect = articleRef.current.getBoundingClientRect()
          const action = pageActionForTap(start, end, selectedText, event.clientX, rect.left, rect.width)
          if (action !== null) handlePageAction(action)
        } else setControlsVisible((value) => !value)
      }}
      onWheel={(event) => { if (paged) event.preventDefault() }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (paged && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault()
          handlePageAction(event.key === 'ArrowLeft' ? 'previous' : 'next')
        } else if (event.key === 'Enter') {
          event.preventDefault()
          setControlsVisible((value) => !value)
        }
      }}>
      {content.contentType === 'html' ? htmlContent.length === 0 && additionalResources.length === 0 ? <p className="muted">本章暂无正文。</p> : <><div className="reader-html-content" data-paragraph={0} dangerouslySetInnerHTML={{ __html: htmlContent }} />{additionalResources.map((url, index) => <p className="reader-resource" data-paragraph={index + 1} key={url}><img src={url} alt="正文插图" loading="lazy" decoding="async" /></p>)}</> : paragraphs.length === 0 ? <p className="muted">本章暂无正文。</p> : paragraphs.map((paragraph, index) => <p data-paragraph={index} key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>)}
    </article>
    {paged && pageGuideVisible ? <button ref={pageGuideRef} id="reader-page-guide" className="reader-page-guide" type="button" aria-label="关闭翻页区域说明" onClick={closePageGuide}>
      <span className="reader-page-guide-title">点击页面对应区域进行操作</span>
      <span className="reader-page-guide-zone"><strong>上一页</strong><small>点击左侧</small></span>
      <span className="reader-page-guide-zone reader-page-guide-zone-middle"><strong>显示 / 隐藏操作栏</strong><small>点击中间</small></span>
      <span className="reader-page-guide-zone"><strong>下一页</strong><small>点击右侧</small></span>
      <span className="reader-page-guide-dismiss">点击任意位置关闭说明</span>
    </button> : null}
    {paged && paginationError.length > 0 ? <div className="reader-pagination-error" role="alert"><p className="error">{paginationError}</p><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={() => { setPaginationError(''); setPageLayout({ pageWidth: 0, pageCount: 0 }); setPageIndex(0) }}>重试分页</Button><Button variant="secondary" size="sm" type="button" onClick={() => void switchToScroll()}>切换滚动阅读</Button></div></div> : null}
    {refreshError.length > 0 ? <p className="error reader-position-error" role="alert">{refreshError}<button className="text-button" disabled={refreshing} onClick={() => void refreshChapter()}>重试刷新</button></p> : null}
    {positionError.length > 0 ? <p className="error reader-position-error" role="alert">{positionError}<button className="text-button" type="button" onClick={() => void persistPosition({ paragraphIndex: latestPositionRef.current?.paragraphIndex ?? 0, offset: latestPositionRef.current?.offset ?? 0, version: (latestPositionRef.current?.version ?? -1) + 1 })}>重试</button></p> : null}
    <div className="reader-bottom-bar" hidden={!controlsVisible}>
      <nav className="reader-chapter-nav" aria-label="章节导航"><button className="reader-nav-button" type="button" disabled={previous === undefined} onClick={() => { if (previous !== undefined) navigate(chapterLink(bookId, previous, editionKey), { replace: true, state: location.state }) }}>上一章</button><span className="reader-word-count" aria-label={paged ? `分页进度 ${pageCounter}，${wordCountLabel}` : '章节字数'}>{paged ? <><span>{pageCounter}</span><span className="reader-word-count-separator" aria-hidden="true">·</span><span>{wordCountLabel}</span></> : wordCountLabel}</span><button className="reader-nav-button" type="button" disabled={next === undefined} onClick={() => { if (next !== undefined) navigate(chapterLink(bookId, next, editionKey), { replace: true, state: location.state }) }}>下一章</button></nav>
      <nav className="reader-shortcuts" aria-label="阅读快捷操作">
        <button type="button" className="reader-shortcut" aria-label="目录" onClick={() => setPanel('toc')}><ReaderIcon name="toc" /><span>目录</span></button>
        <Link className="reader-shortcut" to={`/books/${encodeURIComponent(bookId)}/sources`} state={pageReturnState(location)} aria-label="换源"><ReaderIcon name="source" /><span>换源</span></Link>
        <button type="button" className="reader-shortcut" aria-label="设置" onClick={() => setPanel('settings')}><ReaderIcon name="settings" /><span>设置</span></button>
        <button type="button" className="reader-shortcut" aria-label={dark ? '切换日间模式' : '切换夜间模式'} disabled={settingsSaving} onClick={() => void toggleTheme()}><ReaderIcon name={dark ? 'sun' : 'moon'} /><span>{dark ? '日间' : '夜间'}</span></button>
      </nav>
      {settingsError === undefined ? null : <p className="error reader-settings-error" role="alert">{settingsError}{themeRetry === null ? null : <button className="text-button" type="button" disabled={settingsSaving} onClick={() => void toggleTheme(themeRetry)}>重试</button>}</p>}
    </div>
    <Sheet open={panel === 'toc'} onOpenChange={(open) => setPanel(open ? 'toc' : null)} title="章节目录"><ReaderTocPanel open={panel === 'toc'} bookId={bookId} editionKey={editionKey} chapters={siblings} currentChapterId={chapterId} onNavigate={() => setPanel(null)} /></Sheet>
    <Sheet open={panel === 'settings'} onOpenChange={(open) => setPanel(open ? 'settings' : null)} title="阅读设置"><ReaderSettingsPanel /></Sheet>
  </section>
}

function ReaderTocPanel({ open, bookId, editionKey, chapters, currentChapterId, onNavigate }: { open: boolean; bookId: string; editionKey: string; chapters: ApiChapter[]; currentChapterId: string; onNavigate: () => void }) {
  const cache = useBookCache()
  const location = useLocation()
  const currentIndex = chapters.findIndex((chapter) => chapter.chapterId === currentChapterId)
  const [reversed, setReversed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || currentIndex < 0) return
    const frame = window.requestAnimationFrame(() => {
      const current = listRef.current?.querySelector<HTMLElement>('.reader-toc-row.current')
      current?.scrollIntoView({ block: 'center' })
      current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentIndex, open, reversed])
  async function refreshDirectory() {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError('')
    try {
      await loadBookSnapshot(cache, bookId, editionKey, true)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setRefreshError(reason instanceof Error ? reason.message : '目录刷新失败')
    } finally {
      setRefreshing(false)
    }
  }
  const orderedChapters = reversed ? [...chapters].reverse() : chapters
  return <div className="reader-toc-panel"><div className="reader-toc-actions"><Link className="button secondary reader-toc-directory" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`} state={pageReturnState(location)} onClick={onNavigate}>完整目录</Link><div className="reader-toc-utility-actions"><Button variant="secondary" size="sm" type="button" onClick={() => setReversed((value) => !value)}>{reversed ? '正序' : '倒序'}</Button><Button variant="secondary" size="sm" type="button" onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>到顶部</Button><Button variant="secondary" size="sm" type="button" onClick={() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })}>到底部</Button><Button variant="secondary" size="sm" type="button" aria-label="刷新目录数据" disabled={refreshing} onClick={() => void refreshDirectory()}>{refreshing ? '刷新中…' : '刷新'}</Button></div></div>{refreshError.length > 0 ? <p className="error reader-toc-error" role="alert">{refreshError}<button className="text-button" type="button" disabled={refreshing} onClick={() => void refreshDirectory()}>重试</button></p> : null}<div className="reader-toc-list" ref={listRef}>{orderedChapters.map((chapter) => <Link className={`reader-toc-row ${chapter.chapterId === currentChapterId ? 'current' : ''}`} aria-current={chapter.chapterId === currentChapterId ? 'location' : undefined} key={chapter.chapterId} to={chapterLink(bookId, chapter, editionKey)} replace state={location.state} onClick={onNavigate}><span className="toc-index">{chapter.index + 1}</span><span>{chapter.title}</span>{chapter.chapterId === currentChapterId ? <span className="toc-check" aria-label="当前阅读章节">✓</span> : null}</Link>)}</div></div>
}

export function ReaderEntryPage() {
  const { bookId = '' } = useParams()
  const cache = useBookCache()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedEditionKey = searchParams.get('editionKey') ?? ''
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setError('')
    void (async () => {
      try {
        const booksResult = requestedEditionKey.length > 0 ? { books: [] } : await apiFetch<{ books: Array<{ book: { id: string; activeEditionKey?: string } }> }>('/api/books', { signal: controller.signal })
        if (!active) return
        const book = booksResult.books.find((item) => item.book.id === bookId)?.book
        const editionKey = requestedEditionKey || book?.activeEditionKey || ''
        if (editionKey.length === 0) throw new Error('没有可用的书源版本')
        const [tocResult, positionResult] = await Promise.all([
          loadBookSnapshot(cache, bookId, editionKey),
          apiFetch<{ position: ApiPosition | null }>(`/api/books/${encodeURIComponent(bookId)}/position?editionKey=${encodeURIComponent(editionKey)}`, { signal: controller.signal }),
        ])
        const positionChapter = positionResult.position?.chapterId === undefined ? undefined : tocResult.toc.chapters.find((chapter) => chapter.chapterId === positionResult.position?.chapterId && chapter.isVolume !== true)
        const target = positionChapter ?? tocResult.toc.chapters.find((chapter) => chapter.isVolume !== true)
        if (target === undefined) throw new Error('目录中没有可阅读的章节')
        if (active) { cache.setPosition(bookId, editionKey, positionResult.position); navigate(chapterLink(bookId, target, editionKey), { replace: true, state: location.state }) }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '无法打开阅读') }
    })()
    return () => { active = false; controller.abort() }
  }, [bookId, navigate, requestedEditionKey, cache, location.state])

  if (error.length > 0) return <section className="reader-error"><p className="error">{error}</p><PageBackButton /></section>
  return <section className="reader-loading"><p className="muted">正在打开阅读…</p></section>
}

function chapterLink(bookId: string, chapter: ApiChapter, editionKey: string): string { return `/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}` }
