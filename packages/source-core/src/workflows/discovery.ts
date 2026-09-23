import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { compileSourcePattern } from '../rules/pattern-guard.ts'
import type { SourcePatternError } from '../rules/pattern-guard.ts'
import { resolveSourceRequestReference } from '../runtime/request-url.ts'
import { detailFields, evaluateField, expandUrl, expansionDiagnostic, expansionStatus, formatBookAuthor, formatBookName, formatWordCount, jsonValue, listFields, pageResult, requestPageResponse, ruleString, sourceNumber, sourceString, statusFromDiagnostics, textValue } from './helpers.ts'
import type { BookCandidate, BookMetadata, DetailInput, DiscoveryInput, RuntimeResult, SearchInput, WorkflowDiagnostic, WorkflowPage, WorkflowPorts, WorkflowStage, WorkflowTraceEntry } from './types.ts'

export async function discoverBooks(ports: WorkflowPorts, input: DiscoveryInput): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
  const cursor = input.cursor ?? { index: sourceNumber(input.source, 'explorePageStart') ?? 1 }
  const exploreListRule = ruleString(input.source, 'ruleExplore', 'bookList')
  const ruleGroup = exploreListRule?.trim() ? 'ruleExplore' : 'ruleSearch'
  return listWorkflow(
    ports,
    'discover',
    input.source,
    sourceString(input.source, 'exploreUrl'),
    exploreListRule?.trim() ? exploreListRule : ruleString(input.source, 'ruleSearch', 'bookList'),
    ruleString(input.source, ruleGroup, 'nextPage'),
    cursor,
    input,
    undefined,
    ruleGroup,
  )
}

export async function searchBooks(ports: WorkflowPorts, input: SearchInput): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
  if (input.keyword.length === 0) return { status: 'empty', value: { items: [], cursor: input.cursor ?? { index: 1 } }, diagnostics: [{ code: 'invalid-input', stage: 'search', message: '搜索关键词为空', retryable: false }], trace: [] }
  const page = input.cursor?.index ?? sourceNumber(input.source, 'searchPageStart') ?? 1
  return listWorkflow(ports, 'search', input.source, sourceString(input.source, 'searchUrl'), ruleString(input.source, 'ruleSearch', 'bookList'), ruleString(input.source, 'ruleSearch', 'nextPage'), input.cursor ?? { index: page }, input, input.keyword, 'ruleSearch')
}

/** Android BookList：列表规则以 `-` 开头表示解析后反转，`+` 只剥离前缀。 */
function normalizeListRule(value: string): { rule: string; reverse: boolean } {
  if (value.startsWith('-')) return { rule: value.slice(1), reverse: true }
  if (value.startsWith('+')) return { rule: value.slice(1), reverse: false }
  return { rule: value, reverse: false }
}

/**
 * 地址模板是否引用页码变量；没有引用时下一页地址与当前页相同，游标不产生新请求。
 * 覆盖 `{{page}}`/`{{pageIndex}}` 和 Android `<n,m>` 页面数组语法。
 */
function pageTemplateHasNext(url: string, page: number): boolean {
  for (const match of url.matchAll(/\{\{([\s\S]*?)\}\}/g)) if (/\b(?:page|pageIndex)\b/u.test(match[1]!)) return true
  for (const match of url.matchAll(/<([^<>]*)>/g)) {
    const values = match[1]!.split(',').map((value) => value.trim())
    if (values.length < 2) continue
    const current = values[Math.min(page - 1, values.length - 1)] ?? ''
    const next = values[Math.min(page, values.length - 1)] ?? ''
    if (current !== next) return true
  }
  return false
}

/** Android `String.matches`：整个响应地址匹配 bookUrlPattern；非法或越界的正则按不匹配处理，并给出诊断。 */
function matchesBookUrlPattern(pattern: string, url: string): { matched: boolean; error?: SourcePatternError } {
  const compiled = compileSourcePattern(`^(?:${pattern})$`)
  if ('error' in compiled) return { matched: false, error: compiled.error }
  return { matched: compiled.regex.test(url) }
}

async function listWorkflow(ports: WorkflowPorts, stage: 'discover' | 'search', source: NormalizedSource, url: string | undefined, listRule: string | undefined, nextRule: string | undefined, cursor: { index: number; token?: string } | undefined, options: DiscoveryInput | SearchInput, keyword: string | undefined, ruleGroup: 'ruleExplore' | 'ruleSearch'): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const pageCursor = cursor ?? { index: 1 }
  if (url === undefined || listRule === undefined) {
    diagnostics.push({ code: 'invalid-config', stage, message: '缺少列表请求地址或 bookList 规则', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const keywordReplacements = keyword === undefined ? {} : { key: keyword, keyword }
  const expanded = await expandUrl(
    ports,
    source,
    stage,
    url,
    { page: String(pageCursor.index), pageIndex: String(pageCursor.index), 'source.bookSourceUrl': source.bookSourceUrl, ...keywordReplacements },
    { page: pageCursor.index, pageIndex: pageCursor.index, 'source.bookSourceUrl': source.bookSourceUrl, ...keywordReplacements },
    options.signal,
  )
  if (expanded.url === undefined) {
    diagnostics.push(expansionDiagnostic(expanded.error, stage, 'url', '书源 URL 展开失败'))
    return { status: expansionStatus(expanded.error), value: null, diagnostics, trace }
  }
  const page = await requestPageResponse(ports, source, expanded.url, stage, options, diagnostics, trace)
  if (page === undefined) return { status: statusFromDiagnostics(diagnostics, 0), value: null, diagnostics, trace }
  const content = page.content
  const maxItems = options.maxItems
  const pattern = sourceString(source, 'bookUrlPattern')
  const candidates: BookCandidate[] = []
  // searchUrl 命中 bookUrlPattern 时整页按详情页解析；Android 的这个分支只在搜索里判断，
  // 但「已配置 pattern 就不做空列表回退」对搜索和发现都生效（BookList.kt:64,100）。
  const patternMatch = pattern === undefined ? undefined : matchesBookUrlPattern(pattern, page.url)
  if (patternMatch?.error !== undefined) diagnostics.push({ code: 'invalid-config', stage, field: 'bookUrlPattern', message: patternMatch.error.message, retryable: false })
  const detailPage = stage === 'search' && patternMatch?.matched === true
  let rawItems: unknown[] = []
  let reverse = false
  if (!detailPage) {
    const normalized = normalizeListRule(listRule)
    reverse = normalized.reverse
    const list = await evaluateField(ports, source, stage, 'bookList', normalized.rule, content, undefined, trace, options.signal, { expect: 'nodes' })
    if (list.state === 'cancelled') {
      diagnostics.push({ code: 'cancelled', stage, field: 'bookList', message: '工作流已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    if (list.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage, field: 'bookList', message: list.message ?? '列表规则能力不可用', retryable: false })
      return { status: 'capability-missing', value: null, diagnostics, trace }
    }
    if (list.state === 'failed') {
      diagnostics.push({ code: 'rule-failed', stage, field: 'bookList', message: list.message ?? '列表规则失败', retryable: false })
      return { status: 'failed', value: null, diagnostics, trace }
    }
    rawItems = list.state === 'value' && Array.isArray(list.value) ? list.value.filter((item) => item !== null && item !== undefined) : []
    if (list.state === 'value' && !Array.isArray(list.value)) {
      diagnostics.push({ code: 'item-skipped', stage, field: 'bookList', message: 'bookList 规则必须返回列表', retryable: false })
    }
  }
  const identities = new Set<string>()
  for (let itemIndex = 0; itemIndex < rawItems.length && (maxItems === undefined || candidates.length < maxItems); itemIndex += 1) {
    const fields = await extractFields(ports, source, stage, ruleGroup, rawItems[itemIndex], listFields, itemIndex, options.signal, diagnostics, trace)
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    // 相对详情地址按响应地址转绝对；空地址回退响应地址（Android isUrl 语义）。
    const bookUrl = resolveCandidateUrl(fields.bookUrl, page.url)
    if (bookUrl === undefined) {
      diagnostics.push({ code: 'identity-missing', stage, itemIndex, message: '候选缺少书源内详情 URL', retryable: false })
      continue
    }
    const name = formatBookName(fields.name ?? '')
    if (name.length === 0) {
      diagnostics.push({ code: 'identity-missing', stage, itemIndex, message: '候选缺少书名', retryable: false })
      continue
    }
    const author = formatBookAuthor(fields.author ?? '')
    // Android SearchBook.equals 只比较 bookUrl：同地址候选折叠为一条。
    const identityKey = `${source.bookSourceUrl}\u0000${bookUrl}`
    if (identities.has(identityKey)) {
      diagnostics.push({ code: 'duplicate-item', stage, itemIndex, message: '重复候选已折叠', retryable: false })
      continue
    }
    identities.add(identityKey)
    trace.push({ stage, event: 'candidate', target: `candidate:${candidates.length}`, itemIndex })
    const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl, name, rawFields: fields.rawFields, traceRef: `${stage}:${candidates.length}` }
    if (author.length > 0) candidate.author = author
    if (fields.intro !== undefined) candidate.intro = fields.intro
    if (fields.coverUrl !== undefined) candidate.coverUrl = resolveCandidateUrl(fields.coverUrl, page.url) ?? fields.coverUrl
    if (fields.kind !== undefined) candidate.kind = fields.kind
    if (fields.wordCount !== undefined) candidate.wordCount = formatWordCount(fields.wordCount)
    if (fields.lastChapter !== undefined) candidate.lastChapter = fields.lastChapter
    if (fields.updateTime !== undefined) candidate.updateTime = fields.updateTime
    candidates.push(candidate)
  }
  if (candidates.length === 0 && (detailPage || (rawItems.length === 0 && pattern === undefined))) {
    // 列表为空（或命中 bookUrlPattern）时，书源把整个响应当作详情页。
    const fallback = await detailPageCandidate(ports, source, page, options, diagnostics, trace)
    if (fallback.cancelled) {
      // 回退分支内部的字段诊断都属于 detail，这里保持一致。
      diagnostics.push({ code: 'cancelled', stage: 'detail', message: '详情页回退已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    if (fallback.candidate !== undefined) {
      trace.push({ stage, event: 'candidate', target: `candidate:${candidates.length}`, itemIndex: 0 })
      candidates.push(fallback.candidate)
    }
  }
  if (reverse) candidates.reverse()
  if (candidates.length === 0) diagnostics.push({ code: 'empty-page', stage, message: '列表没有可用候选', retryable: false })
  // Android 由调用方递增页码继续翻页；只有地址模板引用页码时下一页才是不同的请求。
  let nextCursor: { index: number; token?: string } | undefined
  if (candidates.length > 0 && pageTemplateHasNext(url, pageCursor.index)) nextCursor = { index: pageCursor.index + 1 }
  if (nextRule !== undefined) {
    const next = await evaluateField(ports, source, stage, 'nextPage', nextRule, content, undefined, trace, options.signal)
    if (next.state === 'cancelled') {
      diagnostics.push({ code: 'cancelled', stage, field: 'nextPage', message: '工作流已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    if (next.state === 'value') nextCursor = { index: pageCursor.index + 1, token: textValue(next.value) }
  }
  const value = pageResult(pageCursor, candidates, nextCursor)
  return { status: statusFromDiagnostics(diagnostics, candidates.length), value, diagnostics, trace }
}

interface ExtractedFields {
  name?: string
  author?: string
  bookUrl?: string
  coverUrl?: string
  intro?: string
  kind?: string
  wordCount?: string
  lastChapter?: string
  updateTime?: string
  rawFields: JsonObject
}

async function extractFields(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, ruleGroup: 'ruleExplore' | 'ruleSearch', content: unknown, fields: readonly (readonly [string, string])[], itemIndex: number, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<ExtractedFields> {
  const extracted: ExtractedFields = { rawFields: {} }
  for (const [ruleField, outputField] of fields) {
    const rule = ruleString(source, ruleGroup, ruleField)
    if (rule === undefined) continue
    const result = await evaluateField(ports, source, stage, ruleField, rule, content, itemIndex, trace, signal)
    if (result.state === 'cancelled') break
    if (result.state === 'failed') diagnostics.push({ code: 'item-skipped', stage, field: ruleField, itemIndex, message: result.message ?? '字段规则失败', retryable: false })
    if (result.state === 'capability-missing') diagnostics.push({ code: 'capability-missing', stage, field: ruleField, itemIndex, message: result.message ?? '字段规则能力不可用', retryable: false })
    if (result.state === 'value') {
      const value = fieldText(result.value, outputField)
      extracted.rawFields[outputField] = jsonValue(result.value)
      if (outputField === 'name') extracted.name = value
      if (outputField === 'author') extracted.author = value
      if (outputField === 'bookUrl') extracted.bookUrl = value
      if (outputField === 'coverUrl') extracted.coverUrl = value
      if (outputField === 'intro') extracted.intro = value
      if (outputField === 'kind') extracted.kind = value
      if (outputField === 'wordCount') extracted.wordCount = value
      if (outputField === 'lastChapter') extracted.lastChapter = value
      if (outputField === 'updateTime') extracted.updateTime = value
    }
  }
  return extracted
}

/** 分类规则在 Android 里取列表并按逗号连接，其余字段按文本拼接。 */
function fieldText(value: unknown, outputField: string): string {
  if (outputField === 'kind' && Array.isArray(value)) return value.map(textValue).filter((item) => item.length > 0).join(',')
  return textValue(value)
}

function resolveCandidateUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (value === undefined || value.length === 0) return baseUrl
  // 旧版本可能把目录响应正文误存进 URL，不能把 HTML 编码成可请求地址。
  if (value.trimStart().startsWith('<') && !/^<(?:js>|\d+(?:,\d+)*>)/i.test(value.trimStart())) return undefined
  try {
    return resolveSourceRequestReference(value, baseUrl)
  } catch {
    return undefined
  }
}

/** 把整个响应当作详情页解析：Android 在 bookUrlPattern 命中或列表为空时使用该分支。 */
async function detailPageCandidate(ports: WorkflowPorts, source: NormalizedSource, page: { content: string; url: string }, options: DiscoveryInput | SearchInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<{ candidate?: BookCandidate; cancelled: boolean }> {
  const extraction = await extractDetailFields(ports, source, 0, page.content, { baseUrl: page.url, redirectUrl: page.url }, options.signal, trace, diagnostics)
  // 取消必须向上传播；回退失败和取消在调用方是两种不同的结果。
  if (extraction.cancelled) return { cancelled: true }
  const name = formatBookName(extraction.values.name ?? '')
  if (name.length === 0) {
    diagnostics.push({ code: 'identity-missing', stage: 'detail', itemIndex: 0, message: '详情页没有解析出书名', retryable: false })
    return { cancelled: false }
  }
  const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl: page.url, name, rawFields: extraction.raw, traceRef: 'detail-page:0' }
  const author = formatBookAuthor(extraction.values.author ?? '')
  if (author.length > 0) candidate.author = author
  if (extraction.values.intro !== undefined) candidate.intro = extraction.values.intro
  if (extraction.values.coverUrl !== undefined) candidate.coverUrl = resolveCandidateUrl(extraction.values.coverUrl, page.url) ?? extraction.values.coverUrl
  if (extraction.values.kind !== undefined) candidate.kind = extraction.values.kind
  if (extraction.values.wordCount !== undefined) candidate.wordCount = formatWordCount(extraction.values.wordCount)
  if (extraction.values.lastChapter !== undefined) candidate.lastChapter = extraction.values.lastChapter
  if (extraction.values.updateTime !== undefined) candidate.updateTime = extraction.values.updateTime
  return { candidate, cancelled: false }
}

interface DetailExtraction {
  /** 规则返回的字段文本，按 Android 输出字段名索引。 */
  values: Record<string, string>
  /** 规则明确返回空字符串的字段。 */
  empty: string[]
  /** 规则失败的字段及脱敏原因。 */
  errors: Record<string, string>
  /** 字段的原始 JSON 值。 */
  raw: JsonObject
  cancelled: boolean
}

async function extractDetailFields(ports: WorkflowPorts, source: NormalizedSource, itemIndex: number, content: unknown, context: { baseUrl: string; redirectUrl: string }, signal: AbortSignal | undefined, trace: WorkflowTraceEntry[], diagnostics: WorkflowDiagnostic[]): Promise<DetailExtraction> {
  const result: DetailExtraction = { values: {}, empty: [], errors: {}, raw: {}, cancelled: false }
  for (const [ruleField, outputField] of detailFields) {
    const rule = ruleString(source, 'ruleBookInfo', ruleField)
    if (rule === undefined) continue
    // Android 将空 tocUrl 规则视为“使用详情页”，而不是“返回整页内容”。
    if (ruleField === 'tocUrl' && rule.length === 0) continue
    const field = await evaluateField(ports, source, 'detail', ruleField, rule, content, itemIndex, trace, signal, context)
    if (field.state === 'cancelled') {
      result.cancelled = true
      return result
    }
    if (field.state === 'empty') {
      result.empty.push(outputField)
      continue
    }
    if (field.state === 'failed' || field.state === 'capability-missing') {
      result.errors[outputField] = field.message ?? '详情字段失败'
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage: 'detail', field: ruleField, itemIndex, message: field.message ?? '详情字段失败', retryable: false })
      continue
    }
    if (field.state !== 'value') continue
    const value = fieldText(field.value, outputField)
    result.raw[outputField] = jsonValue(field.value)
    result.values[outputField] = outputField === 'wordCount' ? formatWordCount(value) : value
    trace.push({ stage: 'detail', event: 'field', target: outputField, itemIndex })
  }
  return result
}

export async function loadBookDetails(ports: WorkflowPorts, input: DetailInput): Promise<RuntimeResult<WorkflowPage<BookMetadata>>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const cursor = input.cursor ?? { index: 0 }
  if (ruleString(input.source, 'ruleBookInfo', 'name') === undefined && ruleString(input.source, 'ruleBookInfo', 'author') === undefined && ruleString(input.source, 'ruleBookInfo', 'intro') === undefined) {
    diagnostics.push({ code: 'invalid-config', stage: 'detail', message: '缺少详情字段规则', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const items: BookMetadata[] = []
  const maxItems = input.maxItems ?? input.candidates.length
  const initRule = ruleString(input.source, 'ruleBookInfo', 'init')
  for (let itemIndex = cursor.index; itemIndex < input.candidates.length && items.length < maxItems; itemIndex += 1) {
    if (input.signal?.aborted === true) {
      diagnostics.push({ code: 'cancelled', stage: 'detail', message: '详情工作流已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    const candidate = input.candidates[itemIndex]!
    if (candidate.bookUrl.length === 0) {
      diagnostics.push({ code: 'identity-missing', stage: 'detail', itemIndex, message: '详情候选缺少 URL', retryable: false })
      continue
    }
    const expandedUrl = await expandUrl(ports, input.source, 'detail', candidate.bookUrl, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl }, input.signal)
    if (expandedUrl.url === undefined) {
      if (expandedUrl.error?.code === 'cancelled') {
        diagnostics.push({ code: 'cancelled', stage: 'detail', message: '详情 URL 展开已取消', retryable: false })
        return { status: 'cancelled', value: null, diagnostics, trace }
      }
      diagnostics.push({ code: expandedUrl.error?.code ?? 'rule-failed', stage: 'detail', field: 'bookUrl', itemIndex, message: expandedUrl.error?.message ?? '详情 URL 展开失败', retryable: false })
      continue
    }
    const page = await requestPageResponse(ports, input.source, expandedUrl.url, 'detail', input, diagnostics, trace)
    if (page === undefined) continue
    const context = { baseUrl: page.url, redirectUrl: page.url }
    // Android BookInfo：init 规则先执行，其结果成为后续详情字段的内容基准。
    let content: unknown = page.content
    if (initRule !== undefined) {
      const init = await evaluateField(ports, input.source, 'detail', 'init', initRule, content, itemIndex, trace, input.signal, { ...context, expect: 'nodes' })
      if (init.state === 'cancelled') return { status: 'cancelled', value: null, diagnostics, trace }
      if (init.state === 'value') content = singleNodeValue(init.value)
      else if (init.state === 'failed' || init.state === 'capability-missing') diagnostics.push({ code: init.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage: 'detail', field: 'init', itemIndex, message: init.message ?? '详情初始化规则失败', retryable: false })
    }
    const extraction = await extractDetailFields(ports, input.source, itemIndex, content, context, input.signal, trace, diagnostics)
    if (extraction.cancelled) return { status: 'cancelled', value: null, diagnostics, trace }
    const name = formatBookName(extraction.values.name ?? '')
    const author = formatBookAuthor(extraction.values.author ?? '')
    const metadata: BookMetadata = {
      ...candidate,
      rawFields: { ...candidate.rawFields, ...extraction.raw },
      emptyFields: extraction.empty,
      fieldErrors: extraction.errors,
    }
    if (name.length > 0) metadata.name = name
    if (author.length > 0) metadata.author = author
    if (extraction.values.intro !== undefined) metadata.intro = extraction.values.intro
    if (extraction.values.coverUrl !== undefined) metadata.coverUrl = extraction.values.coverUrl
    if (extraction.values.kind !== undefined) metadata.kind = extraction.values.kind
    if (extraction.values.wordCount !== undefined) metadata.wordCount = extraction.values.wordCount
    if (extraction.values.lastChapter !== undefined) metadata.lastChapter = extraction.values.lastChapter
    if (extraction.values.updateTime !== undefined) metadata.updateTime = extraction.values.updateTime
    const tocUrl = resolveCandidateUrl(extraction.values.tocUrl, page.url) ?? page.url
    metadata.tocUrl = tocUrl
    if (tocUrl === page.url) metadata.tocHtml = page.content
    items.push(metadata)
  }
  const endIndex = Math.min(input.candidates.length, cursor.index + maxItems)
  const value: WorkflowPage<BookMetadata> = { items, cursor, ...(endIndex < input.candidates.length ? { nextCursor: { index: endIndex } } : {}) }
  if (items.length === 0) diagnostics.push({ code: 'empty-page', stage: 'detail', message: '没有可补全的详情', retryable: false })
  const status = statusFromDiagnostics(diagnostics, items.length)
  // 取消的调用不拿半份详情（与目录、正文流程一致）。
  return { status, value: status === 'cancelled' ? null : value, diagnostics, trace }
}

/**
 * init 规则可能返回节点列表（Android 会把 Elements 重新序列化后作为内容）。
 * 核心没有多根节点视图，取首个节点作为后续规则的内容基准。
 */
function singleNodeValue(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : value
}
