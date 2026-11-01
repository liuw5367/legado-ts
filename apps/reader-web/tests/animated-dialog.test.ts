import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/components/ui/animated-dialog.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText

function setup() {
  let present = true, active = true, reduced = false, cursor = 0, closed = 0, restored = 0, otherModal = false
  const slots: any[] = [], effects: { deps: unknown[]; cleanup?: (() => void) | undefined }[] = []
  const pending: (() => void)[] = [], timers = new Map<number, () => void>(), events: (() => void)[] = []
  let timerId = 0, effectIndex = 0, node: any
  const trace: string[] = []
  class Element {
    focus() { restored++; trace.push('restore-focus') }
    blur() {}
  }
  const trigger = new Element()
  const document = { activeElement: trigger, querySelector: () => otherModal ? {} : null }
  const dialog = {
    open: false,
    showModal() { this.open = true; trace.push('showModal') },
    close() { this.open = false; trace.push('close'); events.push(() => { trace.push('close-event'); node.props.onClose({ currentTarget: dialog }) }) },
    contains: () => false,
  }
  const module = { exports: {} as { AnimatedDialog: (props: any) => any } }
  runInNewContext(code, { module, exports: module.exports, HTMLElement: Element, document,
    window: { matchMedia: () => ({ matches: reduced }), setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId }, clearTimeout(id: number) { timers.delete(id) } },
    require(name: string) {
      if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }) }
      if (name.includes('use-page-resource')) return { usePageActivity: () => ({ active }) }
      if (name === 'react') return {
        createContext: (initial: unknown) => initial, useContext: () => present,
        useRef(initial: unknown) { const at = cursor++; return slots[at] ??= { current: initial } },
        useState(initial: unknown) { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], (value: any) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
        useLayoutEffect(fn: () => (() => void) | void, deps: unknown[]) {
          const at = effectIndex++, old = effects[at]
          if (!old || deps.some((value, index) => value !== old.deps[index])) pending.push(() => { old?.cleanup?.(); effects[at] = { deps, cleanup: fn() ?? undefined } })
        },
      }
      return {}
    },
  })
  function render(open = true) {
    cursor = 0; effectIndex = 0
    node = module.exports.AnimatedDialog({ open, children: 'content', onClose: () => { closed++; trace.push('parent-close') } })
    node.props.ref.current = dialog
    while (pending.length) pending.shift()!()
  }
  return {
    render, dialog, trace,
    setPresent(value: boolean) { present = value }, setActive(value: boolean) { active = value }, setReduced(value: boolean) { reduced = value }, setOtherModal(value: boolean) { otherModal = value },
    finishAnimation() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()) },
    flushEvents() { while (events.length) events.shift()!() },
    unmount() { effects.forEach((effect) => effect.cleanup?.()) },
    closed: () => closed, restored: () => restored,
  }
}

for (const mode of ['animated exit', 'reduced motion', 'hidden page', 'controlled close']) {
  test(`internal ${mode} does not invoke the owner's close callback`, () => {
    const view = setup()
    view.render()
    assert.equal(view.dialog.open, true)
    if (mode === 'reduced motion') view.setReduced(true)
    if (mode === 'hidden page') view.setActive(false)
    if (mode !== 'controlled close') view.setPresent(false)
    view.render(mode !== 'controlled close')
    view.finishAnimation(); view.flushEvents()
    assert.equal(view.dialog.open, false)
    assert.equal(view.closed(), 0, view.trace.join(' → '))
  })
}

test('a native close still notifies the owner and restores focus', () => {
  const view = setup(); view.render(); view.dialog.close(); view.flushEvents()
  assert.equal(view.closed(), 1)
  assert.equal(view.restored(), 1)
})

test('the outgoing picker does not restore focus over the new editor', () => {
  const view = setup(); view.render(); view.setPresent(false); view.render(); view.setOtherModal(true)
  view.finishAnimation(); view.flushEvents(); view.unmount()
  assert.equal(view.restored(), 0)
  assert.equal(view.closed(), 0)
})

test('reopening before the exit timeout cancels the old close', () => {
  const view = setup(); view.render(); view.setPresent(false); view.render(); view.setPresent(true); view.render()
  view.finishAnimation(); view.flushEvents()
  assert.equal(view.dialog.open, true)
  assert.equal(view.closed(), 0)
})

test('a queued internal close event cannot consume a later native close', () => {
  const view = setup(); view.render(); view.setPresent(false); view.render(); view.finishAnimation()
  view.setPresent(true); view.render(); view.flushEvents()
  assert.equal(view.dialog.open, true)
  view.dialog.close(); view.flushEvents()
  assert.equal(view.closed(), 1)
})

test('a native close during the exit delay does not leave a suppressed event for the next opening', () => {
  const view = setup(); view.render(); view.setPresent(false); view.render()
  view.dialog.close(); view.flushEvents(); view.finishAnimation()
  view.setPresent(true); view.render(); view.dialog.close(); view.flushEvents()
  assert.equal(view.closed(), 2)
})

test('Sheet keeps explicit close, Escape and backdrop dismissal independent of internal close events', () => {
  const sheetCode = ts.transpileModule(readFileSync(new URL('../src/components/ui/sheet.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} as { Sheet: (props: any) => any } }
  let closed = 0, prevented = 0
  runInNewContext(sheetCode, { module, exports: module.exports, require(name: string) {
    if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
    if (name === 'react') return { useId: () => 'title' }
    return { AnimatedDialog: 'dialog' }
  } })
  const sheet = module.exports.Sheet({ open: true, title: '测试', children: 'content', onOpenChange: (open: boolean) => { if (!open) closed++ } })
  const backdrop = {}, child = {}
  sheet.props.onClick({ currentTarget: backdrop, target: child })
  assert.equal(closed, 0)
  sheet.props.onClick({ currentTarget: backdrop, target: backdrop })
  sheet.props.onCancel({ preventDefault: () => { prevented++ } })
  sheet.props.children.props.children[0].props.children[1].props.onClick()
  assert.equal(closed, 3)
  assert.equal(prevented, 1)
})
