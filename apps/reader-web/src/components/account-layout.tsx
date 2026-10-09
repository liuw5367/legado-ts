import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'

export function AccountLayout() {
  const { user, logout } = useAuth()
  return <div className="app-shell">
    <header className="app-header">
      <Link className="brand" to="/">Legado Reader</Link>
      <nav className="nav-links" aria-label="账号导航">
        <Link className="link" to="/search">搜索</Link>
        <span className="muted">{user?.email ?? ''}</span>
        <Link className="link" to="/account/password">修改密码</Link>
        <button className="button secondary" type="button" onClick={() => void logout()}>退出</button>
      </nav>
    </header>
    <main className="app-main"><Outlet /></main>
  </div>
}
