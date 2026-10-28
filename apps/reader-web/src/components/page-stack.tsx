import type { BookListPageSnapshot } from '../lib/book-list-state.ts'
import { Activity, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { apiFetch, type ApiPosition } from '../lib/api.ts'
import { NavigationContext, PageContext } from '../lib/navigation-context.tsx'
import { mutationDomains, subscribePageMutations } from '../lib/page-data.ts'
import { emptyPageStack, pageDelta, previousPageDelta, readerIdentity, visitPage, type PageFrame } from '../lib/page-stack.ts'
import { ReadingPositionQueue } from '../lib/reading-position-queue.ts'
import { AccountLayout } from './account-layout.tsx'

export function PageStack({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return <AccountPageStack key={user?.id} userId={user?.id ?? ''}>{children}</AccountPageStack>
}

function AccountPageStack({ children, userId }: { children: ReactNode; userId: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const action = useNavigationType()
  const cache = useBookCache()
  const [stack, setStack] = useState(emptyPageStack)
  const current = visitPage(stack, location, action)
  if (current !== stack) setStack(current)
  const latest = useRef(current)
  latest.current = current
  const bookListSnapshots = useRef(new Map<string, BookListPageSnapshot>())
  useEffect(() => { const liveKeys = new Set(current.entries.map((entry) => entry.key)); for (const key of bookListSnapshots.current.keys()) if (!liveKeys.has(key)) bookListSnapshots.current.delete(key) }, [current.entries])
  const [versions, setVersions] = useState<ReadonlyMap<string, number>>(new Map())
  const pending = useRef<{ origin: string; target: string; state: unknown; via: string } | undefined>(undefined)
  const positions = useMemo(() => new ReadingPositionQueue(async (input) => {
    const { bookId, ...body } = input
    const result = await apiFetch<{ position: ApiPosition }>(`/api/books/${encodeURIComponent(bookId)}/position`, { method: 'POST', body: JSON.stringify(body), keepalive: true }, userId)
    cache.setPosition(bookId, input.editionKey, result.position)
    return result.position
  }), [userId, cache])
  useEffect(() => {
    // StrictMode 会重复建立 Effect；队列的有效期由这次所有者挂载控制。
    positions.resume()
    const unsubscribe = subscribePageMutations((mutation) => {
      if (mutation.userId !== userId) return
      const domains = mutationDomains(mutation.path, mutation.method)
      if (domains.length === 0) return
      if (mutation.method === 'DELETE' && mutation.path.split('/').length === 4 && mutation.path.startsWith('/api/book-lists/')) {
        const listId = mutation.path.split('/')[3]
        for (const [key, snapshot] of bookListSnapshots.current) if (snapshot.data.list.id === listId) bookListSnapshots.current.delete(key)
      }
      if (domains.includes('sources')) cache.clear()
      if (domains.includes('edition-options')) cache.invalidateEditionOptions()
      setVersions((previous) => {
        const next = new Map(previous)
        const books = new Set(latest.current.frames.map((frame) => frame.location.pathname.split('/')[2]))
        for (const key of next.keys()) if (key.startsWith('book:') && !books.has(encodeURIComponent(key.slice(5)))) next.delete(key)
        for (const domain of domains) {
          if (!domain.startsWith('book:') || books.has(encodeURIComponent(domain.slice(5)))) next.set(domain, (next.get(domain) ?? 0) + 1)
        }
        return next
      })
    })
    return () => { unsubscribe(); positions.dispose() }
  }, [userId, cache, positions])

  useEffect(() => {
    const flush = () => { void positions.flush().catch(() => undefined) }
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', flush)
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flush) }
  }, [positions])

  const processReadingNavigation = useEffectEvent(() => {
    const intent = pending.current
    if (intent !== undefined) {
      if (location.key === intent.origin) {
        pending.current = undefined
        void navigate(intent.target, { replace: true, state: intent.state })
      } else if (location.key !== intent.via) pending.current = undefined
      return
    }
    const state = location.state as { resumeReadingKey?: string } | null
    if (readerIdentity(location) === undefined || typeof state?.resumeReadingKey !== 'string') return
    const delta = pageDelta(current, state.resumeReadingKey)
    if (delta === undefined) return
    const { resumeReadingKey: _, ...rest } = state
    pending.current = { origin: state.resumeReadingKey, target: location.pathname + location.search + location.hash, state: rest, via: location.key }
    void navigate(delta)
  })
  useLayoutEffect(() => { processReadingNavigation() }, [location.key])

  const value = {
    userId, versions, positions, bookListSnapshots: bookListSnapshots.current,
    back: (fallback: { to: string; state: unknown }) => {
      pending.current = undefined
      const delta = previousPageDelta(latest.current)
      if (delta === undefined) void navigate(fallback.to, { replace: true, state: fallback.state })
      else void navigate(delta)
    },
    rootTarget: (path: string) => {
      const root = latest.current.frames.find((frame) => frame.kind === 'root' && frame.location.pathname === path)
      return root === undefined ? path : root.location.pathname + root.location.search
    },
  }
  const reading = readerIdentity(location) !== undefined
  return <NavigationContext value={value}><AccountLayout reader={reading}>
    {current.frames.map((frame) => <PageInstance key={frame.id} frame={frame} active={frame.id === current.activeId}>{children}</PageInstance>)}
  </AccountLayout></NavigationContext>
}

function PageInstance({ frame, active, children }: { frame: PageFrame; active: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const snapshot = useRef<{ x: number; y: number; focus?: Element | null } | undefined>(undefined)
  // Activity 清理时 DOM 可能已隐藏；持续记录可见位置，不在清理中重新测量。
  useLayoutEffect(() => {
    if (!active) return
    const element = root.current
    const previous = history.scrollRestoration
    history.scrollRestoration = 'manual'
    const saved = snapshot.current
    let interrupted = false
    const stopRestore = () => { interrupted = true }
    const save = () => { snapshot.current = { x: window.scrollX, y: window.scrollY, focus: element?.contains(document.activeElement) ? document.activeElement : null } }
    let restored = false
    const restore = () => {
      if (interrupted || restored || element === null || element.querySelector('[data-page-loading="true"]')) return
      restored = true
      if (readerIdentity(frame.location) === undefined) window.scrollTo(saved?.x ?? 0, saved?.y ?? 0)
      const focus = saved?.focus instanceof HTMLElement && saved.focus.isConnected ? saved.focus : element.querySelector<HTMLElement>('h1,h2')
      if (focus !== null && focus !== undefined) { if (!focus.hasAttribute('tabindex')) focus.tabIndex = -1; focus.focus({ preventScroll: true }) }
    }
    const observer = new MutationObserver(restore)
    if (element !== null) observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-page-loading'] })
    const raf = requestAnimationFrame(restore)
    window.addEventListener('scroll', save, { passive: true })
    window.addEventListener('wheel', stopRestore, { passive: true })
    window.addEventListener('touchstart', stopRestore, { passive: true })
    element?.addEventListener('focusin', save)
    return () => {
      observer.disconnect(); cancelAnimationFrame(raf)
      window.removeEventListener('scroll', save); window.removeEventListener('wheel', stopRestore); window.removeEventListener('touchstart', stopRestore); element?.removeEventListener('focusin', save)
      history.scrollRestoration = previous
    }
  }, [active, frame.location.key])
  return <PageContext value={{ active, id: frame.id, root, location: frame.location, restored: snapshot.current !== undefined }}>
    <Activity mode={active ? 'visible' : 'hidden'}><div ref={root} data-page-frame={frame.id} inert={!active}>
      <Routes location={frame.location}>{children}</Routes>
    </div></Activity>
  </PageContext>
}
