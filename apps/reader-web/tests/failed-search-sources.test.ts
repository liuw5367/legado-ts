import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/components/failed-search-sources.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
function nodes(value: any): any[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }

test('failure list loads on expansion and disables the selected source while retaining diagnostics', async () => {
  const states: any[] = [], refs: any[] = [], effects: any[] = [], requests: any[] = []
  let index = 0, refIndex = 0, effectKey = '', refreshed = 0
  let initialized = false
  const source = { sourceId: 'https://book.example/source', name: '测试源', group: '小说', importDisplayUrl: 'https://imports.example/list', enabled: true, sourceRevision: 'revision' }
  const jsx = (type: any, props: any) => ({ type, props })
  const module = { exports: {} as { FailedSearchSources: (props: any) => any } }
  runInNewContext(code, { AbortController, module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'react') return {
      useState(initial: any) { const at = index++; if (!initialized) states[at] = initial; return [states[at], (next: any) => { states[at] = typeof next === 'function' ? next(states[at]) : next }] },
      useRef(initial: any) { const at = refIndex++; return refs[at] ??= { current: initial } },
      useEffect(effect: any, deps: any[]) { const next = JSON.stringify(deps); if (next !== effectKey) { effectKey = next; effects.push(effect) } },
    }
    if (name.includes('api')) return { apiFetch: async (path: string, init: any) => { requests.push({ path, init }); return path.includes('actions') ? { affected: 1 } : { sources: [source] } } }
    if (name.includes('source-domain')) return { sourceDomainInfo: () => ({ domain: 'book.example' }) }
    return { ChevronDown: 'svg', Button: 'button' }
  } })
  function render() {
    index = 0; refIndex = 0
    const tree = module.exports.FailedSearchSources({ sources: [{ sourceId: source.sourceId, status: 'failed', diagnostics: [{ message: '请求超时' }], startedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:00:15Z' }], onDisabled: async () => { refreshed++ } })
    initialized = true
    while (effects.length) effects.shift()()
    return nodes(tree)
  }
  let tree = render()
  assert.equal(tree[0].type, 'details')
  assert.equal(tree[0].props.open, undefined)
  assert.equal(requests.length, 0)
  tree[0].props.onToggle({ currentTarget: { open: true } })
  render()
  await new Promise((resolve) => setImmediate(resolve))
  tree = render()
  for (const expected of ['测试源', 'book.example', '小说', 'https://imports.example/list', '15000ms', '请求超时']) assert.ok(JSON.stringify(tree).includes(expected), expected)
  const button = tree.find((node) => node.type === 'button' && node.props.children === '禁用')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests[1].path, '/api/source-management/actions')
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: 'disable', items: [{ sourceId: source.sourceId, expectedSourceRevision: 'revision' }] })
  tree = render()
  assert.equal(tree.find((node) => node.props?.children === '已禁用').props.disabled, true)
  assert.equal(refreshed, 1)
  assert.ok(JSON.stringify(tree).includes('请求超时'))
})
