import { EmptyState } from './empty-state.tsx'
import { ImageOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BookCoverSelection, BookSourceItem, BookSourcesResponse } from '../../shared/book-sources.ts'
import type { BookDetailsResponse } from '../../shared/book-details.ts'
import { sourceDomainInfo } from '../../shared/source-domain.ts'
import { apiFetch, type ApiBook, type ApiEdition } from '../lib/api.ts'
import { bookCoverSourceKey, readBookCovers } from '../lib/book-cover-queue.ts'
import { usePageActivity } from '../lib/use-page-resource.ts'
import { BookCover } from './book-cover.tsx'
import { DismissibleMessage } from './dismissible-message.tsx'
import { LoadingState } from './loading-state.tsx'
import { Button } from './ui/button.tsx'
import { Sheet } from './ui/sheet.tsx'

type CoverRow = { source: BookSourceItem; status: 'pending' | 'loading' | 'ready' | 'empty' | 'failed'; coverUrl?: string; error?: string; selection?: BookCoverSelection }

export function BookCoverPicker({ data, onClose, onSaved }: { data: BookDetailsResponse; onClose: () => void; onSaved: (book: ApiBook) => void }) {
  const activity = usePageActivity()
  const [rows, setRows] = useState<CoverRow[]>([])
  const rowsRef = useRef<CoverRow[]>([])
  const request = useRef<AbortController | null>(null)
  const listing = useRef<AbortController | null>(null)
  const alive = useRef(false)
  const [imageRetries, setImageRetries] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('current')
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set())
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const prefix = '/api/books/' + encodeURIComponent(data.book.id)
  const currentCover = data.book.customCoverUrl || data.edition.metadata.coverUrl || data.book.coverUrl

  function replaceRows(next: CoverRow[]) { rowsRef.current = next; setRows(next) }
  function stop() {
    request.current?.abort()
    request.current = null
    replaceRows(rowsRef.current.map((row) => row.status === 'loading' ? { ...row, status: 'pending' } : row))
    setRunning(false)
  }
  async function run(sources: BookSourceItem[]) {
    if (request.current !== null || sources.length === 0 || savingRef.current) return
    const controller = new AbortController(); request.current = controller; setRunning(true)
    await readBookCovers(sources, controller.signal, async (source, signal) => {
      if (source.status !== 'discovered') return source.coverUrl
      const { edition } = await apiFetch<{ edition: ApiEdition }>(prefix + '/sources/' + encodeURIComponent(source.candidateId) + '/open', { method: 'POST', signal })
      if (!signal.aborted && alive.current) {
        // 详情脚本可能规范化书籍地址，保存时使用服务端返回的版本身份。
        const key = bookCoverSourceKey(source)
        replaceRows(rowsRef.current.map((row) => bookCoverSourceKey(row.source) === key ? { ...row, selection: { sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl } } : row))
      }
      return typeof edition.metadata.coverUrl === 'string' ? edition.metadata.coverUrl : undefined
    }, (source, result) => {
      if (!alive.current || controller.signal.aborted) return
      const key = bookCoverSourceKey(source)
      replaceRows(rowsRef.current.map((row) => bookCoverSourceKey(row.source) === key ? { ...row, ...result } : row))
    })
    if (request.current === controller) { request.current = null; if (alive.current) setRunning(false) }
  }
  async function load() {
    listing.current?.abort()
    const controller = new AbortController(); listing.current = controller
    setLoading(true); setError('')
    try {
      const response = await apiFetch<BookSourcesResponse>(prefix + '/sources', { signal: controller.signal })
      if (controller.signal.aborted || !alive.current) return
      const next: CoverRow[] = response.sources.map((source) => source.coverUrl ? { source, status: 'ready', coverUrl: source.coverUrl } : { source, status: source.status === 'discovered' ? 'pending' : 'empty' })
      replaceRows(next)
      void run(next.filter((row) => row.status === 'pending').map((row) => row.source))
    } catch (reason) { if (!controller.signal.aborted && alive.current) setError(reason instanceof Error ? reason.message : '封面来源加载失败') }
    finally { if (!controller.signal.aborted && alive.current) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    if (activity?.active === false) { onClose(); return () => { alive.current = false } }
    void load()
    return () => { alive.current = false; listing.current?.abort(); request.current?.abort(); request.current = null }
  }, [data.book.id, activity?.active])

  function close() { if (savingRef.current) return; listing.current?.abort(); stop(); onClose() }
  async function save() {
    if (savingRef.current || selected === 'current') return
    const row = rowsRef.current.find((item) => bookCoverSourceKey(item.source) === selected)
    if (selected !== 'default' && (!row?.coverUrl || row.coverUrl === currentCover || !loadedImages.has(row.coverUrl) || failedImages.has(row.coverUrl))) return
    savingRef.current = true; setSaving(true); setError(''); stop(); listing.current?.abort()
    const source = row?.selection ?? row?.source
    try {
      const value = await apiFetch<{ book: ApiBook }>(prefix + '/cover', { method: 'PUT', body: JSON.stringify({ selection: selected === 'default' ? null : { sourceId: source!.sourceId, sourceFingerprint: source!.sourceFingerprint, bookUrl: source!.bookUrl } }) })
      if (alive.current) { onSaved(value.book); onClose() }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '封面保存失败') }
    finally { savingRef.current = false; if (alive.current) setSaving(false) }
  }
  function imageState(url: string, state: 'loaded' | 'failed') {
    if (state === 'loaded') setLoadedImages((current) => new Set(current).add(url))
    else setFailedImages((current) => new Set(current).add(url))
  }

  const pending = rows.some((row) => row.status === 'pending')
  const completed = rows.filter((row) => row.status !== 'pending' && row.status !== 'loading').length
  const groups = new Map<string, CoverRow[]>()
  for (const row of rows) {
    const key = row.coverUrl || bookCoverSourceKey(row.source)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const selectedRow = rows.find((row) => bookCoverSourceKey(row.source) === selected)
  const canSave = selected === 'default' ? !!data.book.customCoverUrl : selected !== 'current' && !!selectedRow?.coverUrl && selectedRow.coverUrl !== currentCover && loadedImages.has(selectedRow.coverUrl) && !failedImages.has(selectedRow.coverUrl)

  return <Sheet open title="切换封面" className="book-cover-sheet" onOpenChange={(open) => { if (!open) close() }}>
    <p className="muted small">从已搜索到的书源中选择封面，阅读书源和进度保持不变。</p>
    {error ? <DismissibleMessage className="error" role="alert" onDismiss={() => setError('')}>{error}{rows.length === 0 ? <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button> : null}</DismissibleMessage> : null}
    <div className="cover-current"><button type="button" className="cover-option" aria-label="保留当前封面" aria-pressed={selected === 'current'} disabled={saving} onClick={() => setSelected('current')}><BookCover name={data.book.name} coverUrl={currentCover} size="detail" /><span>当前封面</span></button><button type="button" className="button secondary" aria-pressed={selected === 'default'} disabled={saving || !data.book.customCoverUrl} onClick={() => setSelected('default')}>使用书源封面</button></div>
    {loading ? <LoadingState message="正在读取封面来源…" /> : <p className="muted small" role="status">已处理 {completed} / {rows.length} 个来源{running ? '，正在获取…' : pending ? '，已停止获取' : ''}</p>}
    <div className="cover-grid">{[...groups.entries()].map(([key, group]) => {
      const row = group[0]!
      const url = row.coverUrl
      const failed = !!url && failedImages.has(url)
      const ready = !!url && loadedImages.has(url) && !failed
      const names = group.map((item) => item.source.name).join('、')
      return <div className="cover-grid-item" key={key}>
        <button type="button" className="cover-option" aria-label={'选择封面：' + names} aria-pressed={group.some((item) => bookCoverSourceKey(item.source) === selected)} disabled={saving || !ready} onClick={() => setSelected(bookCoverSourceKey(row.source))}>
          <BookCover key={key + (imageRetries[key] ?? 0)} name={data.book.name} coverUrl={url} size="detail" onImageState={(state) => { if (url) imageState(url, state) }} />
          <span className="cover-source-name">{row.source.name}</span><span className="muted small">{sourceDomainInfo(row.source.sourceId).domain}</span>
          <span className={row.status === 'failed' || failed ? 'cover-failed small' : 'muted small'}>{failed ? '图片加载失败' : row.status === 'ready' ? ready ? '可选择' : '图片加载中…' : row.status === 'loading' ? '读取中…' : row.status === 'pending' ? '等待获取' : row.status === 'empty' ? '无封面' : row.error || '读取失败'}</span>
        </button>
        {group.length > 1 ? <details className="small"><summary>{group.length} 个来源</summary><p className="cover-source-names">{names}</p></details> : null}
        {row.status === 'failed' ? <Button size="sm" variant="secondary" disabled={running || saving} onClick={() => void run([row.source])}>重试</Button> : failed && url ? <Button size="sm" variant="secondary" disabled={saving} onClick={() => { setFailedImages((current) => { const next = new Set(current); next.delete(url); return next }); setLoadedImages((current) => { const next = new Set(current); next.delete(url); return next }); replaceRows(rowsRef.current.map((item) => item.coverUrl === url ? { ...item } : item)); setImageRetries((value) => ({ ...value, [url]: (value[url] ?? 0) + 1 })) }}>重试图片</Button> : null}
      </div>
    })}</div>
    {!loading && rows.length === 0 && !error ? <EmptyState icon={ImageOff} title="没有其他封面来源" description="先到切换书源页面搜索" /> : null}
    <div className="cover-picker-footer"><div>{running ? <Button variant="secondary" disabled={saving} onClick={stop}>停止获取</Button> : pending ? <Button variant="secondary" disabled={saving} onClick={() => void run(rowsRef.current.filter((row) => row.status === 'pending').map((row) => row.source))}>继续获取</Button> : null}</div><div className="actions"><Button variant="secondary" disabled={saving} onClick={close}>取消</Button><Button disabled={saving || !canSave} onClick={() => void save()}>{saving ? '保存中…' : '保存封面'}</Button></div></div>
  </Sheet>
}
