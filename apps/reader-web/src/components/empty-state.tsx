import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state" role="status"><span className="empty-state-icon"><Icon aria-hidden="true" /></span><strong>{title}</strong><p>{description}</p>{action ? <div className="empty-state-action">{action}</div> : null}</div>
}
