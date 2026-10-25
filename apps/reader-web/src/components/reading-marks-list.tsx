import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { MessageSquare, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { apiFetch } from '../lib/api.ts'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { pageReturnState } from '../lib/page-navigation.ts'
import type { MarkKind, MarkPage, ReadingMark } from '../../shared/reading-annotations.ts'
import { ReadingMarkEditor } from './reading-mark-editor.tsx'
import { DismissibleMessage } from './dismissible-message.tsx'
import { LoadingState } from './loading-state.tsx'
import { Button } from './ui/button.tsx'

export function ReadingMarksList({ kind, bookId, q = '', deleted = false, global = false, onNavigate }: { kind: MarkKind; bookId?: string; q?: string; deleted?: boolean; global?: boolean; onNavigate?: () => void }) {
  const [items, setItems] = useState<ReadingMark[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [retry, setRetry] = useState(0); const [busy, setBusy] = useState<string | null>(null); const [editing, setEditing] = useState<ReadingMark | null>(null)
  const cache = useBookCache(); const navigate = useNavigate(); const location = useLocation()
  const params = new URLSearchParams({ q, deleted: String(deleted) }); if (bookId) params.set('bookId', bookId)
  const path = global ? '/api/annotations?' + params : '/api/books/' + encodeURIComponent(bookId ?? '') + '/' + kind + '?' + params
  usePageLoadEffect((settle) => {
    const controller = new AbortController(); setLoading(true); setError('')
    void apiFetch<MarkPage>(path, { signal: controller.signal }).then((page) => { setItems(page.items); setCursor(page.nextCursor) }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败') }).finally(() => { if (!controller.signal.aborted) { setLoading(false); settle() } })
    return () => controller.abort()
  }, [path, retry], ['notes'])
  function itemPath(mark: ReadingMark) { return '/api/books/' + encodeURIComponent(mark.bookId) + '/' + kind + '/' + mark.id }
  async function action(mark: ReadingMark, restore: boolean) {
    setBusy(mark.id); setError('')
    try { await apiFetch(itemPath(mark) + (restore ? '/restore' : ''), { method: restore ? 'POST' : 'DELETE', body: JSON.stringify({ expectedVersion: mark.version }) }); setItems((current) => current.filter((r) => r.id !== mark.id)) } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') } finally { setBusy(null) }
  }
  async function open(mark: ReadingMark) {
    setBusy(mark.id); setError('')
    try {
      const snapshot = await loadBookSnapshot(cache, mark.bookId, mark.editionKey)
      const chapter = snapshot.toc.chapters.find((c) => c.chapterUrl === mark.chapterUrl)
      if (!chapter || snapshot.toc.sourceFingerprint !== mark.sourceFingerprint) throw new Error('原来源或章节不可用，笔记仍然保留')
      navigate('/books/' + encodeURIComponent(mark.bookId) + '/read/' + encodeURIComponent(chapter.chapterId) + '?editionKey=' + encodeURIComponent(mark.editionKey) + '&mark=' + mark.id + '&markKind=' + kind, { state: pageReturnState(location) }); onNavigate?.()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法打开原文') } finally { setBusy(null) }
  }
  async function more() {
    if (!cursor) return
    setBusy('more'); setError('')
    try { const result = await apiFetch<MarkPage>(path + '&cursor=' + cursor); setItems((old) => [...old, ...result.items.filter((r) => !old.some((i) => i.id === r.id))]); setCursor(result.nextCursor) } catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败') } finally { setBusy(null) }
  }
  return <div className="reading-marks-list">
    {error ? <div className="notice-with-recovery"><DismissibleMessage className="error" role="alert" onDismiss={() => setError('')}>{error}</DismissibleMessage><button className="text-button" onClick={() => setRetry((n) => n + 1)} type="button">重新加载</button></div> : null}
    {loading ? <LoadingState message="正在读取记录…" /> : items.length === 0 ? <p className="muted">{q || bookId && global ? '没有符合条件的笔记' : deleted ? '没有已删除的笔记' : kind === 'bookmarks' ? '还没有书签' : '还没有笔记'}</p> : null}
    {items.map((mark) => <div className="reading-mark-item" key={mark.id} data-color={mark.color}>
      <div className="reading-mark-meta"><strong>{global ? mark.bookName : mark.chapterTitle}</strong><time dateTime={mark.createdAt}>{new Date(mark.createdAt).toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>
      <button type="button" className="reading-mark-excerpt" disabled={busy !== null || deleted} onClick={() => void open(mark)}>{mark.anchor.exact}</button>
      {mark.note ? <p className="reading-mark-note"><MessageSquare aria-hidden="true" />{mark.note}</p> : null}
      <div className="reading-mark-footer"><span className="muted small">{global ? mark.chapterTitle + ' · ' : ''}{'来源版本'} {mark.sourceFingerprint.slice(0, 8)}</span><div className="reading-mark-actions">{deleted ? <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void action(mark, true)}><RotateCcw aria-hidden="true" />恢复</Button> : <>{kind === 'annotations' ? <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(mark)}><Pencil aria-hidden="true" />编辑</Button> : null}<Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void action(mark, false)}><Trash2 aria-hidden="true" />删除</Button></>}</div></div>
    </div>)}
    {cursor ? <Button variant="secondary" disabled={busy !== null || loading} onClick={() => void more()}>加载更多</Button> : null}
    {editing ? <ReadingMarkEditor key={editing.id} initialNote={editing.note ?? ''} onClose={() => setEditing(null)} onSave={async (note) => { const { id: _id, userId: _user, bookId: _book, bookName: _name, author: _author, createdAt: _created, updatedAt: _updated, deletedAt: _deleted, version, ...input } = editing; await apiFetch(itemPath(editing), { method: 'PUT', body: JSON.stringify({ ...input, note, expectedVersion: version }) }) }} /> : null}
  </div>
}
