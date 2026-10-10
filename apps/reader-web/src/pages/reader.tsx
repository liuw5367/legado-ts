import { ChevronLeft } from 'lucide-react'
import { ReaderMoreMenu } from '../components/reader-more-menu.tsx'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { PageBackButton } from '../components/page-back-button.tsx'
import { ReaderIcon } from '../components/reader-icon.tsx'
import { chapterCharacterCount, isReaderTap } from '../lib/reader-interactions.ts'
import { pageReturnState, pageReturnTarget } from '../lib/page-navigation.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { apiFetch, type ApiChapter, type ApiContent, type ApiPosition, type ApiToc } from '../lib/api.ts'
import { useReaderSettings } from '../lib/settings-context.tsx'

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
  const refreshController = useRef<AbortController | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const latestPositionRef = useRef<ApiPosition | null>(null)
  const requestIdRef = useRef(0)
  const liveToc = cache.get(bookId, editionKey)?.toc ?? toc

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setControlsVisible(false); restoredPositionRef.current = false; setPanel(null); setContent(null); setToc(null); setPosition(null); setPositionLoaded(false); setError(''); setPositionError(''); setRefreshing(false); setRefreshError('')
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
      setContent(contentResult.content.content); setToc(tocResult.toc); setPosition(positionResult.position); setPositionLoaded(true); cache.setPosition(bookId, editionKey, positionResult.position); window.scrollTo({ top: 0, behavior: 'auto' })
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
    setPositionError('')
    try {
      const result = await apiFetch<{ position: ApiPosition }>(`/api/books/${encodeURIComponent(bookId)}/position`, { method: 'POST', body: JSON.stringify({ editionKey, chapterId, chapterUrl: content.chapter.chapterUrl, chapterIndex: content.chapter.index, title: content.chapter.title ?? `第 ${content.chapter.index + 1} 章`, tocRevision: liveToc?.revision, paragraphIndex: input.paragraphIndex, offset: input.offset, version: input.version }) })
      if (requestId !== requestIdRef.current) return
      latestPositionRef.current = result.position; setPosition(result.position); cache.setPosition(bookId, editionKey, result.position)
    } catch (reason) { if (requestId === requestIdRef.current) setPositionError(reason instanceof Error ? reason.message : '阅读位置保存失败') }
  }

  useEffect(() => { latestPositionRef.current = position }, [position])
  useEffect(() => {
    if (content === null || content.chapter.chapterId !== chapterId || !positionLoaded || position?.chapterId === chapterId) return
    void persistPosition({ paragraphIndex: 0, offset: 0, version: (position?.version ?? -1) + 1 })
  }, [bookId, chapterId, editionKey, content, positionLoaded, position?.chapterId, position?.version, liveToc?.revision])
  useEffect(() => {
    if (content === null || content.chapter.chapterId !== chapterId || !positionLoaded) return
    let timer: number | undefined
    const persist = () => {
      if (articleRef.current === null) return
      const paragraphs = [...articleRef.current.querySelectorAll<HTMLElement>('[data-paragraph]')]
      const toolbarHeight = 0
      const firstVisible = paragraphs.find((paragraph) => paragraph.getBoundingClientRect().bottom > toolbarHeight + 16)
      const paragraphIndex = firstVisible === undefined ? 0 : Number(firstVisible.dataset.paragraph ?? 0)
      const current = latestPositionRef.current
      if (current?.chapterId === chapterId && current.paragraphIndex === paragraphIndex) return
      const offset = current?.chapterId === chapterId ? current.offset : 0
      void persistPosition({ paragraphIndex, offset, version: (current?.version ?? -1) + 1 })
    }
    const onScroll = () => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => { timer = undefined; persist() }, 500) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); if (timer !== undefined) window.clearTimeout(timer) }
  }, [bookId, chapterId, editionKey, content, positionLoaded, liveToc?.revision])
  useEffect(() => {
    if (content === null || position?.chapterId !== chapterId || articleRef.current === null || restoredPositionRef.current) return
    const paragraph = articleRef.current.querySelector<HTMLElement>(`[data-paragraph="${position.paragraphIndex}"]`)
    if (paragraph === null) return
    restoredPositionRef.current = true
    const toolbarHeight = 0
    window.scrollTo({ top: window.scrollY + paragraph.getBoundingClientRect().top - toolbarHeight - 12, behavior: 'auto' })
  }, [chapterId, content, position?.chapterId, position?.paragraphIndex, settings.fontSize, settings.lineHeight])

  const paragraphs = useMemo(() => content?.cleaned.split(/\n+/u).map((text) => text.trim()).filter(Boolean) ?? [], [content])
  const siblings = liveToc?.chapters.filter((chapter) => chapter.isVolume !== true) ?? []
  const currentIndex = siblings.findIndex((chapter) => chapter.chapterId === chapterId)
  const previous = currentIndex > 0 ? siblings[currentIndex - 1] : undefined
  const next = currentIndex >= 0 ? siblings[currentIndex + 1] : undefined
  async function refreshChapter() {
    if (refreshing || content === null) return
    const requestId = requestIdRef.current
    const controller = new AbortController(); refreshController.current = controller
    const nodes = [...articleRef.current?.querySelectorAll<HTMLElement>('[data-paragraph]') ?? []]
    const visible = nodes.find((node) => node.getBoundingClientRect().bottom > 16)
    const paragraphIndex = Number(visible?.dataset.paragraph ?? 0)
    const top = visible?.getBoundingClientRect().top ?? 0
    setRefreshing(true); setRefreshError('')
    try {
      const result = await apiFetch<{ content: { content: ApiContent; tocRevision: string } }>('/api/books/' + encodeURIComponent(bookId) + '/chapters/' + encodeURIComponent(chapterId) + '?editionKey=' + encodeURIComponent(editionKey) + '&refresh=true', { signal: controller.signal })
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      if (result.content.tocRevision !== cache.get(bookId, editionKey)?.toc.revision) await loadBookSnapshot(cache, bookId, editionKey, true)
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      setContent(result.content.content)
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
  async function toggleTheme(target: 'light' | 'dark' = dark ? 'light' : 'dark') {
    setThemeRetry(null)
    try { await updateSettings({ theme: target }) } catch { setThemeRetry(target) }
  }
  return <section className="reader-page" onKeyDown={(event) => {
    if (event.key === 'Escape' && panel === null) { setControlsVisible(false); articleRef.current?.focus({ preventScroll: true }) }
  }}>
    <header className="reader-topbar" hidden={!controlsVisible}><Link className="reader-back" to={returnTarget.to} state={returnTarget.state} replace aria-label="返回上一页"><ChevronLeft aria-hidden="true" /><span>返回</span></Link><div className="reader-title"><strong title={content.chapter.title ?? ''}>{content.chapter.title ?? '正文'}</strong></div><div className="reader-tools"><Link className="reader-tool-button" to={'/books/' + encodeURIComponent(bookId) + '/details?editionKey=' + encodeURIComponent(editionKey)} state={pageReturnState(location)}>详情</Link><ReaderMoreMenu url={content.chapter.chapterUrl} refreshing={refreshing} onRefresh={() => void refreshChapter()} /></div></header>
    <article className="reader-content" ref={articleRef} tabIndex={0} aria-label="正文，按回车显示或隐藏阅读操作" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}
      onPointerDown={(event) => { articleRef.current?.focus({ preventScroll: true }); pointerStartRef.current = { x: event.clientX, y: event.clientY, scrollY: window.scrollY } }}
      onPointerCancel={() => { pointerStartRef.current = null }}
      onClick={(event) => {
        const tap = isReaderTap(pointerStartRef.current, { x: event.clientX, y: event.clientY, scrollY: window.scrollY }, window.getSelection()?.toString() ?? '')
        pointerStartRef.current = null
        if (tap) setControlsVisible((value) => !value)
      }}
      onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); setControlsVisible((value) => !value) } }}>
      {paragraphs.length === 0 ? <p className="muted">本章暂无正文。</p> : paragraphs.map((paragraph, index) => <p data-paragraph={index} key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>)}
    </article>
    {refreshError.length > 0 ? <p className="error reader-position-error" role="alert">{refreshError}<button className="text-button" disabled={refreshing} onClick={() => void refreshChapter()}>重试刷新</button></p> : null}
    {positionError.length > 0 ? <p className="error reader-position-error" role="alert">{positionError}<button className="text-button" type="button" onClick={() => void persistPosition({ paragraphIndex: latestPositionRef.current?.paragraphIndex ?? 0, offset: latestPositionRef.current?.offset ?? 0, version: (latestPositionRef.current?.version ?? -1) + 1 })}>重试</button></p> : null}
    <div className="reader-bottom-bar" hidden={!controlsVisible}>
      <nav className="reader-chapter-nav" aria-label="章节导航"><button className="reader-nav-button" type="button" disabled={previous === undefined} onClick={() => { if (previous !== undefined) navigate(chapterLink(bookId, previous, editionKey), { replace: true, state: location.state }) }}>上一章</button><span className="reader-word-count" aria-label="章节字数">{chapterCharacterCount(content.cleaned).toLocaleString('zh-CN')} 字</span><button className="reader-nav-button" type="button" disabled={next === undefined} onClick={() => { if (next !== undefined) navigate(chapterLink(bookId, next, editionKey), { replace: true, state: location.state }) }}>下一章</button></nav>
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
  const location = useLocation()
  const currentIndex = chapters.findIndex((chapter) => chapter.chapterId === currentChapterId)
  const [reversed, setReversed] = useState(false)
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
  const orderedChapters = reversed ? [...chapters].reverse() : chapters
  return <div className="reader-toc-panel"><div className="reader-toc-actions"><Link className="button secondary" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`} state={pageReturnState(location)} onClick={onNavigate}>打开完整目录</Link><Button variant="secondary" size="sm" type="button" onClick={() => setReversed((value) => !value)}>{reversed ? '正序' : '倒序'}</Button><Button variant="secondary" size="sm" type="button" onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>到顶部</Button><Button variant="secondary" size="sm" type="button" onClick={() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })}>到底部</Button></div><div className="reader-toc-list" ref={listRef}>{orderedChapters.map((chapter) => <Link className={`reader-toc-row ${chapter.chapterId === currentChapterId ? 'current' : ''}`} aria-current={chapter.chapterId === currentChapterId ? 'location' : undefined} key={chapter.chapterId} to={chapterLink(bookId, chapter, editionKey)} replace state={location.state} onClick={onNavigate}><span className="toc-index">{chapter.index + 1}</span><span>{chapter.title}</span>{chapter.chapterId === currentChapterId ? <span className="toc-check" aria-label="当前阅读章节">✓</span> : null}</Link>)}</div></div>
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
