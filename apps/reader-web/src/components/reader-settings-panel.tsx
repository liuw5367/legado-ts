import { useState } from 'react'
import { ThemeModeSelect, useReaderSettings } from '../lib/settings-context.tsx'

export function ReaderSettingsPanel() {
  const { settings, saving, error, updateSettings } = useReaderSettings()
  const [message, setMessage] = useState('')
  async function save(patch: Parameters<typeof updateSettings>[0]) {
    setMessage('')
    try { await updateSettings(patch); setMessage('已保存') }
    catch { /* context 会保留错误并展示 */ }
  }
  return <div className="reader-settings-panel">
    <div className="reader-setting-row"><div><strong>页面模式</strong><p className="muted small">跟随系统或固定浅色、夜间模式。</p></div><ThemeModeSelect /></div>
    <label className="reader-setting-row reader-range"><span><strong>字号</strong><span className="muted small">{settings.fontSize}px</span></span><input aria-label="阅读字号" type="range" min="15" max="28" step="1" value={settings.fontSize} onChange={(event) => void save({ fontSize: Number(event.target.value) })} /></label>
    <label className="reader-setting-row reader-range"><span><strong>行距</strong><span className="muted small">{settings.lineHeight.toFixed(1)}</span></span><input aria-label="阅读行距" type="range" min="1.4" max="2.6" step="0.1" value={settings.lineHeight} onChange={(event) => void save({ lineHeight: Number(event.target.value) })} /></label>
    {saving ? <p className="muted small" role="status">正在保存…</p> : null}
    {message.length > 0 ? <p className="success compact-message" role="status">{message}</p> : null}
    {error === undefined ? null : <p className="error compact-message" role="alert">{error}</p>}
  </div>
}
