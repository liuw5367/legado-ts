import { readdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ContentCache } from '@legado/source-core'
import { JsonStore } from './json-store.ts'
import { sha256, type StoragePaths } from './storage-model.ts'

export type CacheCategory = 'source-input' | 'toc' | 'content'

export interface CacheIndexEntry {
  relativePath: string
  category: CacheCategory
  bytes: number
  lastAccessedAt: string
}

export interface CacheIndex {
  entries: CacheIndexEntry[]
}

interface CacheRecord {
  value: string
  category: CacheCategory
  key: string
  storedAt: string
}

interface CacheStoreOptions {
  paths: StoragePaths
  now: () => Date
  maxCacheBytes: number
  json: JsonStore
  withWriteLock: <T>(task: () => Promise<T>) => Promise<T>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function iso(now: () => Date): string {
  return now().toISOString()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
}

function safeFilePart(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('缓存键必须是 SHA-256 摘要')
  return value
}

export function cacheCategory(value: unknown): CacheCategory | undefined {
  return value === 'source-input' || value === 'toc' || value === 'content' ? value : undefined
}

export function normalizeCacheRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/')
  // 索引只能引用三个缓存分类下的 SHA-256 文件，拒绝绝对路径、父目录和其他文件名。
  return /^(?:source-input|toc|content)\/[a-f0-9]{64}\.json$/u.test(normalized) ? normalized : undefined
}

export function cacheEntryPath(root: string, entry: CacheIndexEntry): string | undefined {
  const normalized = normalizeCacheRelativePath(entry.relativePath)
  if (normalized === undefined || !normalized.startsWith(`${entry.category}/`)) return undefined
  const key = normalized.slice(entry.category.length + 1, -'.json'.length)
  // 重新校验文件名，避免未来调用方绕过相对路径校验后形成删除路径。
  if (!/^[a-f0-9]{64}$/u.test(key)) return undefined
  return cachePath(root, entry.category, key)
}

export function cachePath(root: string, category: CacheCategory, key: string): string {
  return join(root, category, `${key}.json`)
}

export class CacheStore {
  private readonly paths: StoragePaths
  private readonly now: () => Date
  private readonly maxCacheBytes: number
  private readonly json: JsonStore
  private readonly withWriteLock: CacheStoreOptions['withWriteLock']
  private cacheIndex: CacheIndex = { entries: [] }
  private cacheIndexDirty = false

  public constructor(options: CacheStoreOptions) {
    this.paths = options.paths
    this.now = options.now
    this.maxCacheBytes = options.maxCacheBytes
    this.json = options.json
    this.withWriteLock = options.withWriteLock
  }

  public async initialize(): Promise<void> {
    let index: CacheIndex | undefined
    try {
      index = await this.json.readOptional<CacheIndex>(join(this.paths.cacheRoot, 'index.json'))
    } catch {
      index = undefined
    }
    const normalized = index === undefined ? await this.rebuildCacheIndex() : this.normalizeCacheIndex(index)
    this.cacheIndex = normalized
    this.cacheIndexDirty = index === undefined || !isObject(index) || !Array.isArray(index.entries) || index.entries.length !== normalized.entries.length
  }

  public async flush(): Promise<void> {
    if (!this.cacheIndexDirty) return
    await this.json.writeFile(join(this.paths.cacheRoot, 'index.json'), this.cacheIndex)
    this.cacheIndexDirty = false
  }

  public workflowCache(namespace = ''): ContentCache {
    return {
      get: async (key, signal) => this.getWorkflowCache(key, signal, namespace),
      set: async (key, value, signal) => this.setWorkflowCache(key, value, signal, namespace),
    }
  }

  public async getSourceInput(sourceUrl: string): Promise<string | undefined> {
    return this.getCacheValue('source-input', sha256(sourceUrl))
  }

  public async setSourceInput(sourceUrl: string, value: string): Promise<void> {
    await this.setCacheValue('source-input', sha256(sourceUrl), value)
  }

  private async getWorkflowCache(key: string, signal?: AbortSignal, namespace = ''): Promise<string | undefined> {
    throwIfAborted(signal)
    const parts = key.split('\u0000')
    const category = parts[1] === 'content' ? 'content' : parts[1] === 'toc' ? 'toc' : undefined
    if (category === undefined) return undefined
    return this.getCacheValue(category, sha256(namespace.length === 0 ? key : `${namespace}\u0000${key}`), signal)
  }

  private async setWorkflowCache(key: string, value: string, signal?: AbortSignal, namespace = ''): Promise<void> {
    throwIfAborted(signal)
    const parts = key.split('\u0000')
    const category = parts[1] === 'content' ? 'content' : parts[1] === 'toc' ? 'toc' : undefined
    if (category === undefined) return
    await this.setCacheValue(category, sha256(namespace.length === 0 ? key : `${namespace}\u0000${key}`), value, signal)
  }

  private async getCacheValue(category: CacheCategory, key: string, signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal)
    const path = cachePath(this.paths.cacheRoot, category, safeFilePart(key))
    const value = await this.json.readOptional<CacheRecord>(path)
    if (value === undefined) return undefined
    const entry = this.cacheIndex.entries.find((item) => item.relativePath === normalizeCacheRelativePath(relative(this.paths.cacheRoot, path)))
    if (entry !== undefined) entry.lastAccessedAt = iso(this.now)
    this.cacheIndexDirty = true
    return value.value
  }

  private async setCacheValue(category: CacheCategory, key: string, value: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const path = cachePath(this.paths.cacheRoot, category, safeFilePart(key))
    await this.withWriteLock(async () => {
      await this.json.writeFile(path, { value, category, key, storedAt: iso(this.now) } satisfies CacheRecord)
      const relativePath = normalizeCacheRelativePath(relative(this.paths.cacheRoot, path))
      const bytes = new TextEncoder().encode(value).byteLength
      if (relativePath === undefined) throw new Error('缓存路径不在缓存目录内')
      const existing = this.cacheIndex.entries.find((item) => item.relativePath === relativePath)
      const item: CacheIndexEntry = { relativePath, category, bytes, lastAccessedAt: iso(this.now) }
      if (existing === undefined) this.cacheIndex.entries.push(item)
      else Object.assign(existing, item)
      this.cacheIndexDirty = true
      await this.evictCacheIfNeeded()
    })
  }

  private async evictCacheIfNeeded(): Promise<void> {
    let total = this.cacheIndex.entries.reduce((sum, item) => sum + item.bytes, 0)
    if (total <= this.maxCacheBytes) return
    const sorted = [...this.cacheIndex.entries].sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt))
    for (const entry of sorted) {
      if (total <= this.maxCacheBytes) break
      const entryPath = cacheEntryPath(this.paths.cacheRoot, entry)
      if (entryPath === undefined) {
        this.cacheIndex.entries = this.cacheIndex.entries.filter((item) => item.relativePath !== entry.relativePath)
        continue
      }
      await rm(entryPath, { force: true })
      this.cacheIndex.entries = this.cacheIndex.entries.filter((item) => item.relativePath !== entry.relativePath)
      total -= entry.bytes
    }
    await this.flush()
  }

  private normalizeCacheIndex(value: CacheIndex): CacheIndex {
    if (!isObject(value) || !Array.isArray(value.entries)) return { entries: [] }
    const entries: CacheIndexEntry[] = []
    for (const item of value.entries) {
      if (!isObject(item) || typeof item.relativePath !== 'string' || typeof item.bytes !== 'number' || !Number.isFinite(item.bytes) || item.bytes < 0 || typeof item.lastAccessedAt !== 'string') continue
      const category = cacheCategory(item.category)
      const relativePath = normalizeCacheRelativePath(item.relativePath)
      if (category === undefined || relativePath === undefined || cacheEntryPath(this.paths.cacheRoot, { relativePath, category, bytes: item.bytes, lastAccessedAt: item.lastAccessedAt }) === undefined) continue
      entries.push({ relativePath, category, bytes: item.bytes, lastAccessedAt: item.lastAccessedAt })
    }
    return { entries }
  }

  private async rebuildCacheIndex(): Promise<CacheIndex> {
    const entries: CacheIndexEntry[] = []
    for (const category of ['source-input', 'toc', 'content'] as const) {
      const directory = join(this.paths.cacheRoot, category)
      const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        const path = join(directory, file.name)
        const metadata = await stat(path).catch(() => undefined)
        if (metadata === undefined) continue
        const relativePath = normalizeCacheRelativePath(relative(this.paths.cacheRoot, path))
        if (relativePath !== undefined) entries.push({ relativePath, category, bytes: metadata.size, lastAccessedAt: metadata.mtime.toISOString() })
      }
    }
    return { entries }
  }
}
