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

for (const state of ['loading', 'error', 'ready', 'on-shelf']) {
  test(`详情页在 ${state} 状态只在详情操作区显示切换书源入口`, () => {
    const ready = state === 'ready' || state === 'on-shelf'
    const data = ready ? { onBookshelf: state === 'on-shelf', book: { name: '测试书' }, edition: { editionKey: 'edition', metadata: {} } } : null
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
    const rendered = nodes(module.exports.BookDetailsPage())
    const buttons = rendered.filter((node) => node.props?.children === '切换书源')
    assert.equal(buttons.length, ready ? 1 : 0)
    assert.equal(buttons[0]?.type, ready ? 'a' : undefined)
    assert.equal(buttons[0]?.props?.disabled, undefined)
    assert.equal(buttons[0]?.props?.to, ready ? '/books/book/sources' : undefined)
    if (ready) {
      const group = rendered.find((node) => node.props?.children === '修改分组')
      assert.ok(group)
      assert.equal(group.props?.disabled, state !== 'on-shelf')
      const actionArea = rendered.find((node) => node.props?.className === 'book-details-actions')
      assert.deepEqual(nodes(actionArea).filter((node) => node.type === 'a' || node.type === 'button').map((node) => node.props?.children), ['加入书架', '加入书单', '修改分组', '查看目录', '切换书源', '阅读 / 继续阅读'].map((label) => label === '加入书架' && state === 'on-shelf' ? '移出书架' : label))
    }
  })
}
