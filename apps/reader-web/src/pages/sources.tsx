import { EmptyState } from '../components/empty-state.tsx'
import { SearchX } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { FloatingMessage } from '../components/floating-message.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { Import } from 'lucide-react'
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
import { groupSourcesByDomain, sourceDomainInfo, type SourceDomainGroup } from '../../shared/source-domain.ts'
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

  function invertVisibleSelection() {
    setSelected((current) => {
      const next = new Map(current)
      for (const source of visibleSources) {
        if (next.has(source.sourceId)) next.delete(source.sourceId)
        else next.set(source.sourceId, source.sourceRevision)
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

  return <section className={`page-stack page-narrow sources-page${selected.size > 0 ? ' has-selection' : ''}`}>
    <PageHeader backTo="/account/settings" title="书源" description={data === null ? '按域名管理当前账号的书源实现。' : `共 ${groups.length} 个域名、${data.sources.length} 个实现，启用 ${enabledDomainCount} 个域名`} actions={<Button size="sm" className="page-action" type="button" onClick={() => setImportOpen(true)}><Import aria-hidden="true" /><span>导入</span></Button>} />
    <nav className="actions source-management-nav" aria-label="书源导入管理"><Link to="/sources/import-history">导入记录</Link><Link to="/sources/import-links">来源排序</Link></nav>
    <div className="source-management-filters"><Input aria-label="搜索书源" placeholder="搜索名称、分组、域名或 URL" value={query} onChange={(event) => { setQuery(event.target.value) }} /><Select aria-label="筛选状态" value={status} onChange={(event) => { setStatus(event.target.value as SourceManagementStatus) }}><option value="all">全部</option><option value="enabled">启用</option><option value="disabled">禁用</option></Select></div>
    {error.length > 0 ? <DismissibleMessage onDismiss={() => setError('')} className="error" role="alert">{error}<Button variant="secondary" size="sm" type="button" onClick={() => void load()}>重试</Button></DismissibleMessage> : null}
    {selected.size > 0 ? <div className="source-bulk-bar"><span>已选 {selected.size} 个实现{enableConflict ? '，同域多选时不能批量启用' : ''}</span><div className="actions"><Button size="sm" type="button" disabled={acting || loading || enableConflict} onClick={() => void apply('enable')}>启用</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={() => void apply('disable')}>禁用</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={() => void apply('delete')}>删除</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={() => setSelected(new Map())}>清空</Button></div></div> : null}
    {loading ? <LoadingState message={data === null ? '正在加载书源…' : '正在更新书源…'} variant={data === null ? 'viewport' : 'inline'} action={data === null ? <PageBackButton appearance="button" fallback="/account/settings" /> : undefined} /> : null}
    {data === null ? null : visibleGroups.length === 0 ? loading ? null : <EmptyState icon={SearchX} title="没有匹配的书源域名" description="调整筛选条件或导入书源" /> : <><div className="source-list-header"><div className="actions source-selection-actions" role="group" aria-label="书源列表批量选择"><label className="button small secondary source-select-all"><input ref={selectAllRef} type="checkbox" checked={pageSelected} disabled={acting || loading} onChange={(event) => toggleMany(visibleSources, event.target.checked)} /><span>全选</span></label><Button size="sm" variant="secondary" type="button" disabled={acting || loading} onClick={invertVisibleSelection}>反选</Button><Button size="sm" variant="secondary" type="button" disabled={acting || loading || pageSelectedCount === 0} onClick={() => toggleMany(visibleSources, false)}>清空</Button></div><span className="muted small">显示 {visibleGroups.length} 个域名、{visibleSources.length} 个实现</span></div><div className="source-management-list">{visibleGroups.map((group) => <SourceDomainRow key={group.domainKey} group={group} busy={acting || loading} selected={selected} onToggle={(source, checked) => toggle(source, checked)} onToggleGroup={(sources, checked) => toggleMany(sources, checked)} onAction={(source, action) => void apply(action, [source])} />)}</div></>}
    <SourceImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(imported) => { setImportOpen(false); cache.clear(); setMessage(`已导入 ${imported} 个书源`) }} />
    {message.length > 0 ? <FloatingMessage tone="success" message={message} onDismiss={() => setMessage('')} /> : null}
  </section>
}

function SourceDomainRow({ group, busy, selected, onToggle, onToggleGroup, onAction }: { group: SourceDomainGroup<ManagedSourceSummary>; busy: boolean; selected: Map<string, string>; onToggle: (source: ManagedSourceSummary, checked: boolean) => void; onToggleGroup: (sources: ManagedSourceSummary[], checked: boolean) => void; onAction: (source: ManagedSourceSummary, action: 'enable' | 'disable' | 'delete') => void }) {
  const groupCheckRef = useRef<HTMLInputElement>(null)
  const selectedCount = group.versions.filter(({ source }) => selected.has(source.sourceId)).length
  const groupSelected = selectedCount === group.versions.length
  const enabled = group.versions.filter(({ source }) => source.enabled)
  const enabledVersion = enabled.length === 1 ? group.versions.find(({ source }) => source.enabled) : undefined
  const latest = group.versions[0]?.source

  useEffect(() => {
    if (groupCheckRef.current !== null) groupCheckRef.current.indeterminate = selectedCount > 0 && !groupSelected
  }, [groupSelected, selectedCount])

  return <article className={`source-domain-group${groupSelected ? ' selected' : ''}`}>
    <div className="source-domain-header">
      <label className="source-management-check source-domain-check"><input ref={groupCheckRef} type="checkbox" checked={groupSelected} disabled={busy} onChange={(event) => onToggleGroup(group.versions.map(({ source }) => source), event.target.checked)} /><span className="sr-only">选择 {group.domain} 的全部实现</span></label>
      <details className="source-domain-details">
        <summary className="source-domain-summary"><span className="source-domain-heading-main"><span className="source-domain-title"><strong title={group.domain}>{group.domain}</strong>{enabled.length > 1 ? <span className="badge source-status source-domain-warning">{enabled.length} 个旧启用项</span> : enabled.length === 0 ? <span className="badge source-status source-disabled">{group.versions.length === 1 ? '已禁用' : '全部禁用'}</span> : enabledVersion ? <span className={`badge source-status ${group.versions.length >= 2 ? 'source-domain-warning' : 'source-enabled'}`}>{enabledVersion.displayName}</span> : null}</span><span className="muted small">{group.versions.length} 个实现 最新规则 {formatSourceRuleDateTime(latest?.lastUpdateTime)}</span></span></summary>
        <div className="source-domain-versions">{group.versions.map(({ source, displayName }) => <SourceVersionRow key={source.sourceId} source={source} displayName={displayName} busy={busy} selected={selected.has(source.sourceId)} onToggle={(checked) => onToggle(source, checked)} onAction={(action) => onAction(source, action)} />)}</div>
      </details>
    </div>
  </article>
}

function SourceVersionRow({ source, displayName, busy, selected, onToggle, onAction }: { source: ManagedSourceSummary; displayName: string; busy: boolean; selected: boolean; onToggle: (checked: boolean) => void; onAction: (action: 'enable' | 'disable' | 'delete') => void }) {
  return <article className={`source-management-row source-domain-version${selected ? ' selected' : ''}`}><div className="source-management-title"><label className="source-management-check"><input type="checkbox" checked={selected} disabled={busy} onChange={(event) => onToggle(event.target.checked)} /><span className="sr-only">选择 {displayName}</span></label><strong title={displayName}>{displayName}</strong>{source.enabled ? null : <span className="badge source-status source-disabled">已禁用</span>}<div className="source-row-actions"><Button size="sm" variant={source.enabled ? 'secondary' : 'default'} type="button" disabled={busy} onClick={() => onAction(source.enabled ? 'disable' : 'enable')}>{source.enabled ? '禁用' : '设默认'}</Button><Button size="sm" variant="secondary" type="button" disabled={busy} onClick={() => onAction('delete')}>删除</Button></div></div><div className="source-management-info"><span className="muted small source-version-meta"><span>{source.group ?? '未分组'}</span><span title={source.sourceId}>{sourceDomainInfo(source.sourceId).domain}</span></span><span className="muted small source-version-meta"><span title={formatSourceRuleDateTime(source.lastUpdateTime)}>更新于 {formatSourceRuleDateTime(source.lastUpdateTime).slice(0, 10)}</span><span title={source.importedAt ? formatSourceRuleDateTime(Date.parse(source.importedAt)) : '未知'}>导入于 {source.importedAt ? formatSourceRuleDateTime(Date.parse(source.importedAt)).slice(0, 10) : '未知'}</span></span><span className="muted small source-version-origin">来源：{source.importDisplayUrl ?? '未记录'}</span>{source.sourceUuid ? <Link className="small" to={"/sources/import-history?sourceUuid=" + source.sourceUuid}>查看导入记录</Link> : <span className="muted small">历史数据未记录</span>}</div></article>
}
