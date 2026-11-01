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
  const internalCloseEvents = useRef(0)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [mountedOpen, setMountedOpen] = useState(false)
  const [retained, setRetained] = useState(children)
  if (visible && retained !== children) setRetained(children)

  function closeInternally(dialog: HTMLDialogElement) {
    // 退出动画和页面隐藏只同步原生状态，不能再次通知业务层关闭新打开的子弹窗。
    if (!dialog.open) return
    internalCloseEvents.current++
    dialog.close()
  }

  function restoreFocus() {
    // 新弹窗已打开时，旧弹窗的退出事件与卸载都不能抢回焦点。
    if (!document.querySelector('dialog[open]:not([inert])')) previousFocusRef.current?.focus({ preventScroll: true })
    previousFocusRef.current = null
  }

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
    if (page?.active === false || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { closeInternally(dialog); return }
    const timer = window.setTimeout(() => closeInternally(dialog), EXIT_DURATION)
    return () => window.clearTimeout(timer)
  }, [visible, page?.active])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    return () => {
      if (dialog?.open) closeInternally(dialog)
      restoreFocus()
    }
  }, [])

  return <dialog {...props} ref={dialogRef} className={`animated-dialog${className ? ` ${className}` : ''}`} data-visible={visible} inert={!visible} onClose={(event) => {
    const internal = internalCloseEvents.current > 0
    if (internal) internalCloseEvents.current--
    if (event.currentTarget.open) return
    setMountedOpen(false)
    restoreFocus()
    if (!internal) onClose?.(event)
  }}>{visible || !mountedOpen ? children : retained}</dialog>
}
