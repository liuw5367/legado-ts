import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { Button } from '../components/ui/button.tsx'
import { apiFetch, type ApiHome } from '../lib/api.ts'

type BookItem = ApiHome['bookshelf'][number]
type View = 'bookshelf' | 'reading' | 'history'

export function AccountHomePage() {
  const [home, setHome] = useState<ApiHome | null>(null)
  const [view, setView] = useState<View>('bookshelf')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string>()
  const [deletingHistory, setDeletingHistory] = useState<string>()

  useEffect(() => {
    let active = true
    void apiFetch<ApiHome>('/api/home').then((result) => { if (active) setHome(result) }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : '首页加载失败') })
    return () => { active = false }
  }, [])

  async function refresh() { setHome(await apiFetch<ApiHome>('/api/home')) }
  async function removeBook(bookId: string) {
    setRemoving(bookId); setMessage('')
    try { await apiFetch(`/api/books/${encodeURIComponent(bookId)}/bookshelf`, { method: 'DELETE' }); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : '移出书架失败') }
    finally { setRemoving(undefined) }
  }
  async function removeHistory(id: string) {
    setDeletingHistory(id); setMessage('')
    try { await apiFetch(`/api/search-history/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : '删除搜索记录失败') }
    finally { setDeletingHistory(undefined) }
  }

  if (home === null) return <section className="page-stack page-narrow"><div className="loading-state"><p className="muted">正在读取你的阅读数据…</p>{message.length > 0 ? <p className="error">{message}</p> : null}</div></section>
  const bookItems: BookItem[] = view === 'bookshelf' ? home.bookshelf : home.reading
  return <section className="page-stack page-narrow">
    <div className="page-heading compact-heading"><div><h1>我的阅读</h1><p className="muted">{view === 'bookshelf' ? `${home.bookshelf.length} 本书` : view === 'reading' ? `${home.reading.length} 条记录` : `${home.searchHistory.length} 条搜索`}</p></div><Link className="button small" to="/search">搜索书籍</Link></div>
    <div className="segmented" role="tablist" aria-label="阅读数据视图">
      <button className={view === 'bookshelf' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'bookshelf'} onClick={() => setView('bookshelf')}>书架 <span>{home.bookshelf.length}</span></button>
      <button className={view === 'reading' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'reading'} onClick={() => setView('reading')}>阅读 <span>{home.reading.length}</span></button>
      <button className={view === 'history' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>搜索 <span>{home.searchHistory.length}</span></button>
    </div>
    {message.length > 0 ? <p className="error compact-message" role="alert">{message}</p> : null}
    {view === 'history' ? <SearchHistory items={home.searchHistory} deletingId={deletingHistory} onRemove={(id) => void removeHistory(id)} /> : <BookList items={bookItems} showRemove={view === 'bookshelf'} removingId={removing} onRemove={(bookId) => void removeBook(bookId)} />}
  </section>
}

function BookList({ items, showRemove, removingId, onRemove }: { items: BookItem[]; showRemove: boolean; removingId: string | undefined; onRemove: (bookId: string) => void }) {
  if (items.length === 0) return <div className="empty-state">{showRemove ? '书架还是空的，去搜索一本书吧。' : '还没有阅读记录。'}</div>
  return <div className="book-list">{items.map((item) => <BookRow key={`${item.book.id}:${item.edition.editionKey}`} item={item} showRemove={showRemove} removing={removingId === item.book.id} onRemove={onRemove} />)}</div>
}

function BookRow({ item, showRemove, removing, onRemove }: { item: BookItem; showRemove: boolean; removing: boolean; onRemove: (bookId: string) => void }) {
  const { book, edition, position } = item
  const target = position === undefined ? `/books/${encodeURIComponent(book.id)}/read?editionKey=${encodeURIComponent(edition.editionKey)}` : `/books/${encodeURIComponent(book.id)}/read/${encodeURIComponent(position.chapterId)}?editionKey=${encodeURIComponent(edition.editionKey)}`
  return <article className="book-row">
    <Link className="book-row-main" to={target} aria-label={`阅读：${book.name}`}>
      <BookCover name={book.name} coverUrl={book.coverUrl} />
      <span className="book-row-info"><strong>{book.name}</strong><span className="muted">{book.author ?? '作者未知'}</span><span className={position === undefined ? 'muted small' : 'small'}>{position === undefined ? '尚未阅读' : `读到：${position.title}`}</span></span>
    </Link>
    <details className="book-more">
      <summary aria-label={`更多操作：${book.name}`}>···</summary>
      <div className="book-more-menu"><Link className="book-more-item" to={`/books/${encodeURIComponent(book.id)}/toc?editionKey=${encodeURIComponent(edition.editionKey)}`} state={{ backTo: '/' }}>查看目录</Link>{showRemove ? <button className="book-more-item danger-action" type="button" disabled={removing} onClick={() => onRemove(book.id)}>{removing ? '移除中…' : '移出书架'}</button> : null}</div>
    </details>
  </article>
}

function SearchHistory({ items, deletingId, onRemove }: { items: ApiHome['searchHistory']; deletingId: string | undefined; onRemove: (id: string) => void }) {
  if (items.length === 0) return <div className="empty-state">还没有搜索记录。</div>
  return <div className="history-list">{items.map((item) => <article className="history-row" key={item.id}><div className="history-content"><Link className="link history-keyword" to={`/search?q=${encodeURIComponent(item.keyword)}`}>{item.keyword}</Link><span className="muted small">{item.resultCount} 条结果 · {formatTime(item.updatedAt)}</span><span className="muted small">{item.summary ?? item.status}</span></div><Button size="sm" variant="secondary" type="button" disabled={deletingId === item.id} onClick={() => onRemove(item.id)}>{deletingId === item.id ? '删除中…' : '删除'}</Button></article>)}</div>
}

function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) }
