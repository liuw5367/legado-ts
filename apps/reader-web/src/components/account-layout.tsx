import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'
import { ThemeModeSelect } from '../lib/settings-context.tsx'
import { Button } from './ui/button.tsx'

export function AccountLayout() {
  const { user, logout } = useAuth()
  return <div className="app-shell">
    <header className="app-header">
      <Link className="brand" to="/">Legado Reader</Link>
      <nav className="nav-links" aria-label="账号导航">
        <Link className="link" to="/search">搜索</Link>
        <Link className="link" to="/account/settings">设置</Link>
        <ThemeModeSelect />
        <span className="muted">{user?.email ?? ''}</span>
        <Link className="link" to="/account/password">修改密码</Link>
        <Button variant="secondary" type="button" onClick={() => void logout()}>退出</Button>
      </nav>
    </header>
    <main className="app-main"><Outlet /></main>
  </div>
}
