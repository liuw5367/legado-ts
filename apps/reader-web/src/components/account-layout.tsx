import { type MouseEvent, type ReactNode } from 'react'
import { usePageNavigation } from '../lib/use-page-resource.ts'
import { Compass, LibraryBig, Settings } from 'lucide-react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'
import { Button } from './ui/button.tsx'

export function AccountLayout({ children, reader = false }: { children?: ReactNode; reader?: boolean }) {
  const navigation = usePageNavigation()
  const discoverTarget = navigation?.rootTarget('/discover') ?? '/discover'
  const { user, logout } = useAuth()
  const location = useLocation()
  const avoidDuplicateRoot = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = new URL(event.currentTarget.href)
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && target.pathname === location.pathname && target.search === location.search) event.preventDefault()
  }
  const showBottomNav = location.pathname !== '/account/password'
  const discoveryActive = location.pathname === '/discover' || location.pathname === '/search'
  return <div className={reader ? 'reader-shell' : 'app-shell'}>
    {!reader ? <><a className="skip-link" href="#main-content">跳到正文</a>
    <header className="app-header">
      <Link onClick={avoidDuplicateRoot} className="brand" to="/">Legado Reader</Link>
      <nav className="desktop-nav" aria-label="主导航">
        <NavLink onClick={avoidDuplicateRoot} className="nav-link" to="/" end>书架</NavLink>
        <Link onClick={avoidDuplicateRoot} className={`nav-link${discoveryActive ? ' active' : ''}`} aria-current={discoveryActive ? 'page' : undefined} to={discoverTarget}>发现</Link>
        <NavLink onClick={avoidDuplicateRoot} className="nav-link" to="/account/settings">设置</NavLink>
      </nav>
      <div className="account-actions">
        <span className="muted account-email">{user?.email ?? ''}</span>
        <Button variant="secondary" size="sm" type="button" onClick={() => void logout()}>退出</Button>
      </div>
    </header></> : null}
    <main className={reader ? 'reader-main' : `app-main ${showBottomNav ? '' : 'app-main-standalone'}`} id="main-content">{children}</main>
    {showBottomNav && !reader ? <nav className="bottom-nav" aria-label="移动端主导航">
      <NavLink onClick={avoidDuplicateRoot} className="bottom-nav-link" to="/" end><LibraryBig aria-hidden="true" /><span>书架</span></NavLink>
      <Link onClick={avoidDuplicateRoot} className={`bottom-nav-link${discoveryActive ? ' active' : ''}`} aria-current={discoveryActive ? 'page' : undefined} to={discoverTarget}><Compass aria-hidden="true" /><span>发现</span></Link>
      <NavLink onClick={avoidDuplicateRoot} className="bottom-nav-link" to="/account/settings"><Settings aria-hidden="true" /><span>设置</span></NavLink>
    </nav> : null}
  </div>
}
