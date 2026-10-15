import { Download, ChevronRight, LogOut, LockKeyhole, Upload } from 'lucide-react'
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BackupRestoreDialog, BACKUP_CATEGORY_OPTIONS } from '../components/backup-restore-dialog.tsx'
import { Button, buttonVariants } from '../components/ui/button.tsx'
import { useAuth } from '../lib/auth-context.tsx'
import { downloadBackup, importBackup, validateBackup, type BackupPreview } from '../lib/api.ts'

const ALL_BACKUP_CATEGORIES = BACKUP_CATEGORY_OPTIONS.map((item) => item.value)

export function SettingsPage() {
  const { user, logout } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | undefined>()
  const [preview, setPreview] = useState<BackupPreview | undefined>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [categories, setCategories] = useState<string[]>(ALL_BACKUP_CATEGORIES)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()

  const chooseBackup = (): void => { setError(undefined); setMessage(undefined); inputRef.current?.click() }
  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setSelectedFile(file)
    setBusy(true)
    setError(undefined)
    void validateBackup(file).then((value) => { setPreview(value); setCategories([...ALL_BACKUP_CATEGORIES]); setDialogOpen(true) }, (reason: unknown) => { setSelectedFile(undefined); setPreview(undefined); setError(reason instanceof Error ? reason.message : '备份校验失败') }).finally(() => setBusy(false))
  }
  const confirmImport = (): void => {
    if (selectedFile === undefined || categories.length === 0) return
    setBusy(true)
    setError(undefined)
    void importBackup(selectedFile, categories).then(() => { setDialogOpen(false); setSelectedFile(undefined); window.location.reload() }, (reason: unknown) => setError(reason instanceof Error ? reason.message : '备份导入失败')).finally(() => setBusy(false))
  }
  const exportData = (): void => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    void downloadBackup().then((blob) => {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `legado-reader-backup-${new Date().toISOString().slice(0, 10)}.zip`
      anchor.className = 'sr-only'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      setMessage('备份已下载。')
    }, (reason: unknown) => setError(reason instanceof Error ? reason.message : '备份导出失败')).finally(() => setBusy(false))
  }

  return <section className="page-stack page-narrow settings-page">
    <div className="compact-heading"><h1>设置</h1><p className="muted">阅读偏好会跟随当前账号同步。</p></div>
    <section className="settings-account" aria-labelledby="account-settings-title">
      <div className="settings-account-info"><h2 id="account-settings-title">账号</h2><p>{user?.email ?? '当前账号'}</p><span className="muted small">当前登录账号</span></div>
      <div className="settings-account-actions"><Link className={buttonVariants({ variant: 'secondary', className: 'settings-account-action' })} to="/account/password"><LockKeyhole aria-hidden="true" />修改密码</Link><Button className="settings-account-action settings-logout-button" type="button" onClick={() => void logout()}><LogOut aria-hidden="true" />退出登录</Button></div>
    </section>
    <nav className="settings-entry-list" aria-label="设置选项">
      <SettingsEntry to="/sources" title="书源管理" description="导入、启用与管理书源" />
      <SettingsEntry to="/account/settings/reading" title="阅读设置" description="调整字号、行距、阅读模式和正文边距" />
      <SettingsEntry title="导入数据" description={busy ? '正在校验备份…' : '选择 ZIP 备份，恢复所选内容'} icon={<Upload aria-hidden="true" />} onClick={chooseBackup} disabled={busy} />
      <SettingsEntry title="导出数据" description={busy ? '正在导出…' : '下载书架、阅读记录、搜索记录、书源和设置'} icon={<Download aria-hidden="true" />} onClick={exportData} disabled={busy} />
    </nav>
    <input ref={inputRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={onFileChange} />
    {error === undefined ? null : <p className="error compact-message">{error}</p>}
    {message === undefined ? null : <p className="success compact-message">{message}</p>}
    <BackupRestoreDialog preview={preview} open={dialogOpen} categories={categories} busy={busy} error={error} onChange={setCategories} onConfirm={confirmImport} onCancel={() => { setDialogOpen(false); setError(undefined) }} />
  </section>
}

function SettingsEntry({ to, title, description, icon, onClick, disabled = false }: { to?: string; title: string; description: string; icon?: ReactNode; onClick?: () => void; disabled?: boolean }) {
  const content = <><span className="settings-entry-copy"><strong>{title}</strong><span className="muted small">{description}</span></span>{icon ?? <ChevronRight aria-hidden="true" />}</>
  if (to !== undefined) return <Link className="settings-entry" to={to}>{content}</Link>
  return <button className="settings-entry settings-entry-action" type="button" disabled={disabled} onClick={onClick}>{content}</button>
}
