import type { NormalizedSource } from '../model/types.ts'
import type { ClockHost, NetworkHost, SourceScriptCache, SourceScriptCacheEntry, SourceScriptCacheSnapshot } from './contracts.ts'
import { SourceRateLimiter, systemClockHost, withSourceRateLimit } from './source-rate-limiter.ts'
import type { SourceRateDiagnostic } from './source-rate-limiter.ts'
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
  /** Host-owned resources shared by the operation ports. */
  onClose?: () => void
}

export interface SourceSession {
  readonly source: NormalizedSource
  /** 会话创建时发现的兼容性配置问题；不把运行时工作流失败伪装成配置诊断。 */
  diagnostics(): readonly SourceRateDiagnostic[]
  /** 为一项完整工作流创建隔离上下文，并在结束后提交 source 变量差异。 */
  run<T>(operation: (ports: WorkflowPorts) => Promise<T>, options?: { requestObserver?: RequestObserver }): Promise<T>
  snapshotVariables(): Readonly<Record<string, string>>
  /** 释放本会话限流等待；关闭后不再接受新的工作流。 */
  close(): void
}

interface CachedValue extends SourceScriptCacheEntry {
  value: string
  expiresAt?: number
}

interface CachedBytes {
  value: Uint8Array
  expiresAt?: number
}

const maxRestoredCacheEntries = 4096
const maxRestoredCacheValueLength = 4 * 1024 * 1024
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 默认内存缓存按 source session 隔离；应用需要跨会话保存时注入自己的端口。 */
export class MemorySourceScriptCache implements SourceScriptCache {
  private readonly values = new Map<string, CachedValue>()
  private readonly memory = new Map<string, string>()
  private readonly files = new Map<string, CachedValue>()
  private readonly bytes = new Map<string, CachedBytes>()

  public get(key: string): string | undefined {
    return this.memory.get(key) ?? this.read(this.values, key)
  }

  public getByteArray(key: string): Uint8Array | undefined {
    const entry = this.bytes.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.bytes.delete(key)
      return undefined
    }
    return Uint8Array.from(entry.value)
  }

  public getFromDisk(key: string): string | undefined {
    return this.read(this.values, key)
  }

  public put(key: string, value: string, saveTime = 0): void {
    this.write(this.values, key, value, saveTime)
    if (saveTime === 0) this.memory.set(key, value)
    else this.memory.delete(key)
  }

  public putByteArray(key: string, value: Uint8Array, saveTime = 0): void {
    const expiresAt = Number.isFinite(saveTime) && saveTime !== 0 ? Date.now() + saveTime * 1000 : undefined
    this.bytes.set(key, { value: Uint8Array.from(value), ...(expiresAt === undefined ? {} : { expiresAt }) })
  }

  public delete(key: string): void {
    this.values.delete(key)
    this.memory.delete(key)
    this.files.delete(key)
    this.bytes.delete(key)
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

  public clear(): void {
    this.values.clear()
    this.memory.clear()
    this.files.clear()
    this.bytes.clear()
  }

  public snapshot(): SourceScriptCacheSnapshot {
    const values = this.snapshotEntries(this.values)
    const memory = [...this.memory].filter(([, value]) => value.length <= maxRestoredCacheValueLength).slice(0, maxRestoredCacheEntries)
    const files = this.snapshotEntries(this.files)
    const bytes = this.snapshotByteEntries()
    return {
      version: 1,
      ...(values.length === 0 ? {} : { values: Object.fromEntries(values) }),
      ...(memory.length === 0 ? {} : { memory: Object.fromEntries(memory) }),
      ...(files.length === 0 ? {} : { files: Object.fromEntries(files) }),
      ...(bytes.length === 0 ? {} : { bytes: Object.fromEntries(bytes) }),
    }
  }

  public restore(snapshot: SourceScriptCacheSnapshot): void {
    if (typeof snapshot !== 'object' || snapshot === null || (snapshot.version !== undefined && snapshot.version !== 1)) return
    if (!isCacheRecord(snapshot.values) || !isCacheRecord(snapshot.memory) || !isCacheRecord(snapshot.files) || !isCacheRecord(snapshot.bytes)) return
    const values = this.restoreEntries(snapshot.values)
    const files = this.restoreEntries(snapshot.files)
    const bytes = this.restoreByteEntries(snapshot.bytes)
    const memory = new Map<string, string>()
    for (const [key, value] of Object.entries(snapshot.memory ?? {})) {
      if (memory.size >= maxRestoredCacheEntries) break
      if (typeof value === 'string' && value.length <= maxRestoredCacheValueLength) memory.set(key, value)
    }
    this.values.clear()
    this.memory.clear()
    this.files.clear()
    this.bytes.clear()
    for (const [key, value] of values) this.values.set(key, value)
    for (const [key, value] of memory) this.memory.set(key, value)
    for (const [key, value] of files) this.files.set(key, value)
    for (const [key, value] of bytes) this.bytes.set(key, value)
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

  private snapshotEntries(store: Map<string, CachedValue>): Array<[string, SourceScriptCacheEntry]> {
    const entries: Array<[string, SourceScriptCacheEntry]> = []
    for (const [key, entry] of store) {
      if (entries.length >= maxRestoredCacheEntries) break
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        store.delete(key)
        continue
      }
      if (entry.value.length > maxRestoredCacheValueLength) continue
      entries.push([key, { value: entry.value, ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }) }])
    }
    return entries
  }

  private restoreEntries(entries: Record<string, SourceScriptCacheEntry> | undefined): Map<string, CachedValue> {
    const store = new Map<string, CachedValue>()
    for (const [key, entry] of Object.entries(entries ?? {})) {
      if (store.size >= maxRestoredCacheEntries) break
      if (typeof entry?.value !== 'string' || entry.value.length > maxRestoredCacheValueLength) continue
      if (entry.expiresAt !== undefined && (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now())) continue
      store.set(key, { value: entry.value, ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }) })
    }
    return store
  }

  private snapshotByteEntries(): Array<[string, SourceScriptCacheEntry]> {
    const entries: Array<[string, SourceScriptCacheEntry]> = []
    for (const [key, entry] of this.bytes) {
      if (entries.length >= maxRestoredCacheEntries) break
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        this.bytes.delete(key)
        continue
      }
      if (entry.value.byteLength > maxRestoredCacheValueLength) continue
      entries.push([key, { value: encodeBase64(entry.value), ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }) }])
    }
    return entries
  }

  private restoreByteEntries(entries: Record<string, SourceScriptCacheEntry> | undefined): Map<string, CachedBytes> {
    const store = new Map<string, CachedBytes>()
    for (const [key, entry] of Object.entries(entries ?? {})) {
      if (store.size >= maxRestoredCacheEntries) break
      if (typeof entry?.value !== 'string' || entry.value.length > maxRestoredCacheValueLength * 2) continue
      if (entry.expiresAt !== undefined && (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now())) continue
      try {
        const value = decodeBase64(entry.value)
        if (value.byteLength > maxRestoredCacheValueLength) continue
        store.set(key, { value, ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }) })
      } catch {
        // Ignore a corrupt binary entry without discarding the rest of the snapshot.
      }
    }
    return store
  }
}

function isCacheRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value))
}

function encodeBase64(value: Uint8Array): string {
  let result = ''
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index]!
    const second = value[index + 1]
    const third = value[index + 2]
    result += base64Alphabet[first >> 2]
    result += base64Alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)]
    result += second === undefined ? '=' : base64Alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)]
    result += third === undefined ? '=' : base64Alphabet[third & 63]
  }
  return result
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)) throw new Error('invalid base64 cache value')
  const output: number[] = []
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Alphabet.indexOf(value[index]!)
    const b = base64Alphabet.indexOf(value[index + 1]!)
    const c = value[index + 2] === '=' ? 0 : base64Alphabet.indexOf(value[index + 2]!)
    const d = value[index + 3] === '=' ? 0 : base64Alphabet.indexOf(value[index + 3]!)
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('invalid base64 cache value')
    output.push((a << 2) | (b >> 4))
    if (value[index + 2] !== '=') output.push(((b & 15) << 4) | (c >> 2))
    if (value[index + 3] !== '=') output.push(((c & 3) << 6) | d)
  }
  return Uint8Array.from(output)
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
  let closed = false
  const diagnostics = rateLimiter.initialDiagnostic === undefined ? [] : [rateLimiter.initialDiagnostic]

  return {
    source,
    diagnostics: () => diagnostics,
    async run<T>(operation: (ports: WorkflowPorts) => Promise<T>, runOptions: { requestObserver?: RequestObserver } = {}): Promise<T> {
      if (closed) throw new Error('source session is closed')
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
    close: () => {
      if (closed) return
      closed = true
      rateLimiter.close()
      options.onClose?.()
    },
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
