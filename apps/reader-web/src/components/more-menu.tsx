import { Ellipsis } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
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
    setPosition({ position: 'fixed', right: 'auto', left: Math.max(left + 8, Math.min(anchor.right - menu.offsetWidth, left + width - menu.offsetWidth - 8)), top: upward ? Math.max(top + 8, anchor.top - menuHeight - 4) : anchor.bottom + 4, maxHeight: available, visibility: 'visible' })
  }, [])

  useEffect(() => {
    const element = ref.current
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open')
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !ref.current?.open) return
      event.preventDefault()
      event.stopPropagation()
      ref.current.removeAttribute('open')
      ref.current.querySelector<HTMLElement>('summary')?.focus()
    }
    window.addEventListener('resize', placeMenu)
    document.addEventListener('scroll', placeMenu, true)
    window.visualViewport?.addEventListener('resize', placeMenu)
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      element?.removeAttribute('open')
      window.removeEventListener('resize', placeMenu)
      document.removeEventListener('scroll', placeMenu, true)
      window.visualViewport?.removeEventListener('resize', placeMenu)
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [placeMenu])

  return <details ref={ref} className="more-menu" onToggle={() => { if (ref.current?.open) placeMenu(); else setPosition(null) }}>
    <summary aria-label={label}><Ellipsis aria-hidden="true" /></summary>
    <div className="more-menu-list" style={position ?? { position: 'fixed', visibility: 'hidden' }} onClick={(event) => { if (event.target instanceof Element && event.target.closest('a,button')) ref.current?.removeAttribute('open') }}>{children}</div>
  </details>
}
