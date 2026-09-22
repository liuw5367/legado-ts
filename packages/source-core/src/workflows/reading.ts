import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { evaluateField, jsonValue, requestPage, ruleString, sourceNumber, sourceString, statusFromDiagnostics, textValue } from './helpers.ts'
import type { Chapter, ChapterContent, ContentInput, ContentResource, ReadingPorts, RuntimeResult, TocInput, WorkflowDiagnostic, WorkflowOptions, WorkflowPage, WorkflowStage, WorkflowTraceEntry } from './types.ts'

export async function loadTableOfContents(ports: ReadingPorts, input: TocInput): Promise<RuntimeResult<WorkflowPage<Chapter>>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const cursor = input.cursor ?? { index: 0 }
  const listRule = ruleString(input.source, 'ruleToc', 'chapterList')
  if (listRule === undefined) {
    diagnostics.push({ code: 'invalid-config', stage, message: '缺少 chapterList 规则', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const maxPages = input.maxPages ?? sourceNumber(input.source, 'tocMaxPages') ?? 32
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024
  const visited = new Set<string>()
  const chapters: Chapter[] = []
  const identities = new Set<string>()
  const pageBodies = new Set<string>()
  const bookBaseUrl = resolveUrl(input.book.tocUrl ?? input.book.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  let pageUrl = bookBaseUrl
  let totalBytes = 0
  let volume: string | undefined
  let nextPagePending = false
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (input.signal?.aborted === true) return cancelled('目录工作流已取消', diagnostics, trace)
    nextPagePending = false
    const normalizedUrl = resolveUrl(pageUrl, input.source.bookSourceUrl)
    if (normalizedUrl === undefined) {
      diagnostics.push({ code: 'item-skipped', stage, message: '目录下一页 URL 无效', retryable: false })
      break
    }
    if (visited.has(normalizedUrl)) {
      diagnostics.push({ code: 'item-skipped', stage, message: '目录下一页形成循环', retryable: false })
      break
    }
    visited.add(normalizedUrl)
    const body = await cachedPage(ports, input.source, normalizedUrl, 'toc', stage, pageOptions(input, maxBytes, totalBytes), diagnostics, trace)
    if (body === undefined) break
    totalBytes += new TextEncoder().encode(body).byteLength
    if (totalBytes > maxBytes) {
      diagnostics.push({ code: 'item-skipped', stage, message: '目录累计响应超过字节预算', retryable: false })
      break
    }
    if (pageBodies.has(body)) {
      diagnostics.push({ code: 'item-skipped', stage, message: '目录重复页面已停止', retryable: false })
      break
    }
    pageBodies.add(body)
    const list = await evaluateField(ports, input.source, stage, 'chapterList', listRule, body, pageIndex, trace, input.signal)
    if (list.state === 'cancelled') return cancelled('目录规则执行已取消', diagnostics, trace)
    if (list.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage, field: 'chapterList', message: list.message ?? '目录规则能力不可用', retryable: false })
      break
    }
    if (list.state === 'failed') {
      diagnostics.push({ code: 'rule-failed', stage, field: 'chapterList', message: list.message ?? '目录规则失败', retryable: false })
      break
    }
    const rawItems = Array.isArray(list.value) ? list.value : list.state === 'value' ? [list.value] : []
    for (const [itemIndex, rawItem] of rawItems.entries()) {
      const fields = await chapterFields(ports, input.source, rawItem, pageIndex * 100000 + itemIndex, input.signal, diagnostics, trace, volume)
      if (input.signal !== undefined && input.signal.aborted) return cancelled('目录工作流已取消', diagnostics, trace)
      if (fields.volume !== undefined && fields.volume.length > 0) volume = fields.volume
      if (fields.url === undefined || fields.url.length === 0 || fields.title === undefined || fields.title.length === 0) {
        diagnostics.push({ code: 'identity-missing', stage, itemIndex, message: '章节缺少标题或 URL', retryable: false })
        continue
      }
      const chapterUrl = resolveUrl(fields.url, bookBaseUrl)
      if (chapterUrl === undefined) {
        diagnostics.push({ code: 'item-skipped', stage, itemIndex, message: '章节 URL 无效', retryable: false })
        continue
      }
      const identityKey = `${input.source.bookSourceUrl}\u0000${input.book.bookUrl}\u0000${chapterUrl}`
      if (identities.has(identityKey)) {
        diagnostics.push({ code: 'duplicate-item', stage, itemIndex, message: '重复章节已折叠', retryable: false })
        continue
      }
      identities.add(identityKey)
      const chapter: Chapter = { sourceId: input.source.bookSourceUrl, bookUrl: input.book.bookUrl, chapterUrl, index: chapters.length, title: fields.title, rawFields: fields.rawFields, traceRef: `toc:${chapters.length}` }
      if (volume !== undefined) chapter.volume = volume
      chapters.push(chapter)
      trace.push({ stage, event: 'candidate', target: `chapter:${chapter.index}`, itemIndex })
    }
    const nextRule = ruleString(input.source, 'ruleToc', 'nextPage')
    if (nextRule === undefined) break
    const next = await evaluateField(ports, input.source, stage, 'nextPage', nextRule, body, pageIndex, trace, input.signal)
    if (next.state === 'cancelled') return cancelled('目录下一页规则已取消', diagnostics, trace)
    if (next.state !== 'value' || textValue(next.value).length === 0) break
    const nextUrl = resolveUrl(textValue(next.value), normalizedUrl)
    if (nextUrl === undefined) {
      diagnostics.push({ code: 'item-skipped', stage, field: 'nextPage', message: '目录下一页 URL 无效', retryable: false })
      break
    }
    pageUrl = nextUrl
    nextPagePending = true
  }
  if (pageUrl !== input.book.bookUrl && visited.size >= maxPages) diagnostics.push({ code: 'item-skipped', stage, message: '目录页数超过限制', retryable: false })
  if (input.source.reverseToc === true) chapters.reverse()
  if (chapters.length === 0) diagnostics.push({ code: 'empty-page', stage, message: '目录为空', retryable: false })
  const value: WorkflowPage<Chapter> = { items: chapters, cursor, ...(nextPagePending && visited.size >= maxPages ? { nextCursor: { index: cursor.index + 1 } } : {}) }
  const status = chapters.length === 0 && diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed') ? 'failed' : statusFromDiagnostics(diagnostics, chapters.length)
  return { status, value, diagnostics, trace }
}

export async function loadChapterContent(ports: ReadingPorts, input: ContentInput): Promise<RuntimeResult<ChapterContent>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const contentRule = ruleString(input.source, 'ruleContent', 'content') ?? sourceString(input.source, 'ruleContent')
  if (contentRule === undefined) {
    diagnostics.push({ code: 'invalid-config', stage, message: '缺少正文规则', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const contentType = input.contentType ?? (input.source.contentType === 'html' ? 'html' : 'text')
  const maxPages = input.maxPages ?? sourceNumber(input.source, 'contentMaxPages') ?? 32
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024
  const maxOutputBytes = input.maxOutputBytes ?? 4 * 1024 * 1024
  const visited = new Set<string>()
  const seenPages = new Set<string>()
  const pages: string[] = []
  const resources: ContentResource[] = []
  const bookUrl = resolveUrl(input.chapter.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  let pageUrl = resolveUrl(input.chapter.chapterUrl, bookUrl) ?? input.chapter.chapterUrl
  const contentBaseUrl = resolveUrl(pageUrl, bookUrl) ?? bookUrl
  let totalBytes = 0
  let stoppedByLimit = false
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (input.signal?.aborted === true) return cancelled('正文工作流已取消', diagnostics, trace)
    const normalizedUrl = resolveUrl(pageUrl, bookUrl)
    if (normalizedUrl === undefined) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文下一页 URL 无效', retryable: false })
      stoppedByLimit = true
      break
    }
    if (visited.has(normalizedUrl)) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文下一页形成循环', retryable: false })
      stoppedByLimit = true
      break
    }
    visited.add(normalizedUrl)
    const body = await cachedPage(ports, input.source, normalizedUrl, 'content', stage, pageOptions(input, maxBytes, totalBytes), diagnostics, trace)
    if (body === undefined) break
    totalBytes += new TextEncoder().encode(body).byteLength
    if (totalBytes > maxBytes) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文累计响应超过字节预算', retryable: false })
      stoppedByLimit = true
      break
    }
    const result = await evaluateField(ports, input.source, stage, 'content', contentRule, body, pageIndex, trace, input.signal)
    if (result.state === 'cancelled') return cancelled('正文规则执行已取消', diagnostics, trace)
    if (result.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage, field: 'content', message: result.message ?? '正文规则能力不可用', retryable: false })
      break
    }
    if (result.state === 'failed') {
      diagnostics.push({ code: 'rule-failed', stage, field: 'content', message: result.message ?? '正文规则失败', retryable: false })
      break
    }
    const page = result.state === 'value' ? textValue(result.value) : ''
    if (page.length > 0 && seenPages.has(page)) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文重复页面已停止', retryable: false })
      stoppedByLimit = true
      break
    }
    if (page.length > 0) {
      seenPages.add(page)
      pages.push(page)
      resources.push(...extractResources(page, contentType, normalizedUrl))
    }
    const nextRule = ruleString(input.source, 'ruleContent', 'nextPage')
    if (nextRule === undefined) break
    const next = await evaluateField(ports, input.source, stage, 'nextPage', nextRule, body, pageIndex, trace, input.signal)
    if (next.state === 'cancelled') return cancelled('正文下一页规则已取消', diagnostics, trace)
    if (next.state !== 'value' || textValue(next.value).length === 0) break
    const nextUrl = resolveUrl(textValue(next.value), normalizedUrl)
    if (nextUrl === undefined) {
      diagnostics.push({ code: 'item-skipped', stage, field: 'nextPage', message: '正文下一页 URL 无效', retryable: false })
      stoppedByLimit = true
      break
    }
    pageUrl = nextUrl
  }
  if (visited.size >= maxPages) stoppedByLimit = true
  const raw = pages.join(contentType === 'html' ? '\n' : '\n\n')
  let replaced = raw
  try {
    replaced = applyReplacements(raw, input.replacements ?? [])
  } catch {
    diagnostics.push({ code: 'item-skipped', stage, message: '正文替换规则无效', retryable: false })
    stoppedByLimit = true
  }
  const cleaned = cleanContent(replaced, contentType, contentBaseUrl)
  const outputBytes = new TextEncoder().encode(cleaned).byteLength
  if (outputBytes > maxOutputBytes) {
    diagnostics.push({ code: 'item-skipped', stage, message: '正文清洗结果超过输出预算', retryable: false })
    stoppedByLimit = true
  }
  if (cleaned.length === 0) {
    diagnostics.push({ code: 'empty-page', stage, message: '正文为空', retryable: false })
    return { status: diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed') ? 'failed' : 'empty', value: null, diagnostics, trace }
  }
  const value: ChapterContent = { chapter: input.chapter, contentType, raw, cleaned, pages, resources: uniqueResources(resources) }
  const status = stoppedByLimit || diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed' || item.code === 'item-skipped') ? 'partial' : 'success'
  return { status, value, diagnostics, trace }
}

async function cachedPage(ports: ReadingPorts, source: NormalizedSource, url: string, scope: 'toc' | 'content', stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<string | undefined> {
  const cacheKey = `${source.bookSourceUrl}\u0000${scope}\u0000${url}`
  if (ports.cache !== undefined) {
    try {
      const cached = await ports.cache.get(cacheKey, options.signal)
      if (cached !== undefined) return cached
    } catch {
      // 缓存失败不得改变无缓存读取语义。
    }
  }
  const value = await requestPage(ports, source, url, stage, options, diagnostics, trace)
  if (value !== undefined && ports.cache !== undefined) {
    try {
      await ports.cache.set(cacheKey, value, options.signal)
    } catch {
      // 缓存写入失败只影响缓存，不影响本次结果。
    }
  }
  return value
}

function pageOptions(options: WorkflowOptions, maxBytes: number, usedBytes: number): WorkflowOptions {
  const remaining = Math.max(0, maxBytes - usedBytes)
  const budget = { ...options.budget, maxTotalBytes: Math.min(options.budget?.maxTotalBytes ?? remaining, remaining) }
  return { ...options, budget }
}

interface ChapterFields {
  title?: string
  url?: string
  volume?: string
  rawFields: JsonObject
}

async function chapterFields(ports: ReadingPorts, source: NormalizedSource, content: unknown, itemIndex: number, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], inheritedVolume: string | undefined): Promise<ChapterFields> {
  const result: ChapterFields = { rawFields: {} }
  for (const [ruleField, outputField] of [['chapterName', 'title'], ['chapterUrl', 'url'], ['chapterVolume', 'volume']] as const) {
    const rule = ruleString(source, 'ruleToc', ruleField)
    if (rule === undefined) continue
    const field = await evaluateField(ports, source, 'detail', ruleField, rule, content, itemIndex, trace, signal)
    if (field.state === 'cancelled') return result
    if (field.state === 'failed' || field.state === 'capability-missing') {
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage: 'detail', field: ruleField, itemIndex, message: field.message ?? '章节字段失败', retryable: false })
      continue
    }
    if (field.state === 'value') {
      const value = textValue(field.value)
      result.rawFields[outputField] = jsonValue(field.value)
      if (outputField === 'title') result.title = value
      if (outputField === 'url') result.url = value
      if (outputField === 'volume') result.volume = value
    }
  }
  if (result.volume === undefined && inheritedVolume !== undefined) result.volume = inheritedVolume
  return result
}

function cleanContent(value: string, contentType: 'text' | 'html', baseUrl: string): string {
  if (contentType === 'text') return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return value.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/\s+(src|data-src)=(['"])(.*?)\2/gi, (_match, name: string, quote: string, url: string) => ` ${name}=${quote}${resolveResource(url, baseUrl)}${quote}`).trim()
}

function applyReplacements(value: string, replacements: readonly { pattern: string; replacement: string; all?: boolean }[]): string {
  return replacements.reduce((result, item) => result.replace(new RegExp(item.pattern, item.all === false ? '' : 'g'), item.replacement), value)
}

function extractResources(value: string, contentType: 'text' | 'html', baseUrl: string): ContentResource[] {
  if (contentType !== 'html') return []
  const result: ContentResource[] = []
  for (const match of value.matchAll(/<(?:img|image)\b[^>]*(?:src|data-src)=(['"])(.*?)\1/gi)) {
    const url = resolveResource(match[2] ?? '', baseUrl)
    if (url.length > 0) result.push({ kind: 'image', url })
  }
  return result
}

function resolveResource(value: string, baseUrl: string): string {
  if (value.length === 0) return ''
  if (value.startsWith('data:')) return value
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

function resolveUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return undefined
  }
}

function uniqueResources(resources: readonly ContentResource[]): ContentResource[] {
  const seen = new Set<string>()
  return resources.filter((resource) => !seen.has(resource.url) && seen.add(resource.url))
}

function cancelled(message: string, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): RuntimeResult<never> {
  diagnostics.push({ code: 'cancelled', stage: 'detail', message, retryable: false })
  return { status: 'cancelled', value: null, diagnostics, trace }
}
