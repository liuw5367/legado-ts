import type { ApiPosition } from './api.ts'

export interface PositionWrite { bookId: string; editionKey: string; chapterId: string; chapterUrl: string; chapterIndex: number; title: string; tocRevision?: string | undefined; paragraphIndex: number; offset: number; version: number }
type Writer = (input: PositionWrite) => Promise<ApiPosition>
/** 页面隐藏后仍结算已经入队的保存；销毁账号所有者后不再发送排队任务。 */
export class ReadingPositionQueue {
  private tail: Promise<void> = Promise.resolve()
  private active = true
  private versions = new Map<string, number>()
  private failed = new Map<string, PositionWrite>()
  private pending: { identity: string; input: PositionWrite; started: boolean; task: Promise<ApiPosition | undefined> } | undefined
  private delayed = new Map<string, { input: PositionWrite; timer: ReturnType<typeof setTimeout>; resolve: (value: ApiPosition | undefined) => void; reject: (reason: unknown) => void; task: Promise<ApiPosition | undefined> }>()
  private readonly write: Writer
  constructor(write: Writer) { this.write = write }
  resume() { this.active = true }
  dispose() { for (const entry of this.delayed.values()) { clearTimeout(entry.timer); entry.resolve(undefined) }; this.delayed.clear(); this.active = false; this.failed.clear(); this.pending = undefined }
  enqueueDebounced(input: PositionWrite): Promise<ApiPosition | undefined> {
    if (!this.active) return Promise.resolve(undefined)
    const key = JSON.stringify([input.bookId, input.editionKey])
    const pending = this.delayed.get(key)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      pending.input = { ...input, version: Math.max(pending.input.version, input.version) }
      pending.timer = setTimeout(() => { void this.flush(input.bookId, input.editionKey).catch(() => undefined) }, 2000)
      return pending.task
    }
    let resolve!: (value: ApiPosition | undefined) => void
    let reject!: (reason: unknown) => void
    const task = new Promise<ApiPosition | undefined>((yes, no) => { resolve = yes; reject = no })
    const timer = setTimeout(() => { void this.flush(input.bookId, input.editionKey).catch(() => undefined) }, 2000)
    this.delayed.set(key, { input: { ...input }, timer, resolve, reject, task })
    return task
  }
  flush(bookId?: string, editionKey?: string): Promise<void> {
    const entries = [...this.delayed.entries()].filter(([, entry]) => bookId === undefined || entry.input.bookId === bookId && entry.input.editionKey === editionKey)
    for (const [key] of entries) this.delayed.delete(key)
    return Promise.all(entries.map(([, entry]) => {
      clearTimeout(entry.timer)
      return this.enqueue(entry.input).then(entry.resolve, entry.reject)
    })).then(() => undefined)
  }
  enqueue(input: PositionWrite): Promise<ApiPosition | undefined> {
    const key = JSON.stringify([input.bookId, input.editionKey])
    const delayed = this.delayed.get(key)
    if (delayed !== undefined) {
      clearTimeout(delayed.timer); this.delayed.delete(key); delayed.resolve(undefined)
    }
    const identity = JSON.stringify([input.bookId, input.editionKey, input.chapterId, input.chapterUrl, input.chapterIndex, input.title, input.tocRevision, input.paragraphIndex, input.offset])
    const pending = this.pending
    if (this.active && pending?.identity === identity) {
      pending.input.version = Math.max(pending.input.version, input.version)
      if (pending.started) this.versions.set(key, Math.max(this.versions.get(key) ?? -1, input.version))
      return pending.task
    }
    const entry = { identity, input: { ...input }, started: false, task: Promise.resolve<ApiPosition | undefined>(undefined) }
    const task = this.tail.then(async () => {
      if (!this.active) return undefined
      entry.started = true
      const next = { ...entry.input, version: Math.max(entry.input.version, (this.versions.get(key) ?? -1) + 1) }
      this.versions.set(key, next.version)
      try {
        const result = await this.write(next)
        if (!this.active) return undefined
        this.versions.set(key, Math.max(this.versions.get(key) ?? -1, next.version, result.version)); this.failed.delete(key)
        return result
      } catch (error) { if (this.active) this.failed.set(key, next); throw error }
    }).finally(() => { if (this.pending === entry) this.pending = undefined })
    entry.task = task
    this.pending = entry
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
  retry(bookId: string, editionKey: string) {
    const pending = this.delayed.get(JSON.stringify([bookId, editionKey]))
    if (pending !== undefined) { void this.flush(bookId, editionKey); return pending.task }
    const input = this.failed.get(JSON.stringify([bookId, editionKey]))
    return input === undefined ? Promise.resolve(undefined) : this.enqueue(input)
  }
}
