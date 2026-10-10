import { useEffect, useMemo, useRef, useState } from 'react'
import type { SourceCacheWarning } from '../../shared/book-sources.ts'
import { apiFetch, mergeSearchStreamCandidates, searchProgressFromEvent, streamSearchAll, type ApiCandidate, type ApiSearchProgress, type SearchSourceEventData } from './api.ts'
import { SearchOperation } from './search-operation.ts'

export function useBookSearch() {
  const [candidates, setCandidates] = useState<ApiCandidate[]>([])
  const [searchId, setSearchId] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<ApiSearchProgress | undefined>()
  const mounted = useRef(false)
  const progressRef = useRef<ApiSearchProgress | undefined>(undefined)
  const visibleProgressRef = useRef<ApiSearchProgress | undefined>(undefined)
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const operation = useMemo(() => new SearchOperation({
    create: async (keyword, precision) => (await apiFetch<{ search: { id: string } }>('/api/searches', { method: 'POST', body: JSON.stringify({ keyword, precision }) })).search.id,
    stream: streamSearchAll,
    cancel: (id) => apiFetch('/api/searches/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }),
  }), [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (progressTimerRef.current !== undefined) clearTimeout(progressTimerRef.current); void operation.cancel().catch(() => undefined) } }, [operation])
  function showProgress(value: ApiSearchProgress, immediate = false) {
    progressRef.current = value
    if (immediate || visibleProgressRef.current === undefined) {
      visibleProgressRef.current = value; if (mounted.current) setProgress(value); return
    }
    if (progressTimerRef.current !== undefined) return
    progressTimerRef.current = setTimeout(() => {
      progressTimerRef.current = undefined
      const latest = progressRef.current
      if (latest !== undefined) { visibleProgressRef.current = latest; if (mounted.current) setProgress(latest) }
    }, 5000)
  }
  async function search(keyword: string, precision: boolean) {
    if (operation.isRunning || keyword.trim().length === 0) return
    if (progressTimerRef.current !== undefined) {
      clearTimeout(progressTimerRef.current)
      progressTimerRef.current = undefined
    }
    setCandidates([]); setSearchId(''); setMessage(''); setProgress(undefined); progressRef.current = undefined; visibleProgressRef.current = undefined; setStatus('loading')
    try {
      const result = await operation.start(keyword.trim(), precision, (event) => {
        if (!mounted.current) return
        if (event.type === 'error') throw new Error((event.data as { message?: string }).message ?? '搜索失败')
        if (event.type === 'source-result' || event.type === 'batch-end') {
          const batch = event.data as SearchSourceEventData & { source?: { status?: string } }
          setCandidates((current) => mergeSearchStreamCandidates(current, batch))
          const nextProgress = searchProgressFromEvent(batch); if (nextProgress !== undefined) showProgress(nextProgress, event.type === 'batch-end')
          if (batch.source?.status === 'failed' || batch.source?.status === 'capability-missing') setMessage('部分书源执行失败，已保留可用结果。')
        }
        if (event.type === 'progress') { const nextProgress = searchProgressFromEvent(event.data as SearchSourceEventData); if (nextProgress !== undefined) showProgress(nextProgress) }
        if (event.type === 'batch') {
          const batch = event.data as SearchSourceEventData & { cacheWarning?: SourceCacheWarning; candidates?: ApiCandidate[] }
          setCandidates((current) => mergeSearchStreamCandidates(current, batch))
          const nextProgress = searchProgressFromEvent(batch); if (nextProgress !== undefined) showProgress(nextProgress, true)
          const warning = batch.cacheWarning
          if (warning !== undefined) setMessage(warning.message)
        }
      }, (id) => { if (mounted.current) setSearchId(id) })
      if (mounted.current) { setStatus('done'); if (result.cancelled) setMessage('搜索已取消，保留已有结果'); if (progressRef.current !== undefined) showProgress(progressRef.current, true) }
    } catch (reason) { if (mounted.current) { setStatus('error'); setMessage(reason instanceof Error ? reason.message : '搜索失败') } }
  }
  async function cancel() {
    try { await operation.cancel() }
    catch (reason) { if (mounted.current) setMessage(reason instanceof Error ? '取消请求失败：' + reason.message : '取消请求失败') }
  }
  return { candidates, searchId, status, message, progress, search, cancel }
}
