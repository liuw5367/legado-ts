import type { ApiSettings } from './api.ts'

export type SettingsPatch = Partial<Pick<ApiSettings, 'theme' | 'readingMode' | 'fontSize' | 'lineHeight' | 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft'>> & { general?: Partial<ApiSettings['general']>; pageTapZones?: ApiSettings['pageTapZones'] }
type Waiter = { resolve: (settings: ApiSettings) => void; reject: (reason: unknown) => void }
type Batch = { patch: SettingsPatch; waiters: Waiter[]; ready: boolean }

function mergePatch(previous: SettingsPatch, next: SettingsPatch): SettingsPatch {
  return { ...previous, ...next, ...(previous.general || next.general ? { general: { ...previous.general, ...next.general } } : {}) }
}

/** 只合并尚未发送的设置；即时保存会连同待保存字段一起提交，失败字段等待后续编辑或明确重试。 */
export class SettingsSaveQueue {
  private pending: Batch | undefined
  private queued: Batch[] = []
  private failed: SettingsPatch | undefined
  private sending: Promise<ApiSettings> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private maxTimer: ReturnType<typeof setTimeout> | undefined
  private active = true
  private readonly write: (patch: SettingsPatch) => Promise<ApiSettings>
  constructor(write: (patch: SettingsPatch) => Promise<ApiSettings>) { this.write = write }
  get hasFailed() { return this.failed !== undefined }
  resume() { this.active = true }
  dispose() {
    this.active = false
    this.clearTimers()
    const batches = [...this.queued, ...(this.pending ? [this.pending] : [])]
    this.pending = undefined; this.failed = undefined; this.queued = []
    for (const batch of batches) for (const waiter of batch.waiters) waiter.reject(new Error('账号已切换，设置保存已取消'))
  }
  enqueue(patch: SettingsPatch, debounce = false): Promise<ApiSettings> {
    if (!this.active) return Promise.reject(new Error('账号已切换，设置保存已取消'))
    this.pending ??= { patch: {}, waiters: [], ready: false }
    this.pending.patch = mergePatch(this.pending.patch, patch)
    const task = new Promise<ApiSettings>((resolve, reject) => this.pending!.waiters.push({ resolve, reject }))
    if (!debounce) {
      // 即时操作固定自己的提交快照，后续编辑不能替换正在等待确认的模式或显式保存。
      this.clearTimers()
      this.pending.ready = true
      this.queued.push(this.pending); this.pending = undefined
      this.send()
    }
    else if (!this.pending.ready) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.makeReady(), 500)
      this.maxTimer ??= setTimeout(() => this.makeReady(), 2000)
    }
    return task
  }
  flush(retry = false): Promise<ApiSettings | undefined> {
    if (!this.active) return Promise.resolve(undefined)
    if (this.pending || (retry && this.failed)) return this.enqueue({}, false)
    const last = this.queued.at(-1)
    if (last) return new Promise<ApiSettings>((resolve, reject) => last.waiters.push({ resolve, reject }))
    return this.sending ?? Promise.resolve(undefined)
  }
  private clearTimers() {
    clearTimeout(this.idleTimer); clearTimeout(this.maxTimer)
    this.idleTimer = undefined; this.maxTimer = undefined
  }
  private makeReady() {
    this.clearTimers()
    if (!this.pending) return
    this.pending.ready = true
    this.send()
  }
  private send() {
    if (!this.active || this.sending) return
    const batch = this.queued.shift() ?? (this.pending?.ready ? this.pending : undefined)
    if (!batch) return
    const patch = mergePatch(this.failed ?? {}, batch.patch)
    if (this.pending === batch) this.pending = undefined
    this.failed = undefined
    // 在微任务中调用 writer，确保同步异常也与网络失败经过相同结算路径。
    const task = Promise.resolve().then(() => {
      if (!this.active) throw new Error('账号已切换，设置保存已取消')
      return this.write(patch)
    })
    this.sending = task
    void task.then((settings) => {
      for (const waiter of batch.waiters) waiter.resolve(settings)
    }, (reason: unknown) => {
      if (this.active) this.failed = patch
      for (const waiter of batch.waiters) waiter.reject(reason)
    }).finally(() => {
      this.sending = undefined
      this.send()
    })
  }
}
