import { hasBookUpdate, setBookUpdate, subscribeBookUpdates } from '../lib/book-updates.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import type { RefreshShelfChaptersResponse } from '../../shared/shelf-chapters.ts'
import { useReaderSettings } from '../lib/settings-context.tsx'
import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { BookListPicker } from '../components/book-list-picker.tsx'
import { ShelfGroupPicker } from '../components/shelf-group-picker.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { BookOpen, Bookmark, History, LoaderCircle, Search } from 'lucide-react'
import { EmptyState } from '../components/empty-state.tsx'
import { useHomeResource } from '../lib/use-home-resource.ts'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { MoreMenu } from '../components/more-menu.tsx'
import { Button } from '../components/ui/button.tsx'
import { apiFetch, type ApiHome, type ApiShelfGroups, type ApiBookshelf, type ApiReadingHistory, type ApiSearchHistory } from '../lib/api.ts'
import { formatShanghaiDateTime } from '../lib/time-format.ts'
import { useAuth } from '../lib/auth-context.tsx'
import { hasSeenOnboarding } from '../lib/onboarding.ts'

type BookItem = ApiHome['bookshelf'][number]
type View = 'bookshelf' | 'reading' | 'history'

export function AccountHomePage() {
  const [selectedGroup, setSelectedGroup] = useState('all')
  const groupInitialized = useRef<string | undefined>(undefined)
  const { settings, settingsLoadStatus, retrySettingsLoad, error: settingsError } = useReaderSettings()
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const onboardingRedirected = useRef(false)
  const initialView = (location.state as { homeView?: View } | null)?.homeView
  const [view, setView] = useState<View>(initialView === 'reading' || initialView === 'history' ? initialView : 'bookshelf')
  const tabScroll = useRef<Partial<Record<View, number>>>({})
  const previousView = useRef(view)
  function selectView(next: View) {
    if (next === view) return
    tabScroll.current[view] = window.scrollY
    setView(next)
  }
  useLayoutEffect(() => {
    if (previousView.current !== view) window.scrollTo({ top: tabScroll.current[view] ?? 0, behavior: 'auto' })
    previousView.current = view
  }, [view])
  const shelf = useHomeResource<ApiBookshelf>('/api/bookshelf', 'bookshelf', view === 'bookshelf', settings.general.bookshelfSort)
  const reading = useHomeResource<ApiReadingHistory>('/api/reading-history', 'reading-history', view === 'reading')
  const history = useHomeResource<ApiSearchHistory>('/api/search-history', 'search-history', view === 'history')
  const groups = useHomeResource<ApiShelfGroups>('/api/bookshelf-groups', 'groups')
  const groupData = groups.data
  const current = view === 'bookshelf' ? shelf : view === 'reading' ? reading : history
  const [feedback, setFeedback] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string>()
  const [deletingHistory, setDeletingHistory] = useState<string>()

  useEffect(() => {
    if (!user?.id || onboardingRedirected.current || hasSeenOnboarding(user.id)) return
    onboardingRedirected.current = true
    navigate('/onboarding', { replace: true, state: { returnTo: '/' } })
  }, [navigate, user?.id])

  useEffect(() => {
    if (!user?.id || settingsLoadStatus !== 'ready' || !groupData || groupInitialized.current === user.id) return
    const initial = settings.general.bookshelfInitialGroup ?? 'all'
    setSelectedGroup(initial === 'all' || initial === 'ungrouped' || groupData.groups.some((group) => group.id === initial) ? initial : 'all')
    groupInitialized.current = user.id
  }, [user?.id, settingsLoadStatus, settings.general.bookshelfInitialGroup, groupData])

  useEffect(() => {
    if (groupData && selectedGroup !== 'all' && selectedGroup !== 'ungrouped' && !groupData.groups.some((group) => group.id === selectedGroup)) setSelectedGroup('all')
  }, [groupData, selectedGroup])

  const updateBookChapters = useCallback((bookId: string, editionKey: string, chapters: RefreshShelfChaptersResponse) => {
    shelf.setData((current) => current === null ? null : { ...current, bookshelf: current.bookshelf.map((row) => {
      if (row.book.id !== bookId || row.edition.editionKey !== editionKey) return row
      const { position: _position, ...book } = row
      return { ...book, chapters, ...(chapters.position ? { position: chapters.position } : {}) }
    }) })
  }, [shelf.setData])

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

  const allShelf = shelf.data?.bookshelf
  const bookItems: BookItem[] = view === 'bookshelf' ? (allShelf ?? []).filter((row) => selectedGroup === 'all' || (selectedGroup === 'ungrouped' ? !row.groupId : row.groupId === selectedGroup)) : reading.data?.reading ?? []
  const count = view === 'bookshelf' ? allShelf?.length : view === 'reading' ? reading.data?.reading.length : history.data?.searchHistory.length
  const countLabel = count === undefined ? current.loading ? '读取中…' : '暂时无法读取' : view === 'bookshelf' ? `${count} 本书` : view === 'reading' ? `${count} 条记录` : `${count} 条搜索`
  return <section className="page-stack page-narrow">
    <PageHeader title="我的阅读" description={countLabel} actions={<Link className="button small page-action" to="/search"><Search aria-hidden="true" /><span>搜索</span></Link>} />
    {settingsLoadStatus === 'error' ? <DismissibleMessage className="error" role="alert">{settingsError ?? '设置加载失败'}<button type="button" onClick={() => void retrySettingsLoad()}>重试</button></DismissibleMessage> : null}
    <div className="segmented" role="tablist" aria-label="阅读数据视图">
      <button className={view === 'bookshelf' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'bookshelf'} onClick={() => selectView('bookshelf')}>书架 {allShelf ? <span>{allShelf.length}</span> : null}</button>
      <button className={view === 'reading' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'reading'} onClick={() => selectView('reading')}>阅读 {reading.data ? <span>{reading.data.reading.length}</span> : null}</button>
      <button className={view === 'history' ? 'selected' : ''} type="button" role="tab" aria-selected={view === 'history'} onClick={() => selectView('history')}>搜索 {history.data ? <span>{history.data.searchHistory.length}</span> : null}</button>
    </div>
    {view === 'bookshelf' && groups.error ? <DismissibleMessage className="error compact-message" role="alert">分组加载失败：{groups.error}<Button variant="secondary" size="sm" onClick={groups.retry}>重试分组</Button></DismissibleMessage> : null}
    {view === 'bookshelf' && groupData && groupData.groups.length > 0 ? <div className="shelf-group-bar" aria-label="书架分组">{[{ id: 'all', name: '全部' }, { id: 'ungrouped', name: '默认' }, ...groupData.groups].map((group) => <Button size="sm" variant={selectedGroup === group.id ? 'default' : 'secondary'} key={group.id} aria-pressed={selectedGroup === group.id} onClick={() => setSelectedGroup(group.id)}>{group.name}</Button>)}</div> : null}
    {view === 'bookshelf' && shelf.data && bookItems.length === 0 && selectedGroup !== 'all' ? <EmptyState icon={BookOpen} title="这个分组还没有书" description="搜索书籍后加入分组" /> : null}
    {current.data === null ? current.error ? <div className="error-state"><DismissibleMessage className="error" role="alert">{current.error}</DismissibleMessage><div className="actions"><Button variant="secondary" size="sm" type="button" onClick={current.retry}>重试</Button></div></div> : <LoadingState message="正在读取你的阅读数据…" variant="viewport" /> : <>
      {current.loading ? <LoadingState message="正在更新你的阅读数据…" variant="inline" /> : null}
      {current.error ? <DismissibleMessage className="error compact-message" role="alert">{current.error}<Button variant="secondary" size="sm" onClick={current.retry}>重试</Button></DismissibleMessage> : null}
      {feedback ? <DismissibleMessage onDismiss={() => setFeedback('')} className="success compact-message" role="status">{feedback}</DismissibleMessage> : null}
      {message.length > 0 ? <DismissibleMessage onDismiss={() => setMessage('')} className="error compact-message" role="alert">{message}</DismissibleMessage> : null}
      {view === 'history' ? <SearchHistory items={history.data?.searchHistory ?? []} deletingId={deletingHistory} onRemove={(id) => void removeHistory(id)} /> : <BookList onRefreshed={updateBookChapters} onOrganized={setFeedback} view={view} items={bookItems} showRemove={view === 'bookshelf'} hideEmpty={view === 'bookshelf' && selectedGroup !== 'all'} removingId={removing} onRemove={(bookId) => void removeBook(bookId)} />}
    </>}
  </section>
}

function BookList({ onRefreshed, view, items, showRemove, hideEmpty = false, removingId, onRemove, onOrganized }: { onRefreshed: (bookId: string, editionKey: string, chapters: RefreshShelfChaptersResponse) => void; view: View; items: BookItem[]; showRemove: boolean; hideEmpty?: boolean; onOrganized: (message: string) => void; removingId: string | undefined; onRemove: (bookId: string) => void }) {
  if (items.length === 0 && hideEmpty) return null
  if (items.length === 0) return <EmptyState icon={showRemove ? BookOpen : Bookmark} title={showRemove ? '书架还是空的' : '还没有阅读记录'} description={showRemove ? '搜索书籍并加入书架' : '开始阅读后会显示在这里'} />
  return <div className="book-list">{items.map((item) => <BookRow onRefreshed={onRefreshed} key={`${item.book.id}:${item.edition.editionKey}`} item={item} onOrganized={onOrganized} view={view} showRemove={showRemove} removing={removingId === item.book.id} onRemove={onRemove} />)}</div>
}

function BookRow({ onRefreshed, view, item, showRemove, removing, onRemove, onOrganized }: { onRefreshed: (bookId: string, editionKey: string, chapters: RefreshShelfChaptersResponse) => void; view: View; item: BookItem; showRemove: boolean; onOrganized: (message: string) => void; removing: boolean; onRemove: (bookId: string) => void }) {
  const [picker, setPicker] = useState<'join' | 'move' | 'group' | null>(null)
  const { book, edition, position } = item
  const { user } = useAuth()
  const cache = useBookCache()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const chapters = item.chapters
  const updated = useSyncExternalStore(subscribeBookUpdates, () => user ? hasBookUpdate(user.id, book.id, edition.editionKey) : false)

  async function refreshChapters() {
    if (refreshing || !user) return
    setRefreshing(true); setRefreshError('')
    try {
      const result = await apiFetch<RefreshShelfChaptersResponse>(`/api/books/${encodeURIComponent(book.id)}/toc/refresh?editionKey=${encodeURIComponent(edition.editionKey)}`, { method: 'POST' }, user.id)
      cache.invalidate(book.id, edition.editionKey)
      onRefreshed(book.id, edition.editionKey, result)
      if (result.hasNewChapters) setBookUpdate(user.id, book.id, edition.editionKey, true)
      if (result.runtimeWarning) setRefreshError(result.runtimeWarning)
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '刷新章节失败')
    } finally { setRefreshing(false) }
  }
  const target = position === undefined ? `/books/${encodeURIComponent(book.id)}/read?editionKey=${encodeURIComponent(edition.editionKey)}` : `/books/${encodeURIComponent(book.id)}/read/${encodeURIComponent(position.chapterId)}?editionKey=${encodeURIComponent(edition.editionKey)}`
  return <article className="book-row">
    <Link className="book-row-main" to={view === 'reading' ? '/books/' + encodeURIComponent(book.id) + '/details?editionKey=' + encodeURIComponent(edition.editionKey) : target} state={{ backTo: '/', backState: { homeView: view } }} aria-label={`${view === 'reading' ? '查看详情' : '阅读'}：${book.name}`}>
      <BookCover name={book.name} coverUrl={book.customCoverUrl || book.coverUrl} />
      <span className={'book-row-info' + (showRemove ? ' shelf-row-info' : '')}>
        <strong className={showRemove ? 'book-row-title' : undefined}>{showRemove ? <><span title={book.name}>{book.name}</span>{refreshing ? <LoaderCircle className="book-refresh-spinner" role="status" aria-label="正在刷新章节" /> : updated ? <span className="book-update-tag">更新</span> : null}</> : book.name}</strong>
        {showRemove ? <span className="shelf-row-author muted"><span title={book.author ?? '作者未知'}>{book.author ?? '作者未知'}</span>{chapters?.latestChapterTitle ? <span className="shelf-row-latest" title={chapters.latestChapterTitle}> · {chapters.latestChapterTitle}</span> : null}</span> : <span className="muted">{book.author ?? '作者未知'}</span>}
        <span className={position === undefined ? 'muted small' : 'small'}>{position === undefined ? '尚未阅读' : showRemove ? chapters?.unreadChapterCount === 0 ? '已读至最新章节' : `${chapters?.unreadChapterCount == null ? '未读数未知' : `${chapters.unreadChapterCount} 章未读`} · ${position.title}` : `读到：${position.title}`}</span>
      </span>
    </Link>
    <MoreMenu label={`更多操作：${book.name}`}>
      {view === 'reading' ? <Link className="more-menu-item" to={target} state={{ backTo: '/', backState: { homeView: view } }}>继续阅读</Link> : null}
      <Link className="more-menu-item" to={'/books/' + encodeURIComponent(book.id) + '/details?editionKey=' + encodeURIComponent(edition.editionKey)} state={{ backTo: '/', backState: { homeView: view } }}>查看详情</Link>
      <Link className="more-menu-item" to={`/books/${encodeURIComponent(book.id)}/toc?editionKey=${encodeURIComponent(edition.editionKey)}`} state={{ backTo: '/', backState: { homeView: view } }}>查看目录</Link>
      {showRemove ? <button className="more-menu-item" type="button" disabled={refreshing} onClick={() => void refreshChapters()}>{refreshing ? '刷新中…' : '刷新章节'}</button> : null}
      {showRemove ? <Link className="more-menu-item" to={`/books/${encodeURIComponent(book.id)}/sources`} state={{ backTo: '/', backState: { homeView: view } }}>切换书源</Link> : null}
      {showRemove ? <><button className="more-menu-item" onClick={() => setPicker('group')}>修改分组</button><button className="more-menu-item" onClick={() => setPicker('join')}>加入书单</button><button className="more-menu-item" onClick={() => setPicker('move')}>移入书单</button></> : null}
      {showRemove ? <button className="more-menu-item danger-action" type="button" disabled={removing} onClick={() => onRemove(book.id)}>{removing ? '移除中…' : '移出书架'}</button> : null}
    </MoreMenu>
    {refreshError ? <DismissibleMessage className="error book-row-feedback" role="alert" onDismiss={() => setRefreshError('')}>{refreshError}</DismissibleMessage> : null}
    {picker === 'group' ? <ShelfGroupPicker book={book} onSaved={() => onOrganized('已修改分组')} onClose={() => setPicker(null)} /> : picker ? <BookListPicker book={book} move={picker === 'move'} onSaved={() => onOrganized(picker === 'move' ? '已移入书单并移出书架' : '已加入书单')} onClose={() => setPicker(null)} /> : null}
  </article>
}

function SearchHistory({ items, deletingId, onRemove }: { items: ApiHome['searchHistory']; deletingId: string | undefined; onRemove: (id: string) => void }) {
  if (items.length === 0) return <EmptyState icon={History} title="还没有搜索记录" description="搜索书籍后会显示在这里" />
  return <div className="history-list">{items.map((item) => <article className="history-row" key={item.id}><div className="history-content"><Link className="link history-keyword" to={`/search?q=${encodeURIComponent(item.keyword)}`}>{item.keyword}</Link><span className="muted small">{item.resultCount} 条结果 · {formatShanghaiDateTime(item.updatedAt)}</span><span className="muted small">{item.summary ?? item.status}</span></div><Button size="sm" variant="secondary" type="button" disabled={deletingId === item.id} onClick={() => onRemove(item.id)}>{deletingId === item.id ? '删除中…' : '删除'}</Button></article>)}</div>
}
