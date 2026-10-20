import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { apiFetch } from './api.ts'
import { useAuth } from './auth-context.tsx'
import { clearDiscoveryChoice, DiscoveryStore } from './discovery-state.ts'

const Context = createContext<DiscoveryStore | null>(null)
export function DiscoveryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* 隐私模式下保持内存状态。 */ }
  const userId = user?.id ?? ''
  const store = useMemo(() => new DiscoveryStore(userId, apiFetch, storage), [userId, storage])
  const previous = useRef<{ userId: string; store: DiscoveryStore } | undefined>(undefined)
  useEffect(() => {
    if (previous.current !== undefined && previous.current.userId !== userId) {
      previous.current.store.suspend()
      clearDiscoveryChoice(previous.current.userId, storage)
    }
    previous.current = { userId, store }
  }, [userId, store, storage])
  return <Context.Provider value={store}>{children}</Context.Provider>
}
export function useDiscoveryStore() {
  const store = useContext(Context)
  if (store === null) throw new Error('缺少发现上下文')
  return store
}
