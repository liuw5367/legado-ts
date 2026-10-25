import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as identity from '../shared/book-identity.ts'
import * as domains from '../shared/source-domain.ts'
import { groupBookSourcesByDomain } from '../src/lib/book-source-groups.ts'
import { formatSourceRuleDateTime } from '../src/lib/time-format.ts'
import type { ApiCandidate } from '../src/lib/api.ts'

const sourceId = 'https://book.example/source'
const candidate: ApiCandidate = { sourceId, sourceFingerprint: 'fingerprint', searchDurationMs: 25, candidate: { sourceId, bookUrl: '/book', name: '目标书', author: '作者' } }
const code = ts.transpileModule(readFileSync(new URL('../src/pages/book-sources.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText

type Node = { type?: unknown; props?: { children?: unknown; className?: string; message?: string; variant?: string } }
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (value === null || typeof value !== 'object') return []
  const node = value as Node
  return [node, ...nodes(node.props?.children)]
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('')
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return value !== null && typeof value === 'object' ? text((value as Node).props?.children) : ''
}
function render(candidates: ApiCandidate[], status = 'done') {
  let stateIndex = 0
  const states = [50, { name: '目标书', author: '作者', activeEditionKey: 'active' }, { activeEditionKey: 'active', sources: [{ sourceId, sourceFingerprint: 'fingerprint', name: '书源', bookUrl: '/book', sourceEnabled: true, status: 'saved', editionKey: 'active', searchDurationMs: 100 }] }, '目标书', true, '', '', null, null, [{ sourceId, name: '书源', group: '测试分组', fingerprint: 'fingerprint', enabled: true, customOrder: 0, sourceRevision: 'revision', origin: 'account' }], null, 0]
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  const module = { exports: {} as { BookSourcesPage: () => unknown } }
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'react') return { useState: () => [states[stateIndex++], () => {}], useRef: () => ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect() {} }
    if (name === 'react-router-dom') return { useParams: () => ({ bookId: 'book' }), useNavigate: () => () => {}, useLocation: () => ({ pathname: '/books/book/sources' }), Link: 'a' }
    if (name.includes('book-identity')) return identity
    if (name.includes('source-domain')) return domains
    if (name.includes('book-source-groups')) return { groupBookSourcesByDomain }
    if (name.includes('time-format')) return { formatSourceRuleDateTime }
    if (name.includes('book-cache-context')) return { useBookCache: () => ({}) }
    if (name.includes('use-page-resource')) return { usePageLoadEffect() {} }
    if (name.includes('use-book-search')) return { useBookSearch: () => ({ candidates, searchId: 'search', status, message: '', progress: { completed: 0, total: 1, activeSources: ['实时书源'], currentGroup: 'https://import.example/source-list' } }) }
    if (name.includes('loading-state')) return { LoadingState: 'loading' }
    return {}
  } })
  return module.exports.BookSourcesPage()
}

test('matching an existing source suppresses empty search text and duplicate result rows while refreshing timing', () => {
  const tree = render([candidate])
  const content = text(tree)
  assert.ok(!content.includes('当前搜索没有找到与这本书匹配的来源'))
  assert.ok(content.includes('已保存版本'))
  assert.ok(!content.includes('本次搜索结果'))
  assert.ok(content.includes('25ms'))
  assert.ok(content.includes('测试分组'))
})

test('empty search text still appears when candidates do not match the book author', () => {
  const tree = render([{ ...candidate, candidate: { ...candidate.candidate, author: '其他作者' } }])
  assert.ok(text(tree).includes('当前搜索没有找到与这本书匹配的来源'))
})

test('source search renders progress inline with active source names', () => {
  const loading = nodes(render([], 'loading')).find((node) => node.type === 'loading')
  assert.equal(loading?.props?.variant, 'inline')
  assert.equal(loading?.props?.message, '正在搜索可用书源… 书源 0/1 · 请求中：实时书源')
})
