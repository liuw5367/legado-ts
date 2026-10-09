import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ThemeModeSelect, useReaderSettings } from '../lib/settings-context.tsx'

export function SettingsPage() {
  const { settings, saving, error, updateSettings } = useReaderSettings()
  const [message, setMessage] = useState('')
  async function save(patch: Parameters<typeof updateSettings>[0]) {
    setMessage('')
    try { await updateSettings(patch); setMessage('设置已保存') } catch { /* context 会展示错误 */ }
  }
  return <section className="page-stack settings-page">
    <div className="page-heading"><div><p className="eyebrow">READING SETTINGS</p><h1>阅读设置</h1><p className="muted">这些偏好会跟随当前账号，也会在设备之间同步。</p></div><Link className="button secondary" to="/">返回书架</Link></div>
    <section className="card settings-panel">
      <div className="settings-row"><div><h2>页面模式</h2><p className="muted small">跟随系统会在系统切换深色外观时自动更新。</p></div><ThemeModeSelect /></div>
      <div className="settings-row"><div><h2>字号</h2><p className="muted small">当前 {settings.fontSize}px</p></div><input aria-label="阅读字号" type="range" min="15" max="28" step="1" value={settings.fontSize} onChange={(event) => void save({ fontSize: Number(event.target.value) })} /></div>
      <div className="settings-row"><div><h2>行距</h2><p className="muted small">当前 {settings.lineHeight.toFixed(1)}</p></div><input aria-label="阅读行距" type="range" min="1.4" max="2.6" step="0.1" value={settings.lineHeight} onChange={(event) => void save({ lineHeight: Number(event.target.value) })} /></div>
      {saving ? <p className="muted small" role="status">正在保存…</p> : null}
      {message.length > 0 ? <p className="success" role="status">{message}</p> : null}
      {error === undefined ? null : <p className="error" role="alert">{error}</p>}
    </section>
  </section>
}
