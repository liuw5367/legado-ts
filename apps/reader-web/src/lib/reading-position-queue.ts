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
  private readonly write: Writer
  constructor(write: Writer) { this.write = write }
  resume() { this.active = true }
  dispose() { this.active = false; this.failed.clear(); this.pending = undefined }
  enqueue(input: PositionWrite): Promise<ApiPosition | undefined> {
    const key = JSON.stringify([input.bookId, input.editionKey])
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
    const input = this.failed.get(JSON.stringify([bookId, editionKey]))
    return input === undefined ? Promise.resolve(undefined) : this.enqueue(input)
  }
}
