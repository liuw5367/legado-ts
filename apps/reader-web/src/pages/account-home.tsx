import { PageHeader } from '../components/page-header.tsx'
import { Search } from 'lucide-react'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { useCallback, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { MoreMenu } from '../components/more-menu.tsx'
import { Button } from '../components/ui/button.tsx'
import { apiFetch, type ApiHome } from '../lib/api.ts'
import { formatShanghaiDateTime } from '../lib/time-format.ts'

type BookItem = ApiHome['bookshelf'][number]
type View = 'bookshelf' | 'reading' | 'history'

export function AccountHomePage() {
  const [home, setHome] = useState<ApiHome | null>(null)
  const [loading, setLoading] = useState(true)
  const location = useLocation()
  const initialView = (location.state as { homeView?: View } | null)?.homeView
  const [view, setView] = useState<View>(initialView === 'reading' || initialView === 'history' ? initialView : 'bookshelf')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string>()
  const [deletingHistory, setDeletingHistory] = useState<string>()
  const requestIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const loadHome = useCallback(async () => {
    const requestId = ++requestIdRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setMessage('')
    try {
      const result = await apiFetch<ApiHome>('/api/home', { signal: controller.signal })
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      setHome(result)
    } catch (error: unknown) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      setMessage(error instanceof Error ? error.message : '首页加载失败')
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false)
        if (controllerRef.current === controller) controllerRef.current = null
      }
    }
  }, [])

  usePageLoadEffect((settle) => {
    void loadHome().then(settle)
    return () => {
      requestIdRef.current += 1
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [], ['home'])

  async function removeBook(bookId: string) {
    setRemoving(bookId); setMessage('')
    try { await apiFetch(`/api/books/${encodeURIComponent(bookId)}/bookshelf`, { method: 'DELETE' }) }
    catch (error) { setMessage(error instanceof Error ? error.message : '移出书架失败') }
    finally { setRemoving(undefined) }
  }
  async function removeHistory(id: string) {
    setDeletingHistory(id); setMessage('')
    try { await apiFetch(`/api/search-history/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
    catch (error) { setMessage(error instanceof Error ? error.message : '删除搜索记录失败') }
    finally { setDeletingHistory(undefined) }
  }

  const bookItems: BookItem[] = home === null ? [] : view === 'bookshelf' ? home.bookshelf : home.reading
  const countLabel = home === null ? (loading ? '读取中…' : '暂时无法读取') : view === 'bookshelf' ? `${home.bookshelf.length} 本书` : view === 'reading' ? `${home.reading.length} 条记录` : `${home.searchHistory.length} 条搜索`
  return <section className="page-stack page-narrow">
    <PageHeader title="我的阅读" description={countLabel} actions={<Link className="button small page-action" to="/search"><Search aria-hidden="true" /><span>搜索</span></Link>} />
    <div className="segmented" role="tablist" aria-label="阅读数据视图">
      <button className={view === 'bookshelf' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'bookshelf'} onClick={() => setView('bookshelf')}>书架 {home === null ? null : <span>{home.bookshelf.length}</span>}</button>
      <button className={view === 'reading' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'reading'} onClick={() => setView('reading')}>阅读 {home === null ? null : <span>{home.reading.length}</span>}</button>
      <button className={view === 'history' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>搜索 {home === null ? null : <span>{home.searchHistory.length}</span>}</button>
    </div>
    {loading && home === null ? <LoadingState message="正在读取你的阅读数据…" /> : home === null ? <div className="error-state"><p className="error" role="alert">{message || '首页加载失败'}</p><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={() => void loadHome()}>重试</Button></div></div> : <>
      {loading ? <LoadingState message="正在更新你的阅读数据…" variant="inline" /> : null}
      {message.length > 0 ? <p className="error compact-message" role="alert">{message}</p> : null}
      {view === 'history' ? <SearchHistory items={home.searchHistory} deletingId={deletingHistory} onRemove={(id) => void removeHistory(id)} /> : <BookList view={view} items={bookItems} showRemove={view === 'bookshelf'} removingId={removing} onRemove={(bookId) => void removeBook(bookId)} />}
    </>}
  </section>
}

function BookList({ view, items, showRemove, removingId, onRemove }: { view: View; items: BookItem[]; showRemove: boolean; removingId: string | undefined; onRemove: (bookId: string) => void }) {
  if (items.length === 0) return <div className="empty-state">{showRemove ? '书架还是空的，去搜索一本书吧。' : '还没有阅读记录。'}</div>
  return <div className="book-list">{items.map((item) => <BookRow key={`${item.book.id}:${item.edition.editionKey}`} item={item} view={view} showRemove={showRemove} removing={removingId === item.book.id} onRemove={onRemove} />)}</div>
}

function BookRow({ view, item, showRemove, removing, onRemove }: { view: View; item: BookItem; showRemove: boolean; removing: boolean; onRemove: (bookId: string) => void }) {
  const { book, edition, position } = item
  const target = position === undefined ? `/books/${encodeURIComponent(book.id)}/read?editionKey=${encodeURIComponent(edition.editionKey)}` : `/books/${encodeURIComponent(book.id)}/read/${encodeURIComponent(position.chapterId)}?editionKey=${encodeURIComponent(edition.editionKey)}`
  return <article className="book-row">
    <Link className="book-row-main" to={target} state={{ backTo: '/', backState: { homeView: view } }} aria-label={`阅读：${book.name}`}>
      <BookCover name={book.name} coverUrl={book.coverUrl} />
      <span className="book-row-info"><strong>{book.name}</strong><span className="muted">{book.author ?? '作者未知'}</span><span className={position === undefined ? 'muted small' : 'small'}>{position === undefined ? '尚未阅读' : `读到：${position.title}`}</span></span>
    </Link>
    <MoreMenu label={`更多操作：${book.name}`}>
      <Link className="more-menu-item" to={'/books/' + encodeURIComponent(book.id) + '/details?editionKey=' + encodeURIComponent(edition.editionKey)} state={{ backTo: '/', backState: { homeView: view } }}>查看详情</Link>
      <Link className="more-menu-item" to={`/books/${encodeURIComponent(book.id)}/toc?editionKey=${encodeURIComponent(edition.editionKey)}`} state={{ backTo: '/', backState: { homeView: view } }}>查看目录</Link>
      {showRemove ? <button className="more-menu-item danger-action" type="button" disabled={removing} onClick={() => onRemove(book.id)}>{removing ? '移除中…' : '移出书架'}</button> : null}
    </MoreMenu>
  </article>
}

function SearchHistory({ items, deletingId, onRemove }: { items: ApiHome['searchHistory']; deletingId: string | undefined; onRemove: (id: string) => void }) {
  if (items.length === 0) return <div className="empty-state">还没有搜索记录。</div>
  return <div className="history-list">{items.map((item) => <article className="history-row" key={item.id}><div className="history-content"><Link className="link history-keyword" to={`/search?q=${encodeURIComponent(item.keyword)}`}>{item.keyword}</Link><span className="muted small">{item.resultCount} 条结果 · {formatShanghaiDateTime(item.updatedAt)}</span><span className="muted small">{item.summary ?? item.status}</span></div><Button size="sm" variant="secondary" type="button" disabled={deletingId === item.id} onClick={() => onRemove(item.id)}>{deletingId === item.id ? '删除中…' : '删除'}</Button></article>)}</div>
}
