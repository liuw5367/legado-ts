import { Minus, Plus } from 'lucide-react'
import { stepSetting } from '../lib/setting-step.ts'
import { ReadingModeSelect, ThemeModeSelect, useReaderSettings } from '../lib/settings-context.tsx'

export function ReaderSettingsPanel() {
  const { settings, saving, error, updateSettings } = useReaderSettings()
  async function save(patch: Parameters<typeof updateSettings>[0]) {
    try { await updateSettings(patch) }
    catch { /* context 会保留错误并展示 */ }
  }
  return <div className="reader-settings-panel">
    <div className="reader-setting-row"><div><strong>页面模式</strong><p className="muted small">跟随系统或固定浅色、夜间模式。</p></div><ThemeModeSelect /></div>
    <div className="reader-setting-row"><div><strong>阅读模式</strong><p className="muted small">滚动浏览章节，或按屏幕分页阅读。</p></div><ReadingModeSelect /></div>
    <SettingRange label="字号" value={settings.fontSize} min={15} max={28} step={1} suffix="px" onChange={(value) => void save({ fontSize: value })} />
    <SettingRange label="行距" value={settings.lineHeight} min={1.4} max={2.6} step={0.1} onChange={(value) => void save({ lineHeight: value })} />
    <div className="reader-setting-group" aria-labelledby="reader-margin-settings-title"><p id="reader-margin-settings-title" className="reader-setting-group-title muted small">正文边距</p>
      <SettingRange label="上边距" value={settings.marginTop} min={0} max={64} step={1} suffix="px" onChange={(value) => void save({ marginTop: value })} />
      <SettingRange label="右边距" value={settings.marginRight} min={0} max={64} step={1} suffix="px" onChange={(value) => void save({ marginRight: value })} />
      <SettingRange label="下边距" value={settings.marginBottom} min={0} max={64} step={1} suffix="px" onChange={(value) => void save({ marginBottom: value })} />
      <SettingRange label="左边距" value={settings.marginLeft} min={0} max={64} step={1} suffix="px" onChange={(value) => void save({ marginLeft: value })} />
    </div>
    {saving ? <p className="muted small" role="status">正在保存…</p> : null}
    {error === undefined ? null : <p className="error compact-message" role="alert">{error}</p>}
  </div>
}

function SettingRange({ label, value, min, max, step, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return <div className="reader-setting-row reader-range"><span className="setting-value"><strong>{label}</strong><span className="muted small">{step === 1 ? value : value.toFixed(1)}{suffix}</span></span><div className="setting-stepper"><button type="button" aria-label={'减小' + label} disabled={value <= min} onClick={() => onChange(stepSetting(value, -1, min, max, step))}><Minus aria-hidden="true" /></button><input aria-label={'阅读' + label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><button type="button" aria-label={'增大' + label} disabled={value >= max} onClick={() => onChange(stepSetting(value, 1, min, max, step))}><Plus aria-hidden="true" /></button></div></div>
}
