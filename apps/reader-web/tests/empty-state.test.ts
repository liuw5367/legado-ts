import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = readFileSync(new URL('../src/components/empty-state.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const module = { exports: {} as { EmptyState: (props: { icon: () => unknown; title: string; description: string; action?: unknown }) => unknown } }
runInNewContext(code, { module, exports: module.exports, require: () => jsx })
const Icon = () => createElement('svg', { 'data-icon': 'book', 'aria-hidden': 'true' })

test('空状态显示图标、标题和提示，仅提供操作时显示按钮', () => {
  const base = { icon: Icon, title: '还没有书单', description: '点击新增书单' }
  const plain = renderToStaticMarkup(createElement(module.exports.EmptyState as never, base))
  assert.match(plain, /data-icon="book"/u)
  assert.match(plain, /还没有书单/u)
  assert.match(plain, /点击新增书单/u)
  assert.doesNotMatch(plain, /<button/u)
  const withAction = renderToStaticMarkup(createElement(module.exports.EmptyState as never, { ...base, action: createElement('button', null, '新增') }))
  assert.match(withAction, /<button[^>]*>新增<\/button>/u)
})
