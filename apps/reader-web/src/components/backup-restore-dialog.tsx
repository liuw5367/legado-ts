import type { BackupPreview } from '../lib/api.ts'

export const BACKUP_CATEGORY_OPTIONS = [
  { value: 'bookshelf', label: '书架', description: '书籍元数据、书架分组、书单与评价' },
  { value: 'reading', label: '阅读记录', description: '章节、段落和阅读位置' },
  { value: 'search', label: '搜索记录', description: '搜索关键词和结果摘要' },
  { value: 'sources', label: '书源', description: '书源定义和启用状态' },
  { value: 'settings', label: '设置', description: '当前应用的阅读设置' },
] as const

export function BackupRestoreDialog({ preview, open, categories, busy, error, onChange, onConfirm, onCancel }: { preview: BackupPreview | undefined; open: boolean; categories: string[]; busy: boolean; error?: string | undefined; onChange: (value: string[]) => void; onConfirm: () => void; onCancel: () => void }) {
  if (!open || preview === undefined) return null
  const toggle = (value: string): void => onChange(categories.includes(value) ? categories.filter((item) => item !== value) : [...categories, value])
  return <div className="backup-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel() }}>
    <section className="backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title">
      <div className="backup-dialog-heading"><div><h2 id="backup-dialog-title">选择要恢复的内容</h2><p className="muted small">备份来自 {preview.manifest.producer.name}，创建于 {formatTime(preview.manifest.createdAt)}。选中的分类会完整覆盖当前数据。</p></div><button className="backup-dialog-close" type="button" aria-label="关闭" disabled={busy} onClick={onCancel}>×</button></div>
      <div className="backup-dialog-list">
        {BACKUP_CATEGORY_OPTIONS.map((option) => <label className="backup-dialog-option" key={option.value}><input type="checkbox" checked={categories.includes(option.value)} disabled={busy} onChange={() => toggle(option.value)} /><span><strong>{option.label}</strong><span className="muted small">{option.description}，备份 {preview.preview.recordCounts[option.value]} 项，当前 {preview.currentCounts[option.value]} 项；确认后完整覆盖</span></span></label>)}
      </div>
      {error === undefined ? null : <p className="error compact-message">{error}</p>}
      <div className="backup-dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button" type="button" disabled={busy || categories.length === 0} onClick={onConfirm}>{busy ? '正在恢复…' : '确认恢复'}</button></div>
    </section>
  </div>
}

function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN') }
