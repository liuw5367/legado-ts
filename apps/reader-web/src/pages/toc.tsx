import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch, type ApiBook, type ApiChapter, type ApiEdition, type ApiToc } from '../lib/api.ts'

export function TocPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [book, setBook] = useState<ApiBook | null>(null)
  const [editions, setEditions] = useState<ApiEdition[]>([])
  const [error, setError] = useState('')
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '目录加载失败')) }, [bookId, editionKey])
  async function load() { const [result, allBooks, editionResult] = await Promise.all([apiFetch<{ toc: ApiToc }>(`/api/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`), apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books'), apiFetch<{ editions: ApiEdition[] }>(`/api/books/${encodeURIComponent(bookId)}/editions`)]); setToc(result.toc); setBook(allBooks.books.map((item) => item.book).find((item) => item.id === bookId) ?? null); setEditions(editionResult.editions) }
  async function switchEdition(nextEditionKey: string) { if (nextEditionKey.length === 0 || nextEditionKey === editionKey) return; setError(''); try { await apiFetch(`/api/books/${encodeURIComponent(bookId)}/edition`, { method: 'PUT', body: JSON.stringify({ editionKey: nextEditionKey }) }); navigate(`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(nextEditionKey)}`) } catch (reason) { setError(reason instanceof Error ? reason.message : '来源切换失败') } }
  if (error.length > 0) return <section className="card"><p className="error">{error}</p><Link className="link" to="/">返回书架</Link></section>
  if (toc === null) return <section className="card"><p className="muted">正在读取目录…</p></section>
  const chapters = toc.chapters.filter((chapter) => chapter.isVolume !== true)
  return <section className="page-stack toc-page"><div className="page-heading"><div><p className="eyebrow">TABLE OF CONTENTS</p><h1>{book?.name ?? '书籍目录'}</h1><p className="muted">共 {chapters.length} 章 · 当前版本 {editionKey.slice(0, 8)}</p></div><div className="actions"><Link className="button secondary" to="/">返回书架</Link><button className="button secondary" type="button" onClick={() => void load()}>刷新目录</button></div></div>{editions.length > 1 ? <section className="source-panel card"><div><h2>阅读来源</h2><p className="muted small">每个来源保留自己的目录和阅读位置。</p></div><label className="field"><span className="sr-only">选择来源</span><select value={editionKey} onChange={(event) => void switchEdition(event.target.value)}><option value="" disabled>选择来源</option>{editions.map((edition) => <option key={edition.editionKey} value={edition.editionKey}>{edition.sourceId} · {edition.editionKey.slice(0, 8)}</option>)}</select></label></section> : null}<div className="toc-list">{chapters.length === 0 ? <div className="empty-state">目录为空。</div> : chapters.map((chapter: ApiChapter) => <Link className="toc-row" key={chapter.chapterId} to={`/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}`}><span className="toc-index">{chapter.index + 1}</span><span>{chapter.title}</span>{chapter.isVip === true ? <span className="toc-tag">VIP</span> : null}</Link>)}</div></section>
}
