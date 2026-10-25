import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { useEffect } from 'react'
import { Download, Upload } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { BackupRestoreDialog, BACKUP_CATEGORY_OPTIONS } from '../components/backup-restore-dialog.tsx'
import { downloadBackup, importBackup, validateBackup, type BackupPreview } from '../lib/api.ts'

import { SettingsEntry } from './settings.tsx'

const ALL_BACKUP_CATEGORIES = BACKUP_CATEGORY_OPTIONS.map((item) => item.value)

export function ImportExportSettingsPage() {
  useEffect(() => () => { setDialogOpen(false); setSelectedFile(undefined); setPreview(undefined) }, [])
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
    <PageHeader backTo="/account/settings" title="导入导出" description="备份应用数据，或从备份中恢复。" />
    <nav className="settings-entry-list" aria-label="导入导出选项">
      <SettingsEntry title="导入数据" description={busy ? '正在校验备份…' : '选择 ZIP 备份，恢复所选内容'} icon={<Upload aria-hidden="true" />} onClick={chooseBackup} disabled={busy} />
      <SettingsEntry title="导出数据" description={busy ? '正在导出…' : '下载书架、书单、分组、阅读记录、搜索记录、书源和设置'} icon={<Download aria-hidden="true" />} onClick={exportData} disabled={busy} />
    </nav>
    <input ref={inputRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={onFileChange} />
    {error === undefined ? null : <DismissibleMessage onDismiss={() => setError('')} className="error compact-message">{error}</DismissibleMessage>}
    {message === undefined ? null : <DismissibleMessage onDismiss={() => setMessage('')} className="success compact-message">{message}</DismissibleMessage>}
    <BackupRestoreDialog preview={preview} open={dialogOpen} categories={categories} busy={busy} error={error} onChange={setCategories} onConfirm={confirmImport} onCancel={() => { setDialogOpen(false); setError(undefined) }} />
  </section>
}
