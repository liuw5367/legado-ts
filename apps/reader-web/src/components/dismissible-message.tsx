import { Children, useState, type HTMLAttributes, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function DismissibleMessage({ children, className = '', onDismiss, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; onDismiss?: () => void }) {
  const message = Children.toArray(children).filter((child) => typeof child === 'string' || typeof child === 'number').join('')
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (dismissed === message) return null
  return <div {...props} className={`dismissible-message ${className}`}><div className="dismissible-message-content">{children}</div><button className="message-close" type="button" aria-label="关闭提示" onClick={() => { setDismissed(message); onDismiss?.() }}><X aria-hidden="true" /></button></div>
}
