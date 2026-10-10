import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useAuth } from './auth-context.tsx'
import { BookCache } from './book-cache.ts'

const Context = createContext<BookCache | null>(null)
export function BookCacheProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const cache = useMemo(() => new BookCache(), [user?.id])
  useEffect(() => () => cache.clear(), [cache])
  return <Context.Provider value={cache}>{children}</Context.Provider>
}
export function useBookCache() {
  const cache = useContext(Context)
  if (cache === null) throw new Error('缺少书籍缓存上下文')
  useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion)
  return cache
}
