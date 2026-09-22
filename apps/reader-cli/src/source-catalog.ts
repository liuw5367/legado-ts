import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { importSources, sourceDefinitionFingerprint } from '@legado/source-core'
import type { ImportCandidate, ImportReader, NormalizedSource } from '@legado/source-core'
import { NodeNetworkHost } from '@legado/source-node'
import { createRequestPlan } from '@legado/source-core'
import { ReaderStorage } from './storage.ts'

const MAX_FILES = 256
const MAX_BYTES = 4 * 1024 * 1024

export interface SourceEntry {
  id: string
  source: NormalizedSource
  candidate: ImportCandidate
  fingerprint: string
  state: 'available' | 'disabled' | 'unsupported' | 'invalid' | 'conflict'
  reason?: string
}

export interface SourceCatalogResult {
  entries: SourceEntry[]
  diagnostics: string[]
  sourceLocation: string
  loadedFromCache: boolean
}

export interface SourceCatalogOptions {
  storage?: ReaderStorage
  network?: NodeNetworkHost
  maxFiles?: number
  maxBytes?: number
}

export async function loadSourceCatalog(input: string | undefined, options: SourceCatalogOptions = {}): Promise<SourceCatalogResult> {
  const diagnostics: string[] = []
  if (input === undefined || input.trim().length === 0) return { entries: [], diagnostics: ['没有配置书源。请使用 --source 或 LEGADO_READER_SOURCE。'], sourceLocation: '', loadedFromCache: false }
  const location = input.trim()
  const storage = options.storage
  const maxFiles = options.maxFiles ?? MAX_FILES
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const texts: Array<{ text: string; location: string }> = []
  let loadedFromCache = false
  if (isHttpUrl(location)) {
    const reader = createImportReader(options.network ?? new NodeNetworkHost(), storage)
    try {
      const response = await reader.read({ uri: location, maxBytes })
      texts.push({ text: response.text, location: response.location ?? location })
      if (storage !== undefined) await storage.setSourceInput(location, response.text)
    } catch (error) {
      const cached = storage === undefined ? undefined : await storage.getSourceInput(location)
      if (cached !== undefined) {
        texts.push({ text: cached, location: location })
        loadedFromCache = true
        diagnostics.push(`远程书源加载失败，使用缓存：${message(error)}`)
      } else {
        diagnostics.push(`远程书源加载失败：${message(error)}`)
      }
    }
  } else {
    const path = resolve(location)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined) diagnostics.push(`书源路径不存在：${path}`)
    else if (info.isSymbolicLink()) diagnostics.push(`拒绝读取符号链接：${path}`)
    else if (info.isDirectory()) await collectDirectory(path, texts, diagnostics, maxFiles, maxBytes)
    else if (info.isFile()) await collectFile(path, texts, diagnostics, maxBytes)
    else diagnostics.push(`书源路径不是普通文件或目录：${path}`)
  }
  const entries: SourceEntry[] = []
  for (const item of texts) {
    const candidates = await importSources({ kind: 'text', text: item.text, origin: { kind: 'file', location: item.location } }, { limits: { maxCandidates: 1000, maxBytes } })
    for (const candidate of candidates) {
      if (candidate.source === undefined) {
        diagnostics.push(`${basename(item.location)}：${candidate.error?.message ?? '无效书源'}`)
        continue
      }
      const source = candidate.source
      const fingerprint = candidate.sourceFingerprint ?? sourceDefinitionFingerprint(source)
      const state = source.bookSourceType !== 0
        ? 'unsupported'
        : source.enabled === false
          ? 'disabled'
          : 'available'
      entries.push({ id: `${source.bookSourceUrl}\u0000${fingerprint}`, source, candidate, fingerprint, state, ...(state === 'unsupported' ? { reason: '首版只支持文本书源' } : state === 'disabled' ? { reason: '书源已禁用' } : {}) })
    }
  }
  const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
  markConflicts(unique)
  return { entries: unique.sort((left, right) => left.source.bookSourceName.localeCompare(right.source.bookSourceName, 'zh-Hans')), diagnostics, sourceLocation: location, loadedFromCache }
}

export function usableSources(catalog: SourceCatalogResult): SourceEntry[] {
  return catalog.entries.filter((entry) => entry.state === 'available')
}

function markConflicts(entries: SourceEntry[]): void {
  const byId = new Map<string, SourceEntry[]>()
  for (const entry of entries) byId.set(entry.source.bookSourceUrl, [...(byId.get(entry.source.bookSourceUrl) ?? []), entry])
  for (const group of byId.values()) {
    const fingerprints = new Set(group.map((entry) => entry.fingerprint))
    if (fingerprints.size > 1) for (const entry of group) {
      entry.state = 'conflict'
      entry.reason = '同一 sourceId 存在不同书源定义'
    }
  }
}

async function collectDirectory(path: string, texts: Array<{ text: string; location: string }>, diagnostics: string[], maxFiles: number, maxBytes: number): Promise<void> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxFiles) break
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && ['.json', '.js'].includes(extname(entry.name).toLowerCase())) files.push(child)
    }
  }
  await visit(path)
  if (files.length >= maxFiles) diagnostics.push(`书源目录达到文件上限 ${maxFiles}，其余文件未读取`)
  for (const file of files) await collectFile(file, texts, diagnostics, maxBytes)
}

async function collectFile(path: string, texts: Array<{ text: string; location: string }>, diagnostics: string[], maxBytes: number): Promise<void> {
  try {
    const text = await readFile(path, 'utf8')
    if (new TextEncoder().encode(text).byteLength > maxBytes) diagnostics.push(`书源文件超过 ${maxBytes} 字节：${path}`)
    else texts.push({ text, location: path })
  } catch (error) {
    diagnostics.push(`书源文件读取失败：${path}，${message(error)}`)
  }
}

function createImportReader(network: NodeNetworkHost, storage: ReaderStorage | undefined): ImportReader {
  return {
    read: async ({ uri, maxBytes, signal }) => {
      if (!isHttpUrl(uri)) throw new Error('远程书源只允许 HTTP/HTTPS')
      const result = createRequestPlan({ url: uri, budget: { maxResponseBytes: maxBytes, maxTotalBytes: maxBytes, ...(signal === undefined ? {} : { signal }) } })
      if (result.plan === undefined) throw new Error(result.error?.message ?? '无法建立远程书源请求')
      const response = await network.request(result.plan)
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
      const text = new TextDecoder().decode(response.bytes)
      if (storage !== undefined) await storage.setSourceInput(uri, text)
      return { text, location: uri }
    },
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
