import type { ClockHost, NetworkHost } from './contracts.ts'
import type { RequestPlan } from './contracts.ts'

interface RateWindow {
  accessLimit: number
  intervalMs: number
}

export interface SourceRateDiagnostic {
  code: 'invalid-config'
  field: 'concurrentRate'
  message: string
}

interface InitialRate {
  rate?: RateWindow
  diagnostic?: SourceRateDiagnostic
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Default wall clock; hosts may inject a deterministic clock for tests or platform timing. */
export const systemClockHost: ClockHost = {
  now: () => Date.now(),
  wait(milliseconds, signal) {
    if (signal?.aborted === true) return Promise.reject(abortError())
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => finish(), Math.max(0, milliseconds))
      const onAbort = (): void => finish(abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
    })
  },
}

function integer(value: string): number | undefined {
  if (!/^[+-]?\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function invalidInitialRate(value: string): InitialRate {
  return {
    rate: { accessLimit: 1, intervalMs: 0 },
    diagnostic: { code: 'invalid-config', field: 'concurrentRate', message: `concurrentRate 配置无效：${value}；已按首次请求放行的兼容回退处理` },
  }
}

function initialRate(value: unknown): InitialRate {
  if (typeof value !== 'string' || value.length === 0 || value === '0') return {}
  const slash = value.indexOf('/')
  if (slash > 0) {
    const accessLimit = integer(value.slice(0, slash))
    const intervalMs = integer(value.slice(slash + 1))
    if (accessLimit !== undefined && intervalMs !== undefined && accessLimit > 0 && intervalMs > 0) return { rate: { accessLimit, intervalMs } }
    return invalidInitialRate(value)
  }
  const intervalMs = integer(value)
  return intervalMs !== undefined && intervalMs > 0 ? { rate: { accessLimit: 1, intervalMs } } : invalidInitialRate(value)
}

function updatedRate(value: string): RateWindow | undefined {
  const slash = value.indexOf('/')
  if (slash > 0) {
    const accessLimit = integer(value.slice(0, slash))
    const intervalMs = integer(value.slice(slash + 1))
    if (accessLimit === undefined || intervalMs === undefined || accessLimit <= 0 || intervalMs <= 0) return undefined
    return { accessLimit, intervalMs }
  }
  const intervalMs = integer(value)
  return intervalMs !== undefined && intervalMs > 0 ? { accessLimit: 1, intervalMs } : undefined
}

/** Android ConcurrentRateLimiter's per-source fixed window, shared by all requests in a session. */
export class SourceRateLimiter {
  private rate: RateWindow | undefined
  private windowStartedAt = 0
  private accesses = 0
  private initialized = false
  private closed = false
  private readonly pendingWaits = new Set<AbortController>()
  private readonly clock: ClockHost
  private readonly diagnostic: SourceRateDiagnostic | undefined

  public constructor(concurrentRate: unknown, clock: ClockHost = systemClockHost) {
    this.clock = clock
    const initial = initialRate(concurrentRate)
    this.rate = initial.rate
    this.diagnostic = initial.diagnostic
  }

  public get initialDiagnostic(): SourceRateDiagnostic | undefined {
    return this.diagnostic
  }

  /** 释放等待中的窗口定时，并阻止已关闭 session 再发起请求。 */
  public close(): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.pendingWaits) controller.abort()
    this.pendingWaits.clear()
    this.rate = undefined
    this.windowStartedAt = 0
    this.accesses = 0
    this.initialized = false
  }

  /** Mirrors BaseSource.putConcurrent: valid changes retain the existing window and access count. */
  public update(concurrentRate: string): void {
    const next = updatedRate(concurrentRate)
    if (next === undefined) return
    if (!this.initialized) {
      this.windowStartedAt = this.clock.now()
      this.accesses = 0
      this.initialized = true
    }
    this.rate = next
  }

  public async acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted === true) throw abortError()
    while (this.rate !== undefined) {
      if (this.closed || isAborted(signal)) throw abortError()
      const now = this.clock.now()
      if (!this.initialized) {
        this.windowStartedAt = now
        this.accesses = 1
        this.initialized = true
        return
      }
      const nextWindowAt = this.windowStartedAt + this.rate.intervalMs
      if (now >= nextWindowAt) {
        this.windowStartedAt = now
        this.accesses = 1
        return
      }
      if (this.accesses < this.rate.accessLimit) {
        this.accesses += 1
        return
      }
      await this.wait(nextWindowAt - now, signal)
      if (this.closed || isAborted(signal)) throw abortError()
    }
  }

  private async wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (this.closed || signal?.aborted === true) throw abortError()
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    this.pendingWaits.add(controller)
    signal?.addEventListener('abort', relay, { once: true })
    if (isAborted(signal)) relay()
    try {
      await this.clock.wait(milliseconds, controller.signal)
    } finally {
      this.pendingWaits.delete(controller)
      signal?.removeEventListener('abort', relay)
    }
  }
}

/** Apply source pacing at the platform network primitive so bridge and ordinary requests share it. */
export function withSourceRateLimit(network: NetworkHost, limiter: SourceRateLimiter): NetworkHost {
  return {
    request: async (plan: RequestPlan) => {
      if (plan.execution.skipRateLimit !== true) {
        await limiter.acquire(plan.budget.signal)
        if (plan.budget.signal?.aborted === true) throw abortError()
      } else if (plan.budget.signal?.aborted === true) {
        throw abortError()
      }
      return network.request(plan)
    },
    ...(network.defaultUserAgent === undefined ? {} : { defaultUserAgent: network.defaultUserAgent }),
    ...(network.encodeCharset === undefined ? {} : { encodeCharset: network.encodeCharset.bind(network) }),
  }
}
