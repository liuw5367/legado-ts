import type { SearchStreamOptions, StreamEvent } from './api.ts'

interface SearchTransport {
  create(keyword: string, precision: boolean): Promise<string>
  stream(id: string, event: (value: StreamEvent) => void, signal: AbortSignal, options?: SearchStreamOptions): Promise<void>
  cancel(id: string): Promise<unknown>
}
/** 流与服务端取消结算后才允许下一次；创建ID前取消也会补发取消。 */
export class SearchOperation {
  private current: { controller: AbortController; id: string; cancelled: boolean; completed: boolean; cancelPromise?: Promise<unknown> } | undefined
  private transport: SearchTransport
  constructor(transport: SearchTransport) { this.transport = transport }
  private settleCancel(run: NonNullable<SearchOperation['current']>) {
    if (run.id.length === 0) return Promise.resolve()
    run.cancelPromise ??= this.transport.cancel(run.id)
    return run.cancelPromise
  }
  get isRunning() { return this.current !== undefined }
  async start(keyword: string, precision: boolean, event: (value: StreamEvent) => void, created: (id: string) => void) {
    if (this.current !== undefined) throw new Error('上一轮搜索尚未结束')
    const run = { controller: new AbortController(), id: '', cancelled: false, completed: false }
    this.current = run
    try {
      // 创建请求不中断，必须获得服务端ID，才能结算创建期间的取消请求。
      run.id = await this.transport.create(keyword, precision)
      created(run.id)
      if (!run.cancelled) await this.transport.stream(run.id, (value) => { if (!run.cancelled && !run.completed) { if (value.type === 'done') run.completed = true; event(value) } }, run.controller.signal)
    } catch (reason) {
      if (!run.cancelled) throw reason
    } finally {
      try { if (run.cancelled) await this.settleCancel(run) }
      finally { if (this.current === run) this.current = undefined }
    }
    return { id: run.id, cancelled: run.cancelled }
  }
  async cancel() {
    const run = this.current
    if (run === undefined || run.completed) return
    run.cancelled = true; run.controller.abort()
    await this.settleCancel(run)
  }
}
