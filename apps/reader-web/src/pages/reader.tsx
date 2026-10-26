import { Bookmark, Moon, Sun, X } from 'lucide-react'
import { useReaderMarks } from '../lib/use-reader-marks.ts'
import { markedFragments, markedHtml, visibleTextPoint } from '../lib/reader-annotations.ts'
import { ReaderSelectionToolbar } from '../components/reader-selection-toolbar.tsx'
import { ReadingMarkEditor } from '../components/reading-mark-editor.tsx'
import { ReadingMarksList, type ReaderMarkDestination } from '../components/reading-marks-list.tsx'
import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { usePageActivity, usePageLoadEffect, usePageNavigation } from '../lib/use-page-resource.ts'
import { CircleHelp, ExternalLink, Info, RefreshCw } from 'lucide-react'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { MoreMenu } from '../components/more-menu.tsx'
import { PageBackButton } from '../components/page-back-button.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { ReaderIcon } from '../components/reader-icon.tsx'
import { browserUrl, cancelReaderGesture, chapterCharacterCount, finishReaderGesture, isReaderTap, moveReaderGesture, startReaderGesture, type ReaderGesture, type ReaderTapPoint } from '../lib/reader-interactions.ts'
import { pageReturnState } from '../lib/page-navigation.ts'
import { anchorFromViewport, clampPageIndex, pageActionForTap, pageCountFromScrollWidth, pageIndexForAnchor, pageLabel, pageTapZoneBoundaryRange, resizePageTapZones, type PageLayout, type PageTapZoneBoundary, type ReaderAnchor, type ReaderPageAction } from '../lib/reader-pagination.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { apiFetch, type ApiChapter, type ApiContent, type ApiPageTapAction, type ApiPageTapZones, type ApiPosition, type ApiToc } from '../lib/api.ts'
import { useReaderSettings } from '../lib/settings-context.tsx'
import { safeResourceUrl, sanitizeChapterHtml } from '../lib/html-content.ts'

type ReaderPanel = 'toc' | 'settings' | 'marks' | null
type PageTapZoneDrag = { pointerId: number; boundary: PageTapZoneBoundary }
type ReaderPreview = { target: { editionKey: string; chapterId: string; point: ReaderAnchor }; origin?: { path: string; editionKey: string; chapterId?: string; point?: ReaderAnchor; state?: unknown } }
type ReaderLocationState = { readingPreview?: ReaderPreview; readingRestorePoint?: ReaderAnchor; readingRestoreChapterId?: string }

export function ReaderPage() {
  const navigation = usePageNavigation()
  const pageActivity = usePageActivity()
  const visible = useRef(false)
  const { bookId = '', chapterId = '' } = useParams()
  const cache = useBookCache()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const locationState = location.state !== null && typeof location.state === 'object' ? location.state as ReaderLocationState : {}
  const readingPreview = locationState.readingPreview
  const previewActive = readingPreview !== undefined
  const previewActiveRef = useRef(previewActive)
  previewActiveRef.current = previewActive
  const positionIdentity = JSON.stringify([bookId, editionKey, chapterId])
  const positionIdentityRef = useRef(positionIdentity)
  positionIdentityRef.current = positionIdentity
  const { settings, resolvedTheme, updateSettings, saving: settingsSaving, error: settingsError } = useReaderSettings()
  const [controlsVisible, setControlsVisible] = useState(false)
  const [pageGuideVisible, setPageGuideVisible] = useState(false)
  const [pageGuideDraft, setPageGuideDraft] = useState<ApiPageTapZones>(settings.pageTapZones)
  const [pageGuideError, setPageGuideError] = useState('')
  const [themeRetry, setThemeRetry] = useState<'light' | 'dark' | null>(null)
  const pointerStartRef = useRef<ReaderTapPoint | null>(null)
  const selectionHandleDragRef = useRef(false)
  const gestureRef = useRef<{ pointerId: number; gesture: ReaderGesture; selection: { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number; text: string } } | null>(null)
  const blockedClickRef = useRef(false)
  const restoredPositionRef = useRef(false)
  const previousChapterEndRef = useRef<string | null>(location.hash === '#last-page' ? chapterId : null)
  const [content, setContent] = useState<ApiContent | null>(null)
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [position, setPosition] = useState<ApiPosition | null>(null)
  const [positionLoaded, setPositionLoaded] = useState(false)
  const [error, setError] = useState('')
  const [positionError, setPositionError] = useState('')
  const [panel, setPanel] = useState<ReaderPanel>(null)
  const [markTab, setMarkTab] = useState<'bookmarks' | 'annotations'>('bookmarks')
  const [retryNonce, setRetryNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [pageLayout, setPageLayout] = useState<PageLayout>({ pageWidth: 0, pageCount: 0 })
  const [pageIndex, setPageIndex] = useState(0)
  const [paginationError, setPaginationError] = useState('')
  const [boundaryNotice, setBoundaryNotice] = useState<{ text: string } | null>(null)
  useEffect(() => {
    if (boundaryNotice === null) return
    const timer = window.setTimeout(() => setBoundaryNotice(null), 2500)
    return () => window.clearTimeout(timer)
  }, [boundaryNotice])
  useEffect(() => setBoundaryNotice(null), [chapterId, pageIndex])
  const refreshController = useRef<AbortController | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const pageGuideRef = useRef<HTMLDialogElement>(null)
  const pageGuidePreviewRef = useRef<HTMLDivElement>(null)
  const pageGuideDragRef = useRef<PageTapZoneDrag | null>(null)
  const latestPositionRef = useRef<ApiPosition | null>(null)
  const positionVersionRef = useRef(-1)
  const latestAnchorRef = useRef<ReaderAnchor | null>(null)
  const paginationAnchorRef = useRef<ReaderAnchor | null>(null)
  const readingModeRef = useRef(settings.readingMode)
  const requestIdRef = useRef(0)
  const liveToc = cache.get(bookId, editionKey)?.toc ?? toc

  const marks = useReaderMarks({ articleRef, bookId, editionKey, chapterId, content, toc: liveToc, blocked: panel !== null || pageGuideVisible || refreshing, paged: settings.readingMode === 'paged', layout: pageLayout, pageIndex, positionReady: positionLoaded, onRestore: (point) => { restoredPositionRef.current = true; latestAnchorRef.current = point; paginationAnchorRef.current = point }, onPage: turnPage, onInteract: cancelGesture })

  useEffect(() => {
    if (marks.selection === null || marks.editing) return
    const preventPageScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.reader-selection-popover')) return
      if (event.type === 'touchmove' && selectionHandleDragRef.current) return
      event.preventDefault()
    }
    document.addEventListener('wheel', preventPageScroll, { capture: true, passive: false })
    document.addEventListener('touchmove', preventPageScroll, { capture: true, passive: false })
    return () => {
      document.removeEventListener('wheel', preventPageScroll, true)
      document.removeEventListener('touchmove', preventPageScroll, true)
    }
  }, [marks.selection, marks.editing])

  function cancelGesture() {
    if (gestureRef.current !== null) cancelReaderGesture(gestureRef.current.gesture)
    blockedClickRef.current = true
    pointerStartRef.current = null
  }

  function selectionSnapshot() {
    const selection = window.getSelection()
    return { anchorNode: selection?.anchorNode ?? null, anchorOffset: selection?.anchorOffset ?? 0, focusNode: selection?.focusNode ?? null, focusOffset: selection?.focusOffset ?? 0, text: selection?.toString() ?? '' }
  }

  function checkGestureSelection() {
    const active = gestureRef.current
    if (active === null) return
    const current = selectionSnapshot()
    const previous = active.selection
    const changed = current.anchorNode !== previous.anchorNode || current.anchorOffset !== previous.anchorOffset || current.focusNode !== previous.focusNode || current.focusOffset !== previous.focusOffset
    // 浏览器可能在普通点击时清除旧选区；只把新的非空选区或范围变化视为本次选字。
    if (current.text.length > 0 && (changed || current.text !== previous.text)) cancelGesture()
  }

  useEffect(() => {
    if (pageActivity?.active === false || settings.readingMode !== 'paged') return
    const selectionChanged = () => checkGestureSelection()
    const anotherPointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch' && !event.isPrimary) cancelGesture()
    }
    const cancel = () => cancelGesture()
    document.addEventListener('selectionchange', selectionChanged)
    document.addEventListener('pointerdown', anotherPointer, true)
    document.addEventListener('visibilitychange', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      cancelGesture()
      gestureRef.current = null
      document.removeEventListener('selectionchange', selectionChanged)
      document.removeEventListener('pointerdown', anotherPointer, true)
      document.removeEventListener('visibilitychange', cancel)
      window.removeEventListener('blur', cancel)
    }
  }, [pageActivity?.active, settings.readingMode, positionIdentity, content])

  useLayoutEffect(() => { cancelGesture(); gestureRef.current = null }, [pageLayout, refreshing])
  useEffect(() => { if (!marks.selection) selectionHandleDragRef.current = false }, [marks.selection])

  usePageLoadEffect((settle) => {
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
      snapshotRequest.then(() => apiFetch<{ content: { content: ApiContent; runtimeWarning?: string } }>(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}?editionKey=${encodeURIComponent(editionKey)}`, { signal: controller.signal })),
      snapshotRequest,
      apiFetch<{ position: ApiPosition | null }>(`/api/books/${encodeURIComponent(bookId)}/position?editionKey=${encodeURIComponent(editionKey)}`, { signal: controller.signal }),
    ]).then(async ([contentResult, tocResult, positionResult]) => {
      if (!active || requestId !== requestIdRef.current) return
      if (editionKey.length > 0 && !previewActiveRef.current) await apiFetch(`/api/books/${encodeURIComponent(bookId)}/edition`, { method: 'PUT', signal: controller.signal, body: JSON.stringify({ editionKey }) })
      if (!active || requestId !== requestIdRef.current) return
      restoredPositionRef.current = positionResult.position?.chapterId !== chapterId
      const chapterPosition = positionResult.position?.chapterId === chapterId ? positionResult.position : null
      // 末页入口仅在跨章时生效；刷新已有本章进度的页面必须恢复已保存位置。
      if (chapterPosition !== null) previousChapterEndRef.current = null
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
      .finally(() => { if (active) settle() })
    return () => { active = false; controller.abort(); refreshController.current?.abort(); requestIdRef.current += 1 }
  }, [bookId, chapterId, editionKey, retryNonce], ['content'])

  async function persistPosition(input: { paragraphIndex: number; offset: number; version: number }, acceptPreview = false): Promise<boolean> {
    if (previewActiveRef.current && !acceptPreview || content === null || content.chapter.chapterId !== chapterId || navigation === null) return false
    const version = Math.max(input.version, positionVersionRef.current + 1)
    positionVersionRef.current = version
    const identity = positionIdentity
    const write = { bookId, editionKey, chapterId, chapterUrl: content.chapter.chapterUrl, chapterIndex: content.chapter.index, title: content.chapter.title ?? `第 ${content.chapter.index + 1} 章`, tocRevision: liveToc?.revision, paragraphIndex: input.paragraphIndex, offset: input.offset, version }
    try {
      const result = await navigation.positions.enqueue(write)
      if (result === undefined || identity !== positionIdentityRef.current) return false
      positionVersionRef.current = Math.max(positionVersionRef.current, result.version)
      latestPositionRef.current = result
      setPosition(result); setPositionError('')
      return true
    } catch (reason) { if (identity === positionIdentityRef.current) setPositionError(reason instanceof Error ? reason.message : '阅读位置保存失败'); return false }
  }

  function navigateToMark(destination: ReaderMarkDestination) {
    const root = articleRef.current
    const originPoint = root ? (settings.readingMode === 'paged' ? anchorFromViewport(root) : visibleTextPoint(root, false)) ?? latestAnchorRef.current : latestAnchorRef.current
    const origin = readingPreview?.origin ?? { path: location.pathname + location.search, editionKey, chapterId, ...(originPoint ? { point: originPoint } : {}), state: location.state }
    navigate(destination.path, { replace: true, state: {
      ...(location.state !== null && typeof location.state === 'object' ? location.state : {}),
      readingPreview: { target: { editionKey: destination.editionKey, chapterId: destination.chapterId, point: destination.point }, origin },
    } })
    setPanel(null)
  }

  function returnToReadingProgress() {
    const origin = readingPreview?.origin
    if (!origin) { setPositionError('找不到进入此内容前的阅读进度。'); return }
    const state = origin.state !== null && typeof origin.state === 'object' ? { ...origin.state } as Record<string, unknown> : {}
    delete state.readingPreview; delete state.readingRestorePoint; delete state.readingRestoreChapterId
    if (origin.point && origin.chapterId) { state.readingRestorePoint = origin.point; state.readingRestoreChapterId = origin.chapterId }
    navigate(origin.path, { replace: true, state })
  }

  function openCurrentProgress() {
    setPanel(null)
    if (previewActive) { returnToReadingProgress(); return }
    if (position?.chapterId && position.chapterId !== chapterId) {
      navigate(`/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(position.chapterId)}?editionKey=${encodeURIComponent(editionKey)}`, { replace: true })
    }
  }

  async function acceptPreviewPosition() {
    if (!readingPreview || !content || previewActiveRef.current === false) return
    const root = articleRef.current
    const point = root ? (settings.readingMode === 'paged' ? anchorFromViewport(root) : visibleTextPoint(root, false)) ?? latestAnchorRef.current : latestAnchorRef.current
    if (!point) { setPositionError('无法读取当前位置，请稍后重试。'); return }
    setPositionError('')
    try {
      const saved = await persistPosition({ ...point, version: Math.max(positionVersionRef.current + 1, position?.version ?? -1) }, true)
      if (!saved) return
      await apiFetch(`/api/books/${encodeURIComponent(bookId)}/edition`, { method: 'PUT', body: JSON.stringify({ editionKey }) })
      const state = location.state !== null && typeof location.state === 'object' ? { ...location.state } as Record<string, unknown> : {}
      delete state.readingPreview; delete state.readingRestorePoint; delete state.readingRestoreChapterId
      navigate(location.pathname + location.search, { replace: true, state })
    } catch (reason) { setPositionError(reason instanceof Error ? reason.message : '接受当前位置失败') }
  }

  const restorePoint = readingPreview?.target.chapterId === chapterId && readingPreview.target.editionKey === editionKey ? readingPreview.target.point : locationState.readingRestoreChapterId === chapterId ? locationState.readingRestorePoint : undefined
  useLayoutEffect(() => {
    const root = articleRef.current
    if (!restorePoint || !root || !content || content.chapter.chapterId !== chapterId || !positionLoaded) return
    restoredPositionRef.current = true
    latestAnchorRef.current = restorePoint; paginationAnchorRef.current = restorePoint
    if (settings.readingMode === 'paged') {
      if (pageLayout.pageCount > 0) {
        const targetPage = pageIndexForAnchor(root, restorePoint, pageLayout)
        root.scrollTo({ left: targetPage * pageLayout.pageWidth, top: 0, behavior: 'auto' })
        setPageIndex(targetPage)
      }
      return
    }
    const frame = window.requestAnimationFrame(() => scrollReaderPoint(root, restorePoint))
    return () => window.cancelAnimationFrame(frame)
  }, [restorePoint, content, chapterId, editionKey, positionLoaded, settings.readingMode, pageLayout.pageCount, pageLayout.pageWidth])

  // 布局清理在 DOM 隐藏前捕获最后锚点；保存任务由账号队列拥有。
  useLayoutEffect(() => {
    visible.current = true
    setControlsVisible(false); setPanel(null); setPageGuideVisible(false)
    if (settings.readingMode === 'scroll' && latestAnchorRef.current !== null && articleRef.current !== null) {
      const paragraph = articleRef.current.querySelector<HTMLElement>(`[data-paragraph="${latestAnchorRef.current.paragraphIndex}"]`)
      if (paragraph !== null) window.scrollTo({ top: window.scrollY + paragraph.getBoundingClientRect().top - 12, behavior: 'auto' })
    }
    return () => {
      visible.current = false
      refreshController.current?.abort()
      const anchor = settings.readingMode === 'paged' ? anchorFromViewport(articleRef.current) : latestAnchorRef.current
      if (anchor !== null && anchor !== undefined) { latestAnchorRef.current = anchor; paginationAnchorRef.current = anchor; if (!previewActive && !previewActiveRef.current) void persistPosition({ ...anchor, version: positionVersionRef.current + 1 }) }
      pageGuideRef.current?.close()
    }
  }, [bookId, chapterId, editionKey, content, settings.readingMode, previewActive])

  useEffect(() => {
    latestPositionRef.current = position
    if (position?.chapterId !== chapterId) return
    latestAnchorRef.current = { paragraphIndex: position.paragraphIndex, offset: position.offset }
    if (settings.readingMode === 'paged') paginationAnchorRef.current = latestAnchorRef.current
  }, [chapterId, position, settings.readingMode])
  useEffect(() => {
    if (previewActive || content === null || content.chapter.chapterId !== chapterId || !positionLoaded || position?.chapterId === chapterId) return
    void persistPosition({ paragraphIndex: 0, offset: 0, version: (position?.version ?? -1) + 1 })
  }, [previewActive, bookId, chapterId, editionKey, content, positionLoaded, position?.chapterId, position?.version, liveToc?.revision])
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
      if (previewActiveRef.current) return
      if (current?.chapterId === chapterId && current.paragraphIndex === anchor.paragraphIndex) return
      const offset = current?.chapterId === chapterId ? current.offset : 0
      void persistPosition({ paragraphIndex: anchor.paragraphIndex, offset, version: (current?.version ?? -1) + 1 })
    }
    const onScroll = () => { const anchor = readAnchor(); if (anchor !== undefined) latestAnchorRef.current = anchor; if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => { timer = undefined; persist() }, 500) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); if (timer !== undefined) window.clearTimeout(timer) }
  }, [previewActive, bookId, chapterId, editionKey, content, positionLoaded, liveToc?.revision, settings.readingMode])
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
    const dialog = pageGuideRef.current
    if (dialog === null) return
    if (pageGuideVisible && visible.current && !dialog.open) {
      dialog.showModal()
      // 原生 showModal 也会聚焦首个控件；打开时清除该焦点，避免关闭按钮出现焦点框。
      const focused = document.activeElement
      if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur()
    } else if (!pageGuideVisible && dialog.open) dialog.close()
    return () => { if (dialog.open) dialog.close() }
  }, [pageGuideVisible])

  useEffect(() => () => { pageGuideDragRef.current = null }, [])

  useEffect(() => {
    if (!controlsVisible) return
    const overflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    return () => { document.documentElement.style.overflow = overflow }
  }, [controlsVisible])

  useEffect(() => {
    const viewport = articleRef.current
    if (settings.readingMode !== 'paged' || paginationError.length > 0 || content === null || content.chapter.chapterId !== chapterId || !positionLoaded || viewport === null) return
    let active = true
    let attempts = 0
    let measuredWidth = 0
    let measured = false
    let frame: number | undefined
    const measure = () => {
      if (!active || !visible.current) return
      const pageWidth = viewport.clientWidth
      cancelGesture()
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
      // 跨章回退在正文和位置加载后定位末页，避免被旧章节位置恢复覆盖。
      const enteringPreviousEnd = previousChapterEndRef.current === chapterId
      const targetPage = enteringPreviousEnd ? pageCount - 1 : !measured || measuredWidth !== pageWidth
        ? pageIndexForAnchor(viewport, paginationAnchorRef.current ?? latestAnchorRef.current, layout)
        : clampPageIndex(Math.round(viewport.scrollLeft / pageWidth), pageCount)
      measuredWidth = pageWidth
      measured = true
      viewport.scrollLeft = targetPage * pageWidth
      viewport.scrollTo({ left: targetPage * pageWidth, top: 0, behavior: 'auto' })
      setPageIndex(targetPage)
      setPaginationError('')
      if (enteringPreviousEnd) {
        previousChapterEndRef.current = null
        const anchor = anchorFromViewport(viewport)
        if (anchor !== undefined) {
          latestAnchorRef.current = anchor
          paginationAnchorRef.current = anchor
          void persistPosition({ ...anchor, version: positionVersionRef.current + 1 })
        }
      }
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
  }, [content, chapterId, positionLoaded, paginationError, settings.fontSize, settings.lineHeight, settings.marginTop, settings.marginRight, settings.marginBottom, settings.marginLeft, settings.readingMode])

  const paragraphs = useMemo(() => content?.cleaned.split(/\n+/u).map((text) => text.trim()).filter(Boolean) ?? [], [content])
  const htmlContent = useMemo(() => content?.contentType === 'html' ? markedHtml(sanitizeChapterHtml(content.cleaned), marks.resolved) : '', [content, marks.resolved])
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
    if (controlsVisible) { setControlsVisible(false); return }
    if (action === 'previous') {
      if (pageLayout.pageCount > 0 && pageIndex === 0 && currentIndex === 0) { setBoundaryNotice({ text: '当前已经是第一章' }); return }
      if (pageLayout.pageCount > 0 && pageIndex === 0 && previous !== undefined) {
        previousChapterEndRef.current = previous.chapterId
        navigate(chapterLink(bookId, previous, editionKey) + '#last-page', { replace: true, state: location.state })
      } else turnPage(pageIndex - 1)
    }
    else if (action === 'next') {
      if (pageLayout.pageCount > 0 && pageIndex >= pageLayout.pageCount - 1 && currentIndex >= 0 && currentIndex === siblings.length - 1) { setBoundaryNotice({ text: '当前已是最后一章' }); return }
      // 排版完成且已到本章末页时，沿用章节导航流程加载下一章。
      if (pageLayout.pageCount > 0 && pageIndex >= pageLayout.pageCount - 1 && next !== undefined) {
        navigate(chapterLink(bookId, next, editionKey), { replace: true, state: location.state })
      } else turnPage(pageIndex + 1)
    }
    else setControlsVisible((value) => !value)
  }

  function openPageGuide() {
    setPageGuideDraft(settings.pageTapZones)
    setPageGuideError('')
    setPageGuideVisible(true)
  }

  function closePageGuide() {
    if (settingsSaving) return
    setPageGuideVisible(false)
    pageGuideDragRef.current = null
    window.requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }))
  }

  async function savePageGuide() {
    if (settingsSaving) return
    setPageGuideError('')
    try {
      await updateSettings({ pageTapZones: pageGuideDraft }, { optimistic: false })
      closePageGuide()
    } catch (reason) {
      setPageGuideError(reason instanceof Error ? reason.message : '翻页区域保存失败，请重试。')
    }
  }

  function beginPageZoneDrag(event: ReactPointerEvent<HTMLButtonElement>, boundary: PageTapZoneBoundary) {
    if (event.button !== 0) return
    event.preventDefault()
    pageGuideDragRef.current = { pointerId: event.pointerId, boundary }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function movePageZoneDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = pageGuideDragRef.current
    const bounds = pageGuidePreviewRef.current?.getBoundingClientRect()
    if (drag === null || drag.pointerId !== event.pointerId || bounds === undefined) return
    const vertical = drag.boundary === 'center-top' || drag.boundary === 'center-bottom'
    const origin = vertical ? bounds.top : bounds.left
    const length = vertical ? bounds.height : bounds.width
    if (length <= 0) return
    setPageGuideDraft((current) => resizePageTapZones(current, drag.boundary, ((vertical ? event.clientY : event.clientX) - origin) / length * 100))
  }

  function finishPageZoneDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (pageGuideDragRef.current?.pointerId === event.pointerId) pageGuideDragRef.current = null
  }

  function handlePageZoneKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, boundary: PageTapZoneBoundary) {
    const vertical = boundary === 'center-top' || boundary === 'center-bottom'
    const range = pageTapZoneBoundaryRange(pageGuideDraft, boundary)
    let target: number | undefined
    if (event.key === 'Home') target = range.min
    else if (event.key === 'End') target = range.max
    else if (vertical && event.key === 'ArrowUp') target = range.value - 1
    else if (vertical && event.key === 'ArrowDown') target = range.value + 1
    else if (!vertical && event.key === 'ArrowLeft') target = range.value - 1
    else if (!vertical && event.key === 'ArrowRight') target = range.value + 1
    if (target === undefined) return
    event.preventDefault()
    setPageGuideDraft((current) => resizePageTapZones(current, boundary, target ?? range.value))
  }

  function updateCenterPageAction(side: 'top' | 'bottom', action: ApiPageTapAction) {
    setPageGuideDraft((current) => side === 'top' ? { ...current, centerTopAction: action } : { ...current, centerBottomAction: action })
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
      const result = await apiFetch<{ content: { content: ApiContent; tocRevision: string; runtimeWarning?: string } }>('/api/books/' + encodeURIComponent(bookId) + '/chapters/' + encodeURIComponent(chapterId) + '?editionKey=' + encodeURIComponent(editionKey) + '&refresh=true', { signal: controller.signal })
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
  if (error.length > 0) return <section className="reader-error loading-state loading-state-viewport"><p className="error" role="alert">{error}</p><div className="loading-state-action"><PageBackButton appearance="button" /><Button variant="secondary" size="sm" type="button" onClick={() => setRetryNonce((value) => value + 1)}>重试</Button></div></section>
  if (content === null) return <LoadingState message="正在读取正文…" variant="viewport" action={<PageBackButton appearance="button" />} />
  const dark = resolvedTheme === 'dark'
  const paged = settings.readingMode === 'paged'
  const pageCounter = pageLayout.pageCount > 0 ? pageLabel(pageIndex, pageLayout.pageCount) : '排版中…'
  const bookDetails = cache.get(bookId, editionKey)?.details
  const bookName = bookDetails?.edition.metadata?.name || bookDetails?.book.name || '阅读'
  const chapterProgress = `${currentIndex < 0 ? '—' : currentIndex + 1}/${siblings.length || '—'}章`
  const wordCountLabel = `${chapterCharacterCount(content.cleaned).toLocaleString('zh-CN')} 字`
  const readerStyle = { fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight, '--reader-margin-top': `${settings.marginTop}px`, '--reader-margin-right': `${settings.marginRight}px`, '--reader-margin-bottom': `${settings.marginBottom}px`, '--reader-margin-left': `${settings.marginLeft}px` } as CSSProperties
  const pageZonePreviewStyle = { '--zone-left-width': `${pageGuideDraft.leftWidthPercent}%`, '--zone-center-width': `${pageGuideDraft.centerWidthPercent}%`, '--zone-top-height': `${pageGuideDraft.centerTopHeightPercent}%`, '--zone-middle-height': `${pageGuideDraft.centerMiddleHeightPercent}%` } as CSSProperties
  const leftCenterRange = pageTapZoneBoundaryRange(pageGuideDraft, 'left-center')
  const centerRightRange = pageTapZoneBoundaryRange(pageGuideDraft, 'center-right')
  const centerTopRange = pageTapZoneBoundaryRange(pageGuideDraft, 'center-top')
  const centerBottomRange = pageTapZoneBoundaryRange(pageGuideDraft, 'center-bottom')
  async function toggleTheme(target: 'light' | 'dark' = dark ? 'light' : 'dark') {
    setThemeRetry(null)
    try { await updateSettings({ theme: target }) } catch { setThemeRetry(target) }
  }
  const address = browserUrl(content.chapter.chapterUrl)
  return <section className={`reader-page${paged ? ' reader-page-paged' : ''}`} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      if (marks.selection && !marks.editing) { event.preventDefault(); marks.close(); window.getSelection()?.removeAllRanges() }
      else if (pageGuideVisible) { event.preventDefault(); closePageGuide() }
      else if (panel === null) { setControlsVisible(false); articleRef.current?.focus({ preventScroll: true }) }
    }
  }}>
    {boundaryNotice ? <div className="reader-boundary-notice" role="status" aria-live="polite">{boundaryNotice.text}</div> : null}
    <div className="reader-status reader-status-top" aria-label="当前阅读书籍与章节"><span title={bookName}>{bookName}</span><span title={content.chapter.title ?? ''}>{content.chapter.title ?? '正文'}</span></div>
    <div className="reader-status reader-status-bottom" aria-label="阅读进度"><span>{chapterProgress}</span><span>{paged ? `${pageCounter}${pageLayout.pageCount > 0 ? '页' : ''} ` : ''}{wordCountLabel}</span></div>
    <header className="reader-topbar" hidden={!controlsVisible}><PageBackButton className="reader-back" /><div className="reader-title"><strong title={content.chapter.title ?? ''}>{content.chapter.title ?? '正文'}</strong></div><div className="reader-tools"><MoreMenu label="更多阅读操作">
      <Link className="more-menu-item" to={'/books/' + encodeURIComponent(bookId) + '/details?editionKey=' + encodeURIComponent(editionKey)} state={readerReturnState(location)}><Info aria-hidden="true" />书籍详情</Link>
      {paged ? <button className="more-menu-item" type="button" onClick={openPageGuide}><CircleHelp aria-hidden="true" />翻页区域</button> : null}
      {address === undefined ? <span className="more-menu-note muted small">没有可用的原文地址</span> : <a className="more-menu-item" href={address} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />查看原文</a>}
      <button className="more-menu-item" type="button" disabled={refreshing} onClick={() => void refreshChapter()}><RefreshCw aria-hidden="true" />{refreshing ? '刷新中…' : '刷新内容'}</button>
    </MoreMenu></div></header>
    <article className={`reader-content${paged ? ' reader-content-paged' : ''}`} ref={articleRef} tabIndex={0} aria-label={paged ? `正文，左侧上一页，中栏上段${settings.pageTapZones.centerTopAction === 'previous' ? '上一页' : '下一页'}，中段显示或隐藏操作栏，下段${settings.pageTapZones.centerBottomAction === 'previous' ? '上一页' : '下一页'}，右侧下一页` : '正文，按回车显示或隐藏阅读操作'} style={readerStyle}
      onPointerDown={(event) => {
        if (marks.selection && !marks.editing) {
          const rect = marks.selection.rect
          selectionHandleDragRef.current = event.pointerType === 'touch' && event.clientX >= rect.left - 36 && event.clientX <= rect.right + 36 && event.clientY >= rect.top - 36 && event.clientY <= rect.bottom + 36
          cancelGesture(); return
        }
        selectionHandleDragRef.current = false
        if (event.target instanceof Element && event.target.closest('[data-mark-id]')) { cancelGesture(); return }
        if (paged && event.pointerType === 'touch' && !event.isPrimary) { cancelGesture(); return }
        blockedClickRef.current = false
        gestureRef.current = null
        if (paged && event.target instanceof Element && event.target.closest('a, button, input, select, textarea, [contenteditable]:not([contenteditable="false"])') !== null) { cancelGesture(); return }
        const selection = paged ? selectionSnapshot() : null
        articleRef.current?.focus({ preventScroll: true })
        pointerStartRef.current = { x: event.clientX, y: event.clientY, scrollY: window.scrollY, selectedText: selection?.text ?? '' }
        if (paged && event.pointerType === 'touch' && selection !== null) {
          const visualViewport = window.visualViewport
          const left = visualViewport?.offsetLeft ?? 0
          const width = visualViewport?.width ?? window.innerWidth
          const allowed = !controlsVisible && panel === null && !pageGuideVisible && !refreshing && pageLayout.pageCount > 0 && selection.text.length === 0 && event.clientX - left >= 24 && left + width - event.clientX >= 24
          gestureRef.current = { pointerId: event.pointerId, selection, gesture: startReaderGesture({ x: event.clientX, y: event.clientY, time: event.timeStamp }, event.currentTarget.clientWidth, allowed) }
        }
      }}
      onPointerMove={(event) => {
        const active = gestureRef.current
        if (active?.pointerId !== event.pointerId) return
        checkGestureSelection()
        moveReaderGesture(active.gesture, { x: event.clientX, y: event.clientY, time: event.timeStamp })
        blockedClickRef.current ||= active.gesture.clickBlocked
      }}
      onPointerUp={(event) => {
        if (marks.selection) { selectionHandleDragRef.current = false; return }
        const active = gestureRef.current
        if (active?.pointerId !== event.pointerId) return
        checkGestureSelection()
        const action = finishReaderGesture(active.gesture, { x: event.clientX, y: event.clientY, time: event.timeStamp })
        blockedClickRef.current ||= active.gesture.clickBlocked
        gestureRef.current = null
        if (action !== null && visible.current && !controlsVisible && panel === null && !pageGuideVisible && !refreshing) handlePageAction(action)
      }}
      onPointerCancel={() => { selectionHandleDragRef.current = false; if (paged) cancelGesture(); else pointerStartRef.current = null }}
      onLostPointerCapture={() => { if (gestureRef.current !== null) cancelGesture() }}
      onClick={(event) => {
        if (event.target instanceof Element && marks.openMark(event.target)) { event.preventDefault(); event.stopPropagation(); return }
        if (paged && event.target instanceof Element && event.target.closest('a, button, input, select, textarea, [contenteditable]:not([contenteditable="false"])') !== null) return
        if (paged && event.detail !== 0 && blockedClickRef.current) return
        const start = pointerStartRef.current
        const selectedText = window.getSelection()?.toString() ?? ''
        const end = { x: event.clientX, y: event.clientY, scrollY: window.scrollY }
        const tap = isReaderTap(start, end, selectedText)
        pointerStartRef.current = null
        if (!tap) return
        if (paged && articleRef.current !== null) {
          const rect = articleRef.current.getBoundingClientRect()
          const action = pageActionForTap(start, end, selectedText, event.clientX, rect.left, rect.width, settings.pageTapZones, event.clientY, rect.top, rect.height)
          if (action !== null) {
            // 普通点击结束旧选区并立即响应；本次新建或拖动的选区已被手势判断拦截。
            if (selectedText.length > 0) window.getSelection()?.removeAllRanges()
            handlePageAction(action)
          }
        } else setControlsVisible((value) => !value)
      }}
      onKeyDown={(event) => {
        if (marks.selection && !marks.editing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) { event.preventDefault(); return }
        if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('[data-mark-id]')) { event.preventDefault(); marks.openMark(event.target); return }
        if (event.target !== event.currentTarget) return
        if (paged && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault()
          handlePageAction(event.key === 'ArrowLeft' ? 'previous' : 'next')
        } else if (event.key === 'Enter') {
          event.preventDefault()
          setControlsVisible((value) => !value)
        }
      }}>
      {content.contentType === 'html' ? htmlContent.length === 0 && additionalResources.length === 0 ? <p className="muted">本章暂无正文。</p> : <><div className="reader-html-content" data-paragraph={0} dangerouslySetInnerHTML={{ __html: htmlContent }} />{additionalResources.map((url, index) => <p className="reader-resource" data-paragraph={index + 1} key={url}><img src={url} alt="正文插图" loading="lazy" decoding="async" /></p>)}</> : paragraphs.length === 0 ? <p className="muted">本章暂无正文。</p> : paragraphs.map((paragraph, index) => <p className="reader-paragraph" data-paragraph={index} key={`${index}:${paragraph.slice(0, 12)}`}>{markedFragments(paragraph, index, marks.resolved).map((part, i) => part.mark ? <span className="reader-mark" data-mark-id={part.mark.id} data-color={part.mark.color} role="button" tabIndex={0} aria-label={part.mark.note ? '编辑想法' : '编辑标记'} key={i}>{part.text}</span> : part.text)}</p>)}
    </article>
    {paged ? <dialog ref={pageGuideRef} id="reader-page-guide" className="reader-page-guide" aria-labelledby="reader-page-guide-title" onCancel={(event) => { event.preventDefault(); closePageGuide() }}>
      <div className="reader-page-guide-shell">
        <header className="reader-page-guide-header"><div><span className="reader-page-guide-kicker">阅读操作</span><h2 id="reader-page-guide-title">翻页区域</h2><p>拖动分割线调整区域，点击中间栏切换操作栏。</p></div><button className="reader-page-guide-close" type="button" data-page-guide-close aria-label="关闭翻页区域设置" disabled={settingsSaving} onClick={closePageGuide}>×</button></header>
        <div className="reader-page-guide-body">
          <div className="reader-zone-preview">
            <div className="reader-zone-layout" ref={pageGuidePreviewRef} style={pageZonePreviewStyle}>
              <div className="reader-zone-cell reader-zone-side"><span aria-hidden="true">‹</span><strong>上一页</strong><small>{pageGuideDraft.leftWidthPercent}%</small></div>
              <div className="reader-zone-center">
                <div className="reader-zone-cell reader-zone-center-action"><small>上栏 · {pageGuideDraft.centerTopHeightPercent}%</small><strong>{pageGuideDraft.centerTopAction === 'previous' ? '上一页' : '下一页'}</strong></div>
                <div className="reader-zone-cell reader-zone-center-toggle"><strong>显示 / 隐藏</strong><small>操作栏 · {pageGuideDraft.centerMiddleHeightPercent}%</small></div>
                <div className="reader-zone-cell reader-zone-center-action"><small>下栏 · {100 - pageGuideDraft.centerTopHeightPercent - pageGuideDraft.centerMiddleHeightPercent}%</small><strong>{pageGuideDraft.centerBottomAction === 'previous' ? '上一页' : '下一页'}</strong></div>
              </div>
              <div className="reader-zone-cell reader-zone-side"><span aria-hidden="true">›</span><strong>下一页</strong><small>{100 - pageGuideDraft.leftWidthPercent - pageGuideDraft.centerWidthPercent}%</small></div>
              <button className="reader-zone-separator reader-zone-separator-vertical reader-zone-separator-left" type="button" role="separator" aria-label="调整左栏与中栏分界" aria-orientation="vertical" aria-valuemin={leftCenterRange.min} aria-valuemax={leftCenterRange.max} aria-valuenow={leftCenterRange.value} aria-valuetext={`分界位置 ${leftCenterRange.value}%`} onKeyDown={(event) => handlePageZoneKeyDown(event, 'left-center')} onPointerDown={(event) => beginPageZoneDrag(event, 'left-center')} onPointerMove={movePageZoneDrag} onPointerUp={finishPageZoneDrag} onPointerCancel={finishPageZoneDrag} onLostPointerCapture={() => { pageGuideDragRef.current = null }} />
              <button className="reader-zone-separator reader-zone-separator-vertical reader-zone-separator-right" type="button" role="separator" aria-label="调整中栏与右栏分界" aria-orientation="vertical" aria-valuemin={centerRightRange.min} aria-valuemax={centerRightRange.max} aria-valuenow={centerRightRange.value} aria-valuetext={`分界位置 ${centerRightRange.value}%`} onKeyDown={(event) => handlePageZoneKeyDown(event, 'center-right')} onPointerDown={(event) => beginPageZoneDrag(event, 'center-right')} onPointerMove={movePageZoneDrag} onPointerUp={finishPageZoneDrag} onPointerCancel={finishPageZoneDrag} onLostPointerCapture={() => { pageGuideDragRef.current = null }} />
              <button className="reader-zone-separator reader-zone-separator-horizontal reader-zone-separator-top" type="button" role="separator" aria-label="调整上栏与中栏分界" aria-orientation="horizontal" aria-valuemin={centerTopRange.min} aria-valuemax={centerTopRange.max} aria-valuenow={centerTopRange.value} aria-valuetext={`分界位置 ${centerTopRange.value}%`} onKeyDown={(event) => handlePageZoneKeyDown(event, 'center-top')} onPointerDown={(event) => beginPageZoneDrag(event, 'center-top')} onPointerMove={movePageZoneDrag} onPointerUp={finishPageZoneDrag} onPointerCancel={finishPageZoneDrag} onLostPointerCapture={() => { pageGuideDragRef.current = null }} />
              <button className="reader-zone-separator reader-zone-separator-horizontal reader-zone-separator-bottom" type="button" role="separator" aria-label="调整中栏与下栏分界" aria-orientation="horizontal" aria-valuemin={centerBottomRange.min} aria-valuemax={centerBottomRange.max} aria-valuenow={centerBottomRange.value} aria-valuetext={`分界位置 ${centerBottomRange.value}%`} onKeyDown={(event) => handlePageZoneKeyDown(event, 'center-bottom')} onPointerDown={(event) => beginPageZoneDrag(event, 'center-bottom')} onPointerMove={movePageZoneDrag} onPointerUp={finishPageZoneDrag} onPointerCancel={finishPageZoneDrag} onLostPointerCapture={() => { pageGuideDragRef.current = null }} />
            </div>
          </div>
          <div className="reader-page-guide-actions"><label><span>上栏点击</span><select aria-label="上栏点击动作" value={pageGuideDraft.centerTopAction} onChange={(event) => updateCenterPageAction('top', event.target.value as ApiPageTapAction)}><option value="previous">上一页</option><option value="next">下一页</option></select></label><label><span>下栏点击</span><select aria-label="下栏点击动作" value={pageGuideDraft.centerBottomAction} onChange={(event) => updateCenterPageAction('bottom', event.target.value as ApiPageTapAction)}><option value="previous">上一页</option><option value="next">下一页</option></select></label></div>
          <p className="reader-page-guide-hint">左 / 中 / 右：{pageGuideDraft.leftWidthPercent}% / {pageGuideDraft.centerWidthPercent}% / {100 - pageGuideDraft.leftWidthPercent - pageGuideDraft.centerWidthPercent}%；上 / 中 / 下：{pageGuideDraft.centerTopHeightPercent}% / {pageGuideDraft.centerMiddleHeightPercent}% / {100 - pageGuideDraft.centerTopHeightPercent - pageGuideDraft.centerMiddleHeightPercent}%。每个区域至少 18%，分割线也可用方向键微调。</p>
          {pageGuideError.length > 0 ? <DismissibleMessage onDismiss={() => setPageGuideError('')} className="error reader-page-guide-error" role="alert">{pageGuideError}</DismissibleMessage> : null}
        </div>
        <footer className="reader-page-guide-footer"><Button variant="secondary" type="button" disabled={settingsSaving} onClick={closePageGuide}>关闭</Button><Button type="button" disabled={settingsSaving} onClick={() => void savePageGuide()}>{settingsSaving ? '保存中…' : '保存设置'}</Button></footer>
      </div>
    </dialog> : null}
    {paged && paginationError.length > 0 ? <div className="reader-pagination-error" role="alert"><DismissibleMessage onDismiss={() => setPaginationError('')} className="error">{paginationError}</DismissibleMessage><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={() => { setPaginationError(''); setPageLayout({ pageWidth: 0, pageCount: 0 }); setPageIndex(0) }}>重试分页</Button><Button variant="secondary" size="sm" type="button" onClick={() => void switchToScroll()}>切换滚动阅读</Button></div></div> : null}
    {refreshError.length > 0 ? <DismissibleMessage onDismiss={() => setRefreshError('')} className="error reader-position-error" role="alert">{refreshError}<button className="text-button" disabled={refreshing} onClick={() => void refreshChapter()}>重试刷新</button></DismissibleMessage> : null}
    {positionError.length > 0 ? <DismissibleMessage onDismiss={() => setPositionError('')} className="error reader-position-error" role="alert">{positionError}<button className="text-button" type="button" onClick={() => void navigation?.positions.retry(bookId, editionKey).then((result) => { if (result !== undefined) { setPosition(result); setPositionError('') } }, (reason: unknown) => setPositionError(reason instanceof Error ? reason.message : '阅读位置保存失败'))}>重试</button></DismissibleMessage> : null}
    {controlsVisible ? <div className="reader-controls-backdrop" aria-hidden="true" onClick={() => setControlsVisible(false)} onWheel={(event) => event.preventDefault()} onTouchMove={(event) => event.preventDefault()} /> : null}
    <div className="reader-bottom-bar" hidden={!controlsVisible}>
      <div className="reader-exit-row"><PageBackButton className="reader-exit" label="退出阅读" /><button className="reader-theme-toggle" type="button" aria-label={dark ? '切换日间模式' : '切换夜间模式'} title={dark ? '切换日间模式' : '切换夜间模式'} disabled={settingsSaving} onClick={() => void toggleTheme()}>{dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</button></div>
      <nav className="reader-chapter-nav" aria-label="章节导航"><button className="reader-nav-button" type="button" disabled={previous === undefined} onClick={() => { if (previous !== undefined) navigate(chapterLink(bookId, previous, editionKey), { replace: true, state: location.state }) }}>上一章</button><span className="reader-word-count" aria-label={paged ? `分页进度 ${pageCounter}，${wordCountLabel}` : '章节字数'}>{paged ? <><span>{pageCounter}</span><span className="reader-word-count-separator" aria-hidden="true">·</span><span>{wordCountLabel}</span></> : wordCountLabel}</span><button className="reader-nav-button" type="button" disabled={next === undefined} onClick={() => { if (next !== undefined) navigate(chapterLink(bookId, next, editionKey), { replace: true, state: location.state }) }}>下一章</button></nav>
      <nav className="reader-shortcuts" aria-label="阅读快捷操作">
        <button type="button" className="reader-shortcut" aria-label="目录" onClick={() => setPanel('toc')}><ReaderIcon name="toc" /><span>目录</span></button>
        <button type="button" className="reader-shortcut" aria-label="书签和笔记" onClick={() => setPanel('marks')}><Bookmark aria-hidden="true" /><span>书签</span></button>
        <button type="button" className="reader-shortcut" aria-label="设置" onClick={() => setPanel('settings')}><ReaderIcon name="settings" /><span>设置</span></button>
        <Link className="reader-shortcut" to={`/books/${encodeURIComponent(bookId)}/sources`} state={readerReturnState(location)} aria-label="换源"><ReaderIcon name="source" /><span>换源</span></Link>
      </nav>
      {settingsError === undefined ? null : <div className="notice-with-recovery"><DismissibleMessage className="error reader-settings-error" role="alert">{settingsError}</DismissibleMessage>{themeRetry === null ? null : <button className="text-button" type="button" disabled={settingsSaving} onClick={() => void toggleTheme(themeRetry)}>重试</button>}</div>}
    </div>
    {controlsVisible && panel === null && !pageGuideVisible && !marks.selection && !marks.editing ? <button className="reader-bookmark-float" type="button" aria-label={marks.currentBookmark ? '取消当前书签' : '添加当前位置书签'} title={marks.currentBookmark ? '取消当前书签' : '添加当前位置书签'} aria-pressed={Boolean(marks.currentBookmark)} disabled={marks.busy} onClick={() => void marks.toggleBookmark()}><Bookmark aria-hidden="true" fill={marks.currentBookmark ? 'currentColor' : 'none'} /></button> : null}
    {marks.error ? <div className="reader-mark-error"><DismissibleMessage className="error" role="alert" onDismiss={() => marks.setError('')}>{marks.error}<button className="text-button" type="button" onClick={marks.retry}>重新加载</button></DismissibleMessage></div> : null}
    {marks.selection && !marks.editing ? <ReaderSelectionToolbar rect={marks.selection.rect} mark={marks.selection.mark} busy={marks.busy} onColor={(color) => void marks.save(color, marks.selection?.mark?.note ?? null)} onThought={marks.startThought} onDelete={() => void marks.remove()} onClose={marks.close} /> : null}
    {marks.editing && marks.selection ? <ReadingMarkEditor initialNote={marks.selection.mark?.note ?? ''} onClose={marks.stopThought} onSave={(note) => marks.save(marks.selection?.mark?.color ?? 'orange', note, true)} /> : null}
    {previewActive && !controlsVisible && !marks.selection && !marks.editing ? <div className="reader-progress-choice"><button type="button" onClick={returnToReadingProgress}>返回阅读进度</button><span className="reader-progress-separator" aria-hidden="true" /><button type="button" aria-label="接受当前位置为最新阅读进度" title="将当前位置设为最新阅读进度" onClick={() => void acceptPreviewPosition()}><X aria-hidden="true" /></button></div> : null}
    <Sheet className="reader-marks-sheet" open={panel === 'marks'} onOpenChange={(open) => setPanel(open ? 'marks' : null)} title="书签与笔记"><div className="notes-status-tabs" role="tablist" aria-label="书签与笔记"><button type="button" role="tab" aria-selected={markTab === 'bookmarks'} onClick={() => setMarkTab('bookmarks')}>书签</button><button type="button" role="tab" aria-selected={markTab === 'annotations'} onClick={() => setMarkTab('annotations')}>笔记</button></div>{panel === 'marks' ? <ReadingMarksList kind={markTab} bookId={bookId} readerSheet currentProgressTitle={position?.title ?? content.chapter.title ?? '正文'} onCurrentProgress={openCurrentProgress} currentEditionKey={editionKey} onNavigate={navigateToMark} /> : null}</Sheet>
    <Sheet open={panel === 'toc'} onOpenChange={(open) => setPanel(open ? 'toc' : null)} title="章节目录"><ReaderTocPanel open={panel === 'toc'} bookId={bookId} editionKey={editionKey} chapters={siblings} currentChapterId={chapterId} onNavigate={() => setPanel(null)} /></Sheet>
    <Sheet open={panel === 'settings'} onOpenChange={(open) => setPanel(open ? 'settings' : null)} title="阅读设置"><ReaderSettingsPanel open={panel === 'settings'} /></Sheet>
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
  return <div className="reader-toc-panel"><div className="reader-toc-actions"><Link className="button secondary reader-toc-directory" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`} state={readerReturnState(location)} onClick={onNavigate}>展开</Link><div className="reader-toc-utility-actions"><Button variant="secondary" size="sm" type="button" onClick={() => setReversed((value) => !value)}>{reversed ? '正序' : '倒序'}</Button><Button variant="secondary" size="sm" type="button" onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>到顶部</Button><Button variant="secondary" size="sm" type="button" onClick={() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })}>到底部</Button><Button variant="secondary" size="sm" type="button" aria-label="刷新目录数据" disabled={refreshing} onClick={() => void refreshDirectory()}>{refreshing ? '刷新中…' : '刷新'}</Button></div></div>{refreshError.length > 0 ? <DismissibleMessage onDismiss={() => setRefreshError('')} className="error reader-toc-error" role="alert">{refreshError}<button className="text-button" type="button" disabled={refreshing} onClick={() => void refreshDirectory()}>重试</button></DismissibleMessage> : null}<div className="reader-toc-list" ref={listRef}>{orderedChapters.map((chapter) => <Link className={`reader-toc-row ${chapter.chapterId === currentChapterId ? 'current' : ''}`} aria-current={chapter.chapterId === currentChapterId ? 'location' : undefined} key={chapter.chapterId} to={chapterLink(bookId, chapter, editionKey)} replace state={location.state} onClick={onNavigate}><span className="toc-index">{chapter.index + 1}</span><span>{chapter.title}</span>{chapter.chapterId === currentChapterId ? <span className="toc-check" aria-label="当前阅读章节">✓</span> : null}</Link>)}</div></div>
}

export function ReaderEntryPage() {
  const { bookId = '' } = useParams()
  const cache = useBookCache()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedEditionKey = searchParams.get('editionKey') ?? ''
  const [error, setError] = useState('')
  const [retryNonce, setRetryNonce] = useState(0)

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
  }, [bookId, navigate, requestedEditionKey, cache, location.state, retryNonce])

  if (error.length > 0) return <section className="reader-error loading-state loading-state-viewport"><p className="error" role="alert">{error}</p><div className="loading-state-action"><PageBackButton appearance="button" /><Button variant="secondary" size="sm" type="button" onClick={() => setRetryNonce((value) => value + 1)}>重试</Button></div></section>
  return <LoadingState message="正在打开阅读…" variant="viewport" action={<PageBackButton appearance="button" />} />
}

function chapterLink(bookId: string, chapter: ApiChapter, editionKey: string): string { return `/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}` }

function readerReturnState(location: { key?: string; pathname: string; search: string; state: unknown }) {
  const base = pageReturnState(location)
  const state = location.state !== null && typeof location.state === 'object' ? location.state as Record<string, unknown> : {}
  return { ...base, ...(state.readingPreview === undefined ? {} : { readingPreview: state.readingPreview }), ...(state.readingRestorePoint === undefined ? {} : { readingRestorePoint: state.readingRestorePoint }), ...(state.readingRestoreChapterId === undefined ? {} : { readingRestoreChapterId: state.readingRestoreChapterId }) }
}

function scrollReaderPoint(root: HTMLElement, point: ReaderAnchor) {
  const paragraph = root.querySelector<HTMLElement>(`[data-paragraph="${point.paragraphIndex}"]`)
  if (!paragraph) return
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  let node: Node | null; let remaining = point.offset
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) {
      const range = document.createRange(); const start = Math.min(remaining, Math.max(0, length - 1)); range.setStart(node, start); range.setEnd(node, Math.min(length, start + 1))
      const rect = range.getBoundingClientRect()
      if (rect.height > 0) { window.scrollTo({ top: window.scrollY + rect.top - 80, behavior: 'auto' }); return }
    }
    remaining -= length
  }
  window.scrollTo({ top: window.scrollY + paragraph.getBoundingClientRect().top - 80, behavior: 'auto' })
}
