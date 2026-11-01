import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/components/reading-marks-list.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText

for (const kind of ['annotations', 'bookmarks']) for (const readerSheet of [false, true]) for (const operation of ['edit', 'delete', 'restore', 'purge']) {
  if (readerSheet && operation === 'purge' || kind === 'bookmarks' && (!readerSheet || operation === 'edit')) continue
  test(`${readerSheet ? '阅读弹窗' : '笔记管理'} ${kind} ${operation} 成功后更新条目且版本变化不重查列表`, async () => {
    const mark = { id: 'mark', bookId: 'book', bookName: '书', chapterTitle: '章节', excerpt: '摘录', note: '旧想法', createdAt: '2026-01-01', deletedAt: operation === 'restore' || operation === 'purge' ? '2026-02-01' : null, version: 1 }
    const updated = { ...mark, note: operation === 'edit' ? '新想法' : mark.note, deletedAt: operation === 'delete' ? '2026-03-01' : null, version: 2 }
    const states: any[] = [], refs: any[] = [], requests: string[] = []
    let stateIndex = 0, refIndex = 0, version = 0, load: any
    const jsx = (type: unknown, props: unknown) => ({ type, props })
    const module = { exports: {} as { ReadingMarksList: (props: any) => any } }
    runInNewContext(code, { module, exports: module.exports, URLSearchParams, AbortController, console, require: (name: string) => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react') return { useEffect() {}, useRef: (initial: any) => { const index = refIndex++; return refs[index] ??= { current: initial } }, useState: (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value }] } }
      if (name === 'react-router-dom') return { useLocation: () => ({}), useNavigate: () => () => {} }
      if (name.includes('use-page-resource')) return { usePageActivity: () => ({ active: true }), usePageNavigation: () => ({ userId: 'user' }), usePageVersion: () => String(version), usePageLoadEffect: (effect: any) => { load = effect } }
      if (name.includes('book-cache-context')) return { useBookCache: () => ({}) }
      if (name.includes('settings-context')) return { useReaderSettings: () => ({ settings: {} }) }
      if (name.includes('reading-annotations')) return { markSaveInput: () => ({}) }
      if (name.includes('api.ts')) return { apiFetch: async (path: string, init: any = {}, _user?: string, onSuccess?: (result: any) => void) => {
        requests.push(`${init.method ?? 'GET'} ${path}`)
        const result = init.method ? { item: updated } : path.includes('?') ? { items: [mark], nextCursor: null } : { item: mark }
        onSuccess?.(result)
        if (init.method) version++
        return result
      } }
      return new Proxy({}, { get: (_target, key) => String(key) })
    } })
    function render() { stateIndex = 0; refIndex = 0; return module.exports.ReadingMarksList({ kind, bookId: 'book', global: !readerSheet, readerSheet, deleted: operation === 'restore' || operation === 'purge' }) }
    function nodes(value: any): any[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
    async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }
    render(); load(() => {}); await flush()
    let tree = render()
    const label = operation === 'edit' ? '编辑笔记' : operation === 'delete' ? kind === 'bookmarks' ? '删除书签' : '删除笔记' : operation === 'restore' ? kind === 'bookmarks' ? '恢复书签' : '恢复笔记' : '彻底删除'
    nodes(tree).find((node) => node.type === 'button' && (node.props.children === label || node.props.children?.includes(label))).props.onClick()
    await flush(); tree = render()
    if (operation === 'edit') await nodes(tree).find((node) => node.type === 'ReadingMarkEditor').props.onSave('新想法')
    if (operation === 'purge') { nodes(tree).find((node) => node.type === 'Sheet' && node.props.title === '确认彻底删除笔记').props.children.at(-1).props.children.at(-1).props.onClick(); await flush() }
    render(); load(() => {}); await flush(); tree = render()
    assert.equal(requests.filter((request) => request.startsWith('GET ') && request.includes('?')).length, 1)
    const rows = nodes(tree).filter((node) => node.props?.className === 'reading-mark-item')
    assert.equal(rows.length, operation === 'edit' || readerSheet ? 1 : 0)
    if (operation === 'edit') assert.ok(JSON.stringify(rows).includes('新想法'))
    if (readerSheet && operation !== 'edit') assert.equal(JSON.stringify(rows).includes('已删除'), operation === 'delete')
  })
}
