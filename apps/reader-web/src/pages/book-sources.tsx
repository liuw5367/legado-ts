import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { BookSourceItem, BookSourcesResponse } from '../../shared/book-sources.ts'
import { PageBackButton } from '../components/page-back-button.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { apiFetch, type ApiBook, type ApiEdition } from '../lib/api.ts'
import { pageReturnState } from '../lib/page-navigation.ts'

export function BookSourcesPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [book, setBook] = useState<ApiBook | null>(null)
  const [data, setData] = useState<BookSourcesResponse | null>(null)
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller
    setBook(null); setData(null); setError(''); setOpening(null)
    void Promise.all([
      apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books', { signal: controller.signal }),
      apiFetch<BookSourcesResponse>(`/api/books/${encodeURIComponent(bookId)}/sources`, { signal: controller.signal }),
    ]).then(([booksResult, sourcesResult]) => {
      if (controller.signal.aborted) return
      const found = booksResult.books.find((item) => item.book.id === bookId)?.book
      if (found === undefined) throw new Error('书籍不存在')
      setBook(found); setData(sourcesResult); setKeyword(found.name)
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '书源加载失败') })
    return () => controller.abort()
  }, [bookId, retry])

  async function openCandidate(source: BookSourceItem) {
    if (source.status !== 'discovered' || opening !== null) return
    const signal = controllerRef.current?.signal
    setOpening(source.candidateId); setError('')
    try {
      const result = await apiFetch<{ edition: ApiEdition }>(`/api/books/${encodeURIComponent(bookId)}/sources/${encodeURIComponent(source.candidateId)}/open`, { method: 'POST', ...(signal === undefined ? {} : { signal }) })
      if (signal?.aborted) return
      navigate(`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(result.edition.editionKey)}`, { state: pageReturnState(location) })
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '来源详情加载失败') }
    finally { if (!signal?.aborted) setOpening(null) }
  }

  const fallback = `/books/${encodeURIComponent(bookId)}/toc${book?.activeEditionKey === undefined ? '' : `?editionKey=${encodeURIComponent(book.activeEditionKey)}`}`
  return <section className="page-stack page-narrow book-sources-page">
    <div className="toc-heading"><PageBackButton fallback={fallback} /><div className="toc-heading-main"><h1>切换书源</h1><p className="muted">{book?.name ?? '书籍来源'}</p></div></div>
    {error.length > 0 ? <p className="error" role="alert">{error}{data === null ? <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>重试</Button> : null}</p> : null}
    {data === null ? error.length === 0 ? <p className="muted">正在读取可用书源…</p> : null : <>
      <section className="book-source-search"><p className="muted small">查看目录后，点击章节才会切换来源。</p><div className="search-row"><Input aria-label="搜索可用书源" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名" /><Button type="button" onClick={() => navigate(`/search?q=${encodeURIComponent(keyword.trim() || book?.name || '')}&bookId=${encodeURIComponent(bookId)}`, { state: pageReturnState(location) })}>再次搜索</Button></div></section>
      <div className="book-source-list">{data.sources.length === 0 ? <div className="empty-state">还没有可用书源，请再次搜索。</div> : data.sources.map((source) => {
        const current = source.status === 'saved' && source.editionKey === data.activeEditionKey
        return <article className={`book-source-row ${current ? 'current' : ''}`} key={source.status === 'saved' ? source.editionKey : source.candidateId}><div><strong>{source.name}</strong><p className="muted small">{source.bookUrl}</p></div><div className="actions"><span className="muted small">{current ? '当前使用' : source.status === 'saved' ? '已保存' : '已发现'}</span>{source.status === 'saved' ? <Link className="button secondary small" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(source.editionKey)}`} state={pageReturnState(location)}>查看目录</Link> : <Button variant="secondary" size="sm" disabled={opening !== null} onClick={() => void openCandidate(source)}>{opening === source.candidateId ? '加载中…' : '查看目录'}</Button>}</div></article>
      })}</div>
    </>}
  </section>
}
