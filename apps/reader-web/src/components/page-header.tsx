import type { ReactNode } from 'react'
import { PageBackButton } from './page-back-button.tsx'
import { cn } from '../lib/utils.ts'

export function PageHeader({ title, description, actions, backTo, className }: { title: string; description?: ReactNode; actions?: ReactNode; backTo?: string; className?: string }) {
  return <header className={cn('page-header', className)}>
    {backTo === undefined ? null : <PageBackButton fallback={backTo} />}
    <div className="page-header-content"><h1>{title}</h1>{description === undefined || description === null || description === '' ? null : <div className="page-header-description muted">{description}</div>}</div>
    {actions === undefined || actions === null ? null : <div className="page-header-actions">{actions}</div>}
  </header>
}
