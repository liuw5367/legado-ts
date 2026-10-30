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
