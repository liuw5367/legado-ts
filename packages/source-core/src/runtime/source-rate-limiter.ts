import type { ClockHost, NetworkHost } from './contracts.ts'
import type { RequestPlan } from './contracts.ts'

interface RateWindow {
  accessLimit: number
  intervalMs: number
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

function initialRate(value: unknown): RateWindow | undefined {
  if (typeof value !== 'string' || value.length === 0 || value === '0') return undefined
  const slash = value.indexOf('/')
  if (slash > 0) {
    const accessLimit = integer(value.slice(0, slash)) ?? 1
    const intervalMs = integer(value.slice(slash + 1)) ?? 0
    return intervalMs > 0 ? { accessLimit: Math.max(1, accessLimit), intervalMs } : undefined
  }
  const intervalMs = integer(value)
  return intervalMs !== undefined && intervalMs > 0 ? { accessLimit: 1, intervalMs } : undefined
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
  private readonly clock: ClockHost

  public constructor(concurrentRate: unknown, clock: ClockHost = systemClockHost) {
    this.clock = clock
    this.rate = initialRate(concurrentRate)
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
    if (signal?.aborted === true) throw abortError()
    while (this.rate !== undefined) {
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
      await this.clock.wait(nextWindowAt - now, signal)
      if (isAborted(signal)) throw abortError()
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
