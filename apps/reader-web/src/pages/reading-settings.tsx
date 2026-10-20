import { useId } from 'react'
import { PageBackButton } from '../components/page-back-button.tsx'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { SettingsPreview } from '../components/settings-preview.tsx'

export function ReadingSettingsPage() {
  const titleId = useId()
  return <section className="page-stack page-narrow reading-settings-page">
    <div className="toc-heading"><PageBackButton fallback="/account/settings" /><div className="toc-heading-main"><h1>阅读设置</h1><p className="muted">调整字号、行距、阅读模式和正文边距。</p></div></div>
    <section className="settings-detail-section" aria-labelledby={titleId}><h2 id={titleId}>阅读显示</h2><ReaderSettingsPanel /><SettingsPreview /></section>
  </section>
}
