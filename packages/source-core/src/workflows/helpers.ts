import type { JsonObject, JsonValue, NormalizedSource } from '../model/types.ts'
import { SourceRequestError, SourceRequestRuntime } from './source-request.ts'
import { resolveSourceRequestUrl, splitSourceRequestUrl } from '../runtime/request-url.ts'
import type { CharsetCodec, NetworkResponse, RequestBudget } from '../runtime/contracts.ts'
import type { SourceFunctionName, WorkflowDiagnostic, WorkflowJavaScriptStage, WorkflowOptions, WorkflowPage, WorkflowPorts, WorkflowRuleOutput, WorkflowStage, WorkflowTraceEntry } from './types.ts'

export const listFields = [
  ['bookName', 'name'],
  ['bookAuthor', 'author'],
  ['bookUrl', 'bookUrl'],
  ['bookCoverUrl', 'coverUrl'],
  ['bookIntro', 'intro'],
  ['bookKind', 'kind'],
  ['bookWordCount', 'wordCount'],
  ['bookLastChapter', 'lastChapter'],
  ['bookUpdateTime', 'updateTime'],
] as const

export const detailFields = [
  ['name', 'name'],
  ['author', 'author'],
  ['intro', 'intro'],
  ['coverUrl', 'coverUrl'],
  ['tocUrl', 'tocUrl'],
  ['kind', 'kind'],
  ['wordCount', 'wordCount'],
  ['lastChapter', 'lastChapter'],
  ['updateTime', 'updateTime'],
] as const

export function asRecord(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

export function sourceString(source: NormalizedSource, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function sourceNumber(source: NormalizedSource, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function ruleString(source: NormalizedSource, group: string, field: string): string | undefined {
  const rules = asRecord(source[group])
  if (rules === undefined) return undefined
  // Android 的列表规则字段名是 name/author/coverUrl/intro；工作流内部保留 book* 名称，读取时兼容两种写法。
  const aliases: Readonly<Record<string, readonly string[]>> = {
    bookName: ['bookName', 'name'],
    bookAuthor: ['bookAuthor', 'author'],
    bookCoverUrl: ['bookCoverUrl', 'coverUrl'],
    bookIntro: ['bookIntro', 'intro'],
    bookKind: ['bookKind', 'kind'],
    bookWordCount: ['bookWordCount', 'wordCount'],
    bookLastChapter: ['bookLastChapter', 'lastChapter'],
    bookUpdateTime: ['bookUpdateTime', 'updateTime'],
  }
  const keys = aliases[field] ?? [field]
  for (const key of keys) if (typeof rules[key] === 'string') return rules[key] as string
  return undefined
}

function numericTemplateExpression(input: string, replacements: Readonly<Record<string, string>>): number | undefined {
  let index = 0
  const skip = (): void => { while (/\s/.test(input[index] ?? '')) index += 1 }
  const primary = (): number | undefined => {
    skip()
    const sign = input[index] === '+' || input[index] === '-' ? input[index++] : undefined
    skip()
    let result: number | undefined
    if (input[index] === '(') {
      index += 1
      result = expression()
      skip()
      if (input[index] !== ')') return undefined
      index += 1
    } else {
      const number = /^\d+(?:\.\d+)?/.exec(input.slice(index))
      if (number !== null) {
        index += number[0].length
        result = Number(number[0])
      } else {
        const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(input.slice(index))
        if (name === null || replacements[name[0]] === undefined || !/^\d+(?:\.\d+)?$/.test(replacements[name[0]]!)) return undefined
        index += name[0].length
        result = Number(replacements[name[0]])
      }
    }
    if (result === undefined) return undefined
    return sign === '-' ? -result : result
  }
  const product = (): number | undefined => {
    let result = primary()
    while (result !== undefined) {
      skip()
      const operator = input[index]
      if (operator !== '*' && operator !== '/' && operator !== '%') break
      index += 1
      const right = primary()
      if (right === undefined) return undefined
      result = operator === '*' ? result * right : operator === '/' ? result / right : result % right
    }
    return result
  }
  function expression(): number | undefined {
    let result = product()
    while (result !== undefined) {
      skip()
      const operator = input[index]
      if (operator !== '+' && operator !== '-') break
      index += 1
      const right = product()
      if (right === undefined) return undefined
      result = operator === '+' ? result + right : result - right
    }
    return result
  }
  const result = expression()
  skip()
  return result !== undefined && index === input.length && Number.isFinite(result) ? result : undefined
}

export interface UrlExpansionError {
  /** 展开失败的稳定分类：规则执行失败、宿主缺少 JavaScript 能力、配置越界或被取消。 */
  code: 'rule-failed' | 'capability-missing' | 'invalid-config' | 'cancelled'
  message: string
}

/**
 * 单个 URL 允许的内联表达式数量上限。语料实测：1871 条 URL 规则中需要求值的表达式
 * 最多 1048 个（起点系 exploreUrl 的分类 JSON），p99.9 为 360；上限取 2048 留一倍余量，
 * 只拒绝病态输入，不误伤真实书源。
 */
const maxUrlExpressions = 2048

/** URL 展开失败对应的阶段状态；取消必须保持 cancelled，不能折叠成 failed。 */
export function expansionStatus(error: UrlExpansionError | undefined): 'failed' | 'cancelled' | 'capability-missing' {
  if (error?.code === 'cancelled') return 'cancelled'
  return error?.code === 'capability-missing' ? 'capability-missing' : 'failed'
}

/** URL 展开失败的诊断；诊断码与失败分类一致。 */
export function expansionDiagnostic(error: UrlExpansionError | undefined, stage: WorkflowStage, field: string, message: string): WorkflowDiagnostic {
  return { code: error?.code ?? 'rule-failed', stage, field, message: error?.message ?? message, retryable: false }
}

/**
 * 展开书源 URL 中的 `{{...}}`。Android 把每个片段当内联 JS 求值（AnalyzeUrl.replaceKeyPageJs），
 * 结果为 null/undefined 时该片段展开为空串，例如 `{{cookie.removeCookie(source.getKey())}}`。
 * 已知替换项（`key`/`keyword`/`page`/`pageIndex`/`source.bookSourceUrl`）和纯页码算术走快速路径，
 * 其余表达式交给规则宿主的 JS 能力；没有 JS 能力时返回可诊断错误，不把字面量拼进 URL。
 */
export async function expandUrl(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, url: string, replacements: Readonly<Record<string, string>>, bindings: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ url?: string; error?: UrlExpansionError }> {
  const scripted = await expandEmbeddedUrlScripts(ports, source, stage, url, bindings, signal)
  if (scripted.error !== undefined) return { error: scripted.error }
  const matches = [...scripted.url!.matchAll(/\{\{([\s\S]*?)\}\}/g)]
  // 每个表达式都可能触发一次 JS 求值，数量不设上限就等于取消预算；超限在任何求值前失败。
  if (matches.length > maxUrlExpressions) return { error: { code: 'invalid-config', message: `书源 URL 内联表达式数量超过上限（${maxUrlExpressions}）` } }
  let result = scripted.url!
  for (const match of matches.reverse()) {
    const value = await expandExpression(ports, source, stage, match[1]!.trim(), replacements, bindings, signal)
    if (value.error !== undefined) return { error: value.error }
    result = `${result.slice(0, match.index!)}${value.text ?? ''}${result.slice(match.index! + match[0]!.length)}`
  }
  const page = Math.max(1, Number(replacements.page ?? replacements.pageIndex ?? 1) || 1)
  result = result.replace(/<([^<>]*)>/g, (_match, values: string) => {
    const pages = values.split(',')
    return (pages[Math.min(page - 1, pages.length - 1)] ?? '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, '')
  })
  return { url: result }
}

async function expandEmbeddedUrlScripts(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, input: string, bindings: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined): Promise<{ url?: string; error?: UrlExpansionError }> {
  const matches = [...input.matchAll(/<js>([\s\S]*?)<\/js>/gi)]
  if (matches.length === 0) return { url: input }
  let result = input
  let end = 0
  for (const match of matches) {
    const start = match.index!
    const literal = input.slice(end, start).trim()
    if (literal.length > 0) result = literal.split('@result').join(result)
    let output: WorkflowRuleOutput
    try {
      output = await ports.rules.evaluate({
        source,
        stage,
        field: 'url',
        rule: `@js:${match[1] ?? ''}`,
        content: result,
        bindings,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      if (signal?.aborted === true) return { error: { code: 'cancelled', message: '书源 URL 脚本已取消' } }
      return { error: { code: 'rule-failed', message: '书源 URL 脚本执行失败' } }
    }
    if (output.status === 'cancelled' || signal?.aborted === true) return { error: { code: 'cancelled', message: '书源 URL 脚本已取消' } }
    if (output.status === 'capability-missing') return { error: { code: 'capability-missing', message: output.message ?? '书源 URL 脚本需要 JavaScript 能力' } }
    if (output.status === 'failed') return { error: { code: 'rule-failed', message: output.message ?? '书源 URL 脚本执行失败' } }
    result = output.status === 'success' ? textValue(output.value) : ''
    end = start + match[0]!.length
  }
  const tail = input.slice(end).trim()
  if (tail.length > 0) result = tail.split('@result').join(result)
  return { url: result }
}

async function expandExpression(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, expression: string, replacements: Readonly<Record<string, string>>, bindings: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined): Promise<{ text?: string; error?: UrlExpansionError }> {
  if (Object.prototype.hasOwnProperty.call(replacements, expression)) return { text: replacements[expression] ?? '' }
  let numeric: number | undefined
  try {
    numeric = numericTemplateExpression(expression, replacements)
  } catch {
    // 病态嵌套（数千层括号）会打爆递归栈；栈溢出只让它落回 JS 求值，不能逃出 RuntimeResult 契约。
    numeric = undefined
  }
  if (numeric !== undefined) return { text: String(numeric) }
  let output: WorkflowRuleOutput
  try {
    output = await ports.rules.evaluate({ source, stage, field: 'url', rule: `@js:${expression}`, content: '', bindings, ...(signal === undefined ? {} : { signal }) })
  } catch {
    // 求值期间取消时异常只是取消的副作用，不能当成规则失败。
    if (signal?.aborted === true) return { error: { code: 'cancelled', message: '书源 URL 表达式求值已取消' } }
    output = { status: 'failed', value: null, message: '规则宿主失败' }
  }
  if (output.status === 'cancelled' || signal?.aborted === true) return { error: { code: 'cancelled', message: '书源 URL 表达式求值已取消' } }
  if (output.status === 'capability-missing') return { error: { code: 'capability-missing', message: '书源 URL 表达式需要 JavaScript 能力' } }
  if (output.status === 'failed') return { error: { code: 'rule-failed', message: output.message ?? '书源 URL 表达式求值失败' } }
  return { text: output.status === 'success' ? textValue(output.value) : '' }
}

/**
 * Java 的 `\s` 只匹配 ASCII 空白，JS 的 `\s` 还包含 U+3000 等 Unicode 空白。
 * 用这两个字符类固定 Android 行为：「我本无意成仙　作者：张三」（全角空格）不会被清洗掉。
 */
const javaSpaceClass = '[\\u0009-\\u000d\\u0020]'
const javaNonSpaceClass = '[^\\u0009-\\u000d\\u0020]'
const nameTailPattern = new RegExp(`${javaSpaceClass}+作${javaSpaceClass}*者[\\s\\S]*|${javaSpaceClass}+${javaNonSpaceClass}+${javaSpaceClass}+著`, 'u')
const authorPrefixPattern = new RegExp(`^${javaSpaceClass}*作${javaSpaceClass}*者[:：\\u0009-\\u000d\\u0020]+|${javaSpaceClass}+著`, 'u')

/** Java `String.trim`：只去掉 <= U+0020 的字符，不碰 U+3000 全角空格。 */
function trimAsciiSpace(value: string): string {
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, '')
}

/**
 * Android `BookHelp.formatBookName`：去掉「 作者 xxx」「 xxx 著」尾巴再按 Java trim 剪空白，
 * 只清洗运行时拿到的书名，不改写规则原文。
 */
export function formatBookName(value: string): string {
  return trimAsciiSpace(value.replace(nameTailPattern, ''))
}

/** Android `BookHelp.formatBookAuthor`：去掉「作者[:：]」前缀和「 著」尾巴再剪空白。 */
export function formatBookAuthor(value: string): string {
  return trimAsciiSpace(value.replace(authorPrefixPattern, ''))
}

/**
 * Android `StringUtils.wordCountFormat`：纯数字时按 万字 归一化。
 * 超过一万走 `DecimalFormat("#.#")`——HALF_EVEN 舍入到一位小数并在整数时省略小数位，
 * 且 Android 先转 Float 再除 10000，这里用 `Math.fround` 复现同样的精度损失。
 */
export function formatWordCount(value: string | undefined): string {
  if (value === undefined) return ''
  if (!/^-?[0-9]+$/u.test(value)) return value
  const words = Number(value)
  if (!(words > 0)) return ''
  if (words > 10000) return `${formatDecimalOne(Math.fround(words) / 10000)}万字`
  return `${words}字`
}

/** Java `DecimalFormat("#.#")` 的 HALF_EVEN 舍入到一位小数；整数不带小数点。 */
function formatDecimalOne(value: number): string {
  const scaled = value * 10
  const floor = Math.floor(scaled)
  const rounded = Math.abs(scaled - floor - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled)
  return (rounded / 10).toFixed(1).replace(/\.0$/u, '')
}

export function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n')
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === 'object') {
    const object: JsonObject = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) object[key] = jsonValue(item)
    return object
  }
  return String(value)
}

export function requestBudget(options: WorkflowOptions): Partial<RequestBudget> {
  const budget = { ...options.budget }
  if (options.signal !== undefined) budget.signal = options.signal
  return budget
}

export function responseText(response: Parameters<NonNullable<WorkflowPorts['decodeResponse']>>[0], source: NormalizedSource, ports: WorkflowPorts): string {
  if (ports.decodeResponse !== undefined) return ports.decodeResponse(response, source)
  return new TextDecoder().decode(response.bytes)
}

function isWebViewError(value: unknown): boolean {
  return value instanceof Error && /webview/i.test(value.message)
}

export interface WorkflowPageResponse {
  content: string
  url: string
}

export async function requestPageResponse(ports: WorkflowPorts, source: NormalizedSource, url: string, stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], execution?: { webJs?: string; sourceRegex?: string }): Promise<WorkflowPageResponse | undefined> {
  if (options.signal?.aborted === true) {
    diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
    return undefined
  }
  trace.push({ stage, event: 'request', target: stage })
  try {
    const requestInput = { source, url, stage, options, ...(execution === undefined ? {} : { execution }) }
    let response: NetworkResponse
    if (ports.request !== undefined) response = await ports.request(requestInput)
    else {
      const encoding: CharsetCodec = {
        encode: (value, charset) => ports.network.encodeCharset?.(value, charset) ?? new TextEncoder().encode(value),
        decode: (bytes, charset) => new TextDecoder(charset).decode(bytes),
      }
      const runtime = new SourceRequestRuntime({
        network: ports.network,
        rules: ports.rules,
        encoding,
        encodeFormBody: false,
        decodeResponse: (value) => responseText(value, source, ports),
      })
      response = await runtime.request(requestInput)
    }
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return undefined
    }
    if (response === undefined) throw new Error('书源请求没有响应')
    const checked = await applyLoginCheck(ports, source, stage, response, options.signal, diagnostics)
    if (checked === undefined) return undefined
    response = checked
    return { content: responseText(response, source, ports), url: response.url }
  } catch (error) {
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return undefined
    }
    // 结构化请求错误是确定性失败：直接映射诊断，不伪装成 500 也不标记可重试。
    if (error instanceof SourceRequestError) {
      diagnostics.push({
        code: error.code,
        stage,
        ...(error.field === undefined ? {} : { field: error.field }),
        message: error.message,
        retryable: false,
      })
      return undefined
    }
    const loginCheckJs = sourceString(source, 'loginCheckJs')
    if (loginCheckJs !== undefined && !isWebViewError(error)) {
      const errorText = error instanceof Error ? error.message : '书源请求失败'
      let errorUrl = url
      try {
        const reference = splitSourceRequestUrl(url).url
        errorUrl = resolveSourceRequestUrl(reference, source.bookSourceUrl, undefined, ports.network.encodeCharset?.bind(ports.network))
      } catch {
        // 保留原地址供 hook 检查，之后仍返回原请求失败诊断。
      }
      const errorResponse: NetworkResponse = { url: errorUrl, status: 500, headers: {}, bytes: new TextEncoder().encode(errorText), redirected: false }
      const recovered = await applyLoginCheck(ports, source, stage, errorResponse, options.signal, diagnostics)
      if (recovered !== undefined && recovered.status !== 500) return { content: responseText(recovered, source, ports), url: recovered.url }
      if (recovered === undefined) return undefined
    }
    diagnostics.push({ code: isWebViewError(error) ? 'capability-missing' : 'request-failed', stage, message: isWebViewError(error) ? '书源请求需要 WebView，当前 Node 宿主不支持' : '书源请求失败', retryable: !isWebViewError(error) })
    return undefined
  }
}

async function applyLoginCheck(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, response: NetworkResponse, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[]): Promise<NetworkResponse | undefined> {
  const code = sourceString(source, 'loginCheckJs')
  if (code === undefined) return response
  if (ports.rules.executeWorkflowJavaScript === undefined) {
    diagnostics.push({ code: 'capability-missing', stage, field: 'loginCheckJs', message: 'loginCheckJs 需要 JavaScript 脚本宿主', retryable: false })
    return undefined
  }
  const responseBody = responseText(response, source, ports)
  const responseBinding = { url: response.url, status: response.status, code: response.status, message: '', body: responseBody, headers: response.headers }
  let output: WorkflowRuleOutput
  try {
    output = await ports.rules.executeWorkflowJavaScript({
      source,
      code,
      stage: stage === 'search' ? 'search' : stage === 'detail' ? 'book' : 'search',
      content: responseBinding,
      bindings: { __strResponse: responseBinding },
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    output = { status: 'failed', value: null, message: 'loginCheckJs 执行失败' }
  }
  if (signal?.aborted === true || output.status === 'cancelled') {
    diagnostics.push({ code: 'cancelled', stage, field: 'loginCheckJs', message: 'loginCheckJs 已取消', retryable: false })
    return undefined
  }
  if (output.status === 'capability-missing') {
    diagnostics.push({ code: 'capability-missing', stage, field: 'loginCheckJs', message: output.message ?? 'loginCheckJs 依赖宿主能力', retryable: false })
    return undefined
  }
  if (output.status !== 'success' || typeof output.value !== 'object' || output.value === null || Array.isArray(output.value)) {
    diagnostics.push({ code: 'rule-failed', stage, field: 'loginCheckJs', message: output.message ?? 'loginCheckJs 必须返回响应对象', retryable: false })
    return undefined
  }
  const value = output.value as Record<string, unknown>
  const body = firstString(value.body, value.__body)
  const responseUrl = firstString(value.url, value.__url) ?? response.url
  const status = firstNumber(value.status, value.code, value.__code) ?? response.status
  const headersValue = value.headers ?? value.__headers
  const headers = typeof headersValue === 'object' && headersValue !== null && !Array.isArray(headersValue)
    ? Object.fromEntries(Object.entries(headersValue).flatMap(([key, item]) => typeof item === 'string' ? [[key, item]] : []))
    : response.headers
  if (body === undefined) {
    diagnostics.push({ code: 'rule-failed', stage, field: 'loginCheckJs', message: 'loginCheckJs 返回的响应缺少正文', retryable: false })
    return undefined
  }
  return { ...response, url: responseUrl, status, headers: { ...headers, 'x-legado-response-charset': 'utf-8' }, bytes: new TextEncoder().encode(body) }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string')
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isInteger(value))
}

export async function requestPage(ports: WorkflowPorts, source: NormalizedSource, url: string, stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<string | undefined> {
  return (await requestPageResponse(ports, source, url, stage, options, diagnostics, trace))?.content
}

export async function evaluateField(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, field: string, rule: string, content: unknown, itemIndex: number | undefined, trace: WorkflowTraceEntry[], signal: AbortSignal | undefined, context?: { baseUrl?: string; redirectUrl?: string; expect?: 'text' | 'nodes' }): Promise<{ state: 'value' | 'empty' | 'missing' | 'failed' | 'cancelled' | 'capability-missing'; value?: unknown; message?: string }> {
  trace.push({ stage, event: 'rule', target: field, ...(itemIndex === undefined ? {} : { itemIndex }) })
  let output: WorkflowRuleOutput
  try {
    output = await ports.rules.evaluate({ source, stage, field, rule, content, ...context, ...(itemIndex === undefined ? {} : { itemIndex }), ...(signal === undefined ? {} : { signal }) })
  } catch {
    output = { status: 'failed', value: null, message: '规则宿主失败' }
  }
  if (output.status === 'cancelled' || (signal !== undefined && signal.aborted)) return output.message === undefined ? { state: 'cancelled' } : { state: 'cancelled', message: output.message }
  if (output.status === 'capability-missing') return output.message === undefined ? { state: 'capability-missing' } : { state: 'capability-missing', message: output.message }
  if (output.status === 'failed') return { state: 'failed', message: output.message ?? '规则解析失败' }
  if (output.status === 'empty' || output.value === null || output.value === undefined) return { state: output.status === 'empty' ? 'empty' : 'missing', value: output.value }
  if (typeof output.value === 'string' && output.value.length === 0) return { state: 'empty', value: output.value }
  if (Array.isArray(output.value) && output.value.length === 0) return { state: 'empty', value: output.value }
  return { state: 'value', value: output.value }
}

export type ScriptExecutionState = 'value' | 'empty' | 'missing-function' | 'failed' | 'cancelled' | 'capability-missing'

export interface ScriptExecutionResult {
  state: ScriptExecutionState
  value?: unknown
  message?: string
}

export async function executeSourceFunction(ports: WorkflowPorts, source: NormalizedSource, name: SourceFunctionName, args: readonly unknown[], bindings: Readonly<Record<string, unknown>>, stage: WorkflowStage, jsStage: WorkflowJavaScriptStage, trace: WorkflowTraceEntry[], signal?: AbortSignal): Promise<ScriptExecutionResult> {
  trace.push({ stage, event: 'rule', target: name })
  if (ports.rules.executeSourceFunction === undefined) return { state: 'capability-missing', message: 'JavaScript 源函数宿主不可用' }
  try {
    const output = await ports.rules.executeSourceFunction({ source, name, args, bindings, stage: jsStage, ...(signal === undefined ? {} : { signal }) })
    if (signal?.aborted === true || output.status === 'cancelled') return { state: 'cancelled', ...(output.message === undefined ? {} : { message: output.message }) }
    if (output.status === 'capability-missing') return { state: 'capability-missing', ...(output.message === undefined ? {} : { message: output.message }) }
    if (output.status === 'failed') return { state: 'failed', message: output.message ?? `${name} 执行失败` }
    if (!output.exists) return { state: 'missing-function' }
    return output.value === null || output.value === undefined || output.status === 'empty'
      ? { state: 'empty', value: output.value }
      : { state: 'value', value: output.value }
  } catch {
    return { state: 'failed', message: `${name} 执行失败` }
  }
}

export async function executeWorkflowJavaScript(ports: WorkflowPorts, source: NormalizedSource, code: string, stage: WorkflowStage, jsStage: WorkflowJavaScriptStage, trace: WorkflowTraceEntry[], options: { content?: unknown; bindings?: Readonly<Record<string, unknown>>; captureMutations?: readonly string[]; signal?: AbortSignal }): Promise<ScriptExecutionResult> {
  trace.push({ stage, event: 'rule', target: 'javascript' })
  if (ports.rules.executeWorkflowJavaScript === undefined) return { state: 'capability-missing', message: 'JavaScript 脚本宿主不可用' }
  try {
  const output = await ports.rules.executeWorkflowJavaScript({ source, code, stage: jsStage, ...(options.content === undefined ? {} : { content: options.content }), ...(options.bindings === undefined ? {} : { bindings: options.bindings }), ...(options.captureMutations === undefined ? {} : { captureMutations: options.captureMutations }), ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (options.signal?.aborted === true || output.status === 'cancelled') return { state: 'cancelled', ...(output.message === undefined ? {} : { message: output.message }) }
    if (output.status === 'capability-missing') return { state: 'capability-missing', ...(output.message === undefined ? {} : { message: output.message }) }
    if (output.status === 'failed') return { state: 'failed', message: output.message ?? 'JavaScript 脚本执行失败' }
    if (output.status === 'empty' || output.value === null || output.value === undefined) return { state: 'empty', value: output.value }
    return { state: 'value', value: output.value }
  } catch {
    return { state: 'failed', message: 'JavaScript 脚本执行失败' }
  }
}

export function pageResult<T>(cursor: { index: number }, items: T[], nextCursor?: { index: number; token?: string }): WorkflowPage<T> {
  return { items, cursor, ...(nextCursor === undefined ? {} : { nextCursor }) }
}

export function statusFromDiagnostics(diagnostics: readonly WorkflowDiagnostic[], itemCount: number): 'success' | 'partial' | 'failed' | 'empty' | 'cancelled' | 'capability-missing' {
  if (diagnostics.some((diagnostic) => diagnostic.code === 'cancelled')) return 'cancelled'
  if (diagnostics.some((diagnostic) => diagnostic.code === 'capability-missing')) return itemCount > 0 ? 'partial' : 'capability-missing'
  if (itemCount === 0) return diagnostics.some((diagnostic) => diagnostic.code === 'empty-page') ? 'empty' : 'failed'
  return diagnostics.some((diagnostic) => diagnostic.code !== 'duplicate-item') ? 'partial' : 'success'
}
