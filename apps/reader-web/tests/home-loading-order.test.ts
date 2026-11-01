import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/pages/account-home.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
function nodes(value: any): any[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
function setup(initialGroup = 'favorites') {
  const states: any[] = [], refs: any[] = [], effects: (() => void)[] = [], calls: any[] = []
  let stateIndex = 0, refIndex = 0
  const settings = { settingsLoadStatus: 'loading', settings: { general: { bookshelfInitialGroup: initialGroup, bookshelfSort: 'lastReadAt' } } }
  const groups = { data: null as any, loading: true, error: '', retry() {} }
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  const module = { exports: {} as { AccountHomePage: () => any } }
  runInNewContext(code, { module, exports: module.exports, require(name: string) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'react') return {
      useState(initial: any) { const at = stateIndex++; if (!(at in states)) states[at] = initial; return [states[at], (value: any) => { states[at] = typeof value === 'function' ? value(states[at]) : value }] },
      useRef(initial: any) { const at = refIndex++; return refs[at] ??= { current: initial } },
      useEffect(effect: () => void) { effects.push(effect) }, useLayoutEffect() {}, useCallback: (fn: any) => fn,
    }
    if (name.includes('settings-context')) return { useReaderSettings: () => settings }
    if (name.includes('auth-context')) return { useAuth: () => ({ user: { id: 'user' } }) }
    if (name.includes('book-cache-context')) return { useBookCache: () => ({}) }
    if (name.includes('onboarding')) return { hasSeenOnboarding: () => true }
    if (name === 'react-router-dom') return { useLocation: () => ({}), useNavigate: () => () => {} }
    if (name.includes('use-home-resource')) return { useHomeResource(path: string, domain: string, enabled = true, cacheKey = '') {
      calls.push({ path, domain, enabled, cacheKey })
      return domain === 'groups' ? groups : { data: null, loading: true, error: '', setData() {} }
    } }
    return {}
  } })
  function render() {
    stateIndex = 0; refIndex = 0; calls.length = 0
    const tree = module.exports.AccountHomePage()
    while (effects.length) effects.shift()!()
    return tree
  }
  return { render, calls, settings, groups }
}

for (const order of ['settings first', 'groups first']) {
  test(`bookshelf waits for both prerequisites and initial selection: ${order}`, () => {
    const view = setup()
    const shelfEnabled = () => view.calls.find((call) => call.domain === 'bookshelf').enabled
    view.render(); assert.equal(shelfEnabled(), false)
    if (order === 'settings first') view.settings.settingsLoadStatus = 'ready'
    else { view.groups.data = { groups: [{ id: 'favorites', name: '收藏' }] }; view.groups.loading = false }
    view.render(); assert.equal(shelfEnabled(), false)
    view.settings.settingsLoadStatus = 'ready'; view.groups.data = { groups: [{ id: 'favorites', name: '收藏' }] }; view.groups.loading = false
    view.render(); assert.equal(shelfEnabled(), false, 'selection must be committed before requesting books')
    const tree = view.render(); assert.equal(shelfEnabled(), true)
    assert.equal(nodes(tree).find((node) => node.props?.children === '收藏').props['aria-pressed'], true)
    assert.equal(view.calls.find((call) => call.domain === 'bookshelf').cacheKey, 'lastReadAt')
  })
}

test('default all group still starts bookshelf loading after initialization', () => {
  const view = setup('all')
  view.settings.settingsLoadStatus = 'ready'; view.groups.data = { groups: [] }; view.groups.loading = false
  view.render(); view.render()
  assert.equal(view.calls.find((call) => call.domain === 'bookshelf').enabled, true)
})

test('failed prerequisites do not start bookshelf requests', () => {
  const view = setup()
  view.settings.settingsLoadStatus = 'error'; view.groups.error = '分组失败'; view.groups.loading = false
  view.render(); view.render()
  assert.equal(view.calls.find((call) => call.domain === 'bookshelf').enabled, false)
})


test('a deleted startup group falls back to all before loading data', () => {
  const view = setup('deleted')
  view.settings.settingsLoadStatus = 'ready'; view.groups.data = { groups: [{ id: 'favorites', name: '收藏' }] }; view.groups.loading = false
  view.render()
  const tree = view.render()
  assert.equal(nodes(tree).find((node) => node.props?.children === '全部').props['aria-pressed'], true)
  assert.equal(view.calls.find((call) => call.domain === 'bookshelf').enabled, true)
})

test('initialized selection is preserved when returning to the bookshelf', () => {
  const view = setup('favorites')
  view.settings.settingsLoadStatus = 'ready'; view.groups.data = { groups: [{ id: 'favorites', name: '收藏' }] }; view.groups.loading = false
  view.render()
  const tree = view.render()
  nodes(tree).find((node) => node.props?.children === '全部').props.onClick()
  view.render()
  const returned = view.render()
  assert.equal(nodes(returned).find((node) => node.props?.children === '全部').props['aria-pressed'], true)
})
