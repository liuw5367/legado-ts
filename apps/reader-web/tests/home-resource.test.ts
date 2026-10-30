import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { mutationDomains } from '../src/lib/page-data.ts'

const code = ts.transpileModule(readFileSync(new URL('../src/lib/use-home-resource.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function harness(fetch: () => Promise<unknown>) {
  const states: any[] = [], refs: any[] = []
  let stateIndex = 0, refIndex = 0, version = 0
  let load!: (settle: () => void) => (() => void) | undefined
  const module = { exports: {} as { useHomeResource: (path: string, domain: string, enabled: boolean) => { data: unknown; error: string; loading: boolean; retry: () => void } } }
  runInNewContext(code, { Error, AbortController, module, exports: module.exports, require(name: string) {
    if (name === 'react') return {
      useState(initial: any) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (next: any) => { states[index] = typeof next === 'function' ? next(states[index]) : next }] },
      useRef(initial: any) { const index = refIndex++; return refs[index] ??= { current: initial } },
    }
    if (name.includes('use-page-resource')) return { usePageNavigation: () => null, usePageVersion: () => String(version), usePageLoadEffect: (effect: typeof load) => { load = effect } }
    if (name.includes('api.ts')) return { apiFetch: fetch }
    return {}
  } })
  return {
    render(enabled = true) { stateIndex = 0; refIndex = 0; return module.exports.useHomeResource('/api/bookshelf', 'bookshelf', enabled) },
    load() { return load(() => {}) }, invalidate() { version++ },
  }
}
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve() }

test('Tab 按需加载，切回复用数据；隐藏期间失效只在再次进入时加载', async () => {
  let requests = 0
  const page = harness(async () => ({ request: ++requests }))
  page.render(false); page.load(); await settle()
  assert.equal(requests, 0)
  page.render(); page.load(); await settle()
  assert.equal(requests, 1)
  page.render(false); page.load(); page.render(); page.load(); await settle()
  assert.equal(requests, 1)
  page.invalidate(); page.render(false); page.load(); await settle()
  assert.equal(requests, 1)
  page.render(); page.load(); await settle()
  assert.equal(requests, 2)
  assert.equal(JSON.stringify(page.render().data), '{"request":2}')
})

test('失败保留到显式重试，切 Tab 不自动重复失败请求', async () => {
  let requests = 0
  const page = harness(async () => { if (++requests === 1) throw new Error('fixture failure'); return { ok: true } })
  page.render(); page.load(); await settle()
  assert.equal(page.render().error, 'fixture failure')
  page.render(false); page.load(); page.render(); page.load(); await settle()
  assert.equal(requests, 1)
  page.render().retry(); page.render(); page.load(); await settle()
  assert.equal(requests, 2)
  assert.equal(page.render().error, '')
})

test('取消的加载不结算为成功，迟到响应不覆盖再次进入的结果', async () => {
  let resolve!: (value: unknown) => void
  let requests = 0
  const page = harness(async () => ++requests === 1 ? new Promise((yes) => { resolve = yes }) : { current: true })
  page.render(); const cancel = page.load(); await settle(); cancel?.()
  page.render(false); page.load(); page.render(); page.load(); await settle()
  resolve({ stale: true }); await settle()
  assert.equal(JSON.stringify(page.render().data), '{"current":true}')
})

test('删除搜索记录不影响书架，修改分组不影响阅读记录，刷新章节不重载列表', () => {
  assert.deepEqual(mutationDomains('/api/search-history/id', 'DELETE'), ['search-history'])
  assert.deepEqual(mutationDomains('/api/bookshelf-groups/id', 'PUT'), ['groups', 'bookshelf'])
  assert.deepEqual(mutationDomains('/api/books/b/toc/refresh?editionKey=e', 'POST'), ['book:b'])
})
