import { DismissibleMessage } from './dismissible-message.tsx'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { Sheet } from './ui/sheet.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { apiFetch } from '../lib/api.ts'
import { formatSourceRuleDateTime } from '../lib/time-format.ts'
import { groupSourcesByDomain } from '../../shared/source-domain.ts'
import type { ImportPreviewSummary, ImportPreviewSummaryCandidate } from '../../shared/source-management.ts'
import { updateImportSelection } from '../lib/source-import-selection.ts'
import { IMPORT_FILE_MAX_BYTES, IMPORT_REQUEST_MAX_BYTES } from '../../shared/source-import-limits.ts'

export function SourceImportDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (imported: number) => void }) {
  const id = useId()
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<'url' | 'file'>('url')
  const [file, setFile] = useState<File | null>(null)
  const [showSourceSites, setShowSourceSites] = useState(false)
  const [preview, setPreview] = useState<ImportPreviewSummary | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [skippedSelected, setSkippedSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [writableExpanded, setWritableExpanded] = useState(true)
  const [skippedExpanded, setSkippedExpanded] = useState(true)
  const [status, setStatus] = useState<'input' | 'loading' | 'confirming' | 'error' | 'done'>('input')
  const [message, setMessage] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) { setMode('url'); setFile(null); setShowSourceSites(false); controllerRef.current?.abort(); controllerRef.current = null; setUrl(''); setPreview(null); setSelected([]); setSkippedSelected([]); setFilter(''); setWritableExpanded(true); setSkippedExpanded(true); setStatus('input'); setMessage('') }
  }, [open])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  async function loadPreview() {
    if (url.trim().length === 0 || (mode === 'file' && file === null)) return
    setStatus('loading'); setMessage('')
    const controller = new AbortController(); controllerRef.current = controller
    try {
      let jsonText: string | undefined
      if (mode === 'file' && file !== null) {
        if (file.size > IMPORT_FILE_MAX_BYTES) throw new Error('JSON 文件不能超过 20 MiB')
        jsonText = await file.text()
        if (jsonText.trim().length === 0) throw new Error('JSON 文件内容不能为空')
        try { JSON.parse(jsonText) } catch { throw new Error('文件不是有效的 JSON，请检查文件内容与 UTF-8 编码') }
      }
      if (controller.signal.aborted) return
      const body = JSON.stringify({ url, ...(jsonText === undefined ? {} : { jsonText }) })
      if (new TextEncoder().encode(body).byteLength > IMPORT_REQUEST_MAX_BYTES) throw new Error('导入请求超过大小限制，请缩小 JSON 文件后重试')
      const result = await apiFetch<ImportPreviewSummary>('/api/source-management/import-preview', { method: 'POST', body, signal: controller.signal })
      setPreview(result); setSkippedSelected([]); setSelected(result.candidates.filter((candidate) => candidate.disposition !== undefined).map((candidate) => candidate.id)); setFilter(''); setWritableExpanded(true); setSkippedExpanded(true); setStatus('input')
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
  return <><Sheet className="source-import-dialog" open={open} onOpenChange={onOpenChange} title="导入书源">
    {preview === null ? <form className="form source-import-form" onSubmit={(event) => { event.preventDefault(); void loadPreview() }}><div className="segmented source-import-mode" role="group" aria-label="导入方式"><button type="button" className={mode === 'url' ? 'selected' : undefined} aria-pressed={mode === 'url'} disabled={busy} onClick={() => { setMode('url'); setFile(null); setMessage('') }}>链接导入</button><button type="button" className={mode === 'file' ? 'selected' : undefined} aria-pressed={mode === 'file'} disabled={busy} onClick={() => { setMode('file'); setMessage('') }}>本地 JSON</button></div>{mode === 'file' ? <div className="field"><label htmlFor={id + '-source-import-file'}>JSON 文件</label><input className="input source-import-file" id={id + '-source-import-file'} type="file" accept=".json,application/json" required disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><p className="muted small">选择 UTF-8 编码的 JSON 书源文件，最大 20 MiB。</p></div> : null}<div className="field"><label htmlFor={id + '-source-import-url'}>{mode === 'file' ? '来源链接（必填）' : '书源或订阅链接'}</label><Input id={id + '-source-import-url'} type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/sources.json" disabled={busy} /><p className="muted small">{mode === 'file' ? '请填写此文件对应的来源链接，用于导入历史和书源管理，不会请求该链接。' : '只获取一次并在确认后保存，不会创建自动订阅。'}</p></div>{message.length > 0 ? <DismissibleMessage onDismiss={() => setMessage('')} className="error" role="alert">{message}</DismissibleMessage> : null}<div className="source-import-actions"><Button variant="secondary" type="button" aria-haspopup="dialog" onClick={() => setShowSourceSites(true)}>获取书源</Button><div className="actions"><Button variant="secondary" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={busy || url.trim().length === 0 || (mode === 'file' && file === null)}>{status === 'loading' ? '加载中…' : '加载书源'}</Button></div></div></form> : <div className="source-import-preview">
      <p className="muted small">预览有效至 {new Date(preview.expiresAt).toLocaleTimeString()}</p>
      <label className="sr-only" htmlFor={id + '-source-import-filter'}>筛选可导入和不会导入的书源</label>
      <Input id={id + '-source-import-filter'} type="search" placeholder="搜索名称、分组或地址" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <section className={`source-import-section${writableExpanded ? '' : ' collapsed'}`} aria-labelledby={id + '-source-import-ready'}>
        <h3 className="source-import-section-heading" id={id + '-source-import-ready'}><button className="source-import-section-toggle" type="button" aria-expanded={writableExpanded} aria-controls={id + '-source-import-ready-list'} onClick={() => setWritableExpanded((value) => !value)}><span>可导入书源 {matchingWritable.length === writable.length ? writable.length : `${matchingWritable.length}/${writable.length}`}</span>{writableExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button></h3>
        {writableExpanded ? <ImportSelectionActions label="可导入书源" candidates={matchingWritable} selected={selected} disabled={busy} onChange={setSelected} /> : null}
        <div className="source-import-list" id={id + '-source-import-ready-list'} hidden={!writableExpanded}>{matchingWritable.length === 0 ? <p className="empty-state">{writable.length === 0 ? '没有可导入的书源。' : '没有匹配的书源。'}</p> : matchingWritable.map((candidate) => <ImportCandidateRow key={candidate.id} candidate={candidate} displayName={presentationById.get(candidate.id)?.displayName ?? candidate.name} domain={presentationById.get(candidate.id)?.domain ?? candidate.sourceId} selected={selected.includes(candidate.id)} disabled={busy} onChange={(checked) => setSelected((current) => checked ? [...current, candidate.id] : current.filter((itemId) => itemId !== candidate.id))} />)}</div>
      </section>
      <section className={`source-import-section${skippedExpanded ? '' : ' collapsed'}`} aria-labelledby={id + '-source-import-skipped'}>
        <h3 className="source-import-section-heading" id={id + '-source-import-skipped'}><button className="source-import-section-toggle" type="button" aria-expanded={skippedExpanded} aria-controls={id + '-source-import-skipped-list'} onClick={() => setSkippedExpanded((value) => !value)}><span>不会导入 {matchingSkipped.length === skipped.length ? skipped.length : `${matchingSkipped.length}/${skipped.length}`}</span>{skippedExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button></h3>
        {skippedExpanded ? <><ImportSelectionActions label="不会导入书源" candidates={matchingSkipped} selected={skippedSelected} disabled={busy} onChange={setSkippedSelected} /><p className="muted small source-import-selection-note">此区域的勾选用于核对，不参与确认导入。</p></> : null}
        <div className="source-import-list" id={id + '-source-import-skipped-list'} hidden={!skippedExpanded}>{matchingSkipped.length === 0 ? <p className="empty-state">{skipped.length === 0 ? '没有跳过项。' : '没有匹配的书源。'}</p> : matchingSkipped.map((candidate) => <ImportCandidateRow key={candidate.id} candidate={candidate} displayName={presentationById.get(candidate.id)?.displayName ?? candidate.name} domain={presentationById.get(candidate.id)?.domain ?? candidate.sourceId} selected={skippedSelected.includes(candidate.id)} disabled={busy} onChange={(checked) => setSkippedSelected((current) => checked ? [...current, candidate.id] : current.filter((itemId) => itemId !== candidate.id))} />)}</div>
      </section>
      {message.length > 0 ? <DismissibleMessage onDismiss={() => setMessage('')} className={status === 'done' ? 'success' : 'error'} role={status === 'done' ? 'status' : 'alert'}>{message}</DismissibleMessage> : null}
      <div className="source-import-footer"><Button variant="secondary" type="button" disabled={busy} onClick={() => { setPreview(null); setFile(null); setSelected([]); setSkippedSelected([]); setFilter(''); setStatus('input'); setMessage('') }}>返回修改地址</Button><Button variant="secondary" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={busy || selected.length === 0} onClick={() => void confirm()}>{status === 'confirming' ? '保存中…' : `确认导入 ${selected.length} 项`}</Button></div>
    </div>}
  </Sheet>
    <Sheet open={open && showSourceSites} onOpenChange={setShowSourceSites} title="获取书源">
      <nav className="settings-entry-list" aria-label="书源获取地址">
        {[
          { name: '源仓库 · 原网站', url: 'https://www.yckceo.com/yuedu/shuyuans/index.html' },
          { name: '源仓库 · yck2026.fun', url: 'https://www.yck2026.fun/yuedu/shuyuans/index.html' },
          { name: '书源合集 · yiove.com', url: 'https://shuyuan.yiove.com/book-source-collections?page=1&page_size=20' },
          { name: '源仓库 · yckceo.vip', url: 'https://yckceo.vip' },
          { name: 'Bing 搜索：源仓库', url: 'https://www.bing.com/search?q=%E6%BA%90%E4%BB%93%E5%BA%93' },
        ].map((site) => <a className="settings-entry" key={site.url} href={site.url} target="_blank" rel="noopener noreferrer"><span className="settings-entry-copy"><strong>{site.name}</strong><span className="muted small source-site-url">{site.url}</span></span><ExternalLink aria-hidden="true" /></a>)}
      </nav>
    </Sheet>
  </>
}

function ImportCandidateRow({ candidate, displayName, domain, selected = false, disabled = false, onChange }: { candidate: ImportPreviewSummaryCandidate; displayName: string; domain: string; selected?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return <label className={`source-import-row ${candidate.disposition === undefined ? 'skipped' : ''}`}><input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => onChange?.(event.target.checked)} /><span className="source-import-row-body"><span className="source-import-row-title"><strong>{displayName}</strong><span className="source-import-reason">{candidate.reason}</span></span><span className="muted small">域名：{domain}{candidate.group === undefined ? '' : ` · ${candidate.group}`}</span><span className="source-url" title={candidate.sourceId}>{candidate.sourceId}</span><span className="muted small">规则更新时间 {formatSourceRuleDateTime(candidate.lastUpdateTime)}</span></span></label>
}

function ImportSelectionActions({ label, candidates, selected, disabled, onChange }: { label: string; candidates: ImportPreviewSummaryCandidate[]; selected: string[]; disabled: boolean; onChange: (selected: string[]) => void }) {
  const ids = candidates.map((candidate) => candidate.id)
  const selectedIds = new Set(selected)
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length
  return <div className="source-import-selection" role="group" aria-label={`${label}批量选择`}><span className="muted small" aria-live="polite">已选 {selectedCount}/{ids.length}</span><Button variant="secondary" size="sm" type="button" disabled={disabled || ids.length === 0 || selectedCount === ids.length} onClick={() => onChange(updateImportSelection(selected, ids, 'all'))}>全选</Button><Button variant="secondary" size="sm" type="button" disabled={disabled || ids.length === 0} onClick={() => onChange(updateImportSelection(selected, ids, 'invert'))}>反选</Button><Button variant="secondary" size="sm" type="button" disabled={disabled || selectedCount === 0} onClick={() => onChange(updateImportSelection(selected, ids, 'clear'))}>取消全选</Button></div>
}
