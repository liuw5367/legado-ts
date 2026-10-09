import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, type ApiHome } from '../lib/api.ts'

export function AccountHomePage() {
  const [home, setHome] = useState<ApiHome | null>(null)
  const [view, setView] = useState<'bookshelf' | 'reading' | 'history'>('bookshelf')
  const [message, setMessage] = useState('')
  useEffect(() => { void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '首页加载失败')) }, [])

  async function refresh() { setHome(await apiFetch<ApiHome>('/api/home')) }
  async function removeBook(bookId: string) { await apiFetch(`/api/books/${encodeURIComponent(bookId)}/bookshelf`, { method: 'DELETE' }); await refresh() }
  async function removeHistory(id: string) { await apiFetch(`/api/search-history/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh() }

  if (home === null) return <section className="page-stack"><div className="card"><p className="muted">正在读取你的阅读数据…</p>{message.length > 0 ? <p className="error">{message}</p> : null}</div></section>
  const bookItems: Array<{ book: ApiHome['bookshelf'][number]['book']; edition: ApiHome['bookshelf'][number]['edition']; position?: ApiHome['bookshelf'][number]['position'] }> = view === 'history' ? [] : view === 'bookshelf' ? home.bookshelf : home.reading
  return <section className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">MY LIBRARY</p><h1>我的阅读</h1><p className="muted">书架、阅读记录和搜索记录都属于当前账号。</p></div><div className="actions"><Link className="button" to="/search">搜索书籍</Link><Link className="button secondary" to="/account/password">修改密码</Link></div></div>
    <div className="segmented" role="tablist" aria-label="阅读数据视图"><button className={view === 'bookshelf' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'bookshelf'} onClick={() => setView('bookshelf')}>书架 <span>{home.bookshelf.length}</span></button><button className={view === 'reading' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'reading'} onClick={() => setView('reading')}>阅读记录 <span>{home.reading.length}</span></button><button className={view === 'history' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>搜索记录 <span>{home.searchHistory.length}</span></button></div>
    {view === 'history' ? <div className="history-list">{home.searchHistory.length === 0 ? <EmptyState text="还没有搜索记录。" /> : home.searchHistory.map((item) => <article className="history-row" key={item.id}><div><Link className="link history-keyword" to={`/search?q=${encodeURIComponent(item.keyword)}`}>{item.keyword}</Link><p className="muted small">{item.summary ?? item.status} · {formatTime(item.updatedAt)}</p></div><button className="button secondary" type="button" onClick={() => void removeHistory(item.id)}>删除</button></article>)}</div> : <div className="book-grid">{bookItems.length === 0 ? <EmptyState text={view === 'bookshelf' ? '书架还是空的，去搜索一本书吧。' : '还没有阅读记录。'} /> : bookItems.map((item) => { const book = item.book; const edition = item.edition; const position = item.position; const target = position === undefined ? `/books/${book.id}/toc?editionKey=${encodeURIComponent(edition.editionKey)}` : `/books/${book.id}/read/${encodeURIComponent(position.chapterId)}?editionKey=${encodeURIComponent(edition.editionKey)}`; return <article className="book-card" key={`${book.id}:${edition.editionKey}`}><div className="book-cover" aria-hidden="true">{book.name.slice(0, 1)}</div><div className="book-info"><h2>{book.name}</h2><p className="muted">{book.author ?? '作者未知'}</p>{position === undefined ? <p className="muted small">尚未开始阅读</p> : <p className="small">读到：{position.title}</p>}<div className="actions"><Link className="button" to={target}>{position === undefined ? '打开目录' : '继续阅读'}</Link>{view === 'bookshelf' ? <button className="button secondary" type="button" onClick={() => void removeBook(book.id)}>移出书架</button> : null}</div></div></article> })}</div>}
  </section>
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state">{text}</div> }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) }
