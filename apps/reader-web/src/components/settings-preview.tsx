import { useReaderSettings } from '../lib/settings-context.tsx'

export function SettingsPreview() {
  const { settings } = useReaderSettings()
  return <div className="settings-preview" aria-label="排版预览"><p className="settings-preview-label muted small">排版预览</p><p className="settings-preview-copy" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>晚风从窗边经过，书页上的句子也跟着慢下来。</p></div>
}
