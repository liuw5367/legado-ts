import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, mergeSearchStreamCandidates, type ApiBook, type ApiCandidate, type ApiSource, type SearchSourceEventData, streamSearch } from '../lib/api.ts'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'

export function SearchPage() {
  const [searchParams] = useSearchParams()
  const [sources, setSources] = useState<ApiSource[]>([])
  const [books, setBooks] = useState<ApiBook[]>([])
  const [targetBookId, setTargetBookId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [precision, setPrecision] = useState(false)
  const [keyword, setKeyword] = useState(() => searchParams.get('q') ?? '')
  const [candidates, setCandidates] = useState<ApiCandidate[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState<number | null>(null)
  const [hasNextPage, setHasNextPage] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const sourceName = useMemo(() => sources.find((source) => source.sourceId === sourceId)?.name, [sourceId, sources])

  useEffect(() => { void Promise.all([apiFetch<{ sources: ApiSource[] }>('/api/sources'), apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books')]).then(([sourceResult, bookResult]) => { setSources(sourceResult.sources); setSourceId(sourceResult.sources[0]?.sourceId ?? ''); setSourceIds(sourceResult.sources.map((source) => source.sourceId)); setBooks(bookResult.books.map((item) => item.book)) }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : '搜索配置加载失败')) }, [])

  async function saveCandidate(index: number) {
    const result = candidates[index]
    if (result === undefined) return
    setSaving(index)
    try { await apiFetch('/api/books', { method: 'POST', body: JSON.stringify({ searchId, candidateIndex: index, ...(targetBookId.length === 0 ? {} : { bookId: targetBookId }) }) }); setMessage(targetBookId.length === 0 ? '已加入书架' : '已添加到现有书籍，并切换为当前版本') } catch (error) { setMessage(error instanceof Error ? error.message : '加入书架失败') } finally { setSaving(null) }
  }

  const [searchId, setSearchId] = useState('')

  async function submitWithId(event: FormEvent) {
    event.preventDefault()
    if (keyword.trim().length === 0 || sourceIds.length === 0) return
    setStatus('loading'); setMessage(''); setCandidates([])
    const controller = new AbortController(); controllerRef.current = controller
    try {
      const created = await apiFetch<{ search: { id: string } }>('/api/searches', { method: 'POST', body: JSON.stringify({ keyword, sourceIds, precision }) })
      setSearchId(created.search.id)
      await streamSearch(created.search.id, (streamEvent) => {
        if (streamEvent.type === 'error') {
          const error = streamEvent.data as { message?: string }
          throw new Error(error.message ?? '搜索失败')
        }
        if (streamEvent.type === 'source-result') {
          const batch = streamEvent.data as SearchSourceEventData & { source?: { candidates?: ApiCandidate[]; status?: string; nextCursor?: unknown } }
          setCandidates((current) => mergeSearchStreamCandidates(current, batch))
          if (batch.source?.status === 'failed' || batch.source?.status === 'capability-missing') setMessage('部分书源执行失败，已保留可用结果。')
        }
        if (streamEvent.type === 'batch-end') {
          const batch = streamEvent.data as SearchSourceEventData & { search?: { sourceStates?: Array<{ nextCursor?: unknown }>; candidates?: ApiCandidate[] } }
          setCandidates((current) => mergeSearchStreamCandidates(current, batch))
          setHasNextPage(batch.search?.sourceStates?.some((source) => source.nextCursor !== undefined) === true)
        }
      }, controller.signal)
      setStatus('done')
    } catch (error) { setStatus('error'); setMessage(error instanceof DOMException && error.name === 'AbortError' ? '搜索已取消' : error instanceof Error ? error.message : '搜索失败') } finally { controllerRef.current = null }
  }

  async function continueNextPage() {
    if (searchId.length === 0 || !hasNextPage) return
    const controller = new AbortController(); controllerRef.current = controller; setStatus('loading'); setMessage('')
    try { await streamSearch(searchId, (streamEvent) => { if (streamEvent.type === 'source-result') { const data = streamEvent.data as SearchSourceEventData; setCandidates((current) => mergeSearchStreamCandidates(current, data)) } if (streamEvent.type === 'batch-end') { const data = streamEvent.data as SearchSourceEventData & { search?: { sourceStates?: Array<{ nextCursor?: unknown }>; candidates?: ApiCandidate[] } }; setCandidates((current) => mergeSearchStreamCandidates(current, data)); setHasNextPage(data.search?.sourceStates?.some((source) => source.nextCursor !== undefined) === true) } }, controller.signal, { nextPage: true }); setStatus('done') } catch (error) { setStatus('error'); setMessage(error instanceof Error ? error.message : '加载下一页失败') } finally { controllerRef.current = null }
  }

  async function cancelSearch() { controllerRef.current?.abort(); if (searchId.length > 0) await apiFetch(`/api/searches/${encodeURIComponent(searchId)}/cancel`, { method: 'POST' }).catch(() => undefined); setStatus('done'); setMessage('搜索已取消') }

  return <section className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">DISCOVER</p><h1>搜索书籍</h1><p className="muted">搜索会以流式结果逐步显示，较慢的书源也不会让页面失去响应。</p></div><Link className="button secondary" to="/">返回书架</Link></div>
    <form className="card search-form" onSubmit={submitWithId}>
      <div className="field"><label htmlFor="search-keyword">关键词</label><Input id="search-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名、作者或分类" autoComplete="off" /></div>
      <div className="field"><span className="field-label">书源</span><div className="source-checks">{sources.map((source) => <label className="source-check" key={source.sourceId}><input type="checkbox" checked={sourceIds.includes(source.sourceId)} onChange={(event) => setSourceIds((current) => event.target.checked ? [...current, source.sourceId] : current.filter((id) => id !== source.sourceId))} /><span>{source.name}{source.group === undefined ? '' : ` · ${source.group}`}</span></label>)}</div>{sourceName === undefined && sources.length > 0 ? <span className="muted">请选择可用书源</span> : null}</div>
      <label className="precision-toggle"><input type="checkbox" checked={precision} onChange={(event) => setPrecision(event.target.checked)} /><span>精确搜索</span><span className="muted small">只保留书名、作者或分类包含关键词的结果</span></label>
      {books.length > 0 ? <div className="field"><label htmlFor="target-book">保存到</label><Select id="target-book" value={targetBookId} onChange={(event) => setTargetBookId(event.target.value)}><option value="">新建书籍</option>{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</Select><span className="muted small">选择已有书籍后，会为它增加一个书源版本。</span></div> : null}
      <div className="actions"><Button type="submit" disabled={status === 'loading' || sourceIds.length === 0}>{status === 'loading' ? '搜索中…' : '开始搜索'}</Button>{status === 'loading' ? <Button variant="secondary" type="button" onClick={() => void cancelSearch()}>取消</Button> : null}{status === 'done' && hasNextPage ? <Button variant="secondary" type="button" onClick={() => void continueNextPage()}>加载下一页</Button> : null}</div>
    </form>
    {message.length > 0 ? <p className={status === 'error' ? 'error' : 'success'} role="status">{message}</p> : null}
    <div className="result-list" aria-live="polite">{candidates.length === 0 && status === 'done' ? <div className="empty-state">没有找到匹配书籍。</div> : candidates.map((item, index) => <article className="result-card" key={`${item.sourceId}:${item.candidate.bookUrl}:${index}`}><div><h2>{item.candidate.name ?? '未命名书籍'}</h2><p className="muted">{item.candidate.author ?? '作者未知'}</p>{item.candidate.intro === undefined ? null : <p>{item.candidate.intro}</p>}<p className="muted small">{item.sourceId}</p></div><Button variant="secondary" type="button" onClick={() => void saveCandidate(index)} disabled={saving === index}>{saving === index ? '保存中…' : '加入书架'}</Button></article>)}</div>
  </section>
}
