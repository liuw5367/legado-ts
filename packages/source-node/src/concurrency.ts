import type { ConcurrencyHost } from '@legado/source-core'

interface Waiter<T> {
  key: string
  task: (signal: AbortSignal) => Promise<T>
  signal: AbortSignal | undefined
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  controller?: AbortController
  started: boolean
  abortListener?: () => void
}

interface QueueState {
  running: Set<Waiter<unknown>>
  pending: Waiter<unknown>[]
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

export class KeyedConcurrencyHost implements ConcurrencyHost {
  private readonly queues = new Map<string, QueueState>()
  private readonly maxConcurrent: number
  private readonly maxConcurrentPerKey: number
  private running = 0

  public constructor(options: { maxConcurrent?: number; maxConcurrentPerKey?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 8
    this.maxConcurrentPerKey = options.maxConcurrentPerKey ?? 1
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || !Number.isInteger(this.maxConcurrentPerKey) || this.maxConcurrentPerKey < 1) throw new Error('concurrency limits are invalid')
  }

  public run<T>(key: string, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (key.length === 0) return Promise.reject(new Error('concurrency key must not be empty'))
    if (signal?.aborted === true) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { key, task, signal, resolve, reject, started: false }
      waiter.abortListener = () => {
        if (waiter.started) waiter.controller?.abort()
        else this.removePending(waiter)
      }
      signal?.addEventListener('abort', waiter.abortListener, { once: true })
      const queue = this.queues.get(key) ?? { running: new Set(), pending: [] }
      queue.pending.push(waiter as Waiter<unknown>)
      this.queues.set(key, queue)
      this.pump()
    })
  }

  public cancel(key: string): void {
    const queue = this.queues.get(key)
    if (queue === undefined) return
    for (const waiter of queue.pending.splice(0)) this.rejectPending(waiter, abortError())
    for (const waiter of queue.running) waiter.controller?.abort()
    this.cleanupQueue(key, queue)
  }

  public clear(): void {
    for (const key of this.queues.keys()) this.cancel(key)
  }

  private removePending<T>(waiter: Waiter<T>): void {
    const queue = this.queues.get(waiter.key)
    if (queue === undefined) return
    const index = queue.pending.indexOf(waiter as Waiter<unknown>)
    if (index >= 0) {
      queue.pending.splice(index, 1)
      this.rejectPending(waiter, abortError())
      this.cleanupQueue(waiter.key, queue)
      this.pump()
    }
  }

  private rejectPending<T>(waiter: Waiter<T>, reason: unknown): void {
    waiter.signal?.removeEventListener('abort', waiter.abortListener!)
    waiter.reject(reason)
  }

  private cleanupQueue(key: string, queue: QueueState): void {
    if (queue.pending.length === 0 && queue.running.size === 0) this.queues.delete(key)
  }

  private pump(): void {
    while (this.running < this.maxConcurrent) {
      const next = [...this.queues.values()].find((queue) => queue.pending.length > 0 && queue.running.size < this.maxConcurrentPerKey)
      if (next === undefined) return
      const waiter = next.pending.shift()!
      if (waiter.signal?.aborted === true) {
        this.rejectPending(waiter, abortError())
        continue
      }
      this.start(waiter, next)
    }
  }

  private start(waiter: Waiter<unknown>, queue: QueueState): void {
    waiter.started = true
    waiter.controller = new AbortController()
    waiter.signal?.removeEventListener('abort', waiter.abortListener!)
    if (waiter.signal !== undefined) {
      const relay = () => waiter.controller?.abort()
      waiter.signal.addEventListener('abort', relay, { once: true })
      void this.execute(waiter, queue, relay)
    } else void this.execute(waiter, queue, undefined)
  }

  private async execute(waiter: Waiter<unknown>, queue: QueueState, relay: (() => void) | undefined): Promise<void> {
    queue.running.add(waiter)
    this.running += 1
    try {
      const value = await waiter.task(waiter.controller!.signal)
      waiter.resolve(value)
    } catch (error) {
      waiter.reject(error)
    } finally {
      if (relay !== undefined) waiter.signal?.removeEventListener('abort', relay)
      queue.running.delete(waiter)
      this.running -= 1
      this.cleanupQueue(waiter.key, queue)
      this.pump()
    }
  }
}
