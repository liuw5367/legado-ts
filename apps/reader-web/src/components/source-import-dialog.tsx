import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Sheet } from './ui/sheet.tsx'
import { Button, buttonVariants } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { apiFetch } from '../lib/api.ts'
import { formatSourceRuleDateTime } from '../lib/time-format.ts'
import { groupSourcesByDomain } from '../../shared/source-domain.ts'
import type { ImportPreviewSummary, ImportPreviewSummaryCandidate } from '../../shared/source-management.ts'

export function SourceImportDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (imported: number) => void }) {
  const id = useId()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<ImportPreviewSummary | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [writableExpanded, setWritableExpanded] = useState(true)
  const [skippedExpanded, setSkippedExpanded] = useState(true)
  const [status, setStatus] = useState<'input' | 'loading' | 'confirming' | 'error' | 'done'>('input')
  const [message, setMessage] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) { controllerRef.current?.abort(); controllerRef.current = null; setUrl(''); setPreview(null); setSelected([]); setFilter(''); setWritableExpanded(true); setSkippedExpanded(true); setStatus('input'); setMessage('') }
  }, [open])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  async function loadPreview() {
    setStatus('loading'); setMessage('')
    const controller = new AbortController(); controllerRef.current = controller
    try {
      const result = await apiFetch<ImportPreviewSummary>('/api/source-management/import-preview', { method: 'POST', body: JSON.stringify({ url }), signal: controller.signal })
      setPreview(result); setSelected(result.candidates.filter((candidate) => candidate.disposition !== undefined).map((candidate) => candidate.id)); setFilter(''); setWritableExpanded(true); setSkippedExpanded(true); setStatus('input')
    } catch (error) { if (!controller.signal.aborted) { setStatus('error'); setMessage(error instanceof Error ? error.message : '加载书源失败') } }
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
  const presentationById = useMemo(() => new Map(groupSourcesByDomain(preview?.candidates ?? []).flatMap((group) => group.versions.map(({ source, displayName }) => [source.id, { domain: group.domain, displayName }] as const))), [preview?.candidates])
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  function matchesFilter(candidate: ImportPreviewSummaryCandidate): boolean {
    if (normalizedFilter.length === 0) return true
    const presentation = presentationById.get(candidate.id)
    return [candidate.name, candidate.group, candidate.sourceId, candidate.reason, presentation?.displayName, presentation?.domain]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedFilter) ?? false)
  }
  const matchingWritable = writable.filter(matchesFilter)
  const matchingSkipped = skipped.filter(matchesFilter)
  const busy = status === 'loading' || status === 'confirming'
  return <Sheet className="source-import-dialog" open={open} onOpenChange={onOpenChange} title="导入书源">
    {preview === null ? <form className="form source-import-form" onSubmit={(event) => { event.preventDefault(); void loadPreview() }}><div className="field"><label htmlFor={id + '-source-import-url'}>书源或订阅链接</label><Input id={id + '-source-import-url'} type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/sources.json" disabled={busy} /><p className="muted small">只获取一次并在确认后保存，不会创建自动订阅。</p></div>{message.length > 0 ? <p className="error" role="alert">{message}</p> : null}<div className="source-import-actions"><a className={buttonVariants({ variant: 'secondary' })} href="https://www.yckceo.com/yuedu/shuyuans/index.html" target="_blank" rel="noopener noreferrer">书源网站</a><div className="actions"><Button variant="secondary" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={busy || url.trim().length === 0}>{status === 'loading' ? '加载中…' : '加载书源'}</Button></div></div></form> : <div className="source-import-preview">
      <p className="muted small">预览有效至 {new Date(preview.expiresAt).toLocaleTimeString()}</p>
      <label className="sr-only" htmlFor={id + '-source-import-filter'}>筛选可导入和不会导入的书源</label>
      <Input id={id + '-source-import-filter'} type="search" placeholder="搜索名称、分组或地址" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <section className={`source-import-section${writableExpanded ? '' : ' collapsed'}`} aria-labelledby={id + '-source-import-ready'}>
        <h3 className="source-import-section-heading" id={id + '-source-import-ready'}><button className="source-import-section-toggle" type="button" aria-expanded={writableExpanded} aria-controls={id + '-source-import-ready-list'} onClick={() => setWritableExpanded((value) => !value)}><span>可导入书源 {matchingWritable.length === writable.length ? writable.length : `${matchingWritable.length}/${writable.length}`}</span>{writableExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button></h3>
        <div className="source-import-list" id={id + '-source-import-ready-list'} hidden={!writableExpanded}>{matchingWritable.length === 0 ? <p className="empty-state">{writable.length === 0 ? '没有可导入的书源。' : '没有匹配的书源。'}</p> : matchingWritable.map((candidate) => <ImportCandidateRow key={candidate.id} candidate={candidate} displayName={presentationById.get(candidate.id)?.displayName ?? candidate.name} domain={presentationById.get(candidate.id)?.domain ?? candidate.sourceId} selected={selected.includes(candidate.id)} disabled={busy} onChange={(checked) => setSelected((current) => checked ? [...current, candidate.id] : current.filter((itemId) => itemId !== candidate.id))} />)}</div>
      </section>
      <section className={`source-import-section${skippedExpanded ? '' : ' collapsed'}`} aria-labelledby={id + '-source-import-skipped'}>
        <h3 className="source-import-section-heading" id={id + '-source-import-skipped'}><button className="source-import-section-toggle" type="button" aria-expanded={skippedExpanded} aria-controls={id + '-source-import-skipped-list'} onClick={() => setSkippedExpanded((value) => !value)}><span>不会导入 {matchingSkipped.length === skipped.length ? skipped.length : `${matchingSkipped.length}/${skipped.length}`}</span>{skippedExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button></h3>
        <div className="source-import-list" id={id + '-source-import-skipped-list'} hidden={!skippedExpanded}>{matchingSkipped.length === 0 ? <p className="empty-state">{skipped.length === 0 ? '没有跳过项。' : '没有匹配的书源。'}</p> : matchingSkipped.map((candidate) => <ImportCandidateRow key={candidate.id} candidate={candidate} displayName={presentationById.get(candidate.id)?.displayName ?? candidate.name} domain={presentationById.get(candidate.id)?.domain ?? candidate.sourceId} disabled />)}</div>
      </section>
      {message.length > 0 ? <p className={status === 'done' ? 'success' : 'error'} role={status === 'done' ? 'status' : 'alert'}>{message}</p> : null}
      <div className="source-import-footer"><Button variant="secondary" type="button" disabled={busy} onClick={() => { setPreview(null); setSelected([]); setFilter(''); setStatus('input'); setMessage('') }}>返回修改地址</Button><Button variant="secondary" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={busy || selected.length === 0} onClick={() => void confirm()}>{status === 'confirming' ? '保存中…' : `确认导入 ${selected.length} 项`}</Button></div>
    </div>}
  </Sheet>
}

function ImportCandidateRow({ candidate, displayName, domain, selected = false, disabled = false, onChange }: { candidate: ImportPreviewSummaryCandidate; displayName: string; domain: string; selected?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return <label className={`source-import-row ${candidate.disposition === undefined ? 'skipped' : ''}`}><input type="checkbox" checked={selected} disabled={disabled || candidate.disposition === undefined} onChange={(event) => onChange?.(event.target.checked)} /><span className="source-import-row-body"><span className="source-import-row-title"><strong>{displayName}</strong><span className="source-import-reason">{candidate.reason}</span></span><span className="muted small">域名：{domain}{candidate.group === undefined ? '' : ` · ${candidate.group}`}</span><span className="source-url" title={candidate.sourceId}>{candidate.sourceId}</span><span className="muted small">规则更新时间 {formatSourceRuleDateTime(candidate.lastUpdateTime)}</span></span></label>
}
