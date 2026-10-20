import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageBackButton } from '../components/page-back-button.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { SourceImportDialog } from '../components/source-import-dialog.tsx'
import { apiFetch } from '../lib/api.ts'
import { formatSourceRuleDateTime } from '../lib/time-format.ts'
import { compareSourceManagementOrder, groupSourcesByDomain, sourceDomainInfo, type SourceDomainGroup } from '../../shared/source-domain.ts'
import type { ManagedSourceSummary, SourceManagementPage, SourceManagementStatus } from '../../shared/source-management.ts'

export function SourcesPage() {
  const cache = useBookCache()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<SourceManagementStatus>('all')
  const [data, setData] = useState<SourceManagementPage | null>(null)
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const actionRef = useRef(false)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [acting, setActing] = useState(false)

  const load = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController(); requestRef.current = controller
    setLoading(true); setError('')
    try {
      const next = await apiFetch<SourceManagementPage>('/api/source-management?all=true', { signal: controller.signal })
      if (!controller.signal.aborted) setData(next)
    } catch (loadError) { if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : '书源加载失败') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }, [])
  useEffect(() => { mounted.current = true; if (!actionRef.current) setActing(false); return () => { mounted.current = false; requestRef.current?.abort() } }, [load])
  usePageLoadEffect((settle) => { void load().then(settle); return () => requestRef.current?.abort() }, [], ['sources'])

  const groups = useMemo(() => groupSourcesByDomain(data?.sources ?? []), [data?.sources])
  const visibleGroups = groups.filter((group) => {
    const matchesQuery = query.trim().length === 0 || group.versions.some(({ source }) => `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    const matchesStatus = status === 'all' || group.versions.some(({ source }) => status === 'enabled' ? source.enabled : !source.enabled)
    return matchesQuery && matchesStatus
  })
  const visibleSources = visibleGroups.flatMap((group) => group.versions.map(({ source }) => source))
  const enabledDomainCount = groups.filter((group) => group.versions.some(({ source }) => source.enabled)).length
  const selectedSources = data?.sources.filter((source) => selected.has(source.sourceId)) ?? []
  const selectedDomains = new Set(selectedSources.map((source) => sourceDomainInfo(source.sourceId).key))
  const enableConflict = selectedSources.length !== selectedDomains.size
  const pageSelectedCount = visibleSources.filter((source) => selected.has(source.sourceId)).length
  const pageSelected = visibleSources.length > 0 && pageSelectedCount === visibleSources.length

  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = pageSelectedCount > 0 && !pageSelected
  }, [pageSelected, pageSelectedCount])

  function toggle(source: ManagedSourceSummary, checked: boolean) {
    setSelected((current) => {
      const next = new Map(current)
      if (checked) next.set(source.sourceId, source.sourceRevision)
      else next.delete(source.sourceId)
      return next
    })
  }

  function toggleMany(sources: ManagedSourceSummary[], checked: boolean) {
    setSelected((current) => {
      const next = new Map(current)
      for (const source of sources) {
        if (checked) next.set(source.sourceId, source.sourceRevision)
        else next.delete(source.sourceId)
      }
      return next
    })
  }

  async function apply(action: 'enable' | 'disable' | 'delete', sources?: ManagedSourceSummary[]) {
    const items = sources === undefined
      ? [...selected.entries()].map(([sourceId, expectedSourceRevision]) => ({ sourceId, expectedSourceRevision }))
      : sources.map((source) => ({ sourceId: source.sourceId, expectedSourceRevision: source.sourceRevision }))
    if (items.length === 0 || actionRef.current) return
    if (action === 'enable' && new Set(items.map((item) => sourceDomainInfo(item.sourceId).key)).size !== items.length) {
      setError('每个域名只能选择一个实现作为账号默认版本。')
      return
    }
    if (action === 'delete' && !window.confirm(`确定删除 ${items.length} 个书源实现吗？书架和阅读进度会保留。`)) return
    actionRef.current = true; setActing(true)
    setMessage(''); setError('')
    try {
      let affected = 0
      for (let offset = 0; offset < items.length; offset += 1000) {
        if (!mounted.current) return
        const result = await apiFetch<{ affected: number }>('/api/source-management/actions', { method: 'POST', body: JSON.stringify({ action, items: items.slice(offset, offset + 1000) }) })
        affected += result.affected; cache.clear(); if (!mounted.current) return; setMessage('已处理 ' + affected + ' 个书源实现')
      }
      setMessage(`${action === 'delete' ? '已删除' : action === 'enable' ? '已切换' : '已禁用'} ${affected} 个书源实现`); setSelected(new Map())
    } catch (actionError) { if (!mounted.current) return; await load(); if (!mounted.current) return; setError(actionError instanceof Error ? actionError.message : '书源操作失败') }
    finally { actionRef.current = false; if (mounted.current) setActing(false) }
  }

  return <section className="page-stack page-narrow sources-page">
    <div className="toc-heading"><div className="toc-heading-main"><PageBackButton fallback="/account/settings" /><h1>书源</h1><p className="muted">{data === null ? '按域名管理当前账号的书源实现。' : `共 ${groups.length} 个域名、${data.sources.length} 个实现，启用 ${enabledDomainCount} 个域名`}</p></div><Button size="sm" type="button" onClick={() => setImportOpen(true)}>导入</Button></div>
    <div className="source-management-filters"><Input aria-label="搜索书源" placeholder="搜索名称、分组、域名或 URL" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(new Map()) }} /><Select aria-label="筛选状态" value={status} onChange={(event) => { setStatus(event.target.value as SourceManagementStatus); setSelected(new Map()) }}><option value="all">全部</option><option value="enabled">启用</option><option value="disabled">禁用</option></Select></div>
    {message.length > 0 ? <p className="success" role="status">{message}</p> : null}{error.length > 0 ? <p className="error" role="alert">{error}<Button variant="secondary" size="sm" type="button" onClick={() => void load()}>重试</Button></p> : null}
    {selected.size > 0 ? <div className="source-bulk-bar"><span>已选 {selected.size} 个实现{enableConflict ? '，同域多选时不能批量启用' : ''}</span><div className="actions"><Button size="sm" type="button" disabled={acting || loading || enableConflict} onClick={() => void apply('enable')}>设为默认</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={() => void apply('disable')}>禁用</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={() => void apply('delete')}>删除</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={() => setSelected(new Map())}>清空</Button></div></div> : null}
    {loading ? <LoadingState message={data === null ? '正在加载书源…' : '正在更新书源…'} variant={data === null ? 'content' : 'inline'} action={data === null ? <PageBackButton appearance="button" fallback="/account/settings" /> : undefined} /> : null}
    {data === null ? null : visibleGroups.length === 0 ? loading ? null : <div className="empty-state">没有匹配的书源域名。</div> : <><div className="source-list-header"><label><input ref={selectAllRef} type="checkbox" checked={pageSelected} disabled={loading} onChange={(event) => toggleMany(visibleSources, event.target.checked)} /> 全选筛选结果</label><span className="muted small">显示 {visibleGroups.length} 个域名、{visibleSources.length} 个实现</span></div><div className="source-management-list">{visibleGroups.map((group) => <SourceDomainRow key={group.domainKey} group={group} busy={acting || loading} selected={selected} onToggle={(source, checked) => toggle(source, checked)} onToggleGroup={(sources, checked) => toggleMany(sources, checked)} onAction={(source, action) => void apply(action, [source])} />)}</div></>}
    <SourceImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(imported) => { setImportOpen(false); cache.clear(); setMessage(`已导入 ${imported} 个书源`) }} />
  </section>
}

function SourceDomainRow({ group, busy, selected, onToggle, onToggleGroup, onAction }: { group: SourceDomainGroup<ManagedSourceSummary>; busy: boolean; selected: Map<string, string>; onToggle: (source: ManagedSourceSummary, checked: boolean) => void; onToggleGroup: (sources: ManagedSourceSummary[], checked: boolean) => void; onAction: (source: ManagedSourceSummary, action: 'enable' | 'disable' | 'delete') => void }) {
  const groupCheckRef = useRef<HTMLInputElement>(null)
  const selectedCount = group.versions.filter(({ source }) => selected.has(source.sourceId)).length
  const groupSelected = selectedCount === group.versions.length
  const enabled = group.versions.filter(({ source }) => source.enabled)
  const effective = [...enabled].sort((left, right) => compareSourceManagementOrder(left.source, right.source))[0]
  const latest = group.versions[0]?.source

  useEffect(() => {
    if (groupCheckRef.current !== null) groupCheckRef.current.indeterminate = selectedCount > 0 && !groupSelected
  }, [groupSelected, selectedCount])

  return <article className="source-domain-group">
    <div className="source-domain-header">
      <label className="source-management-check"><input ref={groupCheckRef} type="checkbox" checked={groupSelected} disabled={busy} onChange={(event) => onToggleGroup(group.versions.map(({ source }) => source), event.target.checked)} /><span className="sr-only">选择 {group.domain} 的全部实现</span></label>
      <details className="source-domain-details">
        <summary className="source-domain-summary"><span className="source-domain-heading-main"><strong title={group.domain}>{group.domain}</strong><span className="muted small">{group.versions.length} 个实现 · 最新规则 {formatSourceRuleDateTime(latest?.lastUpdateTime)}</span></span>{enabled.length > 1 ? <span className="badge source-status source-domain-warning">{enabled.length} 个旧启用项</span> : effective === undefined ? <span className="badge source-status source-disabled">全部禁用</span> : <span className="badge source-status source-enabled">当前 {group.versions.find(({ source }) => source.sourceId === effective.source.sourceId)?.displayName}</span>}</summary>
        <div className="source-domain-versions">{group.versions.map(({ source, displayName }) => <SourceVersionRow key={source.sourceId} source={source} displayName={displayName} busy={busy} selected={selected.has(source.sourceId)} onToggle={(checked) => onToggle(source, checked)} onAction={(action) => onAction(source, action)} />)}</div>
      </details>
    </div>
  </article>
}

function SourceVersionRow({ source, displayName, busy, selected, onToggle, onAction }: { source: ManagedSourceSummary; displayName: string; busy: boolean; selected: boolean; onToggle: (checked: boolean) => void; onAction: (action: 'enable' | 'disable' | 'delete') => void }) {
  return <article className="source-management-row source-domain-version"><label className="source-management-check"><input type="checkbox" checked={selected} disabled={busy} onChange={(event) => onToggle(event.target.checked)} /><span className="sr-only">选择 {displayName}</span></label><div className="source-management-info"><span className="source-management-title"><strong title={displayName}>{displayName}</strong><span className={`badge source-status ${source.enabled ? 'source-enabled' : 'source-disabled'}`}>{source.enabled ? '已启用' : '已禁用'}</span></span><span className="muted small">{source.group ?? '未分组'} · 规则更新时间 {formatSourceRuleDateTime(source.lastUpdateTime)}</span><span className="source-url" title={source.sourceId}>{source.sourceId}</span></div><div className="source-row-actions"><Button size="sm" variant="secondary" type="button" disabled={busy} onClick={() => onAction(source.enabled ? 'disable' : 'enable')}>{source.enabled ? '禁用' : '设为默认'}</Button><Button size="sm" variant="secondary" type="button" disabled={busy} onClick={() => onAction('delete')}>删除</Button></div></article>
}
