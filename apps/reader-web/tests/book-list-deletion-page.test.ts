import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

for (const detail of [false, true]) for (const outcome of ['cancel', 'success', 'failure']) {
  test(`${detail ? '书单详情' : '书单列表'}删除必须确认：${outcome}`, async () => {
    const source = readFileSync(new URL(`../src/pages/${detail ? 'book-list-details' : 'book-lists'}.tsx`, import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const list = { id: 'list', name: '测试书单', description: '简介', createdAt: '2026-01-01', updatedAt: '2026-01-01', bookCount: 0, coverBooks: [] }
    const states: any[] = [], requests: string[] = [], destinations: string[] = []
    let stateIndex = 0, load: any, release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const module = { exports: {} as Record<string, () => any> }
    const jsx = (type: unknown, props: unknown) => ({ type, props })
    runInNewContext(code, { module, exports: module.exports, AbortController, requestAnimationFrame() {}, require: (name: string) => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react') return { useEffect() {}, useLayoutEffect() {}, useRef: (value: any) => ({ current: value }), useState: (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value }] } }
      if (name === 'react-router-dom') return { Link: 'a', useParams: () => ({ listId: 'list' }), useLocation: () => ({ key: 'detail' }), useNavigate: () => (path: string) => destinations.push(path) }
      if (name.includes('use-page-resource')) return { usePageActivity: () => ({ active: true }), usePageNavigation: () => ({ bookListSnapshots: new Map(), back: (target: any) => destinations.push(target.to) }), usePageLoadEffect: (effect: any) => { load = effect } }
      if (name.includes('api.ts')) return { ApiError: Error, apiFetch: async (path: string, init: any = {}) => { if (init.method === 'DELETE') { requests.push(path); await pending; if (outcome === 'failure') throw new Error('删除失败'); return {} } return detail ? { list, items: [] } : { lists: [list] } } }
      if (name.includes('book-list-state')) return { mergeBookListRows: (_previous: any, incoming: any) => incoming }
      if (name.includes('page-navigation')) return { pageReturnState: () => ({}) }
      if (name.includes('time-format')) return { formatShanghaiDateTime: () => '2026-01-01' }
      return new Proxy({}, { get: (_target, key) => String(key) })
    } })
    function render() { stateIndex = 0; return module.exports[detail ? 'BookListDetailsPage' : 'BookListsPage']!() }
    function nodes(value: any): any[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children), ...nodes(value.props?.actions)] : [] }
    function confirmation(tree: any) { return nodes(tree).find((node) => node.type === 'Sheet' && node.props.title === '删除书单“测试书单”？') }
    async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }
    render(); load(() => {}); await flush()
    let tree = render()
    assert.equal(confirmation(tree), undefined)
    nodes(tree).find((node) => node.type === 'button' && node.props.children === '删除书单').props.onClick()
    tree = render()
    assert.equal(requests.length, 0)
    const sheet = confirmation(tree)
    assert.ok(sheet)
    assert.ok(JSON.stringify(sheet).includes('书籍、书架和阅读记录会保留'))
    if (outcome === 'cancel') {
      nodes(sheet).find((node) => node.props?.children === '取消').props.onClick()
      assert.equal(confirmation(render()), undefined)
      assert.equal(requests.length, 0)
      return
    }
    nodes(sheet).find((node) => node.type === 'Button' && node.props.children === '删除书单').props.onClick()
    tree = render()
    assert.ok(nodes(confirmation(tree)).find((node) => node.props?.children === '删除中…')?.props.disabled)
    confirmation(tree).props.onOpenChange(false)
    assert.ok(confirmation(render()), '提交时不能关闭确认框')
    release(); await flush(); tree = render()
    assert.deepEqual(requests, ['/api/book-lists/list'])
    assert.equal(!!confirmation(tree), outcome === 'failure')
    assert.deepEqual(destinations, detail && outcome === 'success' ? ['/book-lists'] : [])
    if (outcome === 'failure') assert.ok(JSON.stringify(confirmation(tree)).includes('删除失败'))
  })
}
