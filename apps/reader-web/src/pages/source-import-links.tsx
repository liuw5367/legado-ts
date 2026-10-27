import { EmptyState } from '../components/empty-state.tsx'
import { Link2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/page-header.tsx'
import { Button } from '../components/ui/button.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { apiFetch } from '../lib/api.ts'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import type { ImportLinksResponse } from '../../shared/source-management.ts'

export function SourceImportLinksPage() {
  const [data, setData] = useState<ImportLinksResponse | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)
  const acting = useRef(false)
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setError('')
    try { const value = await apiFetch<ImportLinksResponse>('/api/source-management/import-links', { signal: controller.signal }); if (!controller.signal.aborted) setData(value) }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '来源加载失败') }
  }, [])
  usePageLoadEffect((settle) => { void load().then(settle); return () => request.current?.abort() }, [], ['sources'])
  useEffect(() => () => request.current?.abort(), [])
  async function move(index: number, destination: number) {
    if (!data || acting.current) return
    acting.current = true; setBusy(true); setError('')
    const ids = data.links.map((row) => row.id); const [id] = ids.splice(index, 1); ids.splice(destination, 0, id!)
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    try { const result = await apiFetch<ImportLinksResponse>('/api/source-management/import-links/order', { method: 'POST', signal: controller.signal, body: JSON.stringify({ orderedIds: ids, expectedRevision: data.revision }) }); if (!controller.signal.aborted) setData(result) }
    catch (reason) { if (!controller.signal.aborted) { await load(); setError(reason instanceof Error ? reason.message : '排序失败') } }
    finally { acting.current = false; setBusy(false) }
  }
  return <section className="page-stack page-narrow">
    <PageHeader backTo="/sources" title="来源排序" description="搜索和切换书源优先使用排在前面的来源。同一来源内按书源顺序执行。" />
    {error ? <DismissibleMessage className="error" role="alert">{error}<Button variant="secondary" onClick={() => void load()}>重试</Button></DismissibleMessage> : null}
    {!data ? <LoadingState message="正在加载来源…" /> : <div className="source-management-list">{data.links.length === 0 ? <EmptyState icon={Link2} title="还没有导入来源" description="从链接导入书源后会显示在这里" /> : data.links.map((row, index) => <article className="source-management-row import-link-row" key={row.id}>
      <div className="source-management-info import-link-info"><div className="source-toolbar"><strong>优先级 {index + 1}</strong><span className="muted small source-toolbar-end">当前归属 {row.sourceCount} 个书源</span></div><span className="source-url">{row.displayUrl}</span>
      <div className="source-toolbar"><Link to={'/sources/import-history?linkId=' + row.id}>查看导入记录</Link><div className="source-row-actions source-toolbar-end"><Button size="sm" variant="secondary" disabled={busy || index === 0} onClick={() => void move(index, 0)}>置顶</Button><Button size="sm" variant="secondary" disabled={busy || index === 0} onClick={() => void move(index, index - 1)}>上移</Button><Button size="sm" variant="secondary" disabled={busy || index === data.links.length - 1} onClick={() => void move(index, index + 1)}>下移</Button></div></div></div>
    </article>)}</div>}
    <p className="muted small">其他书源固定排在最后。新来源追加到末尾；重复导入沿用原顺序。排序只影响之后开始的搜索。</p>
  </section>
}
