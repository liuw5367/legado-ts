import { useBookCache } from '../lib/book-cache-context.tsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PageBackButton } from '../components/page-back-button.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { SourceImportDialog } from '../components/source-import-dialog.tsx'
import { apiFetch } from '../lib/api.ts'
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
  const [acting, setActing] = useState(false)

  const load = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController(); requestRef.current = controller
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ all: 'true', query, status })
      const next = await apiFetch<SourceManagementPage>(`/api/source-management?${params.toString()}`, { signal: controller.signal })
      if (!controller.signal.aborted) setData(next)
    } catch (loadError) { if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : '书源加载失败') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }, [query, status])
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; requestRef.current?.abort() } }, [load])

  const pageSelected = data?.sources.length !== 0 && data?.sources.every((source) => selected.has(source.sourceId))

  function toggle(source: ManagedSourceSummary, checked: boolean) { setSelected((current) => { const next = new Map(current); if (checked) next.set(source.sourceId, source.sourceRevision); else next.delete(source.sourceId); return next }) }
  function togglePage(checked: boolean) { setSelected((current) => { const next = new Map(current); for (const source of data?.sources ?? []) if (checked) next.set(source.sourceId, source.sourceRevision); else next.delete(source.sourceId); return next }) }
  async function apply(action: 'enable' | 'disable' | 'delete', sources?: ManagedSourceSummary[]) {
    const items = sources === undefined
      ? [...selected.entries()].map(([sourceId, expectedSourceRevision]) => ({ sourceId, expectedSourceRevision }))
      : sources.map((source) => ({ sourceId: source.sourceId, expectedSourceRevision: source.sourceRevision }))
    if (items.length === 0 || actionRef.current) return
    if (action === 'delete' && !window.confirm(`确定删除 ${items.length} 个书源吗？书架和阅读进度会保留。`)) return
    actionRef.current = true; setActing(true)
    setMessage(''); setError('')
    try {
      let affected = 0
      for (let offset = 0; offset < items.length; offset += 1000) {
        if (!mounted.current) return
        const result = await apiFetch<{ affected: number }>('/api/source-management/actions', { method: 'POST', body: JSON.stringify({ action, items: items.slice(offset, offset + 1000) }) })
        affected += result.affected; cache.clear(); if (!mounted.current) return; setMessage('已处理 ' + affected + ' 个书源')
      }
      setMessage(`${action === 'delete' ? '已删除' : action === 'enable' ? '已启用' : '已禁用'} ${affected} 个书源`); setSelected(new Map()); await load()
    } catch (actionError) { if (!mounted.current) return; await load(); if (!mounted.current) return; setError(actionError instanceof Error ? actionError.message : '书源操作失败') }
    finally { actionRef.current = false; if (mounted.current) setActing(false) }
  }

  return <section className="page-stack page-narrow sources-page">
    <div className="toc-heading"><PageBackButton fallback="/account/settings" /><div className="toc-heading-main"><h1>书源</h1><p className="muted">{data === null ? '管理当前账号可用的书源。' : `共 ${data.total} 个，启用 ${data.enabledCount} 个`}</p></div><Button size="sm" type="button" onClick={() => setImportOpen(true)}>导入</Button></div>
    <div className="source-management-filters"><Input aria-label="搜索书源" placeholder="搜索名称、分组或 URL" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(new Map()) }} /><Select aria-label="筛选状态" value={status} onChange={(event) => { setStatus(event.target.value as SourceManagementStatus); setSelected(new Map()) }}><option value="all">全部</option><option value="enabled">启用</option><option value="disabled">禁用</option></Select></div>
    {message.length > 0 ? <p className="success" role="status">{message}</p> : null}{error.length > 0 ? <p className="error" role="alert">{error}</p> : null}
    {selected.size > 0 ? <div className="source-bulk-bar"><span>已选 {selected.size} 个</span><div className="actions"><Button size="sm" type="button" disabled={acting} onClick={() => void apply('enable')}>启用</Button><Button size="sm" variant="secondary" type="button" disabled={acting} onClick={() => void apply('disable')}>禁用</Button><Button size="sm" variant="secondary" type="button" disabled={acting} onClick={() => void apply('delete')}>删除</Button><Button size="sm" variant="secondary" type="button" disabled={acting} onClick={() => setSelected(new Map())}>清空</Button></div></div> : null}
    {loading ? <p className="loading-state muted">正在加载书源…</p> : data?.sources.length === 0 ? <div className="empty-state">没有匹配的书源。</div> : <><div className="source-list-header"><label><input type="checkbox" checked={pageSelected} onChange={(event) => togglePage(event.target.checked)} /> 全选筛选结果</label></div><div className="source-management-list">{data?.sources.map((source) => <SourceRow key={source.sourceId} source={source} busy={acting} selected={selected.has(source.sourceId)} onToggle={(checked) => toggle(source, checked)} onAction={(action) => void apply(action, [source])} />)}</div></>}
    <SourceImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(imported) => { setImportOpen(false); cache.clear(); setMessage(`已导入 ${imported} 个书源`); void load() }} />
  </section>
}

function SourceRow({ source, busy, selected, onToggle, onAction }: { source: ManagedSourceSummary; busy: boolean; selected: boolean; onToggle: (checked: boolean) => void; onAction: (action: 'enable' | 'disable' | 'delete') => void }) {
  return <article className="source-management-row"><label className="source-management-check"><input type="checkbox" checked={selected} onChange={(event) => onToggle(event.target.checked)} /><span className="sr-only">选择 {source.name}</span></label><div className="source-management-info"><span className="source-management-title"><strong>{source.name}</strong><span className={`badge ${source.enabled ? 'source-enabled' : 'source-disabled'}`}>{source.enabled ? '启用' : '禁用'}</span></span><span className="muted small">{source.group ?? '未分组'} · 当前账号</span><span className="source-url" title={source.sourceId}>{source.sourceId}</span></div><div className="source-row-actions"><Button size="sm" variant="secondary" type="button" disabled={busy} onClick={() => onAction(source.enabled ? 'disable' : 'enable')}>{source.enabled ? '禁用' : '启用'}</Button><Button size="sm" variant="secondary" type="button" disabled={busy} onClick={() => onAction('delete')}>删除</Button></div></article>
}
