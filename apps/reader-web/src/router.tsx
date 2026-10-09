import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router-dom'
import { AccountLayout } from './components/account-layout.tsx'
import { ReaderLayout } from './components/reader-layout.tsx'
import { useAuth } from './lib/auth-context.tsx'
import { AccountHomePage } from './pages/account-home.tsx'
import { AuthConfirmPage } from './pages/auth-confirm.tsx'
import { ChangePasswordPage } from './pages/change-password.tsx'
import { ForgotPasswordPage } from './pages/forgot-password.tsx'
import { LoginPage } from './pages/login.tsx'
import { RegisterPage } from './pages/register.tsx'
import { ResetPasswordPage } from './pages/reset-password.tsx'
import { SearchPage } from './pages/search.tsx'
import { SettingsPage } from './pages/settings.tsx'
import { ReaderPage } from './pages/reader.tsx'
import { TocPage } from './pages/toc.tsx'

function ProtectedRoute() {
  const { error, loading, session } = useAuth(); const location = useLocation()
  if (loading) return <main className="app-main app-main-standalone"><p className="muted">正在读取登录状态…</p></main>
  if (error !== undefined) return <main className="app-main app-main-standalone"><section className="card"><h1>认证服务未配置</h1><p className="error">{error.message}</p><p className="muted">请配置 Supabase 的公开 URL 和 publishable key 后重试。</p></section></main>
  return session === null ? <Navigate to="/login" replace state={{ from: location.pathname }} /> : <Outlet />
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/auth/confirm', element: <AuthConfirmPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { element: <ProtectedRoute />, children: [{ element: <AccountLayout />, children: [{ index: true, element: <AccountHomePage /> }, { path: '/search', element: <SearchPage /> }, { path: '/books/:bookId/toc', element: <TocPage /> }, { path: '/account/password', element: <ChangePasswordPage /> }, { path: '/account/settings', element: <SettingsPage /> }] }, { element: <ReaderLayout />, children: [{ path: '/books/:bookId/read/:chapterId', element: <ReaderPage /> }] }] },
  { path: '*', element: <Navigate to="/" replace /> },
])

export function AppRouter() { return <RouterProvider router={router} /> }
