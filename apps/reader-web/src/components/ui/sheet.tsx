import { usePageActivity } from '../../lib/use-page-resource.ts'
import { useEffect, useId, useRef, type ReactNode } from 'react'

export function Sheet({ open, onOpenChange, title, children, side = 'bottom' }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; side?: 'bottom' | 'top' }) {
  const page = usePageActivity()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open && page?.active !== false && !dialog.open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      // 原生 showModal 也会聚焦首个控件；打开时清除该焦点，避免关闭按钮出现焦点框。
      const focused = document.activeElement
      if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur()
    }
    if (!open && dialog.open) dialog.close()
    return () => {
      if (dialog.open) { previousFocusRef.current = null; dialog.close(); onOpenChange(false) }
    }
  }, [open, page?.active])
  return <dialog className={`sheet sheet-${side}`} ref={dialogRef} aria-labelledby={titleId} onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false) }} onCancel={(event) => { event.preventDefault(); onOpenChange(false) }} onClose={() => { previousFocusRef.current?.focus(); previousFocusRef.current = null; onOpenChange(false) }}>
    <div className="sheet-content"><header className="sheet-header"><h2 id={titleId}>{title}</h2><button className="sheet-close" type="button" aria-label="关闭" onClick={() => onOpenChange(false)}>×</button></header><div className="sheet-body">{children}</div></div>
  </dialog>
}
