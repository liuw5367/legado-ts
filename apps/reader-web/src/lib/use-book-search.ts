import { useEffect, useMemo, useRef, useState } from 'react'
import type { SourceCacheWarning } from '../../shared/book-sources.ts'
import { apiFetch, mergeSearchStreamCandidates, streamSearch, type ApiCandidate, type SearchSourceEventData } from './api.ts'
import { SearchOperation } from './search-operation.ts'

export function useBookSearch() {
  const [candidates, setCandidates] = useState<ApiCandidate[]>([])
  const [searchId, setSearchId] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const mounted = useRef(false)
  const operation = useMemo(() => new SearchOperation({
    create: async (keyword, precision) => (await apiFetch<{ search: { id: string } }>('/api/searches', { method: 'POST', body: JSON.stringify({ keyword, precision }) })).search.id,
    stream: streamSearch,
    cancel: (id) => apiFetch('/api/searches/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }),
  }), [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void operation.cancel().catch(() => undefined) } }, [operation])
  async function search(keyword: string, precision: boolean) {
    if (status === 'loading' || keyword.trim().length === 0) return
    setCandidates([]); setSearchId(''); setMessage(''); setStatus('loading')
    try {
      const result = await operation.start(keyword.trim(), precision, (event) => {
        if (!mounted.current) return
        if (event.type === 'error') throw new Error((event.data as { message?: string }).message ?? '搜索失败')
        if (event.type === 'source-result' || event.type === 'batch-end') {
          const batch = event.data as SearchSourceEventData & { source?: { status?: string } }
          setCandidates((current) => mergeSearchStreamCandidates(current, batch))
          if (batch.source?.status === 'failed' || batch.source?.status === 'capability-missing') setMessage('部分书源执行失败，已保留可用结果。')
        }
        if (event.type === 'batch') {
          const warning = (event.data as { cacheWarning?: SourceCacheWarning }).cacheWarning
          if (warning !== undefined) setMessage(warning.message)
        }
      }, (id) => { if (mounted.current) setSearchId(id) })
      if (mounted.current) { setStatus('done'); if (result.cancelled) setMessage('搜索已取消') }
    } catch (reason) { if (mounted.current) { setStatus('error'); setMessage(reason instanceof Error ? reason.message : '搜索失败') } }
  }
  async function cancel() {
    try { await operation.cancel() }
    catch (reason) { if (mounted.current) setMessage(reason instanceof Error ? '取消请求失败：' + reason.message : '取消请求失败') }
  }
  return { candidates, searchId, status, message, search, cancel }
}
