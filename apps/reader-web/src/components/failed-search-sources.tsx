import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { apiFetch, type ApiSearchSourceState } from '../lib/api.ts'
import type { ManagedSourceSummary, SourceManagementPage } from '../../shared/source-management.ts'
import { sourceDomainInfo } from '../../shared/source-domain.ts'
import { Button } from './ui/button.tsx'

export function FailedSearchSources({ sources, onDisabled }: { sources: ApiSearchSourceState[]; onDisabled?: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false)
  const [managedSources, setManagedSources] = useState<ManagedSourceSummary[]>([])
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const pendingRef = useRef(false)
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    void apiFetch<SourceManagementPage>('/api/source-management?all=true', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setManagedSources(result.sources); setError('') } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '书源信息加载失败') })
    return () => controller.abort()
  }, [retry, expanded])
  const byId = new Map(managedSources.map((source) => [source.sourceId, source]))
  async function disable(source: ManagedSourceSummary) {
    if (pendingRef.current) return
    pendingRef.current = true; setPending(source.sourceId); setError('')
    try {
      await apiFetch('/api/source-management/actions', { method: 'POST', body: JSON.stringify({ action: 'disable', items: [{ sourceId: source.sourceId, expectedSourceRevision: source.sourceRevision }] }) })
      setManagedSources((current) => current.map((item) => item.sourceId === source.sourceId ? { ...item, enabled: false } : item))
      await onDisabled?.()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '禁用失败') }
    finally { pendingRef.current = false; setPending(null) }
  }
  return <details className="failed-search-sources" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><span>本次搜索失败的书源（{sources.length}）</span><ChevronDown aria-hidden="true" /></summary>
    {error ? <div className="failed-source-error" role="alert"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>刷新书源信息</Button></div> : null}
    <div className="failed-source-list">{sources.map((state) => {
      const source = byId.get(state.sourceId)
      const duration = state.startedAt && state.completedAt ? Date.parse(state.completedAt) - Date.parse(state.startedAt) : NaN
      const reasons = state.diagnostics?.flatMap((diagnostic) => typeof diagnostic === 'object' && diagnostic !== null && 'message' in diagnostic && typeof diagnostic.message === 'string' ? [diagnostic.message] : []) ?? []
      return <article className="failed-source-item" key={state.sourceId}>
        <div className="failed-source-info"><strong>{source?.name ?? state.sourceId}</strong><p className="muted small">{sourceDomainInfo(state.sourceId).domain} · {source?.group?.trim() || '未分组'} · {Number.isFinite(duration) ? `耗时 ${Math.max(0, duration)}ms` : '耗时未知'}</p><p className="muted small">导入来源：{source?.importDisplayUrl || '未知'}</p><p className="small">{reasons.join('；') || (state.status === 'capability-missing' ? '缺少搜索能力' : '搜索执行失败')}</p></div>
        <Button variant="secondary" size="sm" disabled={!source || !source.enabled || pending !== null} onClick={() => { if (source) void disable(source) }}>{pending === state.sourceId ? '禁用中…' : source && !source.enabled ? '已禁用' : '禁用'}</Button>
      </article>
    })}</div>
  </details>
}
