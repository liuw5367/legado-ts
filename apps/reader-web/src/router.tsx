import { lazy, type ReactNode } from 'react'
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AccountLayout } from './components/account-layout.tsx'
import { LoadingState } from './components/loading-state.tsx'
import { PageBackButton } from './components/page-back-button.tsx'
import { PageLoadBoundary } from './components/page-load-boundary.tsx'
import { ReaderLayout } from './components/reader-layout.tsx'
import { useAuth } from './lib/auth-context.tsx'

const AccountHomePage = lazy(() => import('./pages/account-home.tsx').then((module) => ({ default: module.AccountHomePage })))
const AuthConfirmPage = lazy(() => import('./pages/auth-confirm.tsx').then((module) => ({ default: module.AuthConfirmPage })))
const ChangePasswordPage = lazy(() => import('./pages/change-password.tsx').then((module) => ({ default: module.ChangePasswordPage })))
const ForgotPasswordPage = lazy(() => import('./pages/forgot-password.tsx').then((module) => ({ default: module.ForgotPasswordPage })))
const LoginPage = lazy(() => import('./pages/login.tsx').then((module) => ({ default: module.LoginPage })))
const RegisterPage = lazy(() => import('./pages/register.tsx').then((module) => ({ default: module.RegisterPage })))
const ResetPasswordPage = lazy(() => import('./pages/reset-password.tsx').then((module) => ({ default: module.ResetPasswordPage })))
const SearchPage = lazy(() => import('./pages/search.tsx').then((module) => ({ default: module.SearchPage })))
const SourcesPage = lazy(() => import('./pages/sources.tsx').then((module) => ({ default: module.SourcesPage })))
const SettingsPage = lazy(() => import('./pages/settings.tsx').then((module) => ({ default: module.SettingsPage })))
const ReadingSettingsPage = lazy(() => import('./pages/reading-settings.tsx').then((module) => ({ default: module.ReadingSettingsPage })))
const ReaderEntryPage = lazy(() => import('./pages/reader.tsx').then((module) => ({ default: module.ReaderEntryPage })))
const ReaderPage = lazy(() => import('./pages/reader.tsx').then((module) => ({ default: module.ReaderPage })))
const BookSourcesPage = lazy(() => import('./pages/book-sources.tsx').then((module) => ({ default: module.BookSourcesPage })))
const BookDetailsPage = lazy(() => import('./pages/book-details.tsx').then((module) => ({ default: module.BookDetailsPage })))
const TocPage = lazy(() => import('./pages/toc.tsx').then((module) => ({ default: module.TocPage })))

function LazyPage({ children, viewport = false, backTo, bookToc = false, searchBack = false }: { children: ReactNode; viewport?: boolean; backTo?: string; bookToc?: boolean; searchBack?: boolean }) {
  const { bookId = '' } = useParams()
  const [params] = useSearchParams()
  const targetBookId = params.get('bookId') ?? ''
  const fallback = bookToc ? `/books/${encodeURIComponent(bookId)}/toc` : searchBack && targetBookId.length > 0 ? `/books/${encodeURIComponent(targetBookId)}/sources` : backTo
  return <PageLoadBoundary variant={viewport ? 'viewport' : 'content'} action={fallback === undefined ? undefined : <PageBackButton fallback={fallback} />}>
    {children}
  </PageLoadBoundary>
}

function ProtectedRoute() {
  const { error, loading, session } = useAuth(); const location = useLocation()
  if (loading) return <main><LoadingState message="正在读取登录状态…" variant="viewport" /></main>
  if (error !== undefined) return <main className="app-main app-main-standalone"><section className="card"><h1>认证服务未配置</h1><p className="error">{error.message}</p><p className="muted">请配置 Supabase 的公开 URL 和 publishable key 后重试。</p></section></main>
  return session === null ? <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} /> : <Outlet />
}

const router = createBrowserRouter([
  { path: '/login', element: <LazyPage viewport><LoginPage /></LazyPage> },
  { path: '/register', element: <LazyPage viewport><RegisterPage /></LazyPage> },
  { path: '/forgot-password', element: <LazyPage viewport backTo="/login"><ForgotPasswordPage /></LazyPage> },
  { path: '/auth/confirm', element: <LazyPage viewport><AuthConfirmPage /></LazyPage> },
  { path: '/reset-password', element: <LazyPage viewport backTo="/login"><ResetPasswordPage /></LazyPage> },
  { element: <ProtectedRoute />, children: [
    { element: <AccountLayout />, children: [
      { index: true, element: <LazyPage><AccountHomePage /></LazyPage> },
      { path: '/search', element: <LazyPage searchBack><SearchPage /></LazyPage> },
      { path: '/sources', element: <LazyPage backTo="/account/settings"><SourcesPage /></LazyPage> },
      { path: '/books/:bookId/details', element: <LazyPage backTo="/"><BookDetailsPage /></LazyPage> },
      { path: '/books/:bookId/toc', element: <LazyPage backTo="/"><TocPage /></LazyPage> },
      { path: '/books/:bookId/sources', element: <LazyPage bookToc><BookSourcesPage /></LazyPage> },
      { path: '/account/password', element: <LazyPage backTo="/account/settings"><ChangePasswordPage /></LazyPage> },
      { path: '/account/settings', element: <LazyPage><SettingsPage /></LazyPage> },
      { path: '/account/settings/reading', element: <LazyPage backTo="/account/settings"><ReadingSettingsPage /></LazyPage> },
    ] },
    { element: <ReaderLayout />, children: [
      { path: '/books/:bookId/read', element: <LazyPage viewport backTo="/"><ReaderEntryPage /></LazyPage> },
      { path: '/books/:bookId/read/:chapterId', element: <LazyPage viewport backTo="/"><ReaderPage /></LazyPage> },
    ] },
  ] },
  { path: '*', element: <Navigate to="/" replace /> },
])

export function AppRouter() { return <RouterProvider router={router} /> }
