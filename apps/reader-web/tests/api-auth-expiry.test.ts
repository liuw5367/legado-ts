import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

test('应用认证失效覆盖 JSON、备份和搜索流，其他错误不会退出', async () => {
  let status = 401
  let codeValue = 'unauthenticated'
  const invalidated: Array<string | undefined> = []
  const auth = { currentSession: async () => ({ access_token: 'fixture-token', user: { id: 'fixture-user' } }), invalidateSession: async (token?: string) => { invalidated.push(token) } }
  const module = { exports: {} as { apiFetch: (path: string) => Promise<unknown>; validateBackup: (file: File) => Promise<unknown>; importBackup: (file: File, categories: string[]) => Promise<unknown>; downloadBackup: () => Promise<unknown>; streamSearch: (id: string, callback: () => void) => Promise<unknown> } }
  const fetcher = async () => new Response(JSON.stringify({ error: { code: codeValue, message: 'fixture failure' } }), { status, headers: { 'Content-Type': 'application/json' } })
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => name.endsWith('/auth.ts') ? auth : name.endsWith('/page-data.ts') ? { mutationDomains: () => [], publishPageMutation() {} } : {}, Headers, Response, Blob, DOMException, TextDecoder, URLSearchParams, fetch: fetcher })
  const api = module.exports
  const file = new File(['fixture'], 'fixture.zip')
  const requests = [() => api.apiFetch('/api/bookshelf'), () => api.validateBackup(file), () => api.importBackup(file, []), () => api.downloadBackup(), () => api.streamSearch('id', () => {})]
  for (const request of requests) await assert.rejects(request(), { message: 'fixture failure' })
  assert.deepEqual(invalidated, Array.from({ length: requests.length }, () => 'fixture-token'))
  status = 403
  await assert.rejects(api.apiFetch('/api/bookshelf'), { message: 'fixture failure' })
  status = 401
  codeValue = 'source-login-required'
  await assert.rejects(api.apiFetch('/api/bookshelf'), { message: 'fixture failure' })
  assert.equal(invalidated.length, requests.length)
})

test('成功回调在失效通知前更新列表，失败请求不调用成功回调', async () => {
  const events: string[] = []
  let status = 200
  const module = { exports: {} as { apiFetch: (path: string, init: RequestInit, user: string, onSuccess: (result: any) => void) => Promise<unknown> } }
  runInNewContext(code, { module, exports: module.exports, Headers, Response, DOMException, TextDecoder, require: (name: string) => name.endsWith('/auth.ts') ? { currentSession: async () => ({ user: { id: 'user' } }) } : name.endsWith('/page-data.ts') ? { mutationDomains: () => ['notes'], publishPageMutation: () => events.push('invalidate') } : {}, fetch: async () => new Response(JSON.stringify(status === 200 ? { item: { version: 2 } } : { error: { message: '失败' } }), { status }) })
  const update = (result: any) => { assert.equal(result.item.version, 2); events.push('update') }
  await module.exports.apiFetch('/api/books/book/annotations/mark', { method: 'DELETE' }, 'user', update)
  assert.deepEqual(events, ['update', 'invalidate'])
  status = 409
  await assert.rejects(module.exports.apiFetch('/api/books/book/annotations/mark', { method: 'DELETE' }, 'user', update), { message: '失败' })
  assert.deepEqual(events, ['update', 'invalidate'])
})
