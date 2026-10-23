import { useState, type FormEvent } from 'react'
import { Sheet } from './ui/sheet.tsx'
import { Input } from './ui/input.tsx'
import { Button } from './ui/button.tsx'
import { apiFetch } from '../lib/api.ts'
import type { StoredBookList } from '../../shared/book-lists.ts'

export function BookListEditor({ list, onClose, onSaved }: { list?: StoredBookList; onClose: () => void; onSaved: (list: StoredBookList) => void }) {
  const [name, setName] = useState(list?.name ?? '')
  const [description, setDescription] = useState(list?.description ?? '')
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try { const result = await apiFetch<{ list: StoredBookList }>(list ? `/api/book-lists/${list.id}` : '/api/book-lists', { method: list ? 'PATCH' : 'POST', body: JSON.stringify({ name, description }) }); onSaved(result.list) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') } finally { setSaving(false) }
  }
  return <Sheet open onOpenChange={(open) => { if (!open) onClose() }} title={list ? '编辑书单' : '新增书单'}><form className="page-stack" onSubmit={(event) => void save(event)}><label>名称<Input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>描述<textarea className="input organization-textarea" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label>{error ? <p className="error" role="alert">{error}</p> : null}<div className="actions"><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button disabled={saving} type="submit">{saving ? '保存中…' : '保存'}</Button></div></form></Sheet>
}
