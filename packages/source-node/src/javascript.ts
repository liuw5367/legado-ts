import { DefaultIntrinsics, newAsyncContext } from 'quickjs-emscripten'
import type { QuickJSHandle } from 'quickjs-emscripten'
import type { JavaScriptBridge, JavaScriptBudget, JavaScriptExecutionInput, JavaScriptExecutionResult, JavaScriptHost, JavaScriptTraceEntry, JavaScriptVariableChange } from '@legado/source-core'
import { decodeJavaScriptValue, encodeJavaScriptValue, guestCodecSource, JavaScriptSerializationError } from './javascript-codec.ts'

const defaultBudget: JavaScriptBudget = {
  timeoutMs: 1000,
  memoryLimitBytes: 16 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024,
  maxInputBytes: 512 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxBridgeCalls: 32,
}

const capabilityMarkers = {
  variables: '__LEGADO_CAPABILITY__variables',
  network: '__LEGADO_CAPABILITY__network',
  rule: '__LEGADO_CAPABILITY__rule',
} as const

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return String(error)
}

function nameOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'name' in error) return String(error.name)
  if (typeof error === 'object' && error !== null && 'cause' in error && typeof error.cause === 'object' && error.cause !== null && 'name' in error.cause) return String(error.cause.name)
  return undefined
}

function capabilityFallback(capability: keyof typeof capabilityMarkers): string {
  return `() => { throw new Error('${capabilityMarkers[capability]}') }`
}

function bridgeWrapper(name: string, hostName: string, capability: keyof typeof capabilityMarkers): string {
  if (name === 'getVar') return `const getVar = typeof ${hostName} === 'function' ? (name) => __legadoDecode(JSON.parse(${hostName}(String(name)))) : ${capabilityFallback(capability)}`
  if (name === 'setVar') return `const setVar = typeof ${hostName} === 'function' ? (name, value) => ${hostName}(String(name), __legadoEncode(value)) : ${capabilityFallback(capability)}`
  if (name === 'request') return `const request = typeof ${hostName} === 'function' ? (...args) => __legadoDecode(JSON.parse(${hostName}(__legadoEncode(args.length === 1 ? args[0] : { url: String(args[0]), method: args[1] === undefined ? 'GET' : args[1], body: args[2] })))) : ${capabilityFallback(capability)}`
  return `const evaluateRule = typeof ${hostName} === 'function' ? (rule) => __legadoDecode(JSON.parse(${hostName}(String(rule)))) : ${capabilityFallback(capability)}`
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return encodeJavaScriptValue(left) === encodeJavaScriptValue(right)
  } catch {
    return Object.is(left, right)
  }
}

export class QuickJSJavaScriptHost implements JavaScriptHost {
  private readonly bridge: JavaScriptBridge

  public constructor(bridge: JavaScriptBridge = {}) {
    this.bridge = bridge
  }

  public async execute(input: JavaScriptExecutionInput, overrides: JavaScriptBridge = {}): Promise<JavaScriptExecutionResult> {
    // 单次执行可以覆盖 bridge：宿主据此把「当前书源」绑到这一趟求值上，而不是共享可变字段。
    const bridge: JavaScriptBridge = { ...this.bridge, ...overrides }
    const budget = { ...defaultBudget, ...input.budget }
    const diagnostics: JavaScriptExecutionResult['diagnostics'] = []
    const trace: JavaScriptTraceEntry[] = []
    const variableValues = new Map<string, unknown>()
    const initialVariables = new Map<string, unknown>()
    const budgetValues = [budget.timeoutMs, budget.memoryLimitBytes, budget.maxStackSizeBytes, budget.maxInputBytes, budget.maxOutputBytes, budget.maxBridgeCalls]
    if (budgetValues.some((value) => !Number.isInteger(value) || value < 0) || budget.timeoutMs === 0 || budget.memoryLimitBytes === 0 || budget.maxStackSizeBytes === 0) {
      diagnostics.push({ code: 'budget-exceeded', message: 'JavaScript 预算必须是正的运行时限制和非负整数', stage: input.stage })
      return { status: 'budget-exceeded', value: null, diagnostics, variableChanges: [], trace }
    }
    const variableCapability = input.variables !== undefined || bridge.getVariable !== undefined || bridge.setVariable !== undefined
    if (input.variables !== undefined) {
      for (const [name, value] of Object.entries(input.variables)) {
        variableValues.set(name, value)
        initialVariables.set(name, value)
      }
    }

    let bindingsJson: string
    try {
      bindingsJson = encodeJavaScriptValue(input.bindings ?? {})
      if (new TextEncoder().encode(input.code).byteLength + new TextEncoder().encode(bindingsJson).byteLength > budget.maxInputBytes) {
        diagnostics.push({ code: 'budget-exceeded', message: 'JavaScript 输入超过字节预算', stage: input.stage })
        return { status: 'budget-exceeded', value: null, diagnostics, variableChanges: [], trace }
      }
    } catch (error) {
      diagnostics.push({ code: 'serialization-error', message: messageOf(error), stage: input.stage })
      return { status: 'failed', value: null, diagnostics, variableChanges: [], trace }
    }

    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort()
    const timeoutAbort = () => {
      timedOut = true
      controller.abort()
    }
    if (input.signal?.aborted === true) controller.abort()
    input.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(timeoutAbort, budget.timeoutMs)
    const signal = controller.signal
    let bridgeCalls = 0
    const startedAt = Date.now()
    let context: Awaited<ReturnType<typeof newAsyncContext>> | undefined
    const callBridge = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      if (input.signal?.aborted === true) throw new Error('__LEGADO_CANCELLED__')
      if (timedOut) throw new Error('__LEGADO_BUDGET__ timeout')
      bridgeCalls += 1
      if (bridgeCalls > budget.maxBridgeCalls) throw new Error('__LEGADO_BUDGET__ bridge call limit exceeded')
      const started = Date.now()
      try {
        return await fn()
      } catch (error) {
        if (signal.aborted || messageOf(error).includes('__LEGADO_')) throw error
        throw new Error(`__LEGADO_BRIDGE__ ${name}: ${messageOf(error)}`)
      } finally {
        trace.push({ kind: 'bridge', name, durationMs: Date.now() - started })
      }
    }

    try {
      if (signal.aborted) {
        diagnostics.push({ code: 'cancelled', message: 'JavaScript 执行已取消', stage: input.stage })
        return { status: 'cancelled', value: null, diagnostics, variableChanges: [], trace }
      }
      context = await newAsyncContext({ intrinsics: { ...DefaultIntrinsics } })
      context.runtime.setMemoryLimit(budget.memoryLimitBytes)
      context.runtime.setMaxStackSize(budget.maxStackSizeBytes)
      context.runtime.setInterruptHandler(() => signal.aborted || Date.now() - startedAt >= budget.timeoutMs)

      const installAsync = (name: string, callback: (...args: QuickJSHandle[]) => Promise<QuickJSHandle>): void => {
        const handle = context!.newAsyncifiedFunction(name, callback)
        handle.consume((value) => context!.setProp(context!.global, name, value))
      }
      if (variableCapability) {
        installAsync('__legadoGetVariable', async (...args) => {
          const name = context!.getString(args[0]!)
          const value = await callBridge('getVariable', async () => {
            if (variableValues.has(name)) return variableValues.get(name)
            if (bridge.getVariable === undefined) return undefined
            return bridge.getVariable(name, signal)
          })
          return context!.newString(encodeJavaScriptValue(value))
        })
        installAsync('__legadoSetVariable', async (...args) => {
          const name = context!.getString(args[0]!)
          const value = decodeJavaScriptValue(context!.getString(args[1]!))
          await callBridge('setVariable', async () => {
            if (bridge.setVariable !== undefined) await bridge.setVariable(name, value, signal)
          })
          variableValues.set(name, value)
          return context!.undefined
        })
      }
      if (bridge.request !== undefined) {
        installAsync('__legadoRequest', async (...args) => {
          const requestInput = decodeJavaScriptValue(context!.getString(args[0]!))
          const response = await callBridge('request', () => bridge.request!(requestInput, signal))
          return context!.newString(encodeJavaScriptValue(response))
        })
      }
      if (bridge.evaluateRule !== undefined) {
        installAsync('__legadoEvaluateRule', async (...args) => {
          const rule = context!.getString(args[0]!)
          const value = await callBridge('evaluateRule', () => bridge.evaluateRule!(rule, signal))
          return context!.newString(encodeJavaScriptValue(value))
        })
      }

      const bindings = JSON.stringify(bindingsJson)
      const source = [
        guestCodecSource,
        `const bindings = __legadoFreeze(__legadoDecode(JSON.parse(${bindings})))`,
        `${bridgeWrapper('getVar', '__legadoGetVariable', 'variables')}\n${bridgeWrapper('setVar', '__legadoSetVariable', 'variables')}`,
        `${bridgeWrapper('request', '__legadoRequest', 'network')}`,
        `${bridgeWrapper('evaluateRule', '__legadoEvaluateRule', 'rule')}`,
        `__legadoEncode((() => {\n${input.code}\n})())`,
      ].join('\n')
      const result = await context.evalCodeAsync(source, input.filename ?? `${input.stage}.js`)
      const valueHandle = context.unwrapResult(result)
      const serialized = context.getString(valueHandle)
      valueHandle.dispose()
      if (input.signal?.aborted === true) throw new Error('__LEGADO_CANCELLED__')
      if (timedOut) throw new Error('__LEGADO_BUDGET__ timeout')
      if (new TextEncoder().encode(serialized).byteLength > budget.maxOutputBytes) {
        diagnostics.push({ code: 'budget-exceeded', message: 'JavaScript 输出超过字节预算', stage: input.stage })
        return { status: 'budget-exceeded', value: null, diagnostics, variableChanges: [], trace }
      }
      const value = decodeJavaScriptValue(serialized)
      const variableChanges = changes(initialVariables, variableValues)
      return { status: 'success', value, diagnostics, variableChanges, trace }
    } catch (error) {
      const message = messageOf(error)
      const capability = (Object.keys(capabilityMarkers) as Array<keyof typeof capabilityMarkers>).find((key) => message.includes(capabilityMarkers[key]))
      if (capability !== undefined) {
        diagnostics.push({ code: 'capability-unavailable', message: `JavaScript bridge 不可用: ${capability}`, stage: input.stage, capability })
        return { status: 'capability-missing', value: null, diagnostics, variableChanges: changes(initialVariables, variableValues), trace }
      }
      if (message.includes('__LEGADO_CANCELLED__') || signal.aborted) {
        diagnostics.push({ code: 'cancelled', message: 'JavaScript 执行已取消', stage: input.stage })
        return { status: 'cancelled', value: null, diagnostics, variableChanges: changes(initialVariables, variableValues), trace }
      }
      if (message.includes('__LEGADO_BUDGET__') || message.includes('interrupted') || message.includes('out of memory')) {
        diagnostics.push({ code: 'budget-exceeded', message, stage: input.stage })
        return { status: 'budget-exceeded', value: null, diagnostics, variableChanges: changes(initialVariables, variableValues), trace }
      }
      if (message.includes('__LEGADO_SERIALIZATION__') || error instanceof JavaScriptSerializationError) {
        diagnostics.push({ code: 'serialization-error', message, stage: input.stage })
        return { status: 'failed', value: null, diagnostics, variableChanges: changes(initialVariables, variableValues), trace }
      }
      if (message.includes('__LEGADO_BRIDGE__')) {
        diagnostics.push({ code: 'bridge-error', message, stage: input.stage })
        return { status: 'failed', value: null, diagnostics, variableChanges: changes(initialVariables, variableValues), trace }
      }
      diagnostics.push({ code: nameOf(error) === 'SyntaxError' || message.includes('syntax') ? 'syntax-error' : 'runtime-error', message, stage: input.stage })
      return { status: 'failed', value: null, diagnostics, variableChanges: changes(initialVariables, variableValues), trace }
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      trace.push({ kind: 'execute', name: input.stage, durationMs: Date.now() - startedAt })
      context?.dispose()
    }
  }
}

function changes(before: Map<string, unknown>, after: Map<string, unknown>): JavaScriptVariableChange[] {
  const result: JavaScriptVariableChange[] = []
  for (const [name, value] of after) {
    const previous = before.get(name)
    if (!before.has(name) || !sameValue(previous, value)) result.push({ name, ...(before.has(name) ? { before: previous } : {}), after: value })
  }
  return result
}
