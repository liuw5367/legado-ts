import { Ellipsis } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
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
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  return <details ref={ref} className="more-menu">
    <summary aria-label={label}><Ellipsis aria-hidden="true" /></summary>
    <div className="more-menu-list" onClick={(event) => { if (event.target instanceof Element && event.target.closest('a,button')) ref.current?.removeAttribute('open') }}>{children}</div>
  </details>
}
