import { PageBackButton } from '../components/page-back-button.tsx'
import { pageReturnState } from '../lib/page-navigation.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { apiFetch, type ApiBook, type ApiChapter, type ApiEdition, type ApiPosition, type ApiSource, type ApiToc } from '../lib/api.ts'
import { isCurrentToc } from '../lib/reader-interactions.ts'

export function TocPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const controlsRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [book, setBook] = useState<ApiBook | null>(null)
  const [editions, setEditions] = useState<ApiEdition[]>([])
  const [sources, setSources] = useState<ApiSource[]>([])
  const [position, setPosition] = useState<ApiPosition | null>(null)
  const [filter, setFilter] = useState('')
  const [reversed, setReversed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setReversed(false)
    const requestId = ++requestIdRef.current
    void load(false, requestId)
    return () => { requestIdRef.current += 1 }
  }, [bookId, editionKey])

  async function load(refresh: boolean, requestId = requestIdRef.current) {
    if (refresh) setRefreshing(true); else setLoading(true)
    setError('')
    try {
      const suffix = refresh ? '&refresh=true' : ''
      const [result, allBooks, editionResult, positionResult, sourceResult] = await Promise.all([
        apiFetch<{ toc: ApiToc }>(`/api/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}${suffix}`),
        apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books'),
        apiFetch<{ editions: ApiEdition[] }>(`/api/books/${encodeURIComponent(bookId)}/editions`),
        apiFetch<{ position: ApiPosition | null }>(`/api/books/${encodeURIComponent(bookId)}/position?editionKey=${encodeURIComponent(editionKey)}`),
        apiFetch<{ sources: ApiSource[] }>('/api/sources').catch(() => ({ sources: [] })),
      ])
      if (requestId !== requestIdRef.current) return
      setToc(result.toc); setBook(allBooks.books.map((item) => item.book).find((item) => item.id === bookId) ?? null); setEditions(editionResult.editions); setSources(sourceResult.sources); setPosition(positionResult.position)
    } catch (reason) { if (requestId === requestIdRef.current) setError(reason instanceof Error ? reason.message : '目录加载失败') }
    finally { if (requestId === requestIdRef.current) { setLoading(false); setRefreshing(false) } }
  }

  async function switchEdition(nextEditionKey: string) {
    if (nextEditionKey.length === 0 || nextEditionKey === editionKey) return
    navigate(`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(nextEditionKey)}`, { replace: true, state: location.state })
  }

  const currentToc = isCurrentToc(toc, bookId, editionKey) ? toc : null
  const chapters = currentToc?.chapters.filter((chapter) => chapter.isVolume !== true) ?? []
  const currentChapter = position === null ? undefined : chapters.find((chapter) => chapter.chapterId === position.chapterId)
  const sourceName = editions.find((edition) => edition.editionKey === editionKey)?.sourceId
  const displaySource = sources.find((source) => source.sourceId === sourceName)?.name ?? sourceName ?? '当前来源'
  const filteredEntries = useMemo(() => filterEntries(currentToc?.chapters ?? [], filter), [filter, currentToc])
  const orderedEntries = useMemo(() => reversed ? reverseEntries(filteredEntries) : filteredEntries, [filteredEntries, reversed])
  useEffect(() => {
    if (position?.chapterId === undefined) return
    const frame = window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-chapter-id="${CSS.escape(position.chapterId)}"]`)?.scrollIntoView({ block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [position?.chapterId, orderedEntries])
  useEffect(() => {
    const controls = controlsRef.current
    if (controls === null) return
    const header = document.querySelector<HTMLElement>('.app-header')
    const measure = () => {
      const headerHeight = header?.getBoundingClientRect().height ?? 0
      controls.style.top = `${headerHeight}px`
      controls.parentElement?.style.setProperty('--toc-scroll-offset', `${controls.getBoundingClientRect().height + headerHeight + 8}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(controls); if (header !== null) observer.observe(header)
    measure()
    return () => observer.disconnect()
  }, [currentToc !== null])
  const continueTarget = currentChapter === undefined ? chapters[0] : currentChapter

  if (loading && currentToc === null) return <section className="page-stack page-narrow"><PageBackButton /><div className="loading-state"><p className="muted">正在读取目录…</p></div></section>
  if (currentToc === null) return <section className="page-stack page-narrow"><div className="error-state"><p className="error">{error || '目录加载失败'}</p><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={() => void load(false)}>重试</Button><PageBackButton /></div></div></section>
  return <section className="page-stack page-narrow toc-page">
    <div className="toc-controls" ref={controlsRef}><div className="toc-heading"><PageBackButton /><div className="toc-heading-main"><h1>{book?.name ?? '书籍目录'}</h1><p className="muted">{chapters.length} 章 · {displaySource}</p></div>{continueTarget === undefined ? null : <Link className="button small" to={chapterLink(bookId, continueTarget, editionKey)} state={pageReturnState(location)}>{currentChapter === undefined ? '开始阅读' : '继续阅读'}</Link>}</div>
    <div className="toc-toolbar">{editions.length > 1 ? <label className="toc-source"><span className="sr-only">阅读来源</span><Select value={editionKey} onChange={(event) => void switchEdition(event.target.value)}>{editions.map((edition) => <option key={edition.editionKey} value={edition.editionKey}>{sources.find((source) => source.sourceId === edition.sourceId)?.name ?? edition.sourceId}</option>)}</Select></label> : <span className="muted small">{displaySource}</span>}<div className="toc-actions"><Button variant="secondary" size="sm" type="button" onClick={() => setReversed((value) => !value)}>{reversed ? '正序' : '倒序'}</Button><Button variant="secondary" size="sm" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>到顶部</Button><Button variant="secondary" size="sm" type="button" onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })}>到底部</Button><Button className="refresh-button" variant="secondary" size="sm" type="button" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? '刷新中' : '刷新'}</Button></div></div>
    {error.length > 0 ? <p className="error compact-message" role="alert">{error}</p> : null}
    <div className="toc-filter-row"><label className="sr-only" htmlFor="chapter-filter">筛选章节</label><Input id="chapter-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选章节" /><span className="muted small">{filter.length > 0 ? `${chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).length} 个匹配` : `共 ${chapters.length} 章`}</span></div>
    </div>
    <div className="toc-list" ref={listRef}>{orderedEntries.length === 0 ? <div className="empty-state">没有匹配的章节。</div> : orderedEntries.map((chapter) => chapter.isVolume === true ? <div className="toc-volume" key={`volume:${chapter.index}:${chapter.title}`}>{chapter.title}</div> : <Link className={`toc-row ${chapter.chapterId === position?.chapterId ? 'current' : ''}`} data-chapter-id={chapter.chapterId} aria-current={chapter.chapterId === position?.chapterId ? 'location' : undefined} key={chapter.chapterId} to={chapterLink(bookId, chapter, editionKey)} state={pageReturnState(location)}><span className="toc-index">{chapter.index + 1}</span><span className="toc-title">{chapter.title}</span>{chapter.chapterId === position?.chapterId ? <span className="toc-current" aria-label="当前阅读章节">✓</span> : chapter.isVip === true ? <Badge>VIP</Badge> : null}</Link>)}</div>
  </section>
}

function filterEntries(entries: ApiChapter[], filter: string): ApiChapter[] {
  const normalized = filter.trim().toLocaleLowerCase()
  if (normalized.length === 0) return entries
  const filtered: ApiChapter[] = []
  let volume: ApiChapter | undefined
  let volumeHasMatch = false
  for (const entry of entries) {
    if (entry.isVolume === true) { volume = entry; volumeHasMatch = false; continue }
    if (!entry.title.toLocaleLowerCase().includes(normalized)) continue
    if (volume !== undefined && !volumeHasMatch) { filtered.push(volume); volumeHasMatch = true }
    filtered.push(entry)
  }
  return filtered
}

function reverseEntries(entries: ApiChapter[]): ApiChapter[] {
  const groups: ApiChapter[][] = []
  let current: ApiChapter[] = []
  for (const entry of entries) {
    if (entry.isVolume === true && current.length > 0) { groups.push(current); current = [] }
    current.push(entry)
  }
  if (current.length > 0) groups.push(current)
  return groups.reverse().flatMap((group) => {
    const volume = group.find((entry) => entry.isVolume === true)
    const chapters = group.filter((entry) => entry.isVolume !== true).reverse()
    return volume === undefined ? chapters : [volume, ...chapters]
  })
}

function chapterLink(bookId: string, chapter: ApiChapter, editionKey: string): string { return `/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}` }
