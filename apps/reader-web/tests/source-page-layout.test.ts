import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const layoutPath = new URL('../src/components/account-layout.tsx', import.meta.url)

test('retained source pages do not determine active route width when navigating away and back', () => {
  let pathname = '/sources'
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
  const module = { exports: {} as { AccountLayout: (props: {}) => { props: { children: unknown[] } } } }
  const code = ts.transpileModule(readFileSync(layoutPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name.includes('auth-context')) return { useAuth: () => ({ user: null, logout() {} }) }
    if (name.includes('use-page-resource')) return { usePageNavigation: () => undefined }
    if (name === 'react-router-dom') return { useLocation: () => ({ pathname }), Link: 'a', NavLink: 'a' }
    return {}
  } })
  for (const [route, expected] of [['/sources', true], ['/account/settings', false], ['/sources/import-history/demo', true], ['/sources/import-history', false], ['/book-lists', false], ['/sources', true]] as const) {
    pathname = route
    const tree = module.exports.AccountLayout({})
    const main = tree.props.children.find((child) => (child as { type?: string })?.type === 'main') as { props: { className: string } }
    assert.equal(main.props.className.split(' ').includes('app-main-full-width'), expected, route)
  }
})
