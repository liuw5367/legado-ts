import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { apiFetch, type ApiChapter, type ApiContent, type ApiPosition, type ApiToc } from '../lib/api.ts'
import { useReaderSettings } from '../lib/settings-context.tsx'

type ReaderPanel = 'toc' | 'settings' | null

export function ReaderPage() {
  const { bookId = '', chapterId = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const { settings } = useReaderSettings()
  const [content, setContent] = useState<ApiContent | null>(null)
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [position, setPosition] = useState<ApiPosition | null>(null)
  const [positionLoaded, setPositionLoaded] = useState(false)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<ReaderPanel>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const articleRef = useRef<HTMLElement>(null)
  const latestPositionRef = useRef<ApiPosition | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setPanel(null); setContent(null); setToc(null); setPosition(null); setPositionLoaded(false); setError('')
    let active = true
    void Promise.all([
      apiFetch<{ content: { content: ApiContent } }>(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}?editionKey=${encodeURIComponent(editionKey)}`),
      apiFetch<{ toc: ApiToc }>(`/api/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`),
      apiFetch<{ position: ApiPosition | null }>(`/api/books/${encodeURIComponent(bookId)}/position?editionKey=${encodeURIComponent(editionKey)}`),
    ]).then(([contentResult, tocResult, positionResult]) => {
      if (!active || requestId !== requestIdRef.current) return
      setContent(contentResult.content.content); setToc(tocResult.toc); setPosition(positionResult.position); setPositionLoaded(true); window.scrollTo({ top: 0, behavior: 'auto' })
    }).catch((reason: unknown) => { if (active && requestId === requestIdRef.current) setError(reason instanceof Error ? reason.message : '正文加载失败') })
    return () => { active = false }
  }, [bookId, chapterId, editionKey, retryNonce])

  async function persistPosition(input: { paragraphIndex: number; offset: number; version: number }): Promise<void> {
    if (content === null || content.chapter.chapterId !== chapterId) return
    const requestId = requestIdRef.current
    try {
      const result = await apiFetch<{ position: ApiPosition }>(`/api/books/${encodeURIComponent(bookId)}/position`, { method: 'POST', body: JSON.stringify({ editionKey, chapterId, chapterUrl: content.chapter.chapterUrl, chapterIndex: content.chapter.index, title: content.chapter.title ?? `第 ${content.chapter.index + 1} 章`, tocRevision: toc?.revision, paragraphIndex: input.paragraphIndex, offset: input.offset, version: input.version }) })
      if (requestId !== requestIdRef.current) return
      latestPositionRef.current = result.position; setPosition(result.position)
    } catch { /* 阅读位置保存失败不应阻断阅读 */ }
  }

  useEffect(() => { latestPositionRef.current = position }, [position])
  useEffect(() => {
    if (content === null || content.chapter.chapterId !== chapterId || !positionLoaded || position?.chapterId === chapterId) return
    const timer = window.setTimeout(() => { void persistPosition({ paragraphIndex: 0, offset: 0, version: (position?.version ?? -1) + 1 }) }, 600)
    return () => window.clearTimeout(timer)
  }, [bookId, chapterId, editionKey, content, positionLoaded, position?.chapterId, position?.version, toc?.revision])
  useEffect(() => {
    if (content === null || content.chapter.chapterId !== chapterId || !positionLoaded) return
    let timer: number | undefined
    const persist = () => {
      if (articleRef.current === null) return
      const paragraphs = [...articleRef.current.querySelectorAll<HTMLElement>('[data-paragraph]')]
      const toolbarHeight = document.querySelector<HTMLElement>('.reader-topbar')?.getBoundingClientRect().height ?? 48
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
  }, [bookId, chapterId, editionKey, content, positionLoaded, toc?.revision])
  useEffect(() => {
    if (content === null || position?.chapterId !== chapterId || articleRef.current === null) return
    const paragraph = articleRef.current.querySelector<HTMLElement>(`[data-paragraph="${position.paragraphIndex}"]`)
    if (paragraph === null) return
    const toolbarHeight = document.querySelector<HTMLElement>('.reader-topbar')?.getBoundingClientRect().height ?? 48
    window.scrollTo({ top: window.scrollY + paragraph.getBoundingClientRect().top - toolbarHeight - 12, behavior: 'auto' })
  }, [chapterId, content, position?.chapterId, position?.paragraphIndex, settings.fontSize, settings.lineHeight])

  const paragraphs = useMemo(() => content?.cleaned.split(/\n+/u).map((text) => text.trim()).filter(Boolean) ?? [], [content])
  const siblings = toc?.chapters.filter((chapter) => chapter.isVolume !== true) ?? []
  const currentIndex = siblings.findIndex((chapter) => chapter.chapterId === chapterId)
  const previous = currentIndex > 0 ? siblings[currentIndex - 1] : undefined
  const next = currentIndex >= 0 ? siblings[currentIndex + 1] : undefined
  if (error.length > 0) return <section className="reader-error"><p className="error">{error}</p><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={() => setRetryNonce((value) => value + 1)}>重试</Button><Link className="link" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`}>返回目录</Link></div></section>
  if (content === null) return <section className="reader-loading"><p className="muted">正在读取正文…</p></section>
  return <section className="reader-page">
    <header className="reader-topbar"><Link className="reader-back" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`} aria-label="返回目录">‹ <span>目录</span></Link><div className="reader-title"><span className="muted">{content.chapter.index + 1}</span><strong title={content.chapter.title ?? ''}>{content.chapter.title ?? `第 ${content.chapter.index + 1} 章`}</strong></div><button className="reader-tool-button" type="button" aria-label="打开阅读设置" onClick={() => setPanel('settings')}>设置</button></header>
    <article className="reader-content" ref={articleRef} style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>{paragraphs.length === 0 ? <p className="muted">本章暂无正文。</p> : paragraphs.map((paragraph, index) => <p data-paragraph={index} key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</article>
    <nav className="reader-bottom-bar" aria-label="章节导航"><button className="reader-nav-button" type="button" disabled={previous === undefined} onClick={() => { if (previous !== undefined) navigate(chapterLink(bookId, previous, editionKey)) }}>上一章</button><button className="reader-nav-button reader-toc-button" type="button" onClick={() => setPanel('toc')}>目录 <span className="muted">{currentIndex < 0 ? '' : `${currentIndex + 1}/${siblings.length}`}</span></button><button className="reader-nav-button" type="button" disabled={next === undefined} onClick={() => { if (next !== undefined) navigate(chapterLink(bookId, next, editionKey)) }}>下一章</button></nav>
    <Sheet open={panel === 'toc'} onOpenChange={(open) => setPanel(open ? 'toc' : null)} title="章节目录"><ReaderTocPanel bookId={bookId} editionKey={editionKey} chapters={siblings} currentChapterId={chapterId} onNavigate={() => setPanel(null)} /></Sheet>
    <Sheet open={panel === 'settings'} onOpenChange={(open) => setPanel(open ? 'settings' : null)} title="阅读设置"><ReaderSettingsPanel /></Sheet>
  </section>
}

function ReaderTocPanel({ bookId, editionKey, chapters, currentChapterId, onNavigate }: { bookId: string; editionKey: string; chapters: ApiChapter[]; currentChapterId: string; onNavigate: () => void }) {
  const currentIndex = chapters.findIndex((chapter) => chapter.chapterId === currentChapterId)
  const [visibleLimit, setVisibleLimit] = useState(() => Math.max(200, Math.ceil((currentIndex + 1) / 200) * 200))
  useEffect(() => {
    if (currentIndex < 0) return
    setVisibleLimit((value) => Math.max(value, Math.ceil((currentIndex + 1) / 200) * 200))
  }, [currentIndex])
  const visibleChapters = chapters.slice(0, visibleLimit)
  return <div className="reader-toc-panel"><Link className="button secondary full-button" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`} onClick={onNavigate}>打开完整目录</Link><div className="reader-toc-list">{visibleChapters.map((chapter) => <Link className={`reader-toc-row ${chapter.chapterId === currentChapterId ? 'current' : ''}`} key={chapter.chapterId} to={chapterLink(bookId, chapter, editionKey)} onClick={onNavigate}><span className="toc-index">{chapter.index + 1}</span><span>{chapter.title}</span></Link>)}</div>{visibleChapters.length < chapters.length ? <Button className="load-more" variant="secondary" type="button" onClick={() => setVisibleLimit((value) => value + 200)}>显示更多章节</Button> : null}</div>
}

function chapterLink(bookId: string, chapter: ApiChapter, editionKey: string): string { return `/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}` }
