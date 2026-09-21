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
] as const

export const detailFields = [
  ['name', 'name'],
  ['author', 'author'],
  ['intro', 'intro'],
  ['coverUrl', 'coverUrl'],
  ['tocUrl', 'tocUrl'],
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
  return rules === undefined || typeof rules[field] !== 'string' ? undefined : rules[field] as string
}

export function template(value: string, replacements: Readonly<Record<string, string>>): string {
  return value.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => replacements[key] ?? '')
}

export function encodeKeyword(value: string): string {
  return encodeURIComponent(value)
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

export async function requestPage(ports: WorkflowPorts, source: NormalizedSource, url: string, stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<string | undefined> {
  if (options.signal?.aborted === true) {
    diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
    return undefined
  }
  const headers = sourceHeaders(source)
  const result = createRequestPlan({ url, baseUrl: source.bookSourceUrl, ...(headers === undefined ? {} : { headers }), budget: requestBudget(options) })
  if (result.plan === undefined) {
    diagnostics.push({ code: 'invalid-config', stage, message: result.error?.message ?? '请求计划无效', retryable: false })
    return undefined
  }
  trace.push({ stage, event: 'request', target: stage })
  try {
    const response = await ports.network.request(result.plan)
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return undefined
    }
    return responseText(response, source, ports)
  } catch {
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return undefined
    }
    diagnostics.push({ code: 'request-failed', stage, message: '书源请求失败', retryable: true })
    return undefined
  }
}

export async function evaluateField(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, field: string, rule: string, content: unknown, itemIndex: number | undefined, trace: WorkflowTraceEntry[], signal: AbortSignal | undefined): Promise<{ state: 'value' | 'empty' | 'missing' | 'failed' | 'cancelled' | 'capability-missing'; value?: unknown; message?: string }> {
  trace.push({ stage, event: 'rule', target: field, ...(itemIndex === undefined ? {} : { itemIndex }) })
  let output: WorkflowRuleOutput
  try {
    output = await ports.rules.evaluate({ source, stage, field, rule, content, ...(itemIndex === undefined ? {} : { itemIndex }), ...(signal === undefined ? {} : { signal }) })
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
