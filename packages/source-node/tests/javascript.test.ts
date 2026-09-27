import assert from 'node:assert/strict'
import test from 'node:test'
import { QuickJSJavaScriptHost } from '../src/index.ts'

test('QuickJS 执行器隔离全局并支持绑定、BigInt 和循环值编码', async () => {
  const host = new QuickJSJavaScriptHost()
  const result = await host.execute({ code: 'return bindings.answer + 2', stage: 'book', bindings: { answer: 40 } })
  assert.equal(result.status, 'success')
  assert.equal(result.value, 42)

  const bigint = await host.execute({ code: 'return 123n', stage: 'book' })
  assert.equal(bigint.value, 123n)

  const cycle = await host.execute({ code: 'const value = {}; value.self = value; return value', stage: 'book' })
  assert.equal(cycle.status, 'success')
  assert.equal((cycle.value as { self: unknown }).self, cycle.value)

  const first = await host.execute({ code: 'globalThis.secret = 123; return typeof process', stage: 'book' })
  const second = await host.execute({ code: 'return typeof secret', stage: 'book' })
  assert.equal(first.value, 'undefined')
  assert.equal(second.value, 'undefined')
})

test('QuickJS 脚本模式返回 JavaScript 完成值并可捕获修改后的 DTO 绑定', async () => {
  const host = new QuickJSJavaScriptHost()
  const numeric = await host.execute({ code: '1 + 2', stage: 'book', mode: 'script' })
  assert.equal(numeric.status, 'success')
  assert.equal(numeric.value, 3)

  const comparison = await host.execute({ code: '3 > 2', stage: 'book', mode: 'script' })
  assert.equal(comparison.value, true)

  const assignment = await host.execute({
    code: 'var answer = 40; answer + 2',
    stage: 'book',
    mode: 'script',
    captureBindings: ['answer'],
  })
  assert.deepEqual(assignment.value, {
    __legadoWorkflowValue: 42,
    __legadoWorkflowBindings: { answer: 40 },
  })

  // 未显式选择脚本模式时仍保留既有函数体 API。
  const functionBody = await host.execute({ code: 'return 40 + 2', stage: 'book' })
  assert.equal(functionBody.value, 42)
})

test('QuickJS 可序列化地捕获脚本全局变量供后续执行恢复', async () => {
  const host = new QuickJSJavaScriptHost()
  const first = await host.execute({
    code: 'globalThis.gInt = bindings.gInt; gInt = gInt + 1; seen = 1; gInt',
    stage: 'chapter',
    mode: 'script',
    bindings: { gInt: 0 },
    captureGlobals: true,
  })
  assert.equal(first.status, 'success')
  const state = (first.value as { __legadoWorkflowGlobals: Record<string, unknown> }).__legadoWorkflowGlobals
  assert.equal(state.gInt, 1)
  assert.equal(state.seen, 1)

  const second = await host.execute({
    code: 'globalThis.gInt = bindings.gInt; globalThis.seen = bindings.seen; gInt = gInt + 1; seen = seen + 1; [gInt, seen]',
    stage: 'chapter',
    mode: 'script',
    bindings: state,
    captureGlobals: true,
  })
  assert.deepEqual((second.value as { __legadoWorkflowValue: unknown }).__legadoWorkflowValue, [2, 2])
})

test('QuickJS 变量 bridge 返回可观察 delta，并支持一次异步宿主调用', async () => {
  const calls: unknown[] = []
  const host = new QuickJSJavaScriptHost({
    request: async (input) => {
      calls.push(input)
      return { ok: true, echo: input }
    },
  })
  const result = await host.execute({
    code: "setVar('count', getVar('count') + 1); return request({ path: bindings.path }).ok",
    stage: 'search',
    bindings: { path: '/books' },
    variables: { count: 1 },
  })
  assert.equal(result.status, 'success')
  assert.equal(result.value, true)
  assert.deepEqual(result.variableChanges, [{ name: 'count', before: 1, after: 2 }])
  assert.deepEqual(calls, [{ path: '/books' }])
  assert.equal(result.trace.filter((entry) => entry.kind === 'bridge').length, 3)
})

test('QuickJS 拒绝未授权 bridge、不可序列化返回值和无限循环', async () => {
  const noNetwork = await new QuickJSJavaScriptHost().execute({ code: 'return request({})', stage: 'book' })
  assert.equal(noNetwork.status, 'capability-missing')
  assert.equal(noNetwork.diagnostics[0]?.capability, 'network')

  const functionValue = await new QuickJSJavaScriptHost().execute({ code: 'return () => 1', stage: 'book' })
  assert.equal(functionValue.status, 'failed')
  assert.equal(functionValue.diagnostics[0]?.code, 'serialization-error')

  const loop = await new QuickJSJavaScriptHost().execute({ code: 'for (;;) {}', stage: 'book', budget: { timeoutMs: 50 } })
  assert.equal(loop.status, 'budget-exceeded')
})

test('QuickJS 取消后返回可判别状态', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await new QuickJSJavaScriptHost().execute({ code: 'return 1', stage: 'book', signal: controller.signal })
  assert.equal(result.status, 'cancelled')
})

test('QuickJS 在 tagged 编码前拒绝超过输入预算的二进制绑定', async () => {
  const host = new QuickJSJavaScriptHost()
  const result = await host.execute({
    code: 'result',
    stage: 'content',
    bindings: { result: new Uint8Array(2 * 1024 * 1024) },
    budget: { maxInputBytes: 1024 },
  })

  assert.equal(result.status, 'budget-exceeded')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'budget-exceeded'))
})
