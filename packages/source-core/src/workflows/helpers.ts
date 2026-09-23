import type { JsonObject, JsonValue, NormalizedSource } from '../model/types.ts'
import { createRequestPlan } from '../runtime/request-plan.ts'
import type { RequestBudget } from '../runtime/contracts.ts'
import type { WorkflowDiagnostic, WorkflowOptions, WorkflowPage, WorkflowPorts, WorkflowRuleOutput, WorkflowStage, WorkflowTraceEntry } from './types.ts'

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
  /** 展开失败的稳定分类：规则执行失败、宿主缺少 JavaScript 能力或被取消。 */
  code: 'rule-failed' | 'capability-missing' | 'cancelled'
  message: string
}

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
  if (!url.includes('{{')) return { url }
  const matches = [...url.matchAll(/\{\{([\s\S]*?)\}\}/g)]
  let result = url
  for (const match of matches.reverse()) {
    const value = await expandExpression(ports, source, stage, match[1]!.trim(), replacements, bindings, signal)
    if (value.error !== undefined) return { error: value.error }
    result = `${result.slice(0, match.index!)}${value.text ?? ''}${result.slice(match.index! + match[0]!.length)}`
  }
  return { url: result }
}

async function expandExpression(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, expression: string, replacements: Readonly<Record<string, string>>, bindings: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined): Promise<{ text?: string; error?: UrlExpansionError }> {
  if (Object.prototype.hasOwnProperty.call(replacements, expression)) return { text: replacements[expression] ?? '' }
  const numeric = numericTemplateExpression(expression, replacements)
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
 * Android `BookHelp.formatBookName`：去掉「 作者 xxx」「 xxx 著」尾巴再剪空白，
 * 只清洗运行时拿到的书名，不改写规则原文。
 */
export function formatBookName(value: string): string {
  return value.replace(/\s+作\s*者.*|\s+\S+\s+著/u, '').trim()
}

/** Android `BookHelp.formatBookAuthor`：去掉「作者[:：]」前缀和「 著」尾巴再剪空白。 */
export function formatBookAuthor(value: string): string {
  return value.replace(/^\s*作\s*者[:：\s]+|\s+著/u, '').trim()
}

/**
 * Android `StringUtils.wordCountFormat(String)`：纯数字时按 万字 归一化，
 * 超过一万保留一位小数，非数字原样返回。
 */
export function formatWordCount(value: string | undefined): string {
  if (value === undefined) return ''
  if (!/^-?[0-9]+$/u.test(value)) return value
  const words = Number(value)
  if (!(words > 0)) return ''
  if (words > 10000) return `${(words / 10000).toFixed(1).replace(/\.0$/u, '')}万字`
  return `${words}字`
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

export interface WorkflowPageResponse {
  content: string
  url: string
}

export async function requestPageResponse(ports: WorkflowPorts, source: NormalizedSource, url: string, stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], execution?: { webJs?: string; sourceRegex?: string }): Promise<WorkflowPageResponse | undefined> {
  if (options.signal?.aborted === true) {
    diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
    return undefined
  }
  const headers = sourceHeaders(source)
  trace.push({ stage, event: 'request', target: stage })
  try {
    let response: Parameters<NonNullable<WorkflowPorts['decodeResponse']>>[0]
    if (ports.request !== undefined) {
      response = await ports.request({ source, url, stage, options, ...(execution === undefined ? {} : { execution }) })
    } else {
      const result = createRequestPlan({ url, baseUrl: source.bookSourceUrl, ...(headers === undefined ? {} : { headers }), budget: requestBudget(options) })
      if (result.plan === undefined) {
        diagnostics.push({ code: 'invalid-config', stage, message: result.error?.message ?? '请求计划无效', retryable: false })
        return undefined
      }
      response = await ports.network.request(result.plan)
    }
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return undefined
    }
    return { content: responseText(response, source, ports), url: response.url }
  } catch {
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return undefined
    }
    diagnostics.push({ code: 'request-failed', stage, message: '书源请求失败', retryable: true })
    return undefined
  }
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

export function pageResult<T>(cursor: { index: number }, items: T[], nextCursor?: { index: number; token?: string }): WorkflowPage<T> {
  return { items, cursor, ...(nextCursor === undefined ? {} : { nextCursor }) }
}

export function statusFromDiagnostics(diagnostics: readonly WorkflowDiagnostic[], itemCount: number): 'success' | 'partial' | 'failed' | 'empty' | 'cancelled' | 'capability-missing' {
  if (diagnostics.some((diagnostic) => diagnostic.code === 'cancelled')) return 'cancelled'
  if (diagnostics.some((diagnostic) => diagnostic.code === 'capability-missing')) return itemCount > 0 ? 'partial' : 'capability-missing'
  if (itemCount === 0) return diagnostics.some((diagnostic) => diagnostic.code === 'empty-page') ? 'empty' : 'failed'
  return diagnostics.some((diagnostic) => diagnostic.code !== 'duplicate-item') ? 'partial' : 'success'
}

function sourceHeaders(source: NormalizedSource): Readonly<Record<string, string>> | undefined {
  const header = source.header
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(header)) if (typeof value === 'string') headers[key] = value
  return headers
}
