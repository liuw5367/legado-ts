import { PageHeader } from '../components/page-header.tsx'
import { useId } from 'react'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { SettingsPreview } from '../components/settings-preview.tsx'

export function ReadingSettingsPage() {
  const titleId = useId()
  return <section className="page-stack page-narrow reading-settings-page">
    <PageHeader backTo="/account/settings" title="阅读设置" description="调整字号、行距、阅读模式和正文边距。" />
    <section className="settings-detail-section" aria-labelledby={titleId}><h2 id={titleId}>阅读显示</h2><ReaderSettingsPanel /><SettingsPreview /></section>
  </section>
}
