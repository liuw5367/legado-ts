import { executeWorkflowJavaScript, expandUrl, textValue } from './helpers.ts'
import type { BookMetadata, ChapterIdentity, RuntimeResult, WorkflowAction, WorkflowDiagnostic, WorkflowPorts, WorkflowTraceEntry } from './types.ts'

export type SourceCallbackEvent =
  | 'clickAuthor' | 'longClickAuthor' | 'clickBookName' | 'longClickBookName'
  | 'clickCustomButton' | 'longClickCustomButton' | 'clickShareBook' | 'clickClearCache'
  | 'clickCopyBookUrl' | 'clickCopyTocUrl' | 'clickCopyPlayUrl' | 'clickBookLabel' | 'longClickBookLabel'
  | 'addBookShelf' | 'delBookShelf' | 'saveRead' | 'startRead' | 'endRead'
  | 'startShelfRefresh' | 'endShelfRefresh' | string

export interface SourcePayActionInput {
  source: import('../model/types.ts').NormalizedSource
  book: BookMetadata
  chapter: ChapterIdentity & { title?: string; variable?: string; rawFields?: Record<string, unknown> }
  payAction?: string
  workflowActions?: Readonly<Record<string, WorkflowAction>>
  signal?: AbortSignal
}

export interface SourcePayActionResult {
  kind: 'url' | 'success' | 'empty'
  value?: string
}

export async function executePayAction(ports: WorkflowPorts, input: SourcePayActionInput): Promise<RuntimeResult<SourcePayActionResult>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const configured = input.payAction ?? readRuleString(input.source.ruleContent, 'payAction')
  if (configured === undefined || configured.trim().length === 0) return { status: 'empty', value: { kind: 'empty' }, diagnostics, trace }
  if (configured.includes('{{') && configured.includes('}}')) {
    const expanded = await expandUrl(ports, input.source, 'detail', configured, {}, { book: input.book, chapter: input.chapter }, input.signal)
    if (expanded.error !== undefined) return actionFailure(expanded.error.code === 'cancelled' ? 'cancelled' : expanded.error.code === 'capability-missing' ? 'capability-missing' : 'failed', expanded.error.message, diagnostics, trace)
    const expandedValue = expanded.url?.trim() ?? ''
    if (expandedValue.length > 0 && /^(?:https?:|file:|about:|data:)/iu.test(expandedValue)) return { status: 'success', value: { kind: 'url', value: expandedValue }, diagnostics, trace }
  }
  const output = await executeWorkflowJavaScript(ports, input.source, configured, 'detail', 'content', trace, {
    bindings: { book: input.book, chapter: input.chapter, title: input.chapter.title ?? '', baseUrl: input.chapter.url ?? input.chapter.chapterUrl, result: null, src: null },
    baseUrl: input.chapter.url ?? input.chapter.chapterUrl,
    javascriptBudget: { timeoutMs: 60_000 },
    ...(input.workflowActions === undefined ? {} : { workflowActions: input.workflowActions }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (output.state === 'cancelled') return actionFailure('cancelled', output.message ?? '购买操作已取消', diagnostics, trace)
  if (output.state === 'capability-missing') return actionFailure('capability-missing', output.message ?? '购买操作需要 JavaScript 宿主', diagnostics, trace)
  if (output.state === 'failed') return actionFailure('failed', output.message ?? '购买操作执行失败', diagnostics, trace)
  const value = textValue(output.value).trim()
  if (value.length === 0) return { status: 'empty', value: { kind: 'empty' }, diagnostics, trace }
  if (/^(?:https?:|file:|about:|data:)/iu.test(value)) return { status: 'success', value: { kind: 'url', value }, diagnostics, trace }
  if (/^(?:true|1|yes|ok|success)$/iu.test(value)) return { status: 'success', value: { kind: 'success', value }, diagnostics, trace }
  return { status: 'success', value: { kind: 'empty', value }, diagnostics, trace }
}

export interface SourceCallbackInput {
  source: import('../model/types.ts').NormalizedSource
  event: SourceCallbackEvent
  result?: unknown
  book?: BookMetadata
  chapter?: ChapterIdentity & { title?: string; variable?: string; rawFields?: Record<string, unknown> }
  /** Android uses 60 seconds for book events and 30 seconds for source events. */
  timeoutMs?: number
  workflowActions?: Readonly<Record<string, WorkflowAction>>
  signal?: AbortSignal
}

export interface SourceCallbackResult {
  handled: boolean
  value?: unknown
}

export async function executeSourceCallback(ports: WorkflowPorts, input: SourceCallbackInput): Promise<RuntimeResult<SourceCallbackResult>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const configured = readRuleString(input.source.ruleContent, 'callBackJs')
  if (input.source.eventListener !== true || configured === undefined || configured.trim().length === 0) return { status: 'empty', value: { handled: false }, diagnostics, trace }
  const timeoutMs = input.timeoutMs ?? (input.book === undefined ? 30_000 : 60_000)
  const output = await executeWorkflowJavaScript(ports, input.source, configured, 'detail', 'content', trace, {
    bindings: { event: input.event, result: input.result ?? null, book: input.book ?? null, chapter: input.chapter ?? null },
    javascriptBudget: { timeoutMs: Math.max(1, Math.min(60_000, timeoutMs)) },
    ...(input.workflowActions === undefined ? {} : { workflowActions: input.workflowActions }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (output.state === 'cancelled') return actionFailure('cancelled', output.message ?? '书源回调已取消', diagnostics, trace)
  if (output.state === 'capability-missing') return actionFailure('capability-missing', output.message ?? '书源回调需要 JavaScript 宿主', diagnostics, trace)
  if (output.state === 'failed') return actionFailure('failed', output.message ?? `书源回调 ${input.event} 执行失败`, diagnostics, trace)
  return { status: 'success', value: { handled: true, ...(output.value === undefined ? {} : { value: output.value }) }, diagnostics, trace }
}

function readRuleString(value: unknown, key: string): string | undefined {
  const rules = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : typeof value === 'string' ? parseObject(value) : undefined
  const result = rules?.[key]
  return typeof result === 'string' && result.length > 0 ? result : undefined
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined } catch { return undefined }
}

function actionFailure<T>(status: 'failed' | 'cancelled' | 'capability-missing', message: string, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): RuntimeResult<T> {
  diagnostics.push({ code: status === 'cancelled' ? 'cancelled' : status === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage: 'detail', message, retryable: false })
  return { status, value: null, diagnostics, trace }
}
