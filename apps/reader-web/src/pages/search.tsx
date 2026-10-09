import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, type ApiCandidate, type ApiSource, streamSearch } from '../lib/api.ts'

export function SearchPage() {
  const [sources, setSources] = useState<ApiSource[]>([])
  const [sourceId, setSourceId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [candidates, setCandidates] = useState<ApiCandidate[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState<number | null>(null)
  const sourceName = useMemo(() => sources.find((source) => source.sourceId === sourceId)?.name, [sourceId, sources])

  useEffect(() => { void apiFetch<{ sources: ApiSource[] }>('/api/sources').then((result) => { setSources(result.sources); setSourceId(result.sources[0]?.sourceId ?? '') }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : '书源加载失败')) }, [])

  async function saveCandidate(index: number) {
    const result = candidates[index]
    if (result === undefined) return
    setSaving(index)
    try { await apiFetch('/api/books', { method: 'POST', body: JSON.stringify({ searchId, candidateIndex: index }) }); setMessage('已加入书架') } catch (error) { setMessage(error instanceof Error ? error.message : '加入书架失败') } finally { setSaving(null) }
  }

  const [searchId, setSearchId] = useState('')

  async function submitWithId(event: FormEvent) {
    event.preventDefault()
    if (keyword.trim().length === 0 || sourceId.length === 0) return
    setStatus('loading'); setMessage(''); setCandidates([])
    try {
      const created = await apiFetch<{ search: { id: string } }>('/api/searches', { method: 'POST', body: JSON.stringify({ keyword, sourceId }) })
      setSearchId(created.search.id)
      await streamSearch(created.search.id, (streamEvent) => {
        if (streamEvent.type === 'error') {
          const error = streamEvent.data as { message?: string }
          throw new Error(error.message ?? '搜索失败')
        }
        if (streamEvent.type === 'batch') {
          const batch = streamEvent.data as { candidates?: ApiCandidate[]; sourceStatus?: string }
          setCandidates((current) => [...current, ...(batch.candidates ?? [])])
          if (batch.sourceStatus === 'failed' || batch.sourceStatus === 'capability-missing') setMessage('书源执行失败，请检查书源配置。')
        }
      })
      setStatus('done')
    } catch (error) { setStatus('error'); setMessage(error instanceof Error ? error.message : '搜索失败') }
  }

  return <section className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">DISCOVER</p><h1>搜索书籍</h1><p className="muted">搜索会以流式结果逐步显示，较慢的书源也不会让页面失去响应。</p></div><Link className="button secondary" to="/">返回书架</Link></div>
    <form className="card search-form" onSubmit={submitWithId}>
      <div className="field"><label htmlFor="search-keyword">关键词</label><input id="search-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名、作者或分类" autoComplete="off" /></div>
      <div className="field"><label htmlFor="search-source">书源</label><select id="search-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={sources.length === 0}><option value="">选择书源</option>{sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.name}{source.group === undefined ? '' : ` · ${source.group}`}</option>)}</select>{sourceName === undefined && sources.length > 0 ? <span className="muted">请选择可用书源</span> : null}</div>
      <button className="button" type="submit" disabled={status === 'loading' || sourceId.length === 0}>{status === 'loading' ? '搜索中…' : '开始搜索'}</button>
    </form>
    {message.length > 0 ? <p className={status === 'error' ? 'error' : 'success'} role="status">{message}</p> : null}
    <div className="result-list" aria-live="polite">{candidates.length === 0 && status === 'done' ? <div className="empty-state">没有找到匹配书籍。</div> : candidates.map((item, index) => <article className="result-card" key={`${item.sourceId}:${item.candidate.bookUrl}:${index}`}><div><h2>{item.candidate.name ?? '未命名书籍'}</h2><p className="muted">{item.candidate.author ?? '作者未知'}</p>{item.candidate.intro === undefined ? null : <p>{item.candidate.intro}</p>}<p className="muted small">{item.sourceId}</p></div><button className="button secondary" type="button" onClick={() => void saveCandidate(index)} disabled={saving === index}>{saving === index ? '保存中…' : '加入书架'}</button></article>)}</div>
  </section>
}
