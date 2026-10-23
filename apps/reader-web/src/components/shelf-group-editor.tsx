import { useState } from 'react'
import { Sheet } from './ui/sheet.tsx'
import { Input } from './ui/input.tsx'
import { Button } from './ui/button.tsx'
import { apiFetch, type ApiShelfGroup } from '../lib/api.ts'
export function ShelfGroupEditor({ group, onClose, onSaved }: { group?: ApiShelfGroup; onClose: () => void; onSaved: (id?: string) => void }) {
  const [name, setName] = useState(group?.name ?? ''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function save() { setBusy(true); setError(''); try { const result = await apiFetch<{ group?: ApiShelfGroup }>(group ? `/api/bookshelf-groups/${group.id}` : '/api/bookshelf-groups', { method: group ? 'PATCH' : 'POST', body: JSON.stringify({ name }) }); onSaved(result.group?.id ?? group?.id) } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') } finally { setBusy(false) } }
  return <Sheet open title={group ? '编辑分组' : '新增分组'} onOpenChange={(open) => { if (!open) onClose() }}><form className="page-stack" onSubmit={(event) => { event.preventDefault(); void save() }}><label>名称<Input value={name} required onChange={(event) => setName(event.target.value)} /></label>{error ? <p className="error" role="alert">{error}</p> : null}<div className="actions"><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>保存</Button></div></form></Sheet>
}
