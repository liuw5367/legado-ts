import { randomUUID } from 'node:crypto'
import type { BookCandidate, BookMetadata } from '@legado/source-core'
import type { ReaderSourceSession, SourceCheckResult } from './application-model.ts'
import type { SourceEntry } from './source-catalog.ts'
import type { SourceCheckConfig, SourceCheckStageRecord } from './storage.ts'

export interface SourceCheckInput {
  entry: SourceEntry
  session: ReaderSourceSession | undefined
  config: SourceCheckConfig
  keyword?: string
  signal?: AbortSignal
  onStage?: (stage: string) => void
}

export async function checkSource(input: SourceCheckInput): Promise<SourceCheckResult> {
  const startedAt = new Date().toISOString()
  const startedClock = Date.now()
  const sessionId = randomUUID()
  const stages: SourceCheckStageRecord[] = []
  const failedStages: string[] = []
  const keyword = sourceCheckKeyword(input.entry.source, input.keyword?.trim() || input.config.keyword)
  const signal = input.signal
  const fail = (stage: SourceCheckStageRecord['stage'], detail: string): void => {
    stages.push({ stage, status: 'failed', detail })
    failedStages.push(stage)
  }
  const pass = (stage: SourceCheckStageRecord['stage'], durationMs: number): void => { stages.push({ stage, status: 'passed', durationMs }) }
  if (input.entry.state === 'unsupported' || input.entry.state === 'conflict') {
    return result(input, sessionId, startedAt, startedClock, 'capability-missing', '书源定义不可执行', stages, ['search'])
  }
  if (signal?.aborted === true) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
  const deadline = timeoutController(signal, input.config.timeoutMs)
  try {
    if (input.config.checkDomain) {
      input.onStage?.('domain')
      const domainStarted = Date.now()
      const domain = await checkDomain(input.entry.source.bookSourceUrl, deadline.signal)
      if (deadline.cancelled()) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
      if (deadline.timedOut()) {
        fail('domain', '校验超时')
        return result(input, sessionId, startedAt, startedClock, 'failed', '校验超时', stages, failedStages)
      }
      if (!domain.ok) {
        fail('domain', domain.message)
        return result(input, sessionId, startedAt, startedClock, 'failed', domain.message, stages, failedStages)
      }
      pass('domain', Date.now() - domainStarted)
    }
    if (input.config.checkSearch) {
      input.onStage?.('search')
      const stageStarted = Date.now()
      if (hasMainJs(input.entry.source.mainJs) || hasText(input.entry.source.searchUrl)) {
        const search = await input.session?.search(keyword, deadline.signal)
        if (deadline.cancelled()) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
        if (deadline.timedOut()) {
          fail('search', '校验超时')
          return result(input, sessionId, startedAt, startedClock, 'failed', '校验超时', stages, failedStages)
        }
        if (search?.value?.items[0] !== undefined) {
          pass('search', Date.now() - stageStarted)
          const outcome = await checkBookBranch(input, 'search', search.value.items[0], deadline, stages, failedStages)
          if (outcome === 'cancelled') return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
        } else if (search?.status === 'cancelled' || deadline.signal.aborted) {
          if (deadline.cancelled()) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
          fail('search', deadline.timedOut() ? '校验超时' : '搜索已取消')
          return result(input, sessionId, startedAt, startedClock, 'failed', deadline.timedOut() ? '校验超时' : '搜索已取消', stages, failedStages)
        } else {
          fail('search', search?.diagnostics[0]?.message ?? '搜索失效')
        }
      } else {
        fail('search', '搜索链接规则为空')
      }
    }
    if (input.config.checkDiscovery && hasExploreUrl(input.entry.source.exploreUrl)) {
      input.onStage?.('discovery')
      const stageStarted = Date.now()
      const discovery = await input.session?.discover?.(deadline.signal)
      if (deadline.cancelled()) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
      if (deadline.timedOut()) {
        fail('discovery', '校验超时')
        return result(input, sessionId, startedAt, startedClock, 'failed', '校验超时', stages, failedStages)
      }
      if (discovery?.value?.items[0] !== undefined) {
        pass('discovery', Date.now() - stageStarted)
        const outcome = await checkBookBranch(input, 'discovery', discovery.value.items[0], deadline, stages, failedStages)
        if (outcome === 'cancelled') return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
      } else if (discovery?.status === 'cancelled' || deadline.signal.aborted) {
        if (deadline.cancelled()) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
        fail('discovery', deadline.timedOut() ? '校验超时' : '发现已取消')
        return result(input, sessionId, startedAt, startedClock, 'failed', deadline.timedOut() ? '校验超时' : '发现已取消', stages, failedStages)
      } else {
        fail('discovery', discovery?.diagnostics[0]?.message ?? '发现失效')
      }
    }
    if (!input.config.checkSearch && !input.config.checkDiscovery) {
      stages.push({ stage: 'search', status: 'skipped', detail: '搜索和发现均未启用' })
    }
    const status = failedStages.length === 0 ? 'passed' : 'failed'
    return result(input, sessionId, startedAt, startedClock, status, failedStages.length === 0 ? '校验成功' : failedStages.join('、'), stages, failedStages)
  } catch (error) {
    if (deadline.cancelled()) return cancelled(input, sessionId, startedAt, startedClock, stages, failedStages)
    if (deadline.timedOut()) {
      failedStages.push('timeout')
      return result(input, sessionId, startedAt, startedClock, 'failed', '校验超时', stages, failedStages)
    }
    const detail = error instanceof Error ? error.message : String(error)
    failedStages.push('request')
    return result(input, sessionId, startedAt, startedClock, 'failed', detail, stages, failedStages)
  } finally {
    deadline.dispose()
  }
}

interface CheckDeadline {
  signal: AbortSignal
  cancelled: () => boolean
  timedOut: () => boolean
}

async function checkBookBranch(input: SourceCheckInput, branch: 'search' | 'discovery', candidate: BookCandidate, deadline: CheckDeadline, stages: SourceCheckStageRecord[], failedStages: string[]): Promise<'done' | 'cancelled'> {
  const signal = deadline.signal
  if (!input.config.checkInfo) {
    stages.push({ stage: 'book-info', status: 'skipped' })
    return 'done'
  }
  let book: BookMetadata
  if (typeof candidate.tocUrl === 'string' && candidate.tocUrl.length > 0) {
    book = { ...candidate, emptyFields: [], fieldErrors: {} }
    stages.push({ stage: 'book-info', status: 'skipped', detail: '书籍结果已带目录地址' })
  } else {
    const session = input.session
    if (session === undefined) {
      failedStages.push(`${branch}:book-info`)
      stages.push({ stage: 'book-info', status: 'failed', detail: '书源会话不可用' })
      return 'done'
    }
    input.onStage?.(`${branch}:book-info`)
    const started = Date.now()
    const result = await session.detail(candidate, signal)
    if (result.status === 'cancelled' || signal.aborted) {
      if (deadline.cancelled()) return 'cancelled'
      failedStages.push(`${branch}:book-info`)
      stages.push({ stage: 'book-info', status: 'failed', detail: deadline.timedOut() ? '校验超时' : '详情已取消', durationMs: Date.now() - started })
      return 'done'
    }
    if (deadline.timedOut()) {
      failedStages.push(`${branch}:book-info`)
      stages.push({ stage: 'book-info', status: 'failed', detail: '校验超时', durationMs: Date.now() - started })
      return 'done'
    }
    const metadata = result.value?.items[0]
    if (metadata === undefined) {
      failedStages.push(`${branch}:book-info`)
      stages.push({ stage: 'book-info', status: 'failed', detail: result.diagnostics[0]?.message ?? '详情失效', durationMs: Date.now() - started })
      return 'done'
    }
    book = metadata
    stages.push({ stage: 'book-info', status: 'passed', durationMs: Date.now() - started })
  }
  if (!input.config.checkCategory || input.entry.source.bookSourceType !== 0) {
    stages.push({ stage: 'toc', status: 'skipped' }, { stage: 'content', status: 'skipped' })
    return 'done'
  }
  input.onStage?.(`${branch}:toc`)
  const tocStarted = Date.now()
  const session = input.session
  if (session === undefined) {
    failedStages.push(`${branch}:toc`)
    stages.push({ stage: 'toc', status: 'failed', detail: '书源会话不可用' })
    return 'done'
  }
  const toc = await session.toc(book, signal, { refresh: true })
  if (toc.status === 'cancelled' || signal.aborted) {
    if (deadline.cancelled()) return 'cancelled'
    failedStages.push(`${branch}:toc`)
    stages.push({ stage: 'toc', status: 'failed', detail: deadline.timedOut() ? '校验超时' : '目录已取消' })
    return 'done'
  }
  if (deadline.timedOut()) {
    failedStages.push(`${branch}:toc`)
    stages.push({ stage: 'toc', status: 'failed', detail: '校验超时' })
    return 'done'
  }
  const readable = (toc.value?.items ?? []).filter((chapter) => !(chapter.isVolume === true && chapter.chapterUrl.startsWith(chapter.title))).slice(0, 2)
  if (toc.status === 'failed' || toc.status === 'capability-missing' || readable[0] === undefined) {
    failedStages.push(`${branch}:toc`)
    stages.push({ stage: 'toc', status: 'failed', detail: toc.diagnostics[0]?.message ?? '目录失效', durationMs: Date.now() - tocStarted })
    return 'done'
  }
  stages.push({ stage: 'toc', status: 'passed', durationMs: Date.now() - tocStarted })
  if (!input.config.checkContent) {
    stages.push({ stage: 'content', status: 'skipped' })
    return 'done'
  }
  input.onStage?.(`${branch}:content`)
  const contentStarted = Date.now()
  const nextChapter = readable[1] ?? readable[0]
  const content = await session.content(readable[0], book, signal, { refresh: true, nextChapterUrl: nextChapter.chapterUrl })
  if (content.status === 'cancelled' || signal.aborted) {
    if (deadline.cancelled()) return 'cancelled'
    failedStages.push(`${branch}:content`)
    stages.push({ stage: 'content', status: 'failed', detail: deadline.timedOut() ? '校验超时' : '正文已取消' })
    return 'done'
  }
  if (deadline.timedOut()) {
    failedStages.push(`${branch}:content`)
    stages.push({ stage: 'content', status: 'failed', detail: '校验超时' })
    return 'done'
  }
  if (content.value?.cleaned.trim().length === 0) {
    failedStages.push(`${branch}:content`)
    stages.push({ stage: 'content', status: 'failed', detail: content.diagnostics[0]?.message ?? '正文失效', durationMs: Date.now() - contentStarted })
  } else {
    stages.push({ stage: 'content', status: 'passed', durationMs: Date.now() - contentStarted })
  }
  return 'done'
}

function result(input: SourceCheckInput, sessionId: string, startedAt: string, startedClock: number, status: SourceCheckResult['status'], detail: string, stages: SourceCheckStageRecord[], failedStages: string[]): SourceCheckResult {
  const durationMs = Date.now() - startedClock
  return { sourceId: input.entry.source.bookSourceUrl, sourceName: input.entry.source.bookSourceName, fingerprint: input.entry.fingerprint, sessionId, status, startedAt, ...(status === 'running' ? {} : { checkedAt: new Date().toISOString() }), durationMs, responseTimeMs: durationMs, detail, failedStages: [...failedStages], stages: [...stages] }
}

function cancelled(input: SourceCheckInput, sessionId: string, startedAt: string, startedClock: number, stages: SourceCheckStageRecord[], failedStages: string[]): SourceCheckResult {
  return result(input, sessionId, startedAt, startedClock, 'cancelled', '校验已取消', stages, failedStages)
}

function sourceCheckKeyword(source: Record<string, unknown>, fallback: string): string {
  const ruleSearch = source.ruleSearch
  const candidate = typeof ruleSearch === 'object' && ruleSearch !== null ? (ruleSearch as Record<string, unknown>).checkKeyWord : undefined
  return typeof candidate === 'string' && candidate.trim().length > 0 && !candidate.includes('http') && !candidate.includes('::') && !candidate.includes('++') && !candidate.includes('--') ? candidate.trim() : fallback.trim() || '我的'
}

function hasExploreUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasMainJs(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function timeoutController(parent: AbortSignal | undefined, timeoutMs: number): CheckDeadline & { dispose: () => void } {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = parent?.aborted === true
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const relay = (): void => { cancelled = true; controller.abort() }
  if (cancelled) controller.abort()
  else parent?.addEventListener('abort', relay, { once: true })
  return { signal: controller.signal, cancelled: () => cancelled, timedOut: () => timedOut, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', relay) } }
}

async function checkDomain(raw: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  if (signal.aborted) return { ok: false, message: '校验已取消' }
  let url: URL
  try { url = new URL(raw.split('#', 1)[0]!) } catch { return { ok: false, message: '源地址不是http链接' } }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, message: '源地址不是http链接' }
  const { connect } = await import('node:net')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port })
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, message: '域名失效' }) }, 1600)
    const finish = (result: { ok: true } | { ok: false; message: string }): void => { clearTimeout(timer); socket.destroy(); resolve(result) }
    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', () => finish({ ok: false, message: '域名失效' }))
    signal.addEventListener('abort', () => finish({ ok: false, message: '校验已取消' }), { once: true })
  })
}
