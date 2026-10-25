import { useState } from 'react'
import { Sheet } from './ui/sheet.tsx'
import { Button } from './ui/button.tsx'
import { DismissibleMessage } from './dismissible-message.tsx'

export function ReadingMarkEditor({ initialNote, onSave, onClose }: { initialNote: string; onSave: (note: string | null) => Promise<void>; onClose: () => void }) {
  const [note, setNote] = useState(initialNote); const [saving, setSaving] = useState(false); const [error, setError] = useState('')
  return <Sheet open onOpenChange={(open) => { if (!open && !saving) onClose() }} title={initialNote ? '编辑想法' : '写想法'}>
    <form className="mark-editor" onSubmit={(event) => { event.preventDefault(); setSaving(true); setError(''); void onSave(note.trim() || null).then(onClose).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '保存失败')).finally(() => setSaving(false)) }}>
      <label htmlFor="reading-mark-note">想法</label><textarea id="reading-mark-note" maxLength={2000} value={note} disabled={saving} onChange={(event) => setNote(event.target.value)} placeholder="写下你的想法…" />
      <span className="muted small">{note.length} / 2000</span>
      {error ? <DismissibleMessage className="error" role="alert" onDismiss={() => setError('')}>{error}</DismissibleMessage> : null}
      <div className="mark-editor-actions"><Button variant="secondary" type="button" disabled={saving} onClick={onClose}>取消</Button><Button type="submit" disabled={saving || (!initialNote && !note.trim())}>{saving ? '保存中…' : '确认'}</Button></div>
    </form>
  </Sheet>
}
