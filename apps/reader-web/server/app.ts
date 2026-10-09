import { createClient } from '@supabase/supabase-js'
import { Hono, type Context } from 'hono'

interface Variables { userId: string }
export const app = new Hono<{ Variables: Variables }>()

app.get('/api/health', (context) => context.json({ ok: true }))

async function requireUser(context: Context<{ Variables: Variables }>): Promise<Response | undefined> {
  const authorization = context.req.header('Authorization')
  if (authorization === undefined || !/^Bearer\s+\S+$/iu.test(authorization)) return context.json({ error: { code: 'unauthenticated', message: '需要登录' } }, 401)
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  if (url.length === 0 || key.length === 0) return context.json({ error: { code: 'configuration', message: '认证服务尚未配置' } }, 503)
  const token = authorization.replace(/^Bearer\s+/iu, '')
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } })
  const { data, error } = await supabase.auth.getUser(token)
  if (error !== null || data.user === null) return context.json({ error: { code: 'unauthenticated', message: '登录已失效' } }, 401)
  context.set('userId', data.user.id)
  return undefined
}

app.get('/api/me', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const userId = context.get('userId')
  return context.json({ user: { id: userId } })
})

app.notFound((context) => context.req.path.startsWith('/api/')
  ? context.json({ error: { code: 'not-found', message: 'API 路径不存在' } }, 404)
  : context.text('Not Found', 404))

export default app
