import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

export function FloatingMessage({ message, actionLabel, onAction, onDismiss, className = '', tone = 'error' }: { message: string; actionLabel?: string; onAction?: () => void; onDismiss: () => void; className?: string; tone?: 'error' | 'success' | 'info' }) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (tone === 'error') return
    const timer = window.setTimeout(() => onDismissRef.current(), 3000)
    return () => window.clearTimeout(timer)
  }, [message, tone])
  const Icon = tone === 'success' ? CircleCheck : tone === 'info' ? Info : CircleAlert
  return <div className={`floating-message ${className}`} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <span className="floating-message-icon"><Icon aria-hidden="true" /></span>
    <span className="floating-message-copy">{message}</span>
    {actionLabel && onAction ? <button className="floating-message-action" type="button" onClick={onAction}>{actionLabel}</button> : null}
    <button className="floating-message-close" type="button" aria-label="关闭提示" onClick={onDismiss}><X aria-hidden="true" /></button>
  </div>
}
