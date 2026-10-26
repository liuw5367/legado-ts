import { PageHeader } from '../components/page-header.tsx'
import { ChevronRight, LogOut, LockKeyhole } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, buttonVariants } from '../components/ui/button.tsx'
import { useAuth } from '../lib/auth-context.tsx'

export function SettingsPage() {
  const { user, logout } = useAuth()

  return <section className="page-stack page-narrow settings-page">
    <PageHeader title="设置" description="应用偏好会跟随当前账号同步。" />
    <section className="settings-account" aria-labelledby="account-settings-title">
      <div className="settings-account-info"><h2 id="account-settings-title">账号</h2><p>{user?.email ?? '当前账号'}</p><span className="muted small">当前登录账号</span></div>
      <div className="settings-account-actions"><Link className={buttonVariants({ variant: 'secondary', className: 'settings-account-action' })} to="/account/password"><LockKeyhole aria-hidden="true" />修改密码</Link><Button className="settings-account-action settings-logout-button" type="button" onClick={() => void logout()}><LogOut aria-hidden="true" />退出登录</Button></div>
    </section>
    <nav className="settings-entry-list" aria-label="设置选项">
      <SettingsEntry to="/sources" title="书源管理" description="导入、启用与管理书源" />
      <SettingsEntry to="/account/settings/bookshelf-groups" title="书架分组" description="管理分组、顺序和启动显示分组" />
      <SettingsEntry to="/account/settings/general" title="通用设置" description="设置书架排序等应用偏好" />
      <SettingsEntry to="/account/settings/reading" title="阅读设置" description="调整字号、行距、阅读模式和正文边距" />
      <SettingsEntry to="/account/settings/notes" title="笔记管理" description="查看和搜索各本书的划线与想法" />
      <SettingsEntry to="/account/settings/import-export" title="导入导出" description="导入备份或导出应用数据" />
      <SettingsEntry to="/account/settings/about" title="关于应用" description="应用版本与项目地址" />
    </nav>
  </section>
}

export function SettingsEntry({ to, title, description, icon, onClick, disabled = false }: { to?: string; title: string; description: string; icon?: ReactNode; onClick?: () => void; disabled?: boolean }) {
  const content = <><span className="settings-entry-copy"><strong>{title}</strong><span className="muted small">{description}</span></span>{icon ?? <ChevronRight aria-hidden="true" />}</>
  if (to !== undefined) return <Link className="settings-entry" to={to}>{content}</Link>
  return <button className="settings-entry settings-entry-action" type="button" disabled={disabled} onClick={onClick}>{content}</button>
}
