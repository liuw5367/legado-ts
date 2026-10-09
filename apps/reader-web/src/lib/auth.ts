import { createClient, type AuthChangeEvent, type Session, type SupabaseClient, type User } from '@supabase/supabase-js'

let client: SupabaseClient | undefined

function publicConfig(): { url: string; key: string } {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() ?? ''
  const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  if (url.length === 0 || key.length === 0) throw new Error('Supabase Auth 尚未配置')
  return { url, key }
}

export function supabase(): SupabaseClient {
  client ??= createClient(publicConfig().url, publicConfig().key, {
    auth: { autoRefreshToken: true, detectSessionInUrl: false, persistSession: true, flowType: 'pkce' },
  })
  return client
}

export function authRedirect(path: string): string {
  const normalized = path.startsWith('/') && !path.startsWith('//') ? path : '/'
  return `${window.location.origin}/auth/confirm?next=${encodeURIComponent(normalized)}`
}

export async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await supabase().auth.signUp({ email, password, options: { emailRedirectTo: authRedirect('/') } })
  if (error) throw error
  return { needsConfirmation: data.session === null }
}

export async function resendConfirmation(email: string): Promise<void> {
  const { error } = await supabase().auth.resend({ type: 'signup', email, options: { emailRedirectTo: authRedirect('/') } })
  if (error) throw error
}

export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password })
  if (error) throw error
  if (data.session === null) throw new Error('登录未建立会话')
  return data.session
}

export async function signOut(): Promise<void> {
  const { error } = await supabase().auth.signOut({ scope: 'global' })
  if (error) throw error
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase().auth.resetPasswordForEmail(email, { redirectTo: authRedirect('/reset-password') })
  if (error) throw error
}

export async function updatePassword(password: string, currentPassword?: string): Promise<void> {
  const attributes = { password, ...(currentPassword === undefined ? {} : { current_password: currentPassword }) }
  const { error } = await supabase().auth.updateUser(attributes as Parameters<SupabaseClient['auth']['updateUser']>[0])
  if (error) throw error
}

export async function verifyCallback(input: { tokenHash?: string; code?: string; type: string }): Promise<'email' | 'recovery'> {
  if (input.tokenHash === undefined && input.code === undefined) throw new Error('验证链接缺少凭证')
  const normalized = input.type === 'signup' ? 'email' : input.type
  if (normalized !== 'email' && normalized !== 'recovery') throw new Error('验证链接类型无效')
  const { error } = input.tokenHash === undefined
    ? await supabase().auth.exchangeCodeForSession(input.code!)
    : await supabase().auth.verifyOtp({ token_hash: input.tokenHash, type: normalized })
  if (error) throw error
  return normalized
}

export function safeNext(value: string | null): string {
  if (value === null || value.length === 0) return '/'
  try {
    const candidate = value.startsWith('http://') || value.startsWith('https://')
      ? (() => {
          const url = new URL(value)
          if (url.origin !== window.location.origin) return '/'
          return url.pathname === '/auth/confirm' ? safeNext(url.searchParams.get('next')) : `${url.pathname}${url.search}${url.hash}`
        })()
      : value
    return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/'
  } catch {
    return '/'
  }
}

export interface AuthSnapshot { session: Session | null; user: User | null; loading: boolean }
export type AuthListener = (event: AuthChangeEvent, session: Session | null) => void

export async function currentSession(): Promise<Session | null> {
  const { data, error } = await supabase().auth.getSession()
  if (error) throw error
  return data.session
}

export function subscribeAuth(listener: AuthListener): { unsubscribe: () => void } {
  return supabase().auth.onAuthStateChange((event, session) => listener(event, session)).data.subscription
}

export function clearCallbackUrl(): void {
  const url = new URL(window.location.href)
  for (const key of ['code', 'token_hash', 'type', 'next', 'redirect_to']) url.searchParams.delete(key)
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
}
