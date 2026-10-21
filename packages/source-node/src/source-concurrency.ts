import { randomUUID } from 'node:crypto'
import type { SourceRuntimeConcurrency, SourceRuntimeConcurrencyLease } from '@legado/source-core'

interface Waiter {
  readonly kind: 'singleFlight' | 'lock'
  readonly name: string
  readonly epoch: number
  readonly resolve: (lease: SourceRuntimeConcurrencyLease) => void
  readonly reject: (reason: unknown) => void
  timer?: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abort: () => void
  settled: boolean
}

interface Entry {
  locked: boolean
  epoch: number
  waiters: Waiter[]
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Node equivalent of Android SourceLock. A single instance must be shared by
 * every operation in one source session; it deliberately does not become a
 * process-global lock across unrelated source sessions.
 */
export class NodeSourceConcurrency implements SourceRuntimeConcurrency {
  private readonly entries = new Map<string, Entry>()
  private readonly leases = new Map<string, { name: string; kind: 'singleFlight' | 'lock' }>()
  private readonly ticks = new Map<string, number>()
  private closed = false

  public acquire(kind: 'singleFlight' | 'lock', name: string, timeoutMs: number, signal: AbortSignal): Promise<SourceRuntimeConcurrencyLease> {
    if (this.closed) return Promise.reject(new Error('SourceLock 已关闭'))
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) return Promise.reject(new Error('timeoutMs 必须在 0..300000 之间'))
    if (signal.aborted) return Promise.reject(abortError())
    const entry = this.entries.get(name) ?? { locked: false, epoch: 0, waiters: [] }
    this.entries.set(name, entry)
    const epoch = entry.epoch
    if (!entry.locked && entry.waiters.length === 0) {
      entry.locked = true
      const token = randomUUID()
      this.leases.set(token, { name, kind })
      return Promise.resolve({ token })
    }
    return new Promise<SourceRuntimeConcurrencyLease>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: Waiter = {
        kind,
        name,
        epoch,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        abort: () => {
          if (waiter.settled) return
          waiter.settled = true
          this.removeWaiter(name, waiter)
          reject(abortError())
        },
        settled: false,
      }
      if (timeoutMs === 0) {
        waiter.settled = true
        reject(new Error(`${kind} 等待超时: ${name} (0ms)`))
        return
      }
      timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        this.removeWaiter(name, waiter)
        reject(new Error(`${kind} 等待超时: ${name} (${timeoutMs}ms)`))
      }, timeoutMs)
      waiter.timer = timer
      signal.addEventListener('abort', waiter.abort, { once: true })
      entry.waiters.push(waiter)
    })
  }

  public release(token: string): void {
    const lease = this.leases.get(token)
    if (lease === undefined) return
    this.leases.delete(token)
    const entry = this.entries.get(lease.name)
    if (entry === undefined) return
    entry.locked = false
    if (lease.kind === 'singleFlight') entry.epoch = entry.epoch === 2_147_483_647 ? 0 : entry.epoch + 1
    this.pump(lease.name, entry)
    if (!entry.locked && entry.waiters.length === 0) this.entries.delete(lease.name)
  }

  public tick(name: string): number {
    const value = this.ticks.get(name) ?? 0
    this.ticks.delete(name)
    this.ticks.set(name, value === 2_147_483_647 ? 0 : value + 1)
    while (this.ticks.size > 4096) this.ticks.delete(this.ticks.keys().next().value!)
    return value
  }

  public close(): void {
    this.closed = true
    for (const [name, entry] of this.entries) {
      for (const waiter of entry.waiters.splice(0)) {
        waiter.settled = true
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        waiter.signal?.removeEventListener('abort', waiter.abort)
        waiter.reject(new Error(`SourceLock 已关闭: ${name}`))
      }
    }
    this.entries.clear()
    this.leases.clear()
    this.ticks.clear()
  }

  private removeWaiter(name: string, waiter: Waiter): void {
    const entry = this.entries.get(name)
    if (entry === undefined) return
    const index = entry.waiters.indexOf(waiter)
    if (index >= 0) entry.waiters.splice(index, 1)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener('abort', waiter.abort)
    if (!entry.locked && entry.waiters.length === 0) this.entries.delete(name)
  }

  private pump(name: string, entry: Entry): void {
    const waiter = entry.waiters.shift()
    if (waiter === undefined) return
    if (waiter.settled) {
      this.pump(name, entry)
      return
    }
    waiter.settled = true
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener('abort', waiter.abort)
    if (waiter.kind === 'singleFlight' && waiter.epoch !== entry.epoch) {
      waiter.resolve({ token: '', skip: true })
      this.pump(name, entry)
      return
    }
    entry.locked = true
    const token = randomUUID()
    this.leases.set(token, { name, kind: waiter.kind })
    waiter.resolve({ token })
  }
}
