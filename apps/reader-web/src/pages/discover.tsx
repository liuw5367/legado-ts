import { PageHeader } from '../components/page-header.tsx'
import { usePageActivity, usePageLoadEffect, usePageVersion } from '../lib/use-page-resource.ts'
import { useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { ArrowLeftRight, Check, Search } from 'lucide-react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { useDiscoveryStore } from '../lib/discovery-context.tsx'
import { pageReturnState } from '../lib/page-navigation.ts'
import type { DiscoveryEntry } from '../lib/discovery-state.ts'
import type { DiscoveryBookResult } from '../../shared/discovery.ts'

export function DiscoverPage() {
  const page = usePageActivity()
  const sourceVersion = usePageVersion(['discovery'])
  const store = useDiscoveryStore()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [params, setParams] = useSearchParams()
  const sourceId = params.get('sourceId') ?? undefined
  const categoryId = params.get('categoryId') ?? undefined
  const navigate = useNavigate()
  const location = useLocation()
  const [switcher, setSwitcher] = useState(false)
  const [filter, setFilter] = useState('')
  usePageLoadEffect((settle) => {
    let active = true
    void store.initialize(sourceId, categoryId, sourceVersion !== '0', true).then(() => {
      const selected = store.getSnapshot()
      // 只在本次选择结算后规范化 URL，避免旧分类状态把用户的新 tab 选择改回去。
      if (active && selected.loaded && selected.error.length === 0 && selected.source !== null && (sourceId !== selected.source.sourceId || (categoryId ?? '') !== selected.categoryId)) {
        setParams({ sourceId: selected.source.sourceId, ...(selected.categoryId.length === 0 ? {} : { categoryId: selected.categoryId }) }, { replace: true })
      }
      if (active) settle()
    })
    return () => { active = false; store.suspend() }
  }, [sourceId, categoryId], ['discovery'])
  const matching = state.sources.filter((source) => `${source.name} ${source.group ?? ''}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const currentCategory = state.categories.find((category) => category.id === state.categoryId)

  function selectSource(next: string) {
    setSwitcher(false)
    if (next === state.source?.sourceId) return
    store.scrollY = 0; window.scrollTo(0, 0)
    setParams({ sourceId: next })
  }
  function selectCategory(next: string) {
    if (state.source === null || next === state.categoryId) return
    store.scrollY = 0; window.scrollTo(0, 0)
    setParams({ sourceId: state.source.sourceId, categoryId: next })
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = state.categories.length
    const next = event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    const category = state.categories[next]
    if (category !== undefined) { selectCategory(category.id); document.getElementById((page?.id ?? 'discovery') + '-tab-' + category.id)?.focus() }
  }
  async function openBook(entry: DiscoveryEntry) {
    showDetails(await store.openBook(entry))
  }
  function showDetails(result: DiscoveryBookResult | void) {
    if (result !== undefined) navigate(`/books/${encodeURIComponent(result.book.id)}/details?editionKey=${encodeURIComponent(result.edition.editionKey)}`, { state: pageReturnState(location) })
  }

  return <section className="page-stack discovery-page">
    <PageHeader title="发现" description={state.source?.name ?? '挑一本想读的书'} actions={<div className="discovery-actions"><Link className="button small page-action" to="/search" state={pageReturnState(location)}><Search aria-hidden="true" /><span>搜索</span></Link><Button className="page-action" size="sm" aria-haspopup="dialog" onClick={() => { setFilter(''); setSwitcher(true) }} disabled={state.sources.length === 0}><ArrowLeftRight aria-hidden="true" /><span>切换</span></Button></div>} />
    {state.categories.length > 0 ? <div className="discovery-tabs" role="tablist" aria-label="发现分类">{state.categories.map((category, index) => <button key={category.id} id={(page?.id ?? 'discovery') + '-tab-' + category.id} className="discovery-tab" type="button" role="tab" aria-selected={category.id === state.categoryId} aria-controls={`${page?.id ?? 'discovery'}-books`} tabIndex={category.id === state.categoryId ? 0 : -1} onClick={() => selectCategory(category.id)} onKeyDown={(event) => tabKey(event, index)} title={category.group === undefined ? category.title : `${category.group} · ${category.title}`}>{category.title}</button>)}</div> : null}
    <div className="discovery-content" id={`${page?.id ?? 'discovery'}-books`} role={state.categories.length > 0 ? 'tabpanel' : undefined} aria-labelledby={currentCategory === undefined ? undefined : (page?.id ?? 'discovery') + '-tab-' + currentCategory.id} aria-busy={state.loading || state.loadingMore}>
      {currentCategory?.group ? <p className="muted small discovery-group">{currentCategory.group}</p> : null}
      {state.error.length > 0 ? <div className="discovery-feedback" role="alert"><p className="error">{state.error}</p><Button variant="secondary" size="sm" onClick={() => { void store.retry().then(showDetails) }}>重试</Button></div> : null}
      {state.loading ? <LoadingState message="正在读取发现…" variant={state.items.length > 0 ? 'inline' : 'viewport'} /> : null}
      {!state.loading && state.loaded && state.source === null ? <div className="empty-state"><p>暂无可用的发现书源</p><p className="muted small">导入并启用支持发现的书源后，即可浏览分类和榜单。</p><Link className="button secondary" to="/sources" state={pageReturnState(location)}>管理书源</Link></div> : null}
      {!state.loading && state.loaded && state.source !== null && state.items.length === 0 && state.error.length === 0 ? <p className="empty-state">{state.message || '这个分类暂时没有书籍。'}</p> : null}
      <div className="book-list">{state.items.map((entry) => <div className="book-row" key={entry.book.sourceId + entry.book.bookUrl}><button className="book-row-main discovery-book" type="button" disabled={state.opening !== null || state.loading || state.loadingMore} onClick={() => void openBook(entry)} aria-label={`查看${entry.book.name ?? '未命名书籍'}详情`}><BookCover name={entry.book.name ?? '书'} coverUrl={entry.book.coverUrl} size="result" /><span className="book-row-info"><strong>{entry.book.name ?? '未命名书籍'}</strong><span className="muted">{[entry.book.author || '作者未知', entry.book.kind].filter(Boolean).join(' · ')}</span>{entry.book.intro ? <span className="muted">{entry.book.intro}</span> : null}{entry.book.lastChapter ? <span className="muted">{entry.book.lastChapter}</span> : null}{state.opening === entry.book.bookUrl ? <span className="discovery-opening" role="status">正在读取详情…</span> : null}</span></button></div>)}</div>
      {state.message.length > 0 && state.items.length > 0 ? <p className="muted small" role="status">{state.message}</p> : null}
      {state.nextCursor !== undefined ? <div className="discovery-pagination"><Button variant="secondary" disabled={state.loading || state.loadingMore || state.opening !== null} onClick={() => void store.loadMore()}>{state.loadingMore ? '正在加载…' : '加载更多'}</Button></div> : state.loaded && state.items.length > 0 ? <p className="muted small discovery-end">已显示全部书籍</p> : null}
    </div>
    <Sheet className="discovery-source-switcher" open={switcher} onOpenChange={setSwitcher} title="切换发现书源"><div className="page-stack"><label className="sr-only" htmlFor={`${page?.id ?? 'discovery'}-filter`}>筛选书源名称或分组</label><Input id={`${page?.id ?? 'discovery'}-filter`} value={filter} placeholder="书源名称或分组" onChange={(event) => setFilter(event.target.value)} /><div className="discovery-sources">{matching.map((source) => <button className="discovery-source" type="button" key={source.sourceId} aria-pressed={source.sourceId === state.source?.sourceId} onClick={() => selectSource(source.sourceId)}><span><strong>{source.name}</strong>{source.group ? <span className="muted small">{source.group}</span> : null}</span>{source.sourceId === state.source?.sourceId ? <Check aria-label="当前书源" /> : null}</button>)}{matching.length === 0 ? <p className="muted">没有匹配的书源。</p> : null}</div><Link className="link" to="/sources" state={pageReturnState(location)}>管理书源</Link></div></Sheet>
  </section>
}
