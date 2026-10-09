import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'
import { Button } from './ui/button.tsx'

export function AccountLayout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const showBottomNav = location.pathname !== '/account/password'
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到正文</a>
    <header className="app-header">
      <Link className="brand" to="/">Legado Reader</Link>
      <nav className="desktop-nav" aria-label="主导航">
        <NavLink className="nav-link" to="/" end>书架</NavLink>
        <NavLink className="nav-link" to="/search">搜索</NavLink>
        <NavLink className="nav-link" to="/account/settings">设置</NavLink>
      </nav>
      <div className="account-actions">
        <span className="muted account-email">{user?.email ?? ''}</span>
        <Button variant="secondary" size="sm" type="button" onClick={() => void logout()}>退出</Button>
      </div>
    </header>
    <main className={`app-main ${showBottomNav ? '' : 'app-main-standalone'}`} id="main-content"><Outlet /></main>
    {showBottomNav ? <nav className="bottom-nav" aria-label="移动端主导航">
      <NavLink className="bottom-nav-link" to="/" end><span aria-hidden="true">⌂</span><span>书架</span></NavLink>
      <NavLink className="bottom-nav-link" to="/search"><span aria-hidden="true">⌕</span><span>搜索</span></NavLink>
      <NavLink className="bottom-nav-link" to="/account/settings"><span aria-hidden="true">⚙</span><span>设置</span></NavLink>
    </nav> : null}
  </div>
}
