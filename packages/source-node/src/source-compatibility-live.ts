import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '@legado/source-core'
import type { NetworkHost, RequestBudget, RuntimeResult, WorkflowPorts } from '@legado/source-core'
import { KeyedConcurrencyHost } from './concurrency.ts'
import { NodeCookieStore } from './cookies.ts'
import { NodeNetworkHost } from './http.ts'
import { SourceRequestHost } from './source-request-host.ts'
import { SourceRuleHost } from './source-rule-host.ts'
import { sourceFixtureCandidateId } from './source-compatibility.ts'
import type { SourceFixtureCandidate, StaticCompatibilityReport } from './source-compatibility.ts'

type LiveStageName = 'search' | 'detail' | 'toc' | 'content'
type LiveCause = 'none' | 'rule-unsupported' | 'external-failed' | 'empty-result'

export interface LiveStageRecord {
  readonly status: 'success' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'capability-missing' | 'blocked'
  readonly cause: LiveCause
  readonly itemCount: number
  readonly requestCount: number
  readonly diagnosticCodes: string[]
}

export interface LiveSourceRecord {
  readonly file: string
  readonly index: number
  readonly candidateId: string
  readonly sourceHash: string
  readonly sourceFingerprint?: string
  readonly name: string
  readonly host?: string
  readonly staticFlags: string[]
  readonly status: 'fully-supported' | 'partial' | 'rule-unsupported' | 'external-failed' | 'search-no-target' | 'blocked-sensitive-config' | 'invalid-source'
  readonly stages: Partial<Record<LiveStageName, LiveStageRecord>>
  readonly requestCount: number
}

export interface LiveCompatibilityReport {
  readonly version: 1
  readonly keyword: string
  readonly generatedAt: string
  readonly limits: {
    maxSources: number | null
    maxItems: number
    maxTocPages: number
    maxContentPages: number
    maxResponseBytes: number
  }
  readonly summary: {
    candidates: number
    attempted: number
    fullySupported: number
    partial: number
    ruleUnsupported: number
    externalFailed: number
    searchNoTarget: number
    blockedSensitiveConfig: number
    invalidSource: number
    stageCounts: Readonly<Record<string, number>>
  }
  readonly sources: LiveSourceRecord[]
}

export interface LiveCompatibilityOptions {
  readonly keyword?: string
  readonly maxSources?: number
  readonly maxItems?: number
  readonly maxTocPages?: number
  readonly maxContentPages?: number
  readonly maxResponseBytes?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface SourceSession {
  readonly ports: WorkflowPorts
  readonly ruleHost: SourceRuleHost
  readonly requestHost: SourceRequestHost
  readonly requests: { count: number }
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '').toLocaleLowerCase('zh-CN')
}

function diagnosticCodes(result: RuntimeResult<unknown>): string[] {
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))].sort()
}

function stageCause(result: RuntimeResult<unknown>): LiveCause {
  if (result.diagnostics.some((diagnostic) => diagnostic.code === 'request-failed')) return 'external-failed'
  if (result.diagnostics.some((diagnostic) => diagnostic.code === 'capability-missing' || diagnostic.code === 'rule-failed' || diagnostic.code === 'invalid-config' || diagnostic.code === 'item-skipped')) return 'rule-unsupported'
  if (result.status === 'empty' || result.diagnostics.some((diagnostic) => diagnostic.code === 'empty-page')) return 'empty-result'
  return 'none'
}

function stageRecord(result: RuntimeResult<unknown>, itemCount: number, requestCount: number): LiveStageRecord {
  return {
    status: result.status === 'capability-missing' ? 'capability-missing' : result.status,
    cause: stageCause(result),
    itemCount,
    requestCount,
    diagnosticCodes: diagnosticCodes(result),
  }
}

function rootStatus(stages: Partial<Record<LiveStageName, LiveStageRecord>>, searchMatched: boolean): LiveSourceRecord['status'] {
  const records = Object.values(stages)
  if (records.some((stage) => stage.cause === 'external-failed')) return 'external-failed'
  if (records.some((stage) => stage.cause === 'rule-unsupported' || stage.status === 'capability-missing')) return 'rule-unsupported'
  if (!searchMatched) return 'search-no-target'
  if (records.length === 4 && records.every((stage) => stage.status === 'success')) return 'fully-supported'
  return 'partial'
}

function sourceSession(): SourceSession {
  const cookieStore = new NodeCookieStore()
  const networkHost = new NodeNetworkHost({ cookieStore })
  const requests = { count: 0 }
  const network: NetworkHost = {
    request: async (plan) => {
      requests.count += 1
      return networkHost.request(plan)
    },
  }
  let requestHost: SourceRequestHost
  const ruleHost = new SourceRuleHost({
    request: (input, signal, source) => requestHost.requestFromBridge(input, signal, source),
  })
  requestHost = new SourceRequestHost({ network, cookieStore })
  requestHost.attachRuleHost(ruleHost)
  const ports: WorkflowPorts = {
    network,
    rules: ruleHost,
    request: (input) => requestHost.request(input),
    decodeResponse: (response) => requestHost.decodeResponse(response),
  }
  return { ports, ruleHost, requestHost, requests }
}

function safeBudget(options: Required<Pick<LiveCompatibilityOptions, 'timeoutMs' | 'maxResponseBytes'>>): Partial<RequestBudget> {
  return {
    timeoutMs: options.timeoutMs,
    maxRequests: 8,
    maxPages: 3,
    maxResponseBytes: options.maxResponseBytes,
    maxTotalBytes: options.maxResponseBytes * 2,
    maxRequestBodyBytes: 1024 * 1024,
    maxRedirects: 3,
  }
}

function itemCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('items' in value)) return value === null || value === undefined ? 0 : 1
  const items = (value as { items?: unknown }).items
  return Array.isArray(items) ? items.length : 0
}

async function runSource(item: SourceFixtureCandidate, staticSource: StaticCompatibilityReport['sources'][number], options: Required<Pick<LiveCompatibilityOptions, 'keyword' | 'maxItems' | 'maxTocPages' | 'maxContentPages' | 'maxResponseBytes' | 'timeoutMs'>> & { signal?: AbortSignal }): Promise<LiveSourceRecord> {
  const source = item.candidate.source
  const base = {
    file: item.file,
    index: item.index,
    candidateId: sourceFixtureCandidateId(item),
    sourceHash: staticSource.sourceHash,
    ...(staticSource.sourceFingerprint === undefined ? {} : { sourceFingerprint: staticSource.sourceFingerprint }),
    name: staticSource.name,
    ...(staticSource.host === undefined ? {} : { host: staticSource.host }),
    staticFlags: staticSource.flags,
  }
  if (source === undefined) return { ...base, status: 'invalid-source', stages: {}, requestCount: 0 }
  if (staticSource.flags.some((flag) => flag === 'sensitive-header' || flag === 'invalid-url' || flag === 'non-http-url' || flag === 'webview')) {
    return { ...base, status: 'blocked-sensitive-config', stages: {}, requestCount: 0 }
  }
  const session = sourceSession()
  const budget = safeBudget(options)
  const workflowOptions = { budget, ...(options.signal === undefined ? {} : { signal: options.signal }) }
  const stages: Partial<Record<LiveStageName, LiveStageRecord>> = {}
  const beforeSearch = session.requests.count
  session.ruleHost.setBindings({ key: options.keyword, page: source.searchPageStart ?? 0 })
  const search = await searchBooks(session.ports, { source, keyword: options.keyword, maxItems: options.maxItems, ...workflowOptions })
  stages.search = stageRecord(search, itemCount(search.value), session.requests.count - beforeSearch)
  const candidates = search.value?.items ?? []
  const targetName = normalizeTitle(options.keyword)
  const candidate = candidates.find((value) => normalizeTitle(value.name ?? '') === targetName)
  if (candidate === undefined) return { ...base, status: rootStatus(stages, false), stages, requestCount: session.requests.count }

  const beforeDetail = session.requests.count
  session.ruleHost.setBindings({ key: options.keyword, page: source.searchPageStart ?? 0, book: candidate })
  const details = await loadBookDetails(session.ports, { source, candidates: [candidate], maxItems: 1, ...workflowOptions })
  stages.detail = stageRecord(details, itemCount(details.value), session.requests.count - beforeDetail)
  const book = details.value?.items[0]
  if (book === undefined) return { ...base, status: rootStatus(stages, true), stages, requestCount: session.requests.count }

  const beforeToc = session.requests.count
  session.ruleHost.setBindings({ key: options.keyword, book })
  const toc = await loadTableOfContents(session.ports, { source, book, maxPages: options.maxTocPages, maxBytes: options.maxResponseBytes, ...workflowOptions })
  stages.toc = stageRecord(toc, itemCount(toc.value), session.requests.count - beforeToc)
  const chapter = toc.value?.items[0]
  if (chapter === undefined) return { ...base, status: rootStatus(stages, true), stages, requestCount: session.requests.count }

  const beforeContent = session.requests.count
  session.ruleHost.setBindings({ key: options.keyword, book, chapter })
  // 跑批同样带上下一章地址，正文分页护栏才会被真正触发（与 CLI 的阅读流程一致）。
  const nextChapter = toc.value?.items[1]?.chapterUrl
  const content = await loadChapterContent(session.ports, { source, chapter, ...(nextChapter === undefined ? {} : { nextChapterUrl: nextChapter }), maxPages: options.maxContentPages, maxBytes: options.maxResponseBytes, maxOutputBytes: options.maxResponseBytes, ...workflowOptions })
  stages.content = stageRecord(content, content.value === null ? 0 : content.value === undefined ? 0 : 1, session.requests.count - beforeContent)
  return { ...base, status: rootStatus(stages, true), stages, requestCount: session.requests.count }
}

function countStatuses(sources: readonly LiveSourceRecord[]): LiveCompatibilityReport['summary'] {
  const stageCounts: Record<string, number> = {}
  for (const source of sources) for (const [stage, value] of Object.entries(source.stages)) {
    const key = `${stage}:${value?.status ?? 'missing'}`
    stageCounts[key] = (stageCounts[key] ?? 0) + 1
  }
  return {
    candidates: sources.length,
    attempted: sources.filter((source) => source.requestCount > 0).length,
    fullySupported: sources.filter((source) => source.status === 'fully-supported').length,
    partial: sources.filter((source) => source.status === 'partial').length,
    ruleUnsupported: sources.filter((source) => source.status === 'rule-unsupported').length,
    externalFailed: sources.filter((source) => source.status === 'external-failed').length,
    searchNoTarget: sources.filter((source) => source.status === 'search-no-target').length,
    blockedSensitiveConfig: sources.filter((source) => source.status === 'blocked-sensitive-config').length,
    invalidSource: sources.filter((source) => source.status === 'invalid-source').length,
    stageCounts,
  }
}

export async function runLiveCompatibility(items: readonly SourceFixtureCandidate[], staticReport: StaticCompatibilityReport, input: LiveCompatibilityOptions = {}): Promise<LiveCompatibilityReport> {
  const options = {
    keyword: input.keyword ?? '我本无意成仙',
    maxSources: input.maxSources ?? null,
    maxItems: input.maxItems ?? 5,
    maxTocPages: input.maxTocPages ?? 3,
    maxContentPages: input.maxContentPages ?? 3,
    maxResponseBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
    timeoutMs: input.timeoutMs ?? 10000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
  const selected = options.maxSources === null ? items : items.slice(0, options.maxSources)
  const staticById = new Map(staticReport.sources.map((source) => [source.candidateId, source]))
  const limiter = new KeyedConcurrencyHost({ maxConcurrent: 4, maxConcurrentPerKey: 1 })
  const records = await Promise.all(selected.map((item) => {
    const candidateId = sourceFixtureCandidateId(item)
    const staticSource = staticById.get(candidateId)
    const fallback = staticSource ?? { file: item.file, index: item.index, candidateId, sourceHash: '', name: '', status: 'invalid' as const, importDiagnostics: [], ruleCount: 0, compiledRuleCount: 0, parseable: false, compileDiagnostics: {}, capabilities: [], flags: ['invalid-source'] }
    return limiter.run(staticSource?.host ?? candidateId, async (signal) => {
      try {
        return await runSource(item, fallback, { ...options, signal })
      } catch {
        return {
          file: item.file,
          index: item.index,
          candidateId,
          sourceHash: fallback.sourceHash,
          ...(fallback.sourceFingerprint === undefined ? {} : { sourceFingerprint: fallback.sourceFingerprint }),
          name: fallback.name,
          ...(fallback.host === undefined ? {} : { host: fallback.host }),
          staticFlags: fallback.flags,
          status: 'external-failed' as const,
          stages: { search: { status: 'failed' as const, cause: 'external-failed' as const, itemCount: 0, requestCount: 0, diagnosticCodes: ['runner-error'] } },
          requestCount: 0,
        }
      }
    }, options.signal)
  }))
  const summary = countStatuses(records)
  return {
    version: 1,
    keyword: options.keyword,
    generatedAt: new Date().toISOString(),
    limits: { maxSources: options.maxSources, maxItems: options.maxItems, maxTocPages: options.maxTocPages, maxContentPages: options.maxContentPages, maxResponseBytes: options.maxResponseBytes },
    summary,
    sources: records,
  }
}
