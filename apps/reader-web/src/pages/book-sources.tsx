import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { apiFetch, type ApiBook, type ApiEdition, type ApiSource } from '../lib/api.ts'

export function BookSourcesPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const [book, setBook] = useState<ApiBook | null>(null)
  const [editions, setEditions] = useState<ApiEdition[]>([])
  const [sources, setSources] = useState<ApiSource[]>([])
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void Promise.all([
      apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books'),
      apiFetch<{ editions: ApiEdition[] }>(`/api/books/${encodeURIComponent(bookId)}/editions`),
      apiFetch<{ sources: ApiSource[] }>('/api/sources'),
    ]).then(([booksResult, editionsResult, sourcesResult]) => {
      if (!active) return
      const matchedBook = booksResult.books.map((item) => item.book).find((item) => item.id === bookId)
      if (matchedBook === undefined) throw new Error('书籍不存在')
      setBook(matchedBook)
      setEditions(editionsResult.editions)
      setSources(sourcesResult.sources)
      setKeyword(booksResult.books.find((item) => item.book.id === bookId)?.book.name ?? '')
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '书源加载失败') })
    return () => { active = false }
  }, [bookId])

  if (error.length > 0) return <section className="page-stack page-narrow"><p className="error" role="alert">{error}</p><Link className="link" to={`/books/${encodeURIComponent(bookId)}/toc`}>返回目录</Link></section>
  if (book === null) return <section className="page-stack page-narrow"><p className="muted">正在读取可用书源…</p></section>
  const sourceName = (sourceId: string) => sources.find((source) => source.sourceId === sourceId)?.name ?? sourceId
  return <section className="page-stack page-narrow book-sources-page">
    <div className="page-heading compact-heading"><div><h1>切换书源</h1><p className="muted">{book.name}{book.author === undefined ? '' : ` · ${book.author}`}</p></div><Link className="button secondary small" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(book.activeEditionKey ?? editions[0]?.editionKey ?? '')}`}>返回目录</Link></div>
    <section className="book-source-search"><p className="muted small">当前书源不会因为查看目录而改变，点击章节后才会生效。</p><div className="search-row"><Input aria-label="搜索可用书源" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名" /><Button type="button" onClick={() => navigate(`/search?q=${encodeURIComponent(keyword.trim() || book.name)}&bookId=${encodeURIComponent(bookId)}`)}>再次搜索</Button></div></section>
    <div className="book-source-list">{editions.length === 0 ? <div className="empty-state">还没有可用书源，请再次搜索。</div> : editions.map((edition) => <article className={`book-source-row ${edition.editionKey === book.activeEditionKey ? 'current' : ''}`} key={edition.editionKey}><div><strong>{sourceName(edition.sourceId)}</strong><p className="muted small">{edition.bookUrl}</p></div><div className="actions"><span className="muted small">{edition.editionKey === book.activeEditionKey ? '当前使用' : '已保存'}</span><Link className="button secondary small" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(edition.editionKey)}`}>查看目录</Link></div></article>)}</div>
  </section>
}
