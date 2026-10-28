import type { ReadingSourceSummary } from '../../shared/source-management.ts'
import { publishPageMutation } from './page-data.ts'
import { usePageNavigation } from './use-page-resource.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SourceCacheWarning } from '../../shared/book-sources.ts'
import { ApiError, apiFetch, mergeSearchStreamCandidates, searchProgressFromEvent, streamSearchAll, type ApiCandidate, type ApiSearchProgress, type SearchSourceEventData } from './api.ts'
import { SearchOperation } from './search-operation.ts'

export function useBookSearch() {
  const navigation = usePageNavigation()
  const userId = navigation?.userId
  const settleState = useRef<{ status: 'done' | 'error' | 'paused'; message: string } | undefined>(undefined)
  const [sourceSummaries, setSourceSummaries] = useState<ReadingSourceSummary[]>([])
  const [candidates, setCandidates] = useState<ApiCandidate[]>([])
  const [searchId, setSearchId] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error' | 'paused'>('idle')
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<ApiSearchProgress | undefined>()
  const retainedSourceIds = useRef<string[] | undefined>(undefined)
  const candidateSearchIds = useRef(new WeakMap<ApiCandidate, string>())
  const ordering = useRef({ keyword: '', precision: false })
  const mounted = useRef(false)
  const progressRef = useRef<ApiSearchProgress | undefined>(undefined)
  const searchTaskRef = useRef<Promise<void> | null>(null)
  const operation = useMemo(() => new SearchOperation({
    create: async (keyword, precision, sourceIds) => (await apiFetch<{ search: { id: string } }>('/api/searches', { method: 'POST', body: JSON.stringify({ keyword, precision, ...(sourceIds === undefined ? {} : { sourceIds }) }) }, userId)).search.id,
    stream: streamSearchAll,
    cancel: (id) => apiFetch('/api/searches/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }, userId),
  }), [userId])
  useEffect(() => {
    mounted.current = true
    const settled = settleState.current
    if (settled !== undefined) { setStatus(settled.status); if (settled.message) setMessage(settled.message) }
    return () => {
      mounted.current = false
      void operation.cancel().catch((reason: unknown) => {
        settleState.current = { status: 'error', message: reason instanceof Error ? reason.message : '取消请求失败' }
      })
    }
  }, [operation])
  function showProgress(value: ApiSearchProgress) {
    progressRef.current = value
    if (mounted.current) setProgress(value)
  }
  async function runSearch(keyword: string, precision: boolean, sourceIds?: string[], resumeId?: string, preserveResults = false): Promise<boolean> {
    if (operation.isRunning || (!resumeId && keyword.trim().length === 0)) return false
    settleState.current = undefined
    if (!resumeId) { ordering.current = { keyword, precision }; if (!preserveResults) { setCandidates([]); setSourceSummaries([]) } setSearchId('') } setMessage(''); setProgress(undefined); progressRef.current = undefined; setStatus('loading')
    let succeeded = true
    if (!resumeId) retainedSourceIds.current = preserveResults ? sourceIds : undefined
    const retainedSources = retainedSourceIds.current
    let currentSearchId = resumeId ?? ''
    let currentCandidates: ApiCandidate[] = resumeId ? candidates.filter((item) => candidateSearchIds.current.get(item) === resumeId) : []
    function updateCandidates(batch: SearchSourceEventData) {
      const summary = batch.sourceSummary
      if (summary !== undefined) setSourceSummaries((current) => [...current.filter((source) => source.sourceId !== summary.sourceId), summary])
      currentCandidates = mergeSearchStreamCandidates(currentCandidates, batch, ordering.current)
      // 保留其他搜索的候选时，打开操作仍必须使用候选所属的搜索记录。
      for (const item of currentCandidates) candidateSearchIds.current.set(item, currentSearchId)
      setCandidates((current) => retainedSources !== undefined
        ? [...current.filter((item) => !retainedSources.includes(item.sourceId)), ...currentCandidates]
        : currentCandidates)
    }
    const task = (async () => {
      try {
        const result = await operation.start(keyword.trim(), precision, (event) => {
          if (!mounted.current) return
          if (event.type === 'error') { const detail = event.data as { code?: string; message?: string }; throw new ApiError(detail.code ?? 'server-error', detail.message ?? '搜索失败', 500) }
          if (event.type === 'source-result' || event.type === 'batch-end') {
            const batch = event.data as SearchSourceEventData & { source?: { status?: string } }
            updateCandidates(batch)
            const nextProgress = searchProgressFromEvent(batch)
            if (nextProgress !== undefined) showProgress(nextProgress)
            if (batch.source?.status === 'failed' || batch.source?.status === 'capability-missing') setMessage('部分书源执行失败，已保留可用结果。')
          }
          if (event.type === 'progress') {
            const nextProgress = searchProgressFromEvent(event.data as SearchSourceEventData)
            if (nextProgress !== undefined) showProgress(nextProgress)
          }
          if (event.type === 'batch') {
            const batch = event.data as SearchSourceEventData & { cacheWarning?: SourceCacheWarning; candidates?: ApiCandidate[] }
            updateCandidates(batch)
            const nextProgress = searchProgressFromEvent(batch)
            if (nextProgress !== undefined) showProgress(nextProgress)
            const warning = batch.cacheWarning
            if (warning !== undefined) setMessage(warning.message)
          }
        }, (id) => { currentSearchId = id; if (mounted.current) setSearchId(id) }, sourceIds, resumeId)
        succeeded = !result.cancelled
        settleState.current = { status: 'done', message: result.cancelled ? '搜索已取消，保留已有结果' : '' }
        setStatus('done'); if (result.cancelled) setMessage('搜索已取消，保留已有结果')
        if (userId !== undefined) publishPageMutation({ userId, path: '/api/searches', method: 'POST' })
        if (mounted.current && progressRef.current !== undefined) showProgress(progressRef.current)
      } catch (reason) {
        succeeded = false
        settleState.current = { status: reason instanceof ApiError && ['search-paused', 'server-error', 'source-busy'].includes(reason.code) ? 'paused' : 'error', message: reason instanceof Error ? reason.message : '搜索失败' }
        setStatus(settleState.current.status); setMessage(settleState.current.message)
      }
    })()
    searchTaskRef.current = task
    try { await task } finally { if (searchTaskRef.current === task) searchTaskRef.current = null }
    return succeeded
  }
  async function search(keyword: string, precision: boolean, sourceIds?: string[]): Promise<boolean> {
    if (operation.isRunning || searchTaskRef.current !== null) return false
    try { if (operation.hasPendingCancellation) await operation.cancel() }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : '取消请求失败'); return false }
    if (status === 'paused') await cancelAndWait()
    return runSearch(keyword, precision, sourceIds)
  }
  async function cancelAndWait() {
    const activeTask = searchTaskRef.current
    if (status === 'paused' && searchId) await apiFetch('/api/searches/' + encodeURIComponent(searchId) + '/cancel', { method: 'POST' }, userId)
    await operation.cancel()
    if (activeTask !== null) {
      await activeTask
    }
  }
  async function replaceSearch(keyword: string, precision: boolean, sourceIds?: string[], preserveResults = false): Promise<boolean> {
    await cancelAndWait()
    if (mounted.current) return runSearch(keyword, precision, sourceIds, undefined, preserveResults)
    return false
  }
  async function cancel() {
    try {
      await cancelAndWait()
      settleState.current = { status: 'done', message: '搜索已取消，保留已有结果' }
      setStatus('done'); setMessage(settleState.current.message)
    }
    catch (reason) { if (mounted.current) setMessage(reason instanceof Error ? '取消请求失败：' + reason.message : '取消请求失败') }
  }
  return { sourceSummaries, candidates, candidateSearchId: (candidate: ApiCandidate) => candidateSearchIds.current.get(candidate) ?? searchId, searchId, status, message, progress, cancellationPending: operation.hasPendingCancellation, isTargetedSearch: retainedSourceIds.current !== undefined, resume: () => runSearch('', false, undefined, searchId), search, replaceSearch, cancelAndWait, cancel }
}
