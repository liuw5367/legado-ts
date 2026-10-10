import { PageBackButton } from '../components/page-back-button.tsx'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { SettingsPreview } from '../components/settings-preview.tsx'

export function ReadingSettingsPage() {
  return <section className="page-stack page-narrow reading-settings-page">
    <div className="toc-heading"><PageBackButton fallback="/account/settings" /><div className="toc-heading-main"><h1>阅读设置</h1><p className="muted">调整阅读时的字号、行距与页面模式。</p></div></div>
    <section className="settings-detail-section" aria-labelledby="reading-settings-title"><h2 id="reading-settings-title">阅读显示</h2><ReaderSettingsPanel /><SettingsPreview /></section>
  </section>
}
