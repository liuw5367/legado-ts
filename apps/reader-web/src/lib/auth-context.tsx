import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { currentSession, signOut, subscribeAuth } from './auth.ts'

interface AuthContextValue { session: Session | null; user: User | null; loading: boolean; error?: Error; logout: () => Promise<void> }
const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | undefined>()
  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined
    void currentSession().then((value) => { if (active) { setSession(value); setLoading(false) } }, (reason: unknown) => { if (active) { setError(reason instanceof Error ? reason : new Error('认证服务尚未配置')); setLoading(false) } })
    try {
      const subscription = subscribeAuth((_event, next) => { if (active) setSession(next) })
      unsubscribe = subscription.unsubscribe
    } catch (reason) {
      if (active) { setError(reason instanceof Error ? reason : new Error('认证服务尚未配置')); setLoading(false) }
    }
    return () => { active = false; unsubscribe() }
  }, [])
  const value = useMemo<AuthContextValue>(() => ({ session, user: session?.user ?? null, loading, ...(error === undefined ? {} : { error }), logout: signOut }), [error, loading, session])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === undefined) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return value
}
