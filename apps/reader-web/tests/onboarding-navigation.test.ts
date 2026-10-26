import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { onboardingSteps, onboardingReturnTo } from '../src/lib/onboarding.ts'

const code = ts.transpileModule(readFileSync(new URL('../src/pages/onboarding.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
interface Node { props?: { children?: unknown; onClick?: () => void; className?: string } }
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (value === null || typeof value !== 'object') return []
  const node = value as Node
  return [node, ...nodes(node.props?.children)]
}

test('引导第三步跳转后，页面返回状态和浏览器历史都保留步骤', () => {
  let state: unknown = { returnTo: '/account/settings/about', stepIndex: 2 }
  const calls: { path: string; options: { state?: unknown; replace?: boolean } }[] = []
  const module = { exports: {} as { OnboardingPage: () => unknown } }
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  runInNewContext(code, { module, exports: module.exports, require(name: string) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'react') return { useState: (initial: unknown) => [initial, () => {}] }
    if (name === 'react-router-dom') return {
      useLocation: () => ({ pathname: '/onboarding', state }),
      useNavigate: () => (path: string, options: { state?: unknown; replace?: boolean }) => { calls.push({ path, options }) },
    }
    if (name.includes('auth-context')) return { useAuth: () => ({ user: { id: 'fixture-user' } }) }
    if (name.includes('lib/onboarding')) return { onboardingSteps, onboardingReturnTo, markOnboardingSeen() {} }
    return {}
  } })
  let tree = module.exports.OnboardingPage()
  const open = nodes(tree).find((node) => node.props?.className === 'button secondary onboarding-open-page')
  open?.props?.onClick?.()
  assert.equal(calls[0]?.path, '/search')
  assert.notEqual(calls[0]?.options.replace, true)
  const returned = calls[0]?.options.state as { backState: { stepIndex: number; returnTo: string } }
  assert.equal(returned.backState.stepIndex, 2)
  assert.equal(returned.backState.returnTo, '/account/settings/about')
  state = returned.backState
  tree = module.exports.OnboardingPage()
  const next = nodes(tree).find((node) => node.props?.className === 'button')
  next?.props?.onClick?.()
  assert.equal((calls[1]?.options.state as { stepIndex: number }).stepIndex, 3)
})
