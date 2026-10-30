import { AnimatedDialog } from './animated-dialog.tsx'
import { useId, type ReactNode } from 'react'

export function Sheet({ open, onOpenChange, title, children, side = 'bottom', className }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; side?: 'bottom' | 'top'; className?: string }) {
  const titleId = useId()
  return <AnimatedDialog open={open} onClose={() => onOpenChange(false)} className={`sheet sheet-${side}${className === undefined ? '' : ` ${className}`}`} aria-labelledby={titleId} onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false) }} onCancel={(event) => { event.preventDefault(); onOpenChange(false) }}>
    <div className="sheet-content"><header className="sheet-header"><h2 id={titleId}>{title}</h2><button className="sheet-close" type="button" aria-label="关闭" onClick={() => onOpenChange(false)}>×</button></header><div className="sheet-body">{children}</div></div>
  </AnimatedDialog>
}
