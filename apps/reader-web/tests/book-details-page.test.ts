import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/pages/book-details.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (value === null || typeof value !== 'object') return []
  const node = value as Node
  return [node, ...nodes(node.props?.children)]
}

for (const state of ['loading', 'error', 'ready']) {
  test(`详情页切换书源入口在 ${state} 状态保持可见`, () => {
    const data = state === 'ready' ? { book: { name: '测试书' }, edition: { editionKey: 'edition', metadata: {} } } : null
    const states = [data, '', state === 'error' ? '加载失败' : '', null, false, 0]
    let index = 0
    const jsx = (type: unknown, props: unknown) => ({ type, props })
    const module = { exports: {} as { BookDetailsPage: () => unknown } }
    runInNewContext(code, { AbortController, module, exports: module.exports, require: (name: string) => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react') return { useState: () => [states[index++], () => {}] }
      if (name === 'react-router-dom') return { Link: 'a', useParams: () => ({ bookId: 'book' }), useSearchParams: () => [new URLSearchParams()], useLocation: () => ({}) }
      if (name.includes('use-page-resource')) return { usePageLoadEffect() {} }
      if (name.includes('book-cache-context')) return { useBookCache: () => ({}) }
      if (name.includes('page-navigation')) return { pageReturnState() {}, readingEntryState() {} }
      if (name.includes('reader-interactions')) return { browserUrl() {} }
      if (name.includes('time-format')) return { formatShanghaiDateTime: () => '' }
      return { Button: 'button' }
    } })
    const buttons = nodes(module.exports.BookDetailsPage()).filter((node) => node.props?.children === '切换书源')
    assert.equal(buttons.length, 1)
    assert.equal(buttons[0]?.type, state === 'ready' ? 'a' : 'button')
    assert.equal(buttons[0]?.props?.disabled, state === 'ready' ? undefined : true)
    assert.equal(buttons[0]?.props?.to, state === 'ready' ? '/books/book/sources' : undefined)
  })
}
