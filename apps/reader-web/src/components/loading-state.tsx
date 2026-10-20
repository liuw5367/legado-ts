import type { ReactNode } from 'react'

interface LoadingStateProps {
  message: string
  variant?: 'viewport' | 'content' | 'inline'
  action?: ReactNode
}

export function LoadingState({ message, variant = 'content', action }: LoadingStateProps) {
  return <div data-page-loading={variant !== 'inline' ? 'true' : undefined} className={`loading-state loading-state-${variant}`}>
    <div className="loading-state-status" role="status">
      <span className="loading-state-spinner" aria-hidden="true" />
      <p className="loading-state-message">{message}</p>
    </div>
    {action === undefined ? null : <div className="loading-state-action">{action}</div>}
  </div>
}
