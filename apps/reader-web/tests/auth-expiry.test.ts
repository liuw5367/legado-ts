import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function loadAuth() {
  let token: string | null = 'old-token'
  let signOuts = 0
  let events = 0
  let finish: (() => void) | undefined
  const auth = {
    getSession: async () => ({ data: { session: token === null ? null : { access_token: token } }, error: null }),
    signOut: async ({ scope }: { scope: string }) => { assert.equal(scope, 'local'); signOuts++; await new Promise<void>((resolve) => { finish = resolve }); return { error: null } },
  }
  const path = process.env.AUTH_TEST_SOURCE ?? new URL('../src/lib/auth.ts', import.meta.url)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { invalidateSession: (token?: string) => Promise<void> } }
  runInNewContext(code, { module, exports: module.exports, require: () => ({ createClient: () => ({ auth }) }), process: { env: { PUBLIC_SUPABASE_URL: 'http://example.test', PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test' } }, window: { dispatchEvent: () => { events++ } }, Event })
  return { invalidate: module.exports.invalidateSession, setToken: (value: string | null) => { token = value }, counts: () => ({ signOuts, events }), finish: () => finish?.() }
}

test('失效响应只退出对应会话，并合并并发退出', async () => {
  const auth = loadAuth()
  const first = auth.invalidate('old-token')
  const second = auth.invalidate('old-token')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(auth.counts(), { signOuts: 1, events: 1 })
  auth.finish()
  await Promise.all([first, second])
  auth.setToken('new-token')
  await auth.invalidate('old-token')
  await auth.invalidate(undefined)
  assert.deepEqual(auth.counts(), { signOuts: 1, events: 1 })
})
