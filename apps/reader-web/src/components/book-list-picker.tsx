import { DismissibleMessage } from './dismissible-message.tsx'
import { useState } from 'react'
import { Sheet } from './ui/sheet.tsx'
import { Button } from './ui/button.tsx'
import { BookListEditor } from './book-list-editor.tsx'
import { apiFetch, type ApiBook, type ApiBookList } from '../lib/api.ts'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'

export function BookListPicker({ book, resolveBook, defaultListId, move = false, onClose, onSaved }: { book: Pick<ApiBook, 'name' | 'author'> & { id?: string }; resolveBook?: () => Promise<ApiBook>; defaultListId?: string; move?: boolean; onClose: () => void; onSaved?: () => void }) {
  const [lists, setLists] = useState<ApiBookList[] | null>(null); const [selected, setSelected] = useState(defaultListId ?? '')
  const [creating, setCreating] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0)
  usePageLoadEffect((settle) => { const controller = new AbortController(); void apiFetch<{ lists: ApiBookList[] }>('/api/book-lists' + (book.id ? `?bookId=${book.id}` : ''), { signal: controller.signal }).then((result) => { setLists(result.lists); if (defaultListId && !result.lists.some((row) => row.id === defaultListId)) { setSelected(''); setError('来源书单已删除，请重新选择') } }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败') }).finally(settle); return () => controller.abort() }, [book.id, retry], ['booklists'])
  async function save() {
    if (!selected || saving) return
    setSaving(true); setError('')
    try {
      const saved = book.id ? book : await resolveBook?.()
      if (!saved?.id) throw new Error('书籍尚未保存')
      await apiFetch(`/api/book-lists/${selected}/books/${saved.id}` + (move ? '/move-from-bookshelf' : ''), { method: move ? 'POST' : 'PUT', body: '{}' })
      onSaved?.(); onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加入失败') } finally { setSaving(false) }
  }
  if (creating) return <BookListEditor onClose={() => setCreating(false)} onSaved={(list) => { setLists((old) => [{ ...list, bookCount: 0, coverBooks: [], containsBook: false }, ...(old ?? [])]); setSelected(list.id); setCreating(false) }} />
  const target = lists?.find((row) => row.id === selected)
  return <Sheet open onOpenChange={(open) => { if (!open) onClose() }} title={move ? '移入书单' : '加入书单'}><div className="page-stack"><p>{book.name} · {book.author ?? '作者未知'}</p>{move ? <p className="muted">成功后将从书架移除。</p> : null}<div className="organization-options">{lists === null ? <p>正在读取书单…</p> : lists.length === 0 ? <p className="muted">还没有书单</p> : lists.map((row) => <label className="organization-choice" key={row.id}><input type="radio" name="book-list" checked={selected === row.id} disabled={!move && row.containsBook} onChange={() => setSelected(row.id)} /><span><strong>{row.name}</strong><span className="muted small">{row.description}</span></span><span>{row.containsBook ? '已加入' : `${row.bookCount} 本`}</span></label>)}</div>{error ? <DismissibleMessage onDismiss={() => setError('')} className="error" role="alert">{error}<Button size="sm" variant="secondary" onClick={() => { setError(''); setRetry((value) => value + 1) }}>重试</Button></DismissibleMessage> : null}<div className="sheet-footer"><Button className="sheet-footer-start" variant="secondary" onClick={() => setCreating(true)}>新建书单</Button><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={saving || !target || (!move && target.containsBook)} onClick={() => void save()}>{saving ? '保存中…' : move ? '确认移入' : '确认加入'}</Button></div></div></Sheet>
}
