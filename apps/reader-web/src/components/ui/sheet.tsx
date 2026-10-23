import { usePageActivity } from '../../lib/use-page-resource.ts'
import { useEffect, useId, useRef, type ReactNode } from 'react'

export function Sheet({ open, onOpenChange, title, children, side = 'bottom', className }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; side?: 'bottom' | 'top'; className?: string }) {
  const page = usePageActivity()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open && page?.active !== false && !dialog.open) {
      if (previousFocusRef.current === null) previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      // 原生 showModal 也会聚焦首个控件；打开时清除该焦点，避免关闭按钮出现焦点框。
      const focused = document.activeElement
      if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur()
    }
    if (!open && dialog.open) dialog.close()
    return () => {
      // StrictMode 的 Effect 重建会立即重新打开；关闭事件须以实际 open 状态判断。
      if (dialog.open) dialog.close()
      previousFocusRef.current?.focus()
    }
  }, [open, page?.active])
  return <dialog className={`sheet sheet-${side}${className === undefined ? '' : ` ${className}`}`} ref={dialogRef} aria-labelledby={titleId} onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false) }} onCancel={(event) => { event.preventDefault(); onOpenChange(false) }} onClose={() => { if (dialogRef.current?.open) return; previousFocusRef.current?.focus(); previousFocusRef.current = null; onOpenChange(false) }}>
    <div className="sheet-content"><header className="sheet-header"><h2 id={titleId}>{title}</h2><button className="sheet-close" type="button" aria-label="关闭" onClick={() => onOpenChange(false)}>×</button></header><div className="sheet-body">{children}</div></div>
  </dialog>
}
