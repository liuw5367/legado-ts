import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { apiFetch, mergeSearchStreamCandidates, type ApiBook, type ApiCandidate, type ApiSource, type SearchSourceEventData, streamSearch } from '../lib/api.ts'

const INITIAL_SOURCE_LIMIT = 100

export function SearchPage() {
  const [searchParams] = useSearchParams()
  const queryKeyword = searchParams.get('q') ?? ''
  const [sources, setSources] = useState<ApiSource[]>([])
  const [books, setBooks] = useState<ApiBook[]>([])
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [precision, setPrecision] = useState(false)
  const [keyword, setKeyword] = useState(queryKeyword)
  const [sourceFilter, setSourceFilter] = useState('')
  const [sourceLimit, setSourceLimit] = useState(INITIAL_SOURCE_LIMIT)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [candidates, setCandidates] = useState<ApiCandidate[]>([])
  const [expandedIndex, setExpandedIndex] = useState<number>()
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [saving, setSaving] = useState<number | null>(null)
  const [targetByIndex, setTargetByIndex] = useState<Record<number, string>>({})
  const [hasNextPage, setHasNextPage] = useState(false)
  const [searchId, setSearchId] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const searchIdRef = useRef('')
  const cancelRequestedRef = useRef(false)

  useEffect(() => {
    let active = true
    void Promise.all([apiFetch<{ sources: ApiSource[] }>('/api/sources'), apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books')]).then(([sourceResult, bookResult]) => {
      if (!active) return
      setSources(sourceResult.sources); setSourceIds(sourceResult.sources.map((source) => source.sourceId)); setBooks(bookResult.books.map((item) => item.book))
    }).catch((error: unknown) => { if (active) { setStatus('error'); setMessageTone('error'); setMessage(error instanceof Error ? error.message : '搜索配置加载失败') } })
    return () => { active = false; controllerRef.current?.abort() }
  }, [])
  useEffect(() => { setKeyword(queryKeyword) }, [queryKeyword])

  const filteredSources = useMemo(() => {
    const normalized = sourceFilter.trim().toLocaleLowerCase()
    return sources.filter((source) => normalized.length === 0 || `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(normalized))
  }, [sourceFilter, sources])
  const visibleSources = filteredSources.slice(0, sourceLimit)
  const sourceLabel = sources.length === 0 ? '暂无可用书源' : sourceIds.length === sources.length ? '全部书源' : `已选 ${sourceIds.length} 个书源`

  async function saveCandidate(index: number, targetBookId?: string) {
    const result = candidates[index]
    if (result === undefined || searchId.length === 0) return
    setSaving(index); setMessageTone('info'); setMessage('')
    try {
      await apiFetch('/api/books', { method: 'POST', body: JSON.stringify({ searchId, candidateIndex: index, ...(targetBookId === undefined || targetBookId.length === 0 ? {} : { bookId: targetBookId }) }) })
      setMessageTone('success'); setMessage(targetBookId === undefined || targetBookId.length === 0 ? '已加入书架' : '已添加到现有书籍，并切换为当前版本')
    } catch (error) { setMessageTone('error'); setMessage(error instanceof Error ? error.message : '加入书架失败') }
    finally { setSaving(null) }
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault()
    if (keyword.trim().length === 0 || sourceIds.length === 0) return
    setStatus('loading'); setMessageTone('info'); setMessage(''); setCandidates([]); setExpandedIndex(undefined); setTargetByIndex({}); setHasNextPage(false); setSearchId(''); searchIdRef.current = ''; cancelRequestedRef.current = false
    const controller = new AbortController(); controllerRef.current = controller
    try {
      const created = await apiFetch<{ search: { id: string } }>('/api/searches', { method: 'POST', body: JSON.stringify({ keyword, sourceIds, precision }) })
      searchIdRef.current = created.search.id; setSearchId(created.search.id)
      if (controller.signal.aborted || cancelRequestedRef.current) {
        await apiFetch(`/api/searches/${encodeURIComponent(created.search.id)}/cancel`, { method: 'POST' }).catch(() => undefined)
        setStatus('done'); setMessageTone('info'); setMessage('搜索已取消'); return
      }
      await streamSearch(created.search.id, handleStreamEvent, controller.signal)
      setStatus('done')
    } catch (error) {
      const cancelled = controller.signal.aborted || cancelRequestedRef.current || (error instanceof DOMException && error.name === 'AbortError')
      setStatus(cancelled ? 'done' : 'error'); setMessageTone(cancelled ? 'info' : 'error'); setMessage(cancelled ? '搜索已取消' : error instanceof Error ? error.message : '搜索失败')
    }
    finally { controllerRef.current = null }
  }

  async function continueNextPage() {
    if (searchIdRef.current.length === 0 || !hasNextPage) return
    cancelRequestedRef.current = false
    const activeSearchId = searchIdRef.current
    const controller = new AbortController(); controllerRef.current = controller; setStatus('loading'); setMessageTone('info'); setMessage('')
    try { await streamSearch(activeSearchId, handleStreamEvent, controller.signal, { nextPage: true }); setStatus('done') }
    catch (error) { const cancelled = controller.signal.aborted || cancelRequestedRef.current || (error instanceof DOMException && error.name === 'AbortError'); setStatus(cancelled ? 'done' : 'error'); setMessageTone(cancelled ? 'info' : 'error'); setMessage(cancelled ? '搜索已取消' : error instanceof Error ? error.message : '加载下一页失败') }
    finally { controllerRef.current = null }
  }

  function handleStreamEvent(streamEvent: { type: string; data: unknown }) {
    if (streamEvent.type === 'error') { const error = streamEvent.data as { message?: string }; throw new Error(error.message ?? '搜索失败') }
    if (streamEvent.type === 'source-result') {
      const batch = streamEvent.data as SearchSourceEventData & { source?: { candidates?: ApiCandidate[]; status?: string } }
      setCandidates((current) => mergeSearchStreamCandidates(current, batch))
      if (batch.source?.status === 'failed' || batch.source?.status === 'capability-missing') { setMessageTone('error'); setMessage('部分书源执行失败，已保留可用结果。') }
    }
    if (streamEvent.type === 'batch-end') {
      const batch = streamEvent.data as SearchSourceEventData & { search?: { sourceStates?: Array<{ nextCursor?: unknown }>; candidates?: ApiCandidate[] } }
      setCandidates((current) => mergeSearchStreamCandidates(current, batch))
      setHasNextPage(batch.search?.sourceStates?.some((source) => source.nextCursor !== undefined) === true)
    }
  }

  async function cancelSearch() { cancelRequestedRef.current = true; controllerRef.current?.abort(); const activeSearchId = searchIdRef.current; if (activeSearchId.length > 0) await apiFetch(`/api/searches/${encodeURIComponent(activeSearchId)}/cancel`, { method: 'POST' }).catch(() => undefined); setStatus('done'); setMessageTone('info'); setMessage('搜索已取消') }
  function toggleSource(sourceId: string, selected: boolean) { setSourceIds((current) => selected ? (current.includes(sourceId) ? current : [...current, sourceId]) : current.filter((id) => id !== sourceId)) }

  return <section className="page-stack page-narrow search-page">
    <div className="page-heading compact-heading"><div><h1>搜索书籍</h1><p className="muted">{status === 'loading' ? '结果正在陆续到达…' : '输入书名或作者，找到后直接加入书架。'}</p></div></div>
    <form className="search-panel" onSubmit={(event) => void submitSearch(event)}>
      <div className="search-row"><label className="sr-only" htmlFor="search-keyword">关键词</label><Input className="search-input" id="search-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名、作者或分类" autoComplete="off" /><Button type="submit" disabled={status === 'loading' || keyword.trim().length === 0 || sourceIds.length === 0}>{status === 'loading' ? '搜索中' : '搜索'}</Button></div>
      <div className="search-options"><button className="filter-toggle" type="button" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((value) => !value)}><span>{sourceLabel}</span><span aria-hidden="true">{sourcesOpen ? '⌃' : '⌄'}</span></button><label className="check-inline"><input type="checkbox" checked={precision} onChange={(event) => setPrecision(event.target.checked)} /><span>精确</span></label>{status === 'loading' ? <Button className="cancel-button" variant="secondary" size="sm" type="button" onClick={() => void cancelSearch()}>取消</Button> : null}</div>
      {sourcesOpen ? <div className="source-picker"><div className="source-picker-toolbar"><Input aria-label="筛选书源" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setSourceLimit(INITIAL_SOURCE_LIMIT) }} placeholder="筛选书源" /><div className="source-picker-actions"><Button variant="secondary" size="sm" type="button" onClick={() => setSourceIds(sources.map((source) => source.sourceId))}>全选</Button><Button variant="secondary" size="sm" type="button" onClick={() => setSourceIds([])}>清空</Button></div></div><div className="source-checks compact-source-checks">{visibleSources.map((source) => <label className="source-check" key={source.sourceId}><input type="checkbox" checked={sourceIds.includes(source.sourceId)} onChange={(event) => toggleSource(source.sourceId, event.target.checked)} /><span>{source.name}{source.group === undefined ? '' : ` · ${source.group}`}</span></label>)}</div>{visibleSources.length < filteredSources.length ? <button className="text-button" type="button" onClick={() => setSourceLimit((value) => value + INITIAL_SOURCE_LIMIT)}>显示更多书源</button> : null}{filteredSources.length === 0 ? <p className="muted small">没有匹配的书源。</p> : null}<Link className="text-button" to="/sources">管理书源</Link></div> : null}
    </form>
    {message.length > 0 ? <p className={`${messageTone === 'error' ? 'error' : messageTone === 'success' ? 'success' : 'muted'} compact-message`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</p> : null}
    <div className="result-summary" aria-live="polite">{status === 'loading' ? '正在搜索' : status === 'done' ? `找到 ${candidates.length} 条结果` : candidates.length > 0 ? `${candidates.length} 条结果` : ''}{hasNextPage ? <Button className="inline-action" variant="secondary" size="sm" type="button" disabled={status === 'loading'} onClick={() => void continueNextPage()}>下一页</Button> : null}</div>
    <div className="result-list">{candidates.length === 0 && status === 'done' ? <div className="empty-state">没有找到匹配书籍。</div> : candidates.map((item, index) => <SearchResult key={`${item.sourceId}:${item.candidate.bookUrl}:${index}`} item={item} index={index} expanded={expandedIndex === index} onToggle={() => setExpandedIndex((current) => current === index ? undefined : index)} books={books} targetBookId={targetByIndex[index] ?? ''} onTargetChange={(value) => setTargetByIndex((current) => ({ ...current, [index]: value }))} saving={saving === index} onSave={(target) => void saveCandidate(index, target)} />)}</div>
  </section>
}

function SearchResult({ item, index, expanded, onToggle, books, targetBookId, onTargetChange, saving, onSave }: { item: ApiCandidate; index: number; expanded: boolean; onToggle: () => void; books: ApiBook[]; targetBookId: string; onTargetChange: (value: string) => void; saving: boolean; onSave: (target?: string) => void }) {
  const intro = item.candidate.intro?.trim() ?? ''
  const source = item.sourceId
  return <article className="result-card"><BookCover name={item.candidate.name ?? '未命名书籍'} coverUrl={item.candidate.coverUrl} size="result" /><div className="result-card-body"><div className="result-card-heading"><div><h2>{item.candidate.name ?? '未命名书籍'}</h2><p className="muted small">{item.candidate.author ?? '作者未知'} · {source}</p></div><Button className="save-button" variant="secondary" size="sm" type="button" disabled={saving} onClick={() => onSave()}>{saving ? '保存中' : '加入书架'}</Button></div>{intro.length > 0 ? <div className={`result-intro ${expanded ? 'expanded' : ''}`}><p>{intro}</p>{intro.length > 90 ? <button className="text-button" type="button" onClick={onToggle}>{expanded ? '收起简介' : '展开简介'}</button> : null}</div> : null}{books.length > 0 ? <details className="save-existing"><summary>添加到已有书籍</summary><div className="save-existing-row"><label className="sr-only" htmlFor={`target-book-${index}`}>选择已有书籍</label><Select id={`target-book-${index}`} value={targetBookId} onChange={(event) => onTargetChange(event.target.value)}><option value="">选择书籍</option>{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</Select><Button size="sm" type="button" disabled={saving || targetBookId.length === 0} onClick={() => onSave(targetBookId)}>保存</Button></div></details> : null}</div></article>
}
