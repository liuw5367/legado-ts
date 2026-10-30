import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { usePageActivity } from '../../lib/use-page-resource.ts'

const DialogPresentContext = createContext(true)
const EXIT_DURATION = 350

// 条件渲染的弹窗在退出期间保留原组件，避免内容先于动画消失。
export function DialogPresence({ children }: { children: ReactNode }) {
  const parentPresent = useContext(DialogPresentContext)
  const present = children !== null && children !== undefined && children !== false
  const [retained, setRetained] = useState(children)
  if (present && children !== retained) setRetained(children)
  useLayoutEffect(() => {
    if (present) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setRetained(null); return }
    const timer = window.setTimeout(() => setRetained(null), EXIT_DURATION)
    return () => window.clearTimeout(timer)
  }, [present])
  return <DialogPresentContext value={parentPresent && present}>{present ? children : retained}</DialogPresentContext>
}

export function AnimatedDialog({ open, children, className, onClose, ...props }: Omit<ComponentProps<'dialog'>, 'open' | 'ref'> & { open: boolean }) {
  const present = useContext(DialogPresentContext)
  const page = usePageActivity()
  const visible = open && present && page?.active !== false
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [mountedOpen, setMountedOpen] = useState(false)
  const [retained, setRetained] = useState(children)
  if (visible && retained !== children) setRetained(children)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (visible) {
      if (!dialog.open) {
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        dialog.showModal()
        setMountedOpen(true)
        const focused = document.activeElement
        if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur()
      }
      return
    }
    if (!dialog.open) return
    if (page?.active === false || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return }
    const timer = window.setTimeout(() => dialog.close(), EXIT_DURATION)
    return () => window.clearTimeout(timer)
  }, [visible, page?.active])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    return () => {
      if (dialog?.open) dialog.close()
      previousFocusRef.current?.focus({ preventScroll: true })
    }
  }, [])

  return <dialog {...props} ref={dialogRef} className={`animated-dialog${className ? ` ${className}` : ''}`} data-visible={visible} inert={!visible} onClose={(event) => {
    if (event.currentTarget.open) return
    setMountedOpen(false)
    previousFocusRef.current?.focus({ preventScroll: true })
    previousFocusRef.current = null
    onClose?.(event)
  }}>{visible || !mountedOpen ? children : retained}</dialog>
}
