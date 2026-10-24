import { DismissibleMessage } from './dismissible-message.tsx'
import { Component, Suspense, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { LoadingState } from './loading-state.tsx'
import { Button } from './ui/button.tsx'

interface PageLoadBoundaryProps {
  children: ReactNode
  variant?: 'viewport' | 'content'
  action?: ReactNode
}

class PageLoadErrorBoundary extends Component<{ children: ReactNode; action: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  override render() {
    if (!this.state.failed) return this.props.children
    // lazy 会缓存失败的模块 Promise，恢复网络后需要完整刷新才能重新下载。
    return <div className="page-load-error">
      <DismissibleMessage className="error" role="alert">页面加载失败，请刷新页面后重试。</DismissibleMessage>
      <div className="loading-state-action">
        <Button type="button" onClick={() => window.location.reload()}>刷新页面</Button>
        {this.props.action}
      </div>
    </div>
  }
}

export function PageLoadBoundary({ children, variant = 'content', action }: PageLoadBoundaryProps) {
  const location = useLocation()
  return <div className={`page-load-boundary page-load-boundary-${variant}`}>
    <PageLoadErrorBoundary key={location.pathname + location.search} action={action}>
      <Suspense fallback={<LoadingState message="正在加载页面…" variant={variant} action={action} />}>
        {children}
      </Suspense>
    </PageLoadErrorBoundary>
  </div>
}
