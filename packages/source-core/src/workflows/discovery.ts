import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { detailFields, encodeKeyword, evaluateField, jsonValue, listFields, pageResult, requestPage, ruleString, sourceNumber, sourceString, statusFromDiagnostics, template } from './helpers.ts'
import type { BookCandidate, BookMetadata, DetailInput, DiscoveryInput, RuntimeResult, SearchInput, WorkflowDiagnostic, WorkflowPage, WorkflowPorts, WorkflowStage, WorkflowTraceEntry } from './types.ts'

export async function discoverBooks(ports: WorkflowPorts, input: DiscoveryInput): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
  const cursor = input.cursor ?? { index: sourceNumber(input.source, 'explorePageStart') ?? 0 }
  return listWorkflow(ports, 'discover', input.source, sourceString(input.source, 'exploreUrl'), ruleString(input.source, 'ruleExplore', 'bookList'), ruleString(input.source, 'ruleExplore', 'nextPage'), cursor, input, {})
}

export async function searchBooks(ports: WorkflowPorts, input: SearchInput): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
  if (input.keyword.length === 0) return { status: 'empty', value: { items: [], cursor: input.cursor ?? { index: 0 } }, diagnostics: [{ code: 'invalid-input', stage: 'search', message: '搜索关键词为空', retryable: false }], trace: [] }
  const page = input.cursor?.index ?? sourceNumber(input.source, 'searchPageStart') ?? 0
  const url = sourceString(input.source, 'searchUrl')
  const expanded = url === undefined ? undefined : template(url, { keyword: encodeKeyword(input.keyword), page: String(page), pageIndex: String(page) })
  return listWorkflow(ports, 'search', input.source, expanded, ruleString(input.source, 'ruleSearch', 'bookList'), ruleString(input.source, 'ruleSearch', 'nextPage'), input.cursor ?? { index: page }, input, { keyword: input.keyword })
}

async function listWorkflow(ports: WorkflowPorts, stage: 'discover' | 'search', source: NormalizedSource, url: string | undefined, listRule: string | undefined, nextRule: string | undefined, cursor: DiscoveryInput['cursor'], options: DiscoveryInput | SearchInput, replacements: Readonly<Record<string, string>>): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const pageCursor = cursor ?? { index: 0 }
  if (url === undefined || listRule === undefined) {
    diagnostics.push({ code: 'invalid-config', stage, message: '缺少列表请求地址或 bookList 规则', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const expanded = template(url, { page: String(pageCursor.index), pageIndex: String(pageCursor.index), ...replacements })
  const content = await requestPage(ports, source, expanded, stage, options, diagnostics, trace)
  if (content === undefined) return { status: diagnostics.some((item) => item.code === 'cancelled') ? 'cancelled' : 'failed', value: null, diagnostics, trace }
  const list = await evaluateField(ports, source, stage, 'bookList', listRule, content, undefined, trace, options.signal)
  if (list.state === 'cancelled') {
    diagnostics.push({ code: 'cancelled', stage, field: 'bookList', message: '工作流已取消', retryable: false })
    return { status: 'cancelled', value: null, diagnostics, trace }
  }
  if (list.state === 'capability-missing') {
    diagnostics.push({ code: 'capability-missing', stage, field: 'bookList', message: list.message ?? '列表规则能力不可用', retryable: false })
    return { status: 'capability-missing', value: null, diagnostics, trace }
  }
  if (list.state !== 'value') {
    diagnostics.push({ code: 'empty-page', stage, field: 'bookList', message: '列表规则没有返回候选', retryable: false })
    return { status: 'empty', value: { items: [], cursor: pageCursor }, diagnostics, trace }
  }
  const rawItems = Array.isArray(list.value) ? list.value : [list.value]
  const candidates: BookCandidate[] = []
  const identities = new Set<string>()
  const maxItems = options.maxItems ?? 100
  for (let itemIndex = 0; itemIndex < rawItems.length && candidates.length < maxItems; itemIndex += 1) {
    const rawItem = rawItems[itemIndex]
    const fields = await extractFields(ports, source, stage, rawItem, listFields, itemIndex, options.signal, diagnostics, trace)
    if (options.signal !== undefined && options.signal.aborted) {
      diagnostics.push({ code: 'cancelled', stage, message: '工作流已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    const bookUrl = fields.bookUrl
    if (bookUrl === undefined || bookUrl.length === 0) {
      diagnostics.push({ code: 'identity-missing', stage, itemIndex, message: '候选缺少书源内详情 URL', retryable: false })
      continue
    }
    const identityKey = `${source.bookSourceUrl}\u0000${bookUrl}`
    if (identities.has(identityKey)) {
      diagnostics.push({ code: 'duplicate-item', stage, itemIndex, message: '重复候选已折叠', retryable: false })
      continue
    }
    identities.add(identityKey)
    trace.push({ stage, event: 'candidate', target: `candidate:${candidates.length}`, itemIndex })
    const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl, rawFields: fields.rawFields, traceRef: `${stage}:${candidates.length}` }
    if (fields.name !== undefined) candidate.name = fields.name
    if (fields.author !== undefined) candidate.author = fields.author
    if (fields.intro !== undefined) candidate.intro = fields.intro
    if (fields.coverUrl !== undefined) candidate.coverUrl = fields.coverUrl
    candidates.push(candidate)
  }
  if (candidates.length === 0) diagnostics.push({ code: 'empty-page', stage, message: '列表没有可用候选', retryable: false })
  let nextCursor: { index: number; token?: string } | undefined
  if (nextRule !== undefined) {
    const next = await evaluateField(ports, source, stage, 'nextPage', nextRule, content, undefined, trace, options.signal)
    if (next.state === 'cancelled') {
      diagnostics.push({ code: 'cancelled', stage, field: 'nextPage', message: '工作流已取消', retryable: false })
      return { status: 'cancelled', value: null, diagnostics, trace }
    }
    if (next.state === 'value') nextCursor = { index: pageCursor.index + 1, token: text(next.value) }
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
  rawFields: JsonObject
}

async function extractFields(ports: WorkflowPorts, source: NormalizedSource, stage: WorkflowStage, content: unknown, fields: readonly (readonly [string, string])[], itemIndex: number, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<ExtractedFields> {
  const extracted: ExtractedFields = { rawFields: {} }
  for (const [ruleField, outputField] of fields) {
    const rule = ruleString(source, stage === 'search' ? 'ruleSearch' : 'ruleExplore', ruleField)
    if (rule === undefined) continue
    const result = await evaluateField(ports, source, stage, ruleField, rule, content, itemIndex, trace, signal)
    if (result.state === 'cancelled') break
    if (result.state === 'failed') diagnostics.push({ code: 'item-skipped', stage, field: ruleField, itemIndex, message: result.message ?? '字段规则失败', retryable: false })
    if (result.state === 'capability-missing') diagnostics.push({ code: 'capability-missing', stage, field: ruleField, itemIndex, message: result.message ?? '字段规则能力不可用', retryable: false })
    if (result.state === 'value') {
      const value = text(result.value)
      extracted.rawFields[outputField] = jsonValue(result.value)
      if (outputField === 'name') extracted.name = value
      if (outputField === 'author') extracted.author = value
      if (outputField === 'bookUrl') extracted.bookUrl = value
      if (outputField === 'coverUrl') extracted.coverUrl = value
      if (outputField === 'intro') extracted.intro = value
    }
  }
  return extracted
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
    const content = await requestPage(ports, input.source, candidate.bookUrl, 'detail', input, diagnostics, trace)
    if (content === undefined) continue
    const metadata: BookMetadata = { ...candidate, rawFields: { ...candidate.rawFields }, emptyFields: [], fieldErrors: {} }
    for (const [ruleField, outputField] of detailFields) {
      const rule = ruleString(input.source, 'ruleBookInfo', ruleField)
      if (rule === undefined) continue
      const result = await evaluateField(ports, input.source, 'detail', ruleField, rule, content, itemIndex, trace, input.signal)
      if (result.state === 'cancelled') return { status: 'cancelled', value: null, diagnostics, trace }
      if (result.state === 'empty') {
        metadata.emptyFields.push(outputField)
        continue
      }
      if (result.state === 'failed' || result.state === 'capability-missing') {
        metadata.fieldErrors = { ...metadata.fieldErrors, [outputField]: result.message ?? '详情字段失败' }
        diagnostics.push({ code: result.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage: 'detail', field: ruleField, itemIndex, message: result.message ?? '详情字段失败', retryable: false })
        continue
      }
      const value = text(result.value)
      metadata.rawFields[outputField] = jsonValue(result.value)
      if (outputField === 'name') metadata.name = value
      if (outputField === 'author') metadata.author = value
      if (outputField === 'intro') metadata.intro = value
      if (outputField === 'coverUrl') metadata.coverUrl = value
      if (outputField === 'tocUrl') metadata.tocUrl = value
      trace.push({ stage: 'detail', event: 'field', target: outputField, itemIndex })
    }
    items.push(metadata)
  }
  const endIndex = Math.min(input.candidates.length, cursor.index + maxItems)
  const value: WorkflowPage<BookMetadata> = { items, cursor, ...(endIndex < input.candidates.length ? { nextCursor: { index: endIndex } } : {}) }
  if (items.length === 0) diagnostics.push({ code: 'empty-page', stage: 'detail', message: '没有可补全的详情', retryable: false })
  return { status: statusFromDiagnostics(diagnostics, items.length), value, diagnostics, trace }
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return Array.isArray(value) ? value.map(text).filter(Boolean).join('\n') : String(value)
}
