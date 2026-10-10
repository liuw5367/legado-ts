import { useEffect, useRef, useState } from 'react'
import { Sheet } from './ui/sheet.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { apiFetch } from '../lib/api.ts'
import type { ImportPreviewSummary, ImportPreviewSummaryCandidate } from '../../shared/source-management.ts'

export function SourceImportDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (imported: number) => void }) {
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<ImportPreviewSummary | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [status, setStatus] = useState<'input' | 'loading' | 'confirming' | 'error' | 'done'>('input')
  const [message, setMessage] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) { controllerRef.current?.abort(); controllerRef.current = null; setUrl(''); setPreview(null); setSelected([]); setStatus('input'); setMessage('') }
  }, [open])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  async function loadPreview() {
    setStatus('loading'); setMessage('')
    const controller = new AbortController(); controllerRef.current = controller
    try {
      const result = await apiFetch<ImportPreviewSummary>('/api/source-management/import-preview', { method: 'POST', body: JSON.stringify({ url }), signal: controller.signal })
      setPreview(result); setSelected(result.candidates.filter((candidate) => candidate.disposition !== undefined).map((candidate) => candidate.id)); setStatus('input')
    } catch (error) { if (!controller.signal.aborted) { setStatus('error'); setMessage(error instanceof Error ? error.message : '获取书源失败') } }
    finally { if (controllerRef.current === controller) controllerRef.current = null }
  }

  async function confirm() {
    if (preview === null || selected.length === 0) return
    setStatus('confirming'); setMessage('')
    try {
      const result = await apiFetch<{ imported: number }>('/api/source-management/import-confirm', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, candidateIds: selected }) })
      setStatus('done'); setMessage(`已导入 ${result.imported} 个书源`); onImported(result.imported)
    } catch (error) { setStatus('error'); setMessage(error instanceof Error ? error.message : '导入失败') }
  }

  const writable = preview?.candidates.filter((candidate) => candidate.disposition !== undefined) ?? []
  const skipped = preview?.candidates.filter((candidate) => candidate.disposition === undefined) ?? []
  const busy = status === 'loading' || status === 'confirming'
  return <Sheet open={open} onOpenChange={onOpenChange} title="导入书源">
    {preview === null ? <form className="form source-import-form" onSubmit={(event) => { event.preventDefault(); void loadPreview() }}><div className="field"><label htmlFor="source-import-url">书源或订阅链接</label><Input id="source-import-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/sources.json" disabled={busy} /><p className="muted small">只获取一次并在确认后保存，不会创建自动订阅。</p></div>{message.length > 0 ? <p className="error" role="alert">{message}</p> : null}<div className="actions"><Button type="submit" disabled={busy || url.trim().length === 0}>{status === 'loading' ? '获取中…' : '获取书源'}</Button><Button variant="secondary" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button></div></form> : <div className="source-import-preview"><p className="muted small">预览有效至 {new Date(preview.expiresAt).toLocaleTimeString()}</p><section aria-labelledby="source-import-ready"><h3 id="source-import-ready">可导入 {writable.length}</h3><div className="source-import-list">{writable.length === 0 ? <p className="empty-state">没有可导入的书源。</p> : writable.map((candidate) => <ImportCandidateRow key={candidate.id} candidate={candidate} selected={selected.includes(candidate.id)} disabled={busy} onChange={(checked) => setSelected((current) => checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} />)}</div></section><section aria-labelledby="source-import-skipped"><h3 id="source-import-skipped">不会导入 {skipped.length}</h3><div className="source-import-list">{skipped.length === 0 ? <p className="muted small">没有跳过项。</p> : skipped.map((candidate) => <ImportCandidateRow key={candidate.id} candidate={candidate} disabled />)}</div></section>{message.length > 0 ? <p className={`${status === 'done' ? 'success' : 'error'}`} role={status === 'done' ? 'status' : 'alert'}>{message}</p> : null}<div className="source-import-footer"><Button variant="secondary" type="button" disabled={busy} onClick={() => { setPreview(null); setSelected([]); setStatus('input'); setMessage('') }}>返回修改地址</Button><Button variant="secondary" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={busy || selected.length === 0} onClick={() => void confirm()}>{status === 'confirming' ? '保存中…' : `确认导入 ${selected.length} 项`}</Button></div></div>}
  </Sheet>
}

function ImportCandidateRow({ candidate, selected = false, disabled = false, onChange }: { candidate: ImportPreviewSummaryCandidate; selected?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return <label className={`source-import-row ${candidate.disposition === undefined ? 'skipped' : ''}`}><input type="checkbox" checked={selected} disabled={disabled || candidate.disposition === undefined} onChange={(event) => onChange?.(event.target.checked)} /><span className="source-import-row-body"><strong>{candidate.name}</strong><span className="muted small">{candidate.group === undefined ? '' : `${candidate.group} · `}{candidate.sourceId}</span><span className="muted small">{candidate.reason}</span></span></label>
}
