import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function setup() {
  let token = 'old-token'
  const values = new Map<string, string>([['sb-example-auth-token', JSON.stringify({ access_token: token })], ['legado-reader-settings:user', 'settings'], ['legado.discovery.v1:user', 'discovery'], ['legado:onboarding:v1:user', 'onboarding'], ['legado-reader-settings:other', 'other']])
  const visits: string[] = []
  let logoutCalls = 0
  const auth = { getSession: async () => ({ data: { session: { access_token: token, user: { id: 'user' } } }, error: null }), signOut: async () => { logoutCalls++ } }
  const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key) } }
  const code = ts.transpileModule(readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { invalidateSession: (token?: string) => Promise<void> } }
  runInNewContext(code, { module, exports: module.exports, require: () => ({ createClient: () => ({ auth }) }), process: { env: { PUBLIC_SUPABASE_URL: 'http://example.test', PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test' } }, window: { localStorage: storage, location: { replace: (path: string) => visits.push(path) } }, URL, encodeURIComponent })
  return { invalidate: module.exports.invalidateSession, values, visits, setToken: (next: string) => { token = next }, logoutCalls: () => logoutCalls }
}

test('登录失效仅清除当前用户本地会话和缓存，不调用退出接口', async () => {
  const fixture = setup()
  await Promise.all([fixture.invalidate('old-token'), fixture.invalidate('old-token')])
  assert.deepEqual(fixture.visits, ['/login'])
  assert.equal(fixture.logoutCalls(), 0)
  assert.equal(fixture.values.has('sb-example-auth-token'), false)
  assert.equal(fixture.values.has('legado-reader-settings:user'), false)
  assert.equal(fixture.values.has('legado.discovery.v1:user'), false)
  assert.equal(fixture.values.has('legado:onboarding:v1:user'), false)
  assert.equal(fixture.values.get('legado-reader-settings:other'), 'other')
})

test('旧请求不能清除已经替换的会话', async () => {
  const fixture = setup()
  fixture.setToken('new-token')
  fixture.values.set('sb-example-auth-token', JSON.stringify({ access_token: 'new-token' }))
  await fixture.invalidate('old-token')
  assert.equal(fixture.visits.length, 0)
  assert.equal(JSON.parse(fixture.values.get('sb-example-auth-token')!).access_token, 'new-token')
  fixture.setToken('old-token')
  await fixture.invalidate('old-token')
  assert.equal(fixture.visits.length, 0)
  assert.equal(JSON.parse(fixture.values.get('sb-example-auth-token')!).access_token, 'new-token')
})
