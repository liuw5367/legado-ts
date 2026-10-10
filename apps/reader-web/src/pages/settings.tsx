import { Link } from 'react-router-dom'
import { ReaderSettingsPanel } from '../components/reader-settings-panel.tsx'
import { Button } from '../components/ui/button.tsx'
import { useAuth } from '../lib/auth-context.tsx'
import { useReaderSettings } from '../lib/settings-context.tsx'

export function SettingsPage() {
  const { user, logout } = useAuth()
  return <section className="page-stack page-narrow settings-page">
    <div className="compact-heading"><h1>设置</h1><p className="muted">阅读偏好会跟随当前账号同步。</p></div>
    <section className="settings-section" aria-labelledby="reading-settings-title"><h2 id="reading-settings-title">阅读显示</h2><ReaderSettingsPanel /><SettingsPreview /></section>
    <section className="settings-section account-section" aria-labelledby="account-settings-title"><h2 id="account-settings-title">账号</h2><div className="account-row"><span className="muted">{user?.email ?? '当前账号'}</span><Link className="button secondary small" to="/account/password">修改密码</Link></div><Link className="button secondary" to="/sources">管理书源</Link><Button className="logout-button" variant="secondary" type="button" onClick={() => void logout()}>退出登录</Button></section>
  </section>
}

function SettingsPreview() {
  const { settings } = useReaderSettings()
  return <div className="settings-preview" aria-label="排版预览"><p className="settings-preview-label muted small">排版预览</p><p className="settings-preview-copy" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>晚风从窗边经过，书页上的句子也跟着慢下来。</p></div>
}
