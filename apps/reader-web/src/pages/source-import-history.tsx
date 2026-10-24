import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../components/page-header.tsx'
import { Button } from '../components/ui/button.tsx'
import { Select } from '../components/ui/select.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { sourceDomainInfo } from '../../shared/source-domain.ts'
import { ApiError, apiFetch } from '../lib/api.ts'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import type { ImportHistoryItem, ImportHistoryPage, ImportItemsPage, UndoPreview } from '../../shared/source-management.ts'

const actionLabel = { new: '新增', update: '更新', restore: '恢复', skipped: '跳过', unselected: '未选择' }
const currentLabel = { unchanged: '仍为导入版本', modified: '后来已修改', deleted: '已删除', undone: '已撤销', skipped: '未写入' }
const undoLabel = { none: '未撤销', partial: '部分撤销', all: '全部撤销' }

export function SourceImportHistoryPage() {
  const { batchId } = useParams()
  const [query] = useSearchParams()
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('imported')
  const [history, setHistory] = useState<ImportHistoryPage | null>(null)
  const [detail, setDetail] = useState<ImportItemsPage | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<UndoPreview | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const request = useRef<AbortController | null>(null)
  const actionRequest = useRef<AbortController | null>(null)
  const action = useRef(false)
  const undoKey = useRef<string>('')
  const undoInput = useRef<string>('')
  const linkId = query.get('linkId'); const sourceUuid = query.get('sourceUuid')
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setLoading(true); setError('')
    const params = new URLSearchParams({ page: batchId ? '1' : String(page), pageSize: batchId ? '50' : '20', filter })
    if (linkId) params.set('linkId', linkId)
    if (sourceUuid) params.set('sourceUuid', sourceUuid)
    try {
      const path = batchId ? `/api/source-management/import-history/${batchId}/items` : '/api/source-management/import-history'
      if (batchId) {
        const first = await apiFetch<ImportItemsPage>(path + '?' + params, { signal: controller.signal })
        const items = [...first.items]
        for (let nextPage = 2; items.length < first.total; nextPage += 1) {
          params.set('page', String(nextPage))
          const next = await apiFetch<ImportItemsPage>(path + '?' + params, { signal: controller.signal })
          if (next.items.length === 0) break
          items.push(...next.items)
        }
        if (!controller.signal.aborted) setDetail({ ...first, items })
      } else {
        const value = await apiFetch<ImportHistoryPage>(path + '?' + params, { signal: controller.signal })
        if (!controller.signal.aborted) setHistory((current) => ({ ...value, batches: page === 1 ? value.batches : [...(current?.batches.filter((batch) => !value.batches.some((next) => next.id === batch.id)) ?? []), ...value.batches] }))
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '导入记录加载失败') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }, [batchId, page, filter, linkId, sourceUuid])
  usePageLoadEffect((settle) => { void load().then(settle); return () => request.current?.abort() }, [batchId, page, filter, linkId, sourceUuid], ['sources'])
  useEffect(() => () => { request.current?.abort(); actionRequest.current?.abort() }, [])
  async function prepareUndo(all: boolean) {
    if (!batchId || action.current) return
    action.current = true; setBusy(true); setError('')
    const controller = new AbortController(); actionRequest.current = controller
    try {
      const value = await apiFetch<UndoPreview>(`/api/source-management/import-history/${batchId}/undo-preview`, { method: 'POST', signal: controller.signal, body: JSON.stringify(all ? {} : { itemIds: selected }) })
      if (!controller.signal.aborted) { setPreview(value); undoKey.current = ''; undoInput.current = '' }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '撤销预览失败') }
    finally { action.current = false; setBusy(false) }
  }
  async function confirmUndo() {
    if (!batchId || !preview || action.current) return
    const items = preview.items.filter((row) => row.canUndo && row.expectedRevision).map((row) => ({ itemId: row.itemId, expectedRevision: row.expectedRevision! }))
    if (!items.length) return
    // 网络结果未知时保留相同请求与幂等键，重试不会重复恢复旧版本。
    undoKey.current ||= crypto.randomUUID()
    undoInput.current ||= JSON.stringify({ idempotencyKey: undoKey.current, items })
    action.current = true; setBusy(true); setError('')
    const controller = new AbortController(); actionRequest.current = controller
    try {
      const result = await apiFetch<{ affected: number }>(`/api/source-management/import-history/${batchId}/undo`, { method: 'POST', signal: controller.signal, body: undoInput.current })
      if (!controller.signal.aborted) { setPreview(null); setSelected([]); setMessage(`已撤销 ${result.affected} 个书源的导入变更`); await load() }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '撤销失败，请重试或重新预览')
        if (reason instanceof ApiError && reason.status === 409) {
          try {
            const value = await apiFetch<UndoPreview>(`/api/source-management/import-history/${batchId}/undo-preview`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ itemIds: items.map((item) => item.itemId) }) })
            if (!controller.signal.aborted) { setPreview(value); undoKey.current = ''; undoInput.current = '' }
          } catch (refreshError) { if (!controller.signal.aborted) setError(refreshError instanceof Error ? refreshError.message : '撤销预览更新失败，请取消后重试') }
        }
      }
    }
    finally { action.current = false; setBusy(false) }
  }
  const total = batchId ? detail?.total ?? 0 : history?.total ?? 0
  function toggle(item: ImportHistoryItem, checked: boolean) { setSelected((values) => checked ? [...values, item.id] : values.filter((id) => id !== item.id)) }
  return <section className="page-stack page-narrow">
    <PageHeader backTo={batchId ? '/sources/import-history' : '/sources'} title={batchId ? '导入明细' : '导入记录'} description={batchId ? detail ? new Date(detail.batch.importedAt).toLocaleString('zh-CN') : '查看当时导入的书源与来源。' : '查看每次导入，并撤销仍可安全恢复的变更。'} />
    {message ? <DismissibleMessage className="success" role="status">{message}</DismissibleMessage> : null}
    {error ? <DismissibleMessage className="error" role="alert">{error}<Button variant="secondary" onClick={() => void load()}>刷新</Button></DismissibleMessage> : null}
    {loading ? <LoadingState message="正在加载导入记录…" /> : null}
    {!batchId ? <div className="source-management-list">{history?.batches.map((batch) => <Link key={batch.id} to={'/sources/import-history/' + batch.id} className="source-management-row import-history-row"><strong className="import-history-date">{new Date(batch.importedAt).toLocaleString('zh-CN')}</strong><span className="source-url import-history-origin">{batch.displayUrl}</span><div className="source-management-info"><span>新增 {batch.newCount} · 更新 {batch.updatedCount} · 恢复 {batch.restoredCount}</span><span className="muted small">跳过 {batch.skippedCount} · 未选择 {batch.unselectedCount} · {undoLabel[batch.undoStatus]}</span></div><span className="button secondary small import-history-detail">查看明细</span>{batch.undoneAt ? <span className="muted small import-history-note">撤销于 {new Date(batch.undoneAt).toLocaleString('zh-CN')}</span> : null}{batch.invalidatedReason ? <span className="muted small import-history-note">{batch.invalidatedReason}</span> : null}</Link>)}{!loading && total === 0 ? <p className="empty-state">没有导入记录。上线前的书源未记录历史。</p> : null}</div> : detail ? <>
      <p className="source-url">{detail.batch.displayUrl}</p>
      <p className="muted small">{undoLabel[detail.batch.undoStatus]}{detail.batch.invalidatedReason ? ' · ' + detail.batch.invalidatedReason : ''}</p>
      <div className="source-toolbar"><Select aria-label="筛选导入明细" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); setSelected([]) }}><option value="imported">实际导入</option><option value="skipped">跳过与未选择</option><option value="all">全部明细</option></Select><div className="actions source-toolbar-end"><Button variant="secondary" disabled={busy || !selected.length} onClick={() => void prepareUndo(false)}>撤销选中 {selected.length || ''}</Button><Button variant="secondary" disabled={busy || detail.batch.undoStatus === 'all' || !!detail.batch.invalidatedReason} onClick={() => void prepareUndo(true)}>撤销整批</Button></div></div>
      <div className="source-management-list">{detail.items.map((item) => <article className="source-management-row" key={item.id}><label className="source-management-check"><input aria-label={'选择 ' + item.name} type="checkbox" checked={selected.includes(item.id)} disabled={busy || !item.afterRevision || !!item.undoneAt} onChange={(event) => toggle(item, event.target.checked)} /></label><div className="source-management-info"><div className="import-item-heading"><strong>{item.name}</strong><span className="muted small">{item.group ?? '未分组'}</span><span className="source-url">{sourceDomainInfo(item.sourceId).domain}</span></div><div className="import-item-status small"><span className={`badge import-action-${item.action}`}>{actionLabel[item.action]}</span><span className={`badge import-current-${item.currentStatus}`}>{currentLabel[item.currentStatus]}</span><span className={`import-reason-${item.currentStatus}`}>{item.reason}</span></div></div></article>)}</div>
      {!loading && detail.items.length === 0 ? <p className="empty-state">没有符合条件的明细。</p> : null}
    </> : null}
    {!batchId && (history?.batches.length ?? 0) < total ? <Button variant="secondary" disabled={loading} onClick={() => setPage((current) => current + 1)}>{loading ? '加载中…' : '加载更多'}</Button> : null}
    <Sheet open={preview !== null} onOpenChange={(open) => { if (!open && !busy) setPreview(null) }} title="确认撤销导入">
      {preview ? <><p>将移除 {preview.removable} 个新增书源，恢复 {preview.restorable} 个书源的导入前状态。书架和阅读进度会保留；登录态不会恢复。</p><p className="muted small">后续已修改、正在使用或存在同域冲突的书源不会撤销。</p><div className="import-undo-list">{preview.items.map((item) => <p key={item.itemId}><strong>{item.name}</strong> · {item.canUndo ? item.action === 'new' ? '移除新增书源' : '恢复导入前状态' : item.reason}</p>)}</div>{error ? <p className="error" role="alert">{error}</p> : null}<div className="actions"><Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>取消</Button><Button disabled={busy || preview.removable + preview.restorable === 0} onClick={() => void confirmUndo()}>{busy ? '撤销中…' : '确认撤销可执行项'}</Button></div></> : null}
    </Sheet>
  </section>
}
