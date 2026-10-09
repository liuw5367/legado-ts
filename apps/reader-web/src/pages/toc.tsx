import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch, type ApiBook, type ApiChapter, type ApiToc } from '../lib/api.ts'

export function TocPage() {
  const { bookId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [book, setBook] = useState<ApiBook | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '目录加载失败')) }, [bookId, editionKey])
  async function load() { const result = await apiFetch<{ toc: ApiToc }>(`/api/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`); setToc(result.toc); const allBooks = await apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books'); setBook(allBooks.books.map((item) => item.book).find((item) => item.id === bookId) ?? null) }
  if (error.length > 0) return <section className="card"><p className="error">{error}</p><Link className="link" to="/">返回书架</Link></section>
  if (toc === null) return <section className="card"><p className="muted">正在读取目录…</p></section>
  const chapters = toc.chapters.filter((chapter) => chapter.isVolume !== true)
  return <section className="page-stack toc-page"><div className="page-heading"><div><p className="eyebrow">TABLE OF CONTENTS</p><h1>{book?.name ?? '书籍目录'}</h1><p className="muted">共 {chapters.length} 章 · 版本 {editionKey.slice(0, 8)}</p></div><div className="actions"><Link className="button secondary" to="/">返回书架</Link><button className="button secondary" type="button" onClick={() => void load()}>刷新目录</button></div></div><div className="toc-list">{chapters.length === 0 ? <div className="empty-state">目录为空。</div> : chapters.map((chapter: ApiChapter) => <Link className="toc-row" key={chapter.chapterId} to={`/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}`}><span className="toc-index">{chapter.index + 1}</span><span>{chapter.title}</span>{chapter.isVip === true ? <span className="toc-tag">VIP</span> : null}</Link>)}</div></section>
}
