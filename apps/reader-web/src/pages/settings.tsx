import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/button.tsx'
import { useAuth } from '../lib/auth-context.tsx'

export function SettingsPage() {
  const { user, logout } = useAuth()
  return <section className="page-stack page-narrow settings-page">
    <div className="compact-heading"><h1>设置</h1><p className="muted">阅读偏好会跟随当前账号同步。</p></div>
    <section className="settings-account" aria-labelledby="account-settings-title"><h2 id="account-settings-title">账号</h2><p>{user?.email ?? '当前账号'}</p><span className="muted small">当前登录账号</span></section>
    <nav className="settings-entry-list" aria-label="设置选项">
      <SettingsEntry to="/account/password" title="修改密码" description="更新登录密码" />
      <SettingsEntry to="/sources" title="书源管理" description="导入、启用与管理书源" />
      <SettingsEntry to="/account/settings/reading" title="阅读设置" description="调整字号、行距、阅读模式和正文边距" />
    </nav>
    <div className="settings-logout-area"><Button className="settings-logout-button" variant="secondary" type="button" onClick={() => void logout()}>退出登录</Button></div>
  </section>
}

function SettingsEntry({ to, title, description }: { to: string; title: string; description: string }) {
  return <Link className="settings-entry" to={to}><span className="settings-entry-copy"><strong>{title}</strong><span className="muted small">{description}</span></span><ChevronRight aria-hidden="true" /></Link>
}
