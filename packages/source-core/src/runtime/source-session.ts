import type { NormalizedSource } from '../model/types.ts'
import type { ClockHost, NetworkHost, SourceScriptCache } from './contracts.ts'
import { SourceRateLimiter, systemClockHost, withSourceRateLimit } from './source-rate-limiter.ts'
import type { RequestObserver, WorkflowPorts } from '../workflows/types.ts'

export interface SourceSessionOperationContext {
  /** 本会话固定使用的书源定义。 */
  source: NormalizedSource
  /** 操作开始时的 source 变量快照。 */
  initialVariables: Readonly<Record<string, string>>
  /** 本会话内隔离的脚本缓存；平台可替换为持久实现。 */
  cache: SourceScriptCache
  /** 已叠加本会话书源限流的网络宿主。 */
  network?: NetworkHost
  /** 更新 Android `source.putConcurrent` 对应的会话限流配置。 */
  updateConcurrentRate: (value: string) => void
  /** 本次操作的可选网络观察器。 */
  requestObserver?: RequestObserver
}

export interface SourceSessionOptions {
  source: NormalizedSource
  /** 每项操作创建新的规则/请求上下文，但共享调用方提供的网络等平台能力。 */
  createPorts: (context: SourceSessionOperationContext) => WorkflowPorts
  /** 原始平台网络能力；core 在会话边界添加同源限流。 */
  network?: NetworkHost
  /** 注入的时间能力；缺省使用标准 wall clock。 */
  clock?: ClockHost
  initialVariables?: Readonly<Record<string, string>>
  cache?: SourceScriptCache
}

export interface SourceSession {
  readonly source: NormalizedSource
  /** 为一项完整工作流创建隔离上下文，并在结束后提交 source 变量差异。 */
  run<T>(operation: (ports: WorkflowPorts) => Promise<T>, options?: { requestObserver?: RequestObserver }): Promise<T>
  snapshotVariables(): Readonly<Record<string, string>>
}

interface CachedValue {
  value: string
  expiresAt?: number
}

/** 默认内存缓存按 source session 隔离；应用需要跨会话保存时注入自己的端口。 */
export class MemorySourceScriptCache implements SourceScriptCache {
  private readonly values = new Map<string, CachedValue>()
  private readonly memory = new Map<string, string>()
  private readonly files = new Map<string, CachedValue>()

  public get(key: string): string | undefined {
    return this.memory.get(key) ?? this.read(this.values, key)
  }

  public put(key: string, value: string, saveTime = 0): void {
    this.write(this.values, key, value, saveTime)
    if (saveTime === 0) this.memory.set(key, value)
    else this.memory.delete(key)
  }

  public delete(key: string): void {
    this.values.delete(key)
    this.memory.delete(key)
    this.files.delete(key)
  }

  public getFromMemory(key: string): string | undefined {
    return this.memory.get(key)
  }

  public putMemory(key: string, value: string): void {
    this.memory.set(key, value)
  }

  public deleteMemory(key: string): void {
    this.memory.delete(key)
  }

  public getFile(key: string): string | undefined {
    return this.read(this.files, key)
  }

  public putFile(key: string, value: string, saveTime = 0): void {
    this.write(this.files, key, value, saveTime)
  }

  private read(store: Map<string, CachedValue>, key: string): string | undefined {
    const entry = store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(key)
      return undefined
    }
    return entry.value
  }

  private write(store: Map<string, CachedValue>, key: string, value: string, saveTime: number): void {
    const expiresAt = Number.isFinite(saveTime) && saveTime !== 0 ? Date.now() + saveTime * 1000 : undefined
    store.set(key, { value, ...(expiresAt === undefined ? {} : { expiresAt }) })
  }
}

/**
 * 保留跨操作的 source 变量，同时将每项操作的规则宿主、节点表和 JS runtime 隔离。
 * 并发操作按各自初始快照提交差异；同名变量冲突时后完成的操作覆盖先完成值。
 */
export function createSourceSession(options: SourceSessionOptions): SourceSession {
  const source = structuredClone(options.source)
  freezeRecursively(source)
  const sourceVariables = new Map(Object.entries(options.initialVariables ?? {}))
  const cache = options.cache ?? new MemorySourceScriptCache()
  const rateLimiter = new SourceRateLimiter(source.concurrentRate, options.clock ?? systemClockHost)
  const network = options.network === undefined ? undefined : withSourceRateLimit(options.network, rateLimiter)

  return {
    source,
    async run<T>(operation: (ports: WorkflowPorts) => Promise<T>, runOptions: { requestObserver?: RequestObserver } = {}): Promise<T> {
      const before = new Map(sourceVariables)
      const ports = options.createPorts({ source, initialVariables: Object.fromEntries(before), cache, ...(network === undefined ? {} : { network }), updateConcurrentRate: (value) => rateLimiter.update(value), ...(runOptions.requestObserver === undefined ? {} : { requestObserver: runOptions.requestObserver }) })
      try {
        return await operation(ports)
      } finally {
        const after = ports.rules.snapshotVariables?.('source')
        if (after !== undefined) mergeChanges(sourceVariables, before, after)
      }
    },
    snapshotVariables: () => Object.fromEntries(sourceVariables),
  }
}

function freezeRecursively(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  for (const nested of Object.values(value)) freezeRecursively(nested)
  Object.freeze(value)
}

function mergeChanges(target: Map<string, string>, before: Map<string, string>, after: Readonly<Record<string, string>>): void {
  const names = new Set([...before.keys(), ...Object.keys(after)])
  for (const name of names) {
    const previous = before.get(name)
    const next = after[name]
    if (previous === next) continue
    if (next === undefined) target.delete(name)
    else target.set(name, next)
  }
}
