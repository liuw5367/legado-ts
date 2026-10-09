import { useEffect, useId, useRef, type ReactNode } from 'react'

export function Sheet({ open, onOpenChange, title, children, side = 'bottom' }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; side?: 'bottom' | 'top' }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open && !dialog.open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      dialog.querySelector<HTMLElement>('.sheet-close')?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])
  return <dialog className={`sheet sheet-${side}`} ref={dialogRef} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onOpenChange(false) }} onClose={() => { previousFocusRef.current?.focus(); previousFocusRef.current = null; onOpenChange(false) }}>
    <div className="sheet-content"><header className="sheet-header"><h2 id={titleId}>{title}</h2><button className="sheet-close" type="button" aria-label="关闭" onClick={() => onOpenChange(false)}>×</button></header><div className="sheet-body">{children}</div></div>
  </dialog>
}
