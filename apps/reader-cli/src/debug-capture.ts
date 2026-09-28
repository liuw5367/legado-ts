import type {
  NetworkResponse,
  RequestObserver,
  RequestObservationComplete,
  RequestObservationError,
  RequestObservationStart,
  RuntimeResult,
  WorkflowDiagnostic,
  WorkflowStage,
  WorkflowTraceEntry,
} from '@legado/source-core'

export type DebugStage = 'search' | 'book-info' | 'toc' | 'content'
export type CaptureMode = 'light' | 'full'

export interface RequestRecord {
  id: string
  stage: DebugStage
  sourceId: string
  sourceName?: string
  sequence: number
  kind: 'primary' | 'retry' | 'bridge'
  parentRequestId?: string
  attempt: number
  method: string
  url: string
  headers: Readonly<Record<string, string | string[]>>
  requestBody?: string
  startedAt: number
  durationMs: number
  finalUrl?: string
  status?: number
  responseHeaders?: Readonly<Record<string, string | string[]>>
  redirected?: boolean
  responseText?: string
  responseBytes: number
  truncated: boolean
  error?: string
}

export type ProcessKind = 'request' | 'response-decode' | 'rule' | 'field' | 'candidate' | 'pagination' | 'deduplicate' | 'result'
export type ProcessState = 'started' | 'success' | 'empty' | 'failed' | 'skipped' | 'cancelled'

export interface ProcessRecord {
  id: string
  stage: DebugStage
  sequence: number
  kind: ProcessKind
  target: string
  state: ProcessState
  inputSummary?: string
  outputSummary?: string
  durationMs?: number
  requestId?: string
  itemIndex?: number
}

export interface StageEvidence {
  stage: DebugStage
  status: RuntimeResult<unknown>['status'] | 'idle' | 'running'
  startedAt?: number
  durationMs?: number
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
  requestIds: string[]
  processIds: string[]
  summary: { candidates?: number; fields?: string[]; chapters?: number; contentCharacters?: number }
}

export interface DebugSessionSnapshot {
  sourceId: string
  sourceName: string
  mode: CaptureMode
  requests: RequestRecord[]
  processes: ProcessRecord[]
  stages: StageEvidence[]
  truncated: boolean
}

const limits = {
  light: { requests: 32, processes: 500, responseBytes: 128 * 1024, totalBytes: 512 * 1024 },
  full: { requests: 100, processes: 2000, responseBytes: 512 * 1024, totalBytes: 4 * 1024 * 1024 },
} as const

const sensitiveKey = /authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|credential|token|secret|api[-_]?key|signature|sig|(?:^|[-_])auth(?:[-_]|$)/i
const sensitiveQuery = /^(authorization|proxy-authorization|cookie|password|passwd|pwd|credential|token|access[-_]?token|refresh[-_]?token|secret|api[-_]?key|signature|sig|key|auth)$/i

export class DebugCapture implements RequestObserver {
  public readonly sourceId: string
  public readonly sourceName: string
  public readonly mode: CaptureMode
  private readonly requestList: RequestRecord[] = []
  private readonly processList: ProcessRecord[] = []
  private readonly stageList = new Map<DebugStage, StageEvidence>()
  private readonly openRequests = new Map<string, RequestRecord[]>()
  private readonly openProcesses = new Map<string, ProcessRecord[]>()
  private currentStage: DebugStage = 'search'
  private sequence = 0
  private processSequence = 0
  private totalResponseBytes = 0
  private wasTruncated = false

  public constructor(options: { sourceId: string; sourceName: string; mode?: CaptureMode }) {
    this.sourceId = redactUrl(options.sourceId)
    this.sourceName = redactText(options.sourceName, 512)
    this.mode = options.mode ?? 'full'
  }

  public beginStage(stage: DebugStage): void {
    this.currentStage = stage
    const existing = this.stageList.get(stage)
    this.stageList.set(stage, existing ?? { stage, status: 'running', diagnostics: [], trace: [], requestIds: [], processIds: [], summary: {}, startedAt: Date.now() })
    if (existing !== undefined) {
      existing.status = 'running'
      existing.startedAt = Date.now()
    }
  }

  public recordResult<T>(stage: DebugStage, result: RuntimeResult<T>, summary: StageEvidence['summary'] = {}): void {
    const current = this.stageList.get(stage)
    const startedAt = current?.startedAt
    const stageLimit = limits[this.mode].processes
    const rawTrace = result.trace.map(safeTrace)
    const rawDiagnostics = result.diagnostics.map(safeDiagnostic)
    if (rawTrace.length > stageLimit || rawDiagnostics.length > stageLimit) this.wasTruncated = true
    const newTrace = rawTrace.slice(0, stageLimit)
    const trace = [...(current?.trace ?? []), ...newTrace]
    if (trace.length > stageLimit) this.wasTruncated = true
    const keptTrace = trace.slice(-stageLimit)
    const processIds: string[] = []
    for (const entry of newTrace) {
      const process = this.addProcess({
        stage,
        kind: traceKind(entry),
        target: entry.target,
        state: 'success',
        ...(entry.itemIndex === undefined ? {} : { itemIndex: entry.itemIndex }),
        outputSummary: entry.event === 'candidate' ? '候选项已生成' : entry.event === 'field' ? '字段已提取' : entry.event === 'rule' ? '规则已执行' : '请求已记录',
      })
      processIds.push(process.id)
    }
    for (const diagnostic of rawDiagnostics.slice(0, stageLimit)) {
      const process = this.addProcess({ stage, kind: diagnosticKind(diagnostic), target: diagnostic.field ?? diagnostic.code, state: diagnosticState(diagnostic.code), outputSummary: diagnostic.message, ...(diagnostic.itemIndex === undefined ? {} : { itemIndex: diagnostic.itemIndex }) })
      processIds.push(process.id)
    }
    const requestIds = current?.requestIds ?? this.requestList.filter((item) => item.stage === stage).map((item) => item.id)
    const next: StageEvidence = {
      stage,
      status: this.sourceId === 'multi' ? mergeStatus(current?.status, result.status) : result.status,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
      diagnostics: [...(current?.diagnostics ?? []), ...rawDiagnostics],
      trace: keptTrace,
      requestIds,
      processIds: [...(current?.processIds ?? []), ...processIds],
      summary: mergeSummary(current?.summary, summary),
    }
    const resultProcess = this.addProcess({ stage, kind: 'result', target: stage, state: result.status === 'cancelled' ? 'cancelled' : result.status === 'empty' ? 'empty' : result.status === 'failed' || result.status === 'capability-missing' ? 'failed' : 'success', outputSummary: resultSummary(result, summary) })
    const allProcessIds = [...next.processIds, resultProcess.id]
    if (allProcessIds.length > stageLimit) this.wasTruncated = true
    this.stageList.set(stage, { ...next, diagnostics: [...next.diagnostics].slice(-stageLimit), processIds: allProcessIds.slice(-stageLimit) })
  }

  public onStart(event: RequestObservationStart): void {
    const stage = this.mapStage(event.stage)
    const record: RequestRecord = {
      id: `request-${this.sequence + 1}`,
      stage,
      sourceId: redactUrl(event.source.bookSourceUrl),
      sourceName: redactText(event.source.bookSourceName, 512),
      sequence: ++this.sequence,
      kind: event.kind === 'bridge' ? 'bridge' : event.attempt === 0 ? 'primary' : 'retry',
      attempt: event.attempt,
      method: event.plan.method,
      url: redactUrl(event.plan.url),
      headers: redactHeaders(event.plan.headers),
      ...(event.plan.body === undefined ? {} : { requestBody: redactText(bodyText(event.plan.body), 4096) }),
      startedAt: event.startedAt,
      durationMs: 0,
      responseBytes: 0,
      truncated: false,
    }
    if (this.requestList.length >= limits[this.mode].requests) {
      this.wasTruncated = true
      return
    }
    this.requestList.push(record)
    const key = observationKey(event)
    this.openRequests.set(key, [...(this.openRequests.get(key) ?? []), record])
    this.ensureStage(stage).requestIds.push(record.id)
    const process = this.addProcess({ stage, kind: 'request', target: `${event.plan.method} ${redactUrl(event.plan.url)}`, state: 'started', requestId: record.id, inputSummary: `attempt=${event.attempt}` })
    this.openProcesses.set(key, [...(this.openProcesses.get(key) ?? []), process])
  }

  public onComplete(event: RequestObservationComplete): void {
    const key = observationKey(event)
    const records = this.openRequests.get(key)
    const record = records?.shift()
    if (records !== undefined && records.length === 0) this.openRequests.delete(key)
    if (record !== undefined) {
      record.durationMs = event.durationMs
      record.finalUrl = redactUrl(event.response.url)
      record.status = event.response.status
      record.responseHeaders = redactHeaders(event.response.headers)
      record.redirected = event.response.redirected
      record.responseBytes = event.response.bytes.byteLength
      const preview = responsePreview(event.response, limits[this.mode].responseBytes, limits[this.mode].totalBytes - this.totalResponseBytes)
      record.responseText = preview.text
      record.truncated = preview.truncated
      this.totalResponseBytes += preview.bytesKept
      if (preview.truncated) this.wasTruncated = true
    }
    const processes = this.openProcesses.get(key)
    const process = processes?.shift()
    if (processes !== undefined && processes.length === 0) this.openProcesses.delete(key)
    if (process !== undefined) {
      process.state = event.response.status >= 400 ? 'failed' : 'success'
      process.durationMs = event.durationMs
      process.outputSummary = `HTTP ${event.response.status} · ${event.response.bytes.byteLength} bytes`
    }
    const stage = this.mapStage(event.stage)
    this.addProcess({ stage, kind: 'response-decode', target: `response:${record?.id ?? event.id}`, state: event.response.status >= 400 ? 'failed' : 'success', ...(record === undefined ? {} : { requestId: record.id }), durationMs: event.durationMs, outputSummary: `HTTP ${event.response.status} · ${event.response.bytes.byteLength} bytes` })
  }

  public onError(event: RequestObservationError): void {
    const key = observationKey(event)
    const records = this.openRequests.get(key)
    const record = records?.shift()
    if (records !== undefined && records.length === 0) this.openRequests.delete(key)
    if (record !== undefined) {
      record.durationMs = event.durationMs
      record.error = redactText(errorText(event.error), 4096)
    }
    const processes = this.openProcesses.get(key)
    const process = processes?.shift()
    if (processes !== undefined && processes.length === 0) this.openProcesses.delete(key)
    if (process !== undefined) {
      process.state = 'failed'
      process.durationMs = event.durationMs
      process.outputSummary = redactText(errorText(event.error), 4096)
    }
  }

  public snapshot(): DebugSessionSnapshot {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      mode: this.mode,
      requests: this.requestList.map((item) => ({ ...item, headers: { ...item.headers }, ...(item.responseHeaders === undefined ? {} : { responseHeaders: { ...item.responseHeaders } }) })),
      processes: this.processList.map((item) => ({ ...item })),
      stages: [...this.stageList.values()].map((item) => ({ ...item, diagnostics: item.diagnostics.map(safeDiagnostic), trace: item.trace.map(safeTrace), requestIds: [...item.requestIds], processIds: [...item.processIds], summary: safeSummary(item.summary) })),
      truncated: this.wasTruncated,
    }
  }

  public get requests(): readonly RequestRecord[] { return this.requestList }
  public get processes(): readonly ProcessRecord[] { return this.processList }
  public get stages(): readonly StageEvidence[] { return [...this.stageList.values()] }
  public get truncated(): boolean { return this.wasTruncated }

  public stageRequests(stage?: DebugStage): RequestRecord[] {
    return this.requestList.filter((item) => stage === undefined || item.stage === stage)
  }

  private addProcess(input: Omit<ProcessRecord, 'id' | 'sequence'>): ProcessRecord {
    const record: ProcessRecord = {
      ...input,
      id: `process-${++this.processSequence}`,
      sequence: this.processSequence,
      target: redactText(input.target, 1024),
      ...(input.inputSummary === undefined ? {} : { inputSummary: redactText(input.inputSummary, 2048) }),
      ...(input.outputSummary === undefined ? {} : { outputSummary: redactText(input.outputSummary, 4096) }),
    }
    if (this.processList.length >= limits[this.mode].processes) {
      this.wasTruncated = true
      return record
    }
    this.processList.push(record)
    return record
  }

  private ensureStage(stage: DebugStage): StageEvidence {
    const existing = this.stageList.get(stage)
    if (existing !== undefined) return existing
    const created: StageEvidence = { stage, status: 'running', diagnostics: [], trace: [], requestIds: [], processIds: [], summary: {}, startedAt: Date.now() }
    this.stageList.set(stage, created)
    return created
  }

  private mapStage(stage: WorkflowStage): DebugStage {
    if (stage === 'discover' || stage === 'search') return this.currentStage === 'book-info' || this.currentStage === 'toc' || this.currentStage === 'content' ? this.currentStage : 'search'
    return this.currentStage === 'book-info' ? 'book-info' : this.currentStage
  }
}

function traceKind(entry: WorkflowTraceEntry): ProcessKind {
  if (entry.event === 'request') return 'request'
  if (entry.event === 'candidate') return 'candidate'
  return entry.event
}

function diagnosticKind(diagnostic: WorkflowDiagnostic): ProcessKind {
  if (diagnostic.code === 'empty-page' || diagnostic.code === 'duplicate-item') return 'deduplicate'
  return diagnostic.field === undefined ? 'result' : 'field'
}

function diagnosticState(code: WorkflowDiagnostic['code']): ProcessState {
  if (code === 'cancelled') return 'cancelled'
  if (code === 'empty-page' || code === 'item-skipped') return 'empty'
  return 'failed'
}

function resultSummary<T>(result: RuntimeResult<T>, summary: StageEvidence['summary']): string {
  const parts = [`status=${result.status}`]
  for (const [key, value] of Object.entries(summary)) if (value !== undefined) parts.push(`${key}=${Array.isArray(value) ? value.join(',') : value}`)
  return parts.join(' · ')
}

function mergeStatus(previous: StageEvidence['status'] | undefined, next: RuntimeResult<unknown>['status']): StageEvidence['status'] {
  if (previous === undefined || previous === 'idle' || previous === 'running') return next
  if (previous === next) return next
  if ((previous === 'success' || previous === 'partial') && (next === 'success' || next === 'partial')) return 'success'
  if (previous === 'empty' && next === 'empty') return 'empty'
  if (previous === 'cancelled' && next === 'cancelled') return 'cancelled'
  return 'partial'
}

function mergeSummary(previous: StageEvidence['summary'] | undefined, next: StageEvidence['summary']): StageEvidence['summary'] {
  const result: StageEvidence['summary'] = { ...(previous ?? {}) }
  for (const key of ['candidates', 'chapters', 'contentCharacters'] as const) {
    const value = next[key]
    if (value !== undefined) result[key] = (result[key] ?? 0) + value
  }
  if (next.fields !== undefined) result.fields = [...new Set([...(result.fields ?? []), ...next.fields.map((field) => redactText(field, 256))])]
  return safeSummary(result)
}

function safeSummary(summary: StageEvidence['summary']): StageEvidence['summary'] {
  return {
    ...(summary.candidates === undefined ? {} : { candidates: summary.candidates }),
    ...(summary.chapters === undefined ? {} : { chapters: summary.chapters }),
    ...(summary.contentCharacters === undefined ? {} : { contentCharacters: summary.contentCharacters }),
    ...(summary.fields === undefined ? {} : { fields: summary.fields.map((field) => redactText(field, 256)) }),
  }
}

function safeDiagnostic(diagnostic: WorkflowDiagnostic): WorkflowDiagnostic {
  return {
    ...diagnostic,
    message: redactText(diagnostic.message, 4096),
    ...(diagnostic.field === undefined ? {} : { field: redactText(diagnostic.field, 512) }),
  }
}

function safeTrace(entry: WorkflowTraceEntry): WorkflowTraceEntry {
  return { ...entry, target: redactText(entry.target, 1024) }
}

function bodyText(value: string | Uint8Array): string {
  if (typeof value === 'string') return value
  const bytes = value.subarray(0, 4096)
  return printable(bytes) ? new TextDecoder().decode(bytes) : `0x${[...bytes.subarray(0, 256)].map((item) => item.toString(16).padStart(2, '0')).join('')}`
}

function responsePreview(response: NetworkResponse, maxBytes: number, remainingBytes: number): { text: string; bytesKept: number; truncated: boolean } {
  const limit = Math.max(0, Math.min(maxBytes, remainingBytes))
  const bytes = response.bytes.subarray(0, limit)
  const text = printable(bytes) ? new TextDecoder().decode(bytes) : `0x${[...bytes.subarray(0, 256)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
  const truncated = bytes.byteLength < response.bytes.byteLength
  return { text: redactText(text, maxBytes), bytesKept: bytes.byteLength, truncated }
}

function printable(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  let control = 0
  for (const value of bytes) if (value === 0 || value < 9 || value > 13 && value < 32) control += 1
  return control / bytes.length < 0.02
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username.length > 0) url.username = '[已隐藏]'
    if (url.password.length > 0) url.password = '[已隐藏]'
    for (const key of [...url.searchParams.keys()]) if (sensitiveQuery.test(key)) url.searchParams.set(key, '[已隐藏]')
    return url.toString()
  } catch {
    return redactText(value, 1024)
  }
}

export function redactHeaders(headers: Readonly<Record<string, string | readonly string[]>>): Readonly<Record<string, string | string[]>> {
  const entries = Object.entries(headers)
  return Object.fromEntries(entries.slice(0, 64).map(([key, value]) => [key, sensitiveKey.test(key) ? '[已隐藏]' : Array.isArray(value) ? value.slice(0, 16).map((item) => redactText(String(item), 1024)) : redactText(String(value), 1024)]))
}

export function redactText(value: string, maxLength = 8192): string {
  const clipped = value.length > maxLength ? `${value.slice(0, maxLength)}…[已截断]` : value
  return clipped
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|credential|token|access[-_]?token|refresh[-_]?token|secret|api[-_]?key|signature|sig|auth)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/[^\s"']*[?&](?:token|key|signature|sig|password)=[^&\s"']+)/gi, (match) => redactUrl(match))
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function observationKey(event: Pick<RequestObservationStart, 'source' | 'id'>): string {
  return `${event.source.bookSourceUrl}\u0000${event.id}`
}
