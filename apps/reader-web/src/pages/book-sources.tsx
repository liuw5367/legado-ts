import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { normalizeIdentity, sameBookIdentity } from '../../shared/book-identity.ts'
import type { BookDetailsResponse } from '../../shared/book-details.ts'
import type { BookSourceItem, BookSourcesResponse } from '../../shared/book-sources.ts'
import { PageBackButton } from '../components/page-back-button.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { apiFetch, type ApiEdition, type ApiPosition } from '../lib/api.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { pageReturnState, readingEntryState } from '../lib/page-navigation.ts'
import { useBookSearch } from '../lib/use-book-search.ts'

export function BookSourcesPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const cache = useBookCache()
  const [book, setBook] = useState<BookDetailsResponse['book'] | null>(null)
  const [data, setData] = useState<BookSourcesResponse | null>(null)
  const [keyword, setKeyword] = useState('')
  const [precision, setPrecision] = useState(true)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const { candidates, searchId, status, message, search, cancel } = useBookSearch()
  const prefix = '/books/' + encodeURIComponent(bookId)

  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller
    setBook(null); setData(null); setError(''); setOpening(null)
    void Promise.all([
      apiFetch<BookDetailsResponse>('/api' + prefix + '/details', { signal: controller.signal }),
      apiFetch<BookSourcesResponse>('/api' + prefix + '/sources', { signal: controller.signal }),
    ]).then(([details, sources]) => {
      if (controller.signal.aborted) return
      setBook(details.book); setData(sources); setKeyword(details.book.name)
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '书源加载失败') })
    return () => controller.abort()
  }, [prefix, retry])

  async function open(key: string, action: 'directory' | 'switch', resolveEdition: () => Promise<string>) {
    if (opening !== null) return
    const signal = controllerRef.current?.signal
    setOpening(key); setError('')
    try {
      const editionKey = await resolveEdition()
      if (signal?.aborted) return
      const query = '?editionKey=' + encodeURIComponent(editionKey)
      if (action === 'directory') {
        navigate(prefix + '/toc' + query, { state: pageReturnState(location) })
        return
      }
      const [snapshot, position] = await Promise.all([
        loadBookSnapshot(cache, bookId, editionKey),
        apiFetch<{ position: ApiPosition | null }>('/api' + prefix + '/position' + query, signal === undefined ? {} : { signal }),
      ])
      if (signal?.aborted) return
      const chapters = snapshot.toc.chapters.filter((chapter) => chapter.isVolume !== true)
      const target = chapters.find((chapter) => chapter.chapterId === position.position?.chapterId) ?? chapters[0]
      if (target === undefined) throw new Error('目录中没有可阅读的章节')
      cache.setPosition(bookId, editionKey, position.position)
      navigate(prefix + '/read/' + encodeURIComponent(target.chapterId) + query, { state: readingEntryState(location) })
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '来源加载失败') }
    finally { if (!signal?.aborted) setOpening(null) }
  }

  function openSource(source: BookSourceItem, action: 'directory' | 'switch') {
    const key = source.status === 'saved' ? source.editionKey : source.candidateId
    void open(key, action, async () => source.status === 'saved' ? source.editionKey : (await apiFetch<{ edition: ApiEdition }>('/api' + prefix + '/sources/' + encodeURIComponent(source.candidateId) + '/open', { method: 'POST', signal: controllerRef.current?.signal ?? null })).edition.editionKey)
  }
  function openSearchCandidate(index: number, action: 'directory' | 'switch') {
    void open('search:' + index, action, async () => (await apiFetch<{ edition: ApiEdition }>('/api/books', { method: 'POST', signal: controllerRef.current?.signal ?? null, body: JSON.stringify({ searchId, candidateIndex: index, bookId, addToBookshelf: false, activateEdition: false }) })).edition.editionKey)
  }

  const known = new Set(data?.sources.map((source) => JSON.stringify([source.sourceId, source.sourceFingerprint, source.bookUrl])) ?? [])
  const results = candidates.flatMap((item, index) => {
    if (book === null) return []
    const matches = book.author?.trim().length && book.author !== '作者未知'
      ? sameBookIdentity(book.name, book.author, item.candidate.name, item.candidate.author)
      : normalizeIdentity(book.name) === normalizeIdentity(item.candidate.name ?? '')
    const key = JSON.stringify([item.sourceId, item.sourceFingerprint, item.candidate.bookUrl])
    if (!matches || known.has(key)) return []
    known.add(key)
    return [{ item, index }]
  })
  const fallback = prefix + '/toc' + (book?.activeEditionKey ? '?editionKey=' + encodeURIComponent(book.activeEditionKey) : '')
  return <section className="page-stack page-narrow book-sources-page">
    <div className="toc-heading"><PageBackButton fallback={fallback} /><div className="toc-heading-main"><h1>切换书源</h1><p className="muted">{book?.name ?? '书籍来源'}</p></div></div>
    {error.length > 0 ? <p className="error" role="alert">{error}<Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>重试列表</Button></p> : null}
    {data === null ? error.length === 0 ? <p className="muted">正在读取可用书源…</p> : null : <>
      <form className="book-source-search" onSubmit={(event) => { event.preventDefault(); void search(keyword, precision) }}><div className="search-row"><Input aria-label="搜索可用书源" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名" /><label className="check-inline"><input type="checkbox" checked={precision} disabled={status === 'loading'} onChange={(event) => setPrecision(event.target.checked)} /><span>精确</span></label><Button type={status === 'loading' ? 'button' : 'submit'} disabled={status !== 'loading' && keyword.trim().length === 0} onClick={status === 'loading' ? () => void cancel() : undefined}>{status === 'loading' ? '取消' : '搜索'}</Button></div><p className="muted small">查看目录只预览；切换恢复该书源进度，无记录从首章开始。</p></form>
      {message.length > 0 ? <p className="muted small" role="status">{message}</p> : null}
      <div className="book-source-list">{data.sources.length === 0 && results.length === 0 ? <div className="empty-state">{status === 'loading' ? '正在搜索…' : '没有可用书源，请搜索。'}</div> : null}{data.sources.map((source) => {
        const current = source.status === 'saved' && source.editionKey === data.activeEditionKey
        const key = source.status === 'saved' ? source.editionKey : source.candidateId
        return <article className={'book-source-row' + (current ? ' current' : '')} key={key}><div className="book-source-info"><strong>{source.name}</strong><p className="muted small" title={source.bookUrl}>{source.bookUrl}</p><span className="muted small">{current ? '当前使用' : source.status === 'saved' ? '已保存' : '已发现'}</span></div><div className="book-source-actions"><Button variant="secondary" size="sm" disabled={opening !== null} onClick={() => openSource(source, 'directory')}>查看目录</Button><Button size="sm" disabled={current || opening !== null} onClick={() => openSource(source, 'switch')}>{opening === key ? '加载中…' : current ? '当前使用' : '切换书源'}</Button></div></article>
      })}{results.map(({ item, index }) => <article className="book-source-row" key={'search:' + index}><div className="book-source-info"><strong>{item.sourceId}</strong><p className="muted small" title={item.candidate.bookUrl}>{item.candidate.bookUrl}</p><span className="muted small">本次搜索</span></div><div className="book-source-actions"><Button variant="secondary" size="sm" disabled={opening !== null} onClick={() => openSearchCandidate(index, 'directory')}>查看目录</Button><Button size="sm" disabled={opening !== null} onClick={() => openSearchCandidate(index, 'switch')}>{opening === 'search:' + index ? '加载中…' : '切换书源'}</Button></div></article>)}</div>
    </>}
    <Link className="sr-only" to={fallback}>本书目录</Link>
  </section>
}
