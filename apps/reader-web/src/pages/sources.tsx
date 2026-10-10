import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { SourceImportDialog } from '../components/source-import-dialog.tsx'
import { apiFetch } from '../lib/api.ts'
import type { ManagedSourceSummary, SourceManagementPage, SourceManagementStatus } from '../../shared/source-management.ts'

export function SourcesPage() {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<SourceManagementStatus>('all')
  const [data, setData] = useState<SourceManagementPage | null>(null)
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50', query, status })
      const next = await apiFetch<SourceManagementPage>(`/api/source-management?${params.toString()}`)
      if (next.total > 0 && next.sources.length === 0 && page > Math.ceil(next.total / next.pageSize)) { setPage(Math.max(1, Math.ceil(next.total / next.pageSize))); return }
      setData(next)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : '书源加载失败') }
    finally { setLoading(false) }
  }, [page, query, status])
  useEffect(() => { void load() }, [load])

  const pageSelected = data?.sources.length !== 0 && data?.sources.every((source) => selected.has(source.sourceId))

  function toggle(source: ManagedSourceSummary, checked: boolean) { setSelected((current) => { const next = new Map(current); if (checked) next.set(source.sourceId, source.sourceRevision); else next.delete(source.sourceId); return next }) }
  function togglePage(checked: boolean) { setSelected((current) => { const next = new Map(current); for (const source of data?.sources ?? []) if (checked) next.set(source.sourceId, source.sourceRevision); else next.delete(source.sourceId); return next }) }
  async function apply(action: 'enable' | 'disable' | 'delete', sources?: ManagedSourceSummary[]) {
    const items = sources === undefined
      ? [...selected.entries()].map(([sourceId, expectedSourceRevision]) => ({ sourceId, expectedSourceRevision }))
      : sources.map((source) => ({ sourceId: source.sourceId, expectedSourceRevision: source.sourceRevision }))
    if (items.length === 0) return
    if (action === 'delete' && !window.confirm(`确定删除 ${items.length} 个书源吗？书架和阅读进度会保留。`)) return
    setMessage(''); setError('')
    try {
      const result = await apiFetch<{ affected: number }>('/api/source-management/actions', { method: 'POST', body: JSON.stringify({ action, items }) })
      setMessage(`${action === 'delete' ? '已删除' : action === 'enable' ? '已启用' : '已禁用'} ${result.affected} 个书源`); setSelected(new Map()); await load()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : '书源操作失败') }
  }

  return <section className="page-stack page-narrow sources-page">
    <div className="page-heading compact-heading"><div><h1>书源</h1><p className="muted">{data === null ? '管理当前账号可用的书源。' : `共 ${data.total} 个，启用 ${data.enabledCount} 个`}</p></div><Button type="button" onClick={() => setImportOpen(true)}>导入</Button></div>
    <div className="source-management-filters"><Input aria-label="搜索书源" placeholder="搜索名称、分组或 URL" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} /><Select aria-label="筛选状态" value={status} onChange={(event) => { setStatus(event.target.value as SourceManagementStatus); setPage(1) }}><option value="all">全部</option><option value="enabled">启用</option><option value="disabled">禁用</option></Select></div>
    {message.length > 0 ? <p className="success" role="status">{message}</p> : null}{error.length > 0 ? <p className="error" role="alert">{error}</p> : null}
    {selected.size > 0 ? <div className="source-bulk-bar"><span>已选 {selected.size} 个</span><div className="actions"><Button size="sm" type="button" onClick={() => void apply('enable')}>启用</Button><Button size="sm" variant="secondary" type="button" onClick={() => void apply('disable')}>禁用</Button><Button size="sm" variant="secondary" type="button" onClick={() => void apply('delete')}>删除</Button><Button size="sm" variant="secondary" type="button" onClick={() => setSelected(new Map())}>清空</Button></div></div> : null}
    {loading ? <p className="loading-state muted">正在加载书源…</p> : data?.sources.length === 0 ? <div className="empty-state">没有匹配的书源。</div> : <><div className="source-list-header"><label><input type="checkbox" checked={pageSelected} onChange={(event) => togglePage(event.target.checked)} /> 全选本页</label><span className="muted small">第 {page} 页</span></div><div className="source-management-list">{data?.sources.map((source) => <SourceRow key={source.sourceId} source={source} selected={selected.has(source.sourceId)} onToggle={(checked) => toggle(source, checked)} onAction={(action) => void apply(action, [source])} />)}</div><div className="source-pagination"><Button variant="secondary" size="sm" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><span className="muted small">{page} / {Math.max(1, Math.ceil((data?.total ?? 0) / 50))}</span><Button variant="secondary" size="sm" type="button" disabled={page >= Math.ceil((data?.total ?? 0) / 50)} onClick={() => setPage((value) => value + 1)}>下一页</Button></div></>}
    <p className="muted small"><Link className="link" to="/account/settings">返回设置</Link></p>
    <SourceImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(imported) => { setImportOpen(false); setMessage(`已导入 ${imported} 个书源`); void load() }} />
  </section>
}

function SourceRow({ source, selected, onToggle, onAction }: { source: ManagedSourceSummary; selected: boolean; onToggle: (checked: boolean) => void; onAction: (action: 'enable' | 'disable' | 'delete') => void }) {
  return <article className="source-management-row"><label className="source-management-check"><input type="checkbox" checked={selected} onChange={(event) => onToggle(event.target.checked)} /><span className="sr-only">选择 {source.name}</span></label><div className="source-management-info"><strong>{source.name}</strong><span className="muted small">{source.group ?? '未分组'} · {source.origin === 'account' ? '当前账号' : '默认书源'}</span><span className="source-url" title={source.sourceId}>{source.sourceId}</span></div><span className={`badge ${source.enabled ? 'source-enabled' : 'source-disabled'}`}>{source.enabled ? '启用' : '禁用'}</span><div className="source-row-actions"><Button size="sm" variant="secondary" type="button" onClick={() => onAction(source.enabled ? 'disable' : 'enable')}>{source.enabled ? '禁用' : '启用'}</Button><Button size="sm" variant="secondary" type="button" onClick={() => onAction('delete')}>删除</Button></div></article>
}
