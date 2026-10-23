import type { NetworkResponse } from '../runtime/contracts.ts'
import type { RuntimeObservation, RuntimeObservationCollector, RuntimeObservationHandle, RequestObserver, WorkflowPorts, WorkflowStage, WorkflowStatus, RuntimeResult } from './types.ts'

interface ObservationState {
  handle: RuntimeObservationHandle
  sourceId: string
  stage: WorkflowStage
  target: string
  itemIndex?: number
  startedAt: number
  requestId?: string
  requested: boolean
  responded: boolean
  terminal: boolean
}

interface ObservationInput {
  sourceId: string
  stage: WorkflowStage
  target: string
  itemIndex?: number
}

function targetSummary(value: string): string {
  try {
    const url = new URL(value)
    const params = new URLSearchParams()
    for (const [key, item] of url.searchParams.entries()) {
      if (/auth|cookie|key|pass(?:word)?|secret|token|user/iu.test(key)) params.set(key, '[redacted]')
      else params.append(key, item)
    }
    const query = params.toString()
    return `${url.protocol}//${url.host}${url.pathname}${query.length === 0 ? '' : `?${query}`}`.slice(0, 512)
  } catch {
    return value.replaceAll(/(?:authorization|cookie|password|secret|token)\s*[=:]\s*[^&\s]+/giu, '$1=[redacted]').slice(0, 512)
  }
}

function optional<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}

/**
 * Network hosts and bridge adapters cannot share one concrete Error class, so
 * request callbacks need a small, stable error classifier.  Explicit
 * `__LEGADO_CAPABILITY__` markers are treated as capability failures; an
 * arbitrary script TypeError remains a normal request failure.
 */
export function classifyRequestError(error: unknown): 'capability-missing' | 'cancelled' | string {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined
  const explicit = typeof record?.code === 'string'
    ? record.code
    : typeof record?.status === 'string'
      ? record.status
      : undefined
  if (explicit === 'capability-missing' || explicit === 'cancelled') return explicit
  if (explicit !== undefined && /^(?:invalid-config|rule-failed|request-failed|cache-failed)$/u.test(explicit)) return explicit
  const message = error instanceof Error ? error.message : String(error)
  if (/__LEGADO_CAPABILITY__|webview\s*(?:required|unavailable)|需要\s*WebView|宿主能力不可用/iu.test(message)) return 'capability-missing'
  if (error instanceof DOMException && error.name === 'AbortError' || record?.name === 'AbortError' || /(?:^|\b)(?:abort|cancel)(?:ed|led)?\b/iu.test(message)) return 'cancelled'
  return 'request-failed'
}

function requestErrorRetryable(code: string): boolean {
  return code === 'request-failed'
}

class DefaultRuntimeObservationCollector implements RuntimeObservationCollector {
  private nextId = 1
  private readonly entries: RuntimeObservation[] = []
  private readonly states = new Map<string, ObservationState>()
  private readonly skipped = new Set<string>()
  private readonly requestHandles = new Map<string, RuntimeObservationHandle>()

  public begin(input: ObservationInput): RuntimeObservationHandle {
    const handle = { id: `observation-${this.nextId++}` }
    const startedAt = Date.now()
    const state: ObservationState = {
      handle,
      sourceId: input.sourceId,
      stage: input.stage,
      target: targetSummary(input.target),
      ...(input.itemIndex === undefined ? {} : { itemIndex: input.itemIndex }),
      startedAt,
      requested: false,
      responded: false,
      terminal: false,
    }
    this.states.set(handle.id, state)
    this.entries.push(optional({
      id: handle.id,
      sourceId: state.sourceId,
      stage: state.stage,
      phase: 'planned' as const,
      target: state.target,
      startedAt,
      ...(state.itemIndex === undefined ? {} : { itemIndex: state.itemIndex }),
    }))
    return handle
  }

  public markRequested(handle: RuntimeObservationHandle, input: { requestId?: string; attempt?: number; startedAt?: number }): void {
    const state = this.states.get(handle.id)
    if (state === undefined || state.terminal) return
    state.requested = true
    if (input.requestId !== undefined) state.requestId = input.requestId
    const startedAt = input.startedAt ?? state.startedAt
    this.entries.push(optional({
      id: state.handle.id,
      ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
      sourceId: state.sourceId,
      stage: state.stage,
      phase: 'requested' as const,
      target: state.target,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      startedAt,
      ...(state.itemIndex === undefined ? {} : { itemIndex: state.itemIndex }),
    }))
  }

  public markResponse(handle: RuntimeObservationHandle, response: NetworkResponse, durationMs?: number): void {
    const state = this.states.get(handle.id)
    if (state === undefined || state.terminal) return
    state.responded = true
    this.entries.push(optional({
      id: state.handle.id,
      ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
      sourceId: state.sourceId,
      stage: state.stage,
      phase: 'response-received' as const,
      target: state.target,
      startedAt: state.startedAt,
      ...(durationMs === undefined ? { durationMs: Math.max(0, Date.now() - state.startedAt) } : { durationMs }),
      statusCode: response.status,
      responseBytes: response.bytes.byteLength,
      ...(state.itemIndex === undefined ? {} : { itemIndex: state.itemIndex }),
    }))
  }

  public markError(handle: RuntimeObservationHandle, input: { code: string; retryable: boolean; durationMs?: number }): void {
    const state = this.states.get(handle.id)
    if (state === undefined || state.terminal) return
    state.terminal = true
    const phase = input.code === 'capability-missing' ? 'capability-missing' : input.code === 'cancelled' ? 'cancelled' : 'failed'
    this.entries.push(optional({
      id: state.handle.id,
      ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
      sourceId: state.sourceId,
      stage: state.stage,
      phase: phase as RuntimeObservation['phase'],
      target: state.target,
      startedAt: state.startedAt,
      ...(input.durationMs === undefined ? { durationMs: Math.max(0, Date.now() - state.startedAt) } : { durationMs: input.durationMs }),
      errorCode: input.code,
      retryable: input.retryable,
      ...(state.itemIndex === undefined ? {} : { itemIndex: state.itemIndex }),
    }))
  }

  public markCancelled(handle: RuntimeObservationHandle, durationMs?: number): void {
    this.markError(handle, { code: 'cancelled', retryable: false, ...(durationMs === undefined ? {} : { durationMs }) })
  }

  public recordNotStarted(input: { sourceId: string; stage: WorkflowStage; target: string; itemIndex?: number; errorCode?: string }): void {
    const id = `observation-${this.nextId++}`
    this.entries.push(optional({
      id,
      sourceId: input.sourceId,
      stage: input.stage,
      phase: 'not-started' as const,
      target: targetSummary(input.target),
      startedAt: Date.now(),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode, retryable: false }),
      ...(input.itemIndex === undefined ? {} : { itemIndex: input.itemIndex }),
    }))
  }

  public recordSkipped(input: { sourceId: string; stage: WorkflowStage; target: string; itemIndex?: number }): void {
    const key = `${input.sourceId}\u0000${input.stage}\u0000${input.target}\u0000${input.itemIndex ?? ''}`
    if (this.skipped.has(key)) return
    this.skipped.add(key)
    const id = `observation-${this.nextId++}`
    this.entries.push(optional({
      id,
      sourceId: input.sourceId,
      stage: input.stage,
      phase: 'skipped' as const,
      target: targetSummary(input.target),
      startedAt: Date.now(),
      ...(input.itemIndex === undefined ? {} : { itemIndex: input.itemIndex }),
    }))
  }

  public finalize(status: WorkflowStatus, itemCount: number): void {
    for (const state of this.states.values()) {
      if (state.terminal) continue
      state.terminal = true
      let phase: RuntimeObservation['phase']
      if (status === 'cancelled') phase = 'cancelled'
      else if (status === 'capability-missing') phase = 'capability-missing'
      else if (!state.requested) phase = 'skipped'
      else if (status === 'failed') phase = 'failed'
      else if (status === 'empty' || itemCount === 0) phase = 'parsed-empty'
      else phase = 'success'
      this.entries.push(optional({
        id: state.handle.id,
        ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
        sourceId: state.sourceId,
        stage: state.stage,
        phase,
        target: state.target,
        startedAt: state.startedAt,
        durationMs: Math.max(0, Date.now() - state.startedAt),
        ...(phase === 'failed' || phase === 'capability-missing' || phase === 'cancelled' ? { errorCode: phase, retryable: false } : {}),
        ...(state.itemIndex === undefined ? {} : { itemIndex: state.itemIndex }),
      }))
    }
    this.requestHandles.clear()
  }

  public observerFor(handle: RuntimeObservationHandle, upstream?: RequestObserver): RequestObserver {
    return {
      onStart: (event) => {
        this.markRequested(handle, { requestId: event.id, attempt: event.attempt, startedAt: event.startedAt })
        try { upstream?.onStart?.(event) } catch { /* 外部观察器不能改变请求结果。 */ }
      },
      onComplete: (event) => {
        this.markResponse(handle, event.response, event.durationMs)
        try { upstream?.onComplete?.(event) } catch { /* 外部观察器不能改变请求结果。 */ }
      },
      onError: (event) => {
        const code = classifyRequestError(event.error)
        this.markError(handle, { code, retryable: requestErrorRetryable(code), durationMs: event.durationMs })
        try { upstream?.onError?.(event) } catch { /* 外部观察器不能改变请求结果。 */ }
      },
    }
  }

  public observerForRequest(input: { sourceId: string; stage: WorkflowStage; target?: string }, upstream?: RequestObserver): RequestObserver {
    return {
      onStart: (event) => {
        const handle = this.begin({ sourceId: input.sourceId, stage: input.stage, target: event.plan.url || input.target || `${input.stage}:request` })
        this.requestHandles.set(event.id, handle)
        this.markRequested(handle, { requestId: event.id, attempt: event.attempt, startedAt: event.startedAt })
        try { upstream?.onStart?.(event) } catch { /* 外部观察器不能改变请求结果。 */ }
      },
      onComplete: (event) => {
        const handle = this.requestHandles.get(event.id)
        if (handle !== undefined) {
          this.markResponse(handle, event.response, event.durationMs)
          this.requestHandles.delete(event.id)
        }
        try { upstream?.onComplete?.(event) } catch { /* 外部观察器不能改变请求结果。 */ }
      },
      onError: (event) => {
        const handle = this.requestHandles.get(event.id)
        if (handle !== undefined) {
          const code = classifyRequestError(event.error)
          this.markError(handle, { code, retryable: requestErrorRetryable(code), durationMs: event.durationMs })
          this.requestHandles.delete(event.id)
        }
        try { upstream?.onError?.(event) } catch { /* 外部观察器不能改变请求结果。 */ }
      },
    }
  }

  public snapshot(): readonly RuntimeObservation[] {
    return this.entries.map((entry) => ({ ...entry }))
  }
}

export function createRuntimeObservationCollector(): RuntimeObservationCollector {
  return new DefaultRuntimeObservationCollector()
}

export function observationScope(ports: WorkflowPorts): { ports: WorkflowPorts; collector: RuntimeObservationCollector } {
  const collector = ports.runtimeObservationCollector ?? createRuntimeObservationCollector()
  if (ports.runtimeObservationCollector === collector) return { ports, collector }
  return { ports: { ...ports, runtimeObservationCollector: collector }, collector }
}

export function attachRuntimeObservations<T>(result: RuntimeResult<T>, collector: RuntimeObservationCollector, sourceId: string): RuntimeResult<T> {
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.code === 'item-skipped') collector.recordSkipped({ sourceId, stage: diagnostic.stage, target: diagnostic.field ?? 'item', ...(diagnostic.itemIndex === undefined ? {} : { itemIndex: diagnostic.itemIndex }) })
    else if (diagnostic.code === 'invalid-config' || diagnostic.code === 'invalid-input') collector.recordNotStarted({ sourceId, stage: diagnostic.stage, target: diagnostic.field ?? diagnostic.stage, ...(diagnostic.itemIndex === undefined ? {} : { itemIndex: diagnostic.itemIndex }), errorCode: diagnostic.code })
  }
  const value = result.value as { items?: unknown[] } | null
  collector.finalize(result.status, Array.isArray(value?.items) ? value.items.length : 0)
  return { ...result, observations: collector.snapshot() }
}
