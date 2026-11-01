import { Ellipsis } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const animation = useRef<Animation | null>(null)
  const closing = useRef(false)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const placeMenu = useCallback(() => {
    const details = ref.current
    const menu = details?.querySelector<HTMLElement>('.more-menu-list')
    if (!details?.open || !menu) return
    const anchor = details.querySelector('summary')!.getBoundingClientRect()
    const viewport = window.visualViewport
    const top = viewport?.offsetTop ?? 0
    const left = viewport?.offsetLeft ?? 0
    const height = viewport?.height ?? window.innerHeight
    const width = viewport?.width ?? window.innerWidth
    const navigation = document.querySelector('.bottom-nav')?.getBoundingClientRect()
    const bottom = navigation && navigation.height > 0 ? Math.min(top + height, navigation.top) : top + height
    const below = bottom - anchor.bottom - 8
    const above = anchor.top - top - 8
    const upward = below < menu.scrollHeight && above > below
    const available = Math.max(0, upward ? above : below)
    const menuHeight = Math.min(menu.scrollHeight + 2, available)
    setPosition({ position: 'fixed', right: 'auto', left: Math.max(left + 8, Math.min(anchor.right - menu.offsetWidth, left + width - menu.offsetWidth - 8)), top: upward ? Math.max(top + 8, anchor.top - menuHeight - 4) : anchor.bottom + 4, maxHeight: available, visibility: 'visible', transformOrigin: upward ? 'bottom right' : 'top right' })
  }, [])

  const setOpen = useCallback((open: boolean) => {
    const details = ref.current
    const menu = details?.querySelector<HTMLElement>('.more-menu-list')
    if (!details || !menu || !open && (!details.open || closing.current)) return
    const current = animation.current ? window.getComputedStyle(menu) : null
    const from = current ? { opacity: current.opacity, transform: current.transform } : { opacity: open ? 0 : 1, transform: open ? 'scale(0.96)' : 'scale(1)' }
    animation.current?.cancel()
    animation.current = null
    closing.current = !open
    menu.inert = !open
    if (open) { details.open = true; placeMenu() }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (!open) { details.open = false; setPosition(null) }
      closing.current = false
      return
    }
    // 关闭动画结束前保留原生 open，避免 details 提前隐藏菜单内容。
    const next = menu.animate([from, { opacity: open ? 1 : 0, transform: open ? 'scale(1)' : 'scale(0.96)' }], { duration: open ? 180 : 120, easing: open ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'ease-in', fill: 'both' })
    animation.current = next
    next.onfinish = () => {
      if (animation.current !== next) return
      if (!open) { details.open = false; setPosition(null) }
      next.cancel()
      animation.current = null
      closing.current = false
    }
  }, [placeMenu])

  useEffect(() => {
    const element = ref.current
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !ref.current?.open) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      ref.current.querySelector<HTMLElement>('summary')?.focus()
    }
    window.addEventListener('resize', placeMenu)
    document.addEventListener('scroll', placeMenu, true)
    window.visualViewport?.addEventListener('resize', placeMenu)
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      animation.current?.cancel()
      animation.current = null
      closing.current = false
      element?.removeAttribute('open')
      window.removeEventListener('resize', placeMenu)
      document.removeEventListener('scroll', placeMenu, true)
      window.visualViewport?.removeEventListener('resize', placeMenu)
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [placeMenu, setOpen])

  return <details ref={ref} className="more-menu" onToggle={() => { if (ref.current?.open) placeMenu(); else setPosition(null) }}>
    <summary aria-label={label} onClick={(event) => { event.preventDefault(); setOpen(!ref.current?.open || closing.current) }}><Ellipsis aria-hidden="true" /></summary>
    <div className="more-menu-list" style={position ?? { position: 'fixed', visibility: 'hidden' }} onClick={(event) => { if (event.target instanceof Element && event.target.closest('a,button')) setOpen(false) }}>{children}</div>
  </details>
}
