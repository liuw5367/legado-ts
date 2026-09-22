import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { evaluateField, jsonValue, requestPageResponse, ruleString, sourceNumber, sourceString, statusFromDiagnostics, textValue } from './helpers.ts'
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
  const pageBodies = new Set<string>()
  const reverseByRule = listRule.startsWith('-')
  const bookBaseUrl = resolveUrl(input.book.tocUrl ?? input.book.bookUrl, input.source.bookSourceUrl)
    ?? resolveUrl(input.book.bookUrl, input.source.bookSourceUrl)
    ?? input.source.bookSourceUrl
  const pendingPages = [{ url: bookBaseUrl, followNext: true }]
  let totalBytes = 0
  let volume: string | undefined
  const listRuleBody = normalizeChapterListRule(listRule)
  for (let pageIndex = 0; pageIndex < maxPages && pendingPages.length > 0; pageIndex += 1) {
    if (input.signal?.aborted === true) return cancelled('目录工作流已取消', diagnostics, trace)
    const pendingPage = pendingPages.shift()!
    const pageUrl = pendingPage.url
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
    const page = pageIndex === 0 && input.book.tocHtml !== undefined && normalizedUrl === bookBaseUrl
      ? { body: input.book.tocHtml, url: normalizedUrl }
      : await cachedPage(ports, input.source, normalizedUrl, 'toc', stage, pageOptions(input, maxBytes, totalBytes), diagnostics, trace)
    if (page === undefined) break
    const body = page.body
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
    const responseUrl = resolveUrl(page.url, normalizedUrl) ?? normalizedUrl
    visited.add(responseUrl)
    const context = { baseUrl: normalizedUrl, redirectUrl: responseUrl }
    const list = await evaluateField(ports, input.source, stage, 'chapterList', listRuleBody, body, pageIndex, trace, input.signal, context)
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
      const fields = await chapterFields(ports, input.source, rawItem, pageIndex * 100000 + itemIndex, input.signal, diagnostics, trace, volume, context)
      if (input.signal !== undefined && input.signal.aborted) return cancelled('目录工作流已取消', diagnostics, trace)
      if (fields.volume !== undefined && fields.volume.length > 0) volume = fields.volume
      if (fields.title === undefined || fields.title.length === 0) {
        diagnostics.push({ code: 'identity-missing', stage, itemIndex, message: '章节缺少标题', retryable: false })
        continue
      }
      const chapterUrl = fields.url === undefined || fields.url.length === 0 ? normalizedUrl : resolveUrl(fields.url, responseUrl)
      if (chapterUrl === undefined) {
        diagnostics.push({ code: 'item-skipped', stage, itemIndex, message: '章节 URL 无效', retryable: false })
        continue
      }
      const chapter: Chapter = { sourceId: input.source.bookSourceUrl, bookUrl: input.book.bookUrl, chapterUrl, index: chapters.length, title: fields.title, rawFields: fields.rawFields, traceRef: `toc:${chapters.length}` }
      if (volume !== undefined) chapter.volume = volume
      chapters.push(chapter)
      trace.push({ stage, event: 'candidate', target: `chapter:${chapter.index}`, itemIndex })
    }
    if (!pendingPage.followNext) continue
    const nextRule = ruleString(input.source, 'ruleToc', 'nextTocUrl')
    if (nextRule === undefined) continue
    const next = await evaluateField(ports, input.source, stage, 'nextTocUrl', nextRule, body, pageIndex, trace, input.signal, context)
    if (next.state === 'cancelled') return cancelled('目录下一页规则已取消', diagnostics, trace)
    if (next.state !== 'value') continue
    const nextValues = listValues(next.value)
    for (const value of nextValues) {
      const nextUrl = resolveUrl(value, responseUrl)
      if (nextUrl === undefined) {
        diagnostics.push({ code: 'item-skipped', stage, field: 'nextTocUrl', message: '目录下一页 URL 无效', retryable: false })
        continue
      }
      if (!visited.has(nextUrl) && !pendingPages.some((item) => item.url === nextUrl)) pendingPages.push({ url: nextUrl, followNext: nextValues.length === 1 })
    }
  }
  if (pendingPages.length > 0 && visited.size >= maxPages) diagnostics.push({ code: 'item-skipped', stage, message: '目录页数超过限制', retryable: false })
  if (!reverseByRule) chapters.reverse()
  const uniqueChapters = deduplicateChapters(chapters, diagnostics, stage)
  if (input.source.reverseToc !== true) uniqueChapters.reverse()
  uniqueChapters.forEach((chapter, index) => { chapter.index = index })
  if (uniqueChapters.length === 0) diagnostics.push({ code: 'empty-page', stage, message: '目录为空', retryable: false })
  const value: WorkflowPage<Chapter> = { items: uniqueChapters, cursor, ...(pendingPages.length > 0 ? { nextCursor: { index: cursor.index + 1 } } : {}) }
  const status = uniqueChapters.length === 0 && diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed') ? 'failed' : statusFromDiagnostics(diagnostics, uniqueChapters.length)
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
  const contentType = input.contentType ?? (input.source.contentType === 'html' || ruleReturnsHtml(contentRule) ? 'html' : 'text')
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
    const page = await cachedPage(ports, input.source, normalizedUrl, 'content', stage, pageOptions(input, maxBytes, totalBytes), diagnostics, trace)
    if (page === undefined) break
    const body = page.body
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
    const contentPage = result.state === 'value' ? textValue(result.value) : ''
    if (contentPage.length > 0 && seenPages.has(contentPage)) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文重复页面已停止', retryable: false })
      stoppedByLimit = true
      break
    }
    if (contentPage.length > 0) {
      seenPages.add(contentPage)
      pages.push(contentPage)
      resources.push(...extractResources(contentPage, contentType, normalizedUrl))
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

async function cachedPage(ports: ReadingPorts, source: NormalizedSource, url: string, scope: 'toc' | 'content', stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<{ body: string; url: string } | undefined> {
  const cacheKey = `${source.bookSourceUrl}\u0000${scope}\u0000${url}`
  const responseUrlKey = `${cacheKey}\u0000response-url`
  if (ports.cache !== undefined) {
    try {
      const cached = await ports.cache.get(cacheKey, options.signal)
      if (cached !== undefined) {
        let responseUrl = url
        try {
          responseUrl = await ports.cache.get(responseUrlKey, options.signal) ?? url
        } catch {
          // 旧缓存没有最终响应地址时仍可复用正文。
        }
        return { body: cached, url: responseUrl }
      }
    } catch {
      // 缓存失败不得改变无缓存读取语义。
    }
  }
  const value = await requestPageResponse(ports, source, url, stage, options, diagnostics, trace)
  if (value !== undefined && ports.cache !== undefined) {
    try {
      await ports.cache.set(cacheKey, value.content, options.signal)
      await ports.cache.set(responseUrlKey, value.url, options.signal)
    } catch {
      // 缓存写入失败只影响缓存，不影响本次结果。
    }
  }
  return value === undefined ? undefined : { body: value.content, url: value.url }
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

async function chapterFields(ports: ReadingPorts, source: NormalizedSource, content: unknown, itemIndex: number, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], inheritedVolume: string | undefined, context: { baseUrl: string; redirectUrl: string }): Promise<ChapterFields> {
  const result: ChapterFields = { rawFields: {} }
  for (const [ruleField, outputField] of [['chapterName', 'title'], ['chapterUrl', 'url'], ['chapterVolume', 'volume']] as const) {
    const rule = ruleString(source, 'ruleToc', ruleField)
    if (rule === undefined) continue
    const field = await evaluateField(ports, source, 'detail', ruleField, rule, content, itemIndex, trace, signal, context)
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

function listValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(textValue).filter((item) => item.length > 0)
}

function normalizeChapterListRule(value: string): string {
  let rule = value
  if (rule.startsWith('-')) rule = rule.slice(1)
  if (rule.startsWith('+')) rule = rule.slice(1)
  return rule
}

/** Legado 的 `@html`/`@all` 输出标记本身就是正文类型声明，JS 规则中的 getString 调用也会保留该标记。 */
function ruleReturnsHtml(rule: string): boolean {
  // 输出标记后不能紧跟名称字符，避免把自定义 token（如 `@html5`）误判为 HTML。
  return /@(?:html|all)(?![A-Za-z0-9_-])/iu.test(rule)
}

function deduplicateChapters(chapters: Chapter[], diagnostics: WorkflowDiagnostic[], stage: WorkflowStage): Chapter[] {
  const seen = new Set<string>()
  return chapters.filter((chapter) => {
    if (seen.has(chapter.chapterUrl)) {
      diagnostics.push({ code: 'duplicate-item', stage, itemIndex: chapter.index, message: '重复章节已折叠', retryable: false })
      return false
    }
    seen.add(chapter.chapterUrl)
    return true
  })
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
  if (value.trimStart().startsWith('<')) return undefined
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
