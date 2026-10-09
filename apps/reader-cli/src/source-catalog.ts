import { importSources, sourceDefinitionFingerprint } from '@legado/source-core'
import type { ImportCandidate, ImportReader, NormalizedSource } from '@legado/source-core'
import { NodeNetworkHost, readSourcePath } from '@legado/source-node'
import { createRequestPlan } from '@legado/source-core'
import { ReaderStorage } from './storage.ts'
import { applySourceState, sourceStateDefaults } from './source-policy.ts'
import type { SourceCheckRecord, SourceHealthState } from './storage-model.ts'
import { getEmbeddedSourceInputs } from './embedded-sources.ts'

const MAX_FILES = 256
const MAX_BYTES = 4 * 1024 * 1024

export interface SourceEntry {
  id: string
  source: NormalizedSource
  candidate: ImportCandidate
  fingerprint: string
  state: 'available' | 'disabled' | 'unsupported' | 'invalid' | 'conflict'
  reason?: string
  customOrder?: number
  searchHealth?: SourceHealthState
  check?: SourceCheckRecord
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
  const location = input?.trim() ?? ''
  const storage = options.storage
  const maxFiles = options.maxFiles ?? MAX_FILES
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const texts: Array<{ text: string; location: string }> = []
  let loadedFromCache = false
  if (location.length === 0) {
    texts.push(...getEmbeddedSourceInputs())
    if (texts.length === 0) return { entries: [], diagnostics: ['没有配置书源。请使用 --source 或 LEGADO_READER_SOURCE。'], sourceLocation: '', loadedFromCache: false }
  } else if (isHttpUrl(location)) {
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
    const result = await readSourcePath(location, { maxFiles, maxBytes })
    texts.push(...result.inputs)
    diagnostics.push(...result.diagnostics)
  }
  const entries: SourceEntry[] = []
  const savedStates = storage === undefined ? {} : await storage.getSourceStates()
  for (const item of texts) {
    const candidates = await importSources({ kind: 'text', text: item.text, origin: { kind: 'file', location: item.location } }, { limits: { maxCandidates: 1000, maxBytes } })
    for (const candidate of candidates) {
      if (candidate.source === undefined) {
        diagnostics.push(`${item.location.split(/[\\/]/u).at(-1) ?? item.location}：${candidate.error?.message ?? '无效书源'}`)
        continue
      }
      const source = candidate.source
      const fingerprint = candidate.sourceFingerprint ?? sourceDefinitionFingerprint(source)
      const saved = savedStates[source.bookSourceUrl]
      const defaults = sourceStateDefaults(source, fingerprint)
      const userState = saved === undefined ? defaults : {
        ...defaults,
        enabled: saved.enabled,
        enabledExplore: saved.enabledExplore,
        customOrder: saved.customOrder,
        weight: saved.weight,
        searchHealth: saved.fingerprint === fingerprint ? saved.searchHealth : { fingerprint, consecutiveFailures: 0 },
        ...(saved.fingerprint === fingerprint && saved.check === undefined ? {} : saved.fingerprint === fingerprint && saved.check !== undefined ? { check: saved.check } : {}),
      }
      const effectiveSource = applySourceState(source, userState)
      const state = effectiveSource.bookSourceType !== 0
        ? 'unsupported'
        : effectiveSource.enabled === false
          ? 'disabled'
          : 'available'
      entries.push({ id: `${effectiveSource.bookSourceUrl}\u0000${fingerprint}`, source: effectiveSource, candidate, fingerprint, state, customOrder: userState.customOrder, searchHealth: userState.searchHealth, ...(userState.check === undefined ? {} : { check: userState.check }), ...(state === 'unsupported' ? { reason: '首版只支持文本书源' } : state === 'disabled' ? { reason: '书源已禁用' } : {}) })
    }
  }
  const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
  markConflicts(unique)
  return { entries: unique.sort((left, right) => left.source.bookSourceName.localeCompare(right.source.bookSourceName, 'zh-Hans')), diagnostics, sourceLocation: location.length === 0 ? '内置书源' : location, loadedFromCache }
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
