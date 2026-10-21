import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { resolveSourceRequestReference } from '../runtime/request-url.ts'
import { evaluateField, executeSourceFunction, expandUrl, pageResult, requestPageResponse, statusFromDiagnostics, textValue } from './helpers.ts'
import type {
  BookMetadata,
  ChapterIdentity,
  ReviewDetailInput,
  ReviewDetailItem,
  ReviewDetailPage,
  ReviewRepliesInput,
  ReviewSummaryInput,
  ReviewSummaryItem,
  RuntimeResult,
  WorkflowDiagnostic,
  WorkflowPorts,
  WorkflowStage,
  WorkflowTraceEntry,
} from './types.ts'

type ReviewRule = Record<string, unknown>
type ReviewChapter = ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }

const stage: WorkflowStage = 'detail'

/** Declarative and JavaScript review sources share the same sanitized result shape. */
export async function loadReviewSummary(ports: WorkflowPorts, input: ReviewSummaryInput): Promise<RuntimeResult<ReviewSummaryItem[]>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  if (input.signal?.aborted === true) return cancelledReview('段评统计已取消', diagnostics, trace)
  if (typeof input.source.mainJs === 'string' && input.source.mainJs.trim().length > 0) {
    const result = await executeSourceFunction(ports, input.source, 'getReviewSummary', [input.chapter, input.book], reviewBindings(input.book, input.chapter), stage, 'content', trace, input.signal)
    if (result.state === 'cancelled') return cancelledReview(result.message ?? '段评统计已取消', diagnostics, trace)
    if (result.state === 'capability-missing') return failedReview('capability-missing', result.message ?? '段评 JavaScript 宿主不可用', diagnostics, trace)
    if (result.state === 'missing-function' || result.state === 'empty') return emptyReview(diagnostics, trace)
    if (result.state === 'failed') return failedReview('failed', result.message ?? '段评统计脚本执行失败', diagnostics, trace)
    const parsed = parseJsonLike(result.value)
    const items = parseSummaryArray(parsed)
    if (items === undefined) {
      diagnostics.push(reviewDiagnostic('rule-failed', 'getReviewSummary 返回格式错误'))
      return failedReview('failed', 'getReviewSummary 返回格式错误', diagnostics, trace)
    }
    return { status: items.length === 0 ? 'empty' : 'success', value: items, diagnostics, trace }
  }
  const rule = reviewRules(input.source)
  const urlRule = reviewString(rule, 'reviewSummaryUrl')
  const listRule = reviewString(rule, 'summaryListRule')
  const indexRule = reviewString(rule, 'summaryParagraphIndexRule')
  const countRule = reviewString(rule, 'summaryCountRule')
  if (rule === undefined || rule.enabled !== true || urlRule === undefined || listRule === undefined || indexRule === undefined || countRule === undefined) return emptyReview(diagnostics, trace)
  const response = await reviewPage(ports, input.source, urlRule, input, { chapter: input.chapter, book: input.book }, { page: 1 }, diagnostics, trace)
  if (response === undefined) return reviewFromDiagnostics('summary', diagnostics, trace)
  const list = await evaluateReviewList(ports, input.source, listRule, response.content, response.url, { chapter: input.chapter, book: input.book }, diagnostics, trace, input.signal, 'summaryListRule')
  if (list === undefined) return reviewFromDiagnostics('summary', diagnostics, trace)
  const dataRule = reviewString(rule, 'summaryParagraphDataRule')
  const items: ReviewSummaryItem[] = []
  for (let index = 0; index < list.length; index += 1) {
    const current = list[index]
    const bindings = reviewBindings(input.book, input.chapter)
    const paragraphIndex = parseInteger(await reviewField(ports, input.source, indexRule, current, response.url, bindings, diagnostics, trace, input.signal, `summaryParagraphIndexRule:${index}`)) ?? index + 1
    const count = parseInteger(await reviewField(ports, input.source, countRule, current, response.url, bindings, diagnostics, trace, input.signal, `summaryCountRule:${index}`)) ?? 0
    if ((paragraphIndex === -1 || paragraphIndex > 0) && count > 0) {
      const paragraphData = dataRule === undefined
        ? String(paragraphIndex)
        : (await reviewField(ports, input.source, dataRule, current, response.url, bindings, diagnostics, trace, input.signal, `summaryParagraphDataRule:${index}`) ?? String(paragraphIndex))
      items.push({ paragraphIndex, count, paragraphData })
    }
  }
  return { status: items.length === 0 ? 'empty' : statusFromDiagnostics(diagnostics, items.length), value: items, diagnostics, trace }
}

export async function loadReviewDetail(ports: WorkflowPorts, input: ReviewDetailInput): Promise<RuntimeResult<ReviewDetailPage>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  if (input.signal?.aborted === true) return cancelledReview('段评详情已取消', diagnostics, trace)
  const page = input.cursor?.index ?? 1
  const paragraphData = input.paragraphData?.trim() || String(input.paragraphIndex)
  if (typeof input.source.mainJs === 'string' && input.source.mainJs.trim().length > 0) {
    const result = await executeSourceFunction(ports, input.source, 'getReviewDetail', [input.chapter, input.book, input.paragraphIndex, paragraphData, page], reviewBindings(input.book, input.chapter), stage, 'content', trace, input.signal)
    if (result.state === 'cancelled') return cancelledReview(result.message ?? '段评详情已取消', diagnostics, trace)
    if (result.state === 'capability-missing') return failedReview('capability-missing', result.message ?? '段评 JavaScript 宿主不可用', diagnostics, trace)
    if (result.state === 'missing-function' || result.state === 'empty') return emptyDetail(diagnostics, trace, page)
    if (result.state === 'failed') return failedReview('failed', result.message ?? '段评详情脚本执行失败', diagnostics, trace)
    const parsed = parseJsonLike(result.value)
    const parsedPage = parseReviewDetailPage(parsed, input.chapter.chapterUrl)
    if (parsedPage === undefined) return failedReview('failed', 'getReviewDetail 返回格式错误', diagnostics, trace)
    const nextCursor = parsedPage.nextPageUrl === undefined || parsedPage.items.length === 0 ? undefined : { index: page + 1, token: parsedPage.nextPageUrl }
    return { status: parsedPage.items.length === 0 ? 'empty' : 'success', value: detailPageResult(page, parsedPage.items, nextCursor), diagnostics, trace }
  }
  const rule = reviewRules(input.source)
  const listRule = reviewString(rule, 'detailListRule')
  const contentRule = reviewString(rule, 'detailContentRule')
  const firstUrl = reviewString(rule, 'reviewDetailUrl')
  if (rule === undefined || rule.enabled !== true || listRule === undefined || contentRule === undefined || firstUrl === undefined) return emptyDetail(diagnostics, trace, page)
  const nextRule = reviewString(rule, 'reviewDetailNextPageUrl')
  const url = input.cursor?.token ?? firstUrl
  const response = await reviewPage(ports, input.source, url, input, { chapter: input.chapter, book: input.book }, { page, paraIndex: input.paragraphIndex, paraData: paragraphData }, diagnostics, trace)
  if (response === undefined) return reviewFromDiagnostics('detail', diagnostics, trace, page)
  const bindings = { ...reviewBindings(input.book, input.chapter), paraIndex: input.paragraphIndex, paraData: paragraphData, page }
  const list = await evaluateReviewList(ports, input.source, listRule, response.content, response.url, bindings, diagnostics, trace, input.signal, 'detailListRule')
  if (list === undefined) return reviewFromDiagnostics('detail', diagnostics, trace, page)
  const items: ReviewDetailItem[] = []
  for (let index = 0; index < list.length; index += 1) {
    const item = await parseDeclarativeReviewItem(ports, input.source, rule, list[index], response.url, bindings, contentRule, false, diagnostics, trace, input.signal, index)
    if (item !== undefined) items.push(item)
  }
  let nextCursor: { index: number; token?: string } | undefined
  if (nextRule !== undefined && items.length > 0) {
    const next = await reviewField(ports, input.source, nextRule, response.content, response.url, bindings, diagnostics, trace, input.signal, 'reviewDetailNextPageUrl')
    const nextUrl = resolveReviewUrl(next, response.url)
    if (nextUrl !== undefined) nextCursor = { index: page + 1, token: nextUrl }
  }
  return { status: items.length === 0 ? 'empty' : statusFromDiagnostics(diagnostics, items.length), value: detailPageResult(page, items, nextCursor), diagnostics, trace }
}

export async function loadReviewReplies(ports: WorkflowPorts, input: ReviewRepliesInput): Promise<RuntimeResult<ReviewDetailPage>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const page = input.cursor?.index ?? 1
  const paragraphData = input.paragraphData?.trim() || String(input.paragraphIndex)
  if (input.signal?.aborted === true) return cancelledReview('段评回复已取消', diagnostics, trace, page)
  if (typeof input.source.mainJs === 'string' && input.source.mainJs.trim().length > 0) {
    const result = await executeSourceFunction(ports, input.source, 'getReviewReplies', [input.chapter, input.book, input.paragraphIndex, paragraphData, input.reviewId, page], reviewBindings(input.book, input.chapter), stage, 'content', trace, input.signal)
    if (result.state === 'cancelled') return cancelledReview(result.message ?? '段评回复已取消', diagnostics, trace, page)
    if (result.state === 'capability-missing') return failedReview('capability-missing', result.message ?? '段评 JavaScript 宿主不可用', diagnostics, trace, page)
    if (result.state === 'missing-function' || result.state === 'empty') return emptyDetail(diagnostics, trace, page)
    if (result.state === 'failed') return failedReview('failed', result.message ?? '段评回复脚本执行失败', diagnostics, trace, page)
    const parsed = parseJsonLike(result.value)
    const items = parseReplyArray(parsed, input.chapter.chapterUrl)
    if (items === undefined) return failedReview('failed', 'getReviewReplies 返回格式错误', diagnostics, trace, page)
    const nextCursor = items.length === 0 ? undefined : { index: page + 1 }
    return { status: items.length === 0 ? 'empty' : 'success', value: detailPageResult(page, items, nextCursor), diagnostics, trace }
  }
  const rule = reviewRules(input.source)
  const listRule = reviewString(rule, 'replyListRule')
  const contentRule = reviewString(rule, 'replyContentRule')
  const urlRule = reviewString(rule, 'reviewQuoteUrl')
  if (rule === undefined || rule.enabled !== true || listRule === undefined || contentRule === undefined || urlRule === undefined) return emptyDetail(diagnostics, trace, page)
  const bindings = { ...reviewBindings(input.book, input.chapter), paraIndex: input.paragraphIndex, paraData: paragraphData, reviewId: input.reviewId, page }
  const response = await reviewPage(ports, input.source, urlRule, input, { chapter: input.chapter, book: input.book }, { page, paraIndex: input.paragraphIndex, paraData: paragraphData, reviewId: input.reviewId }, diagnostics, trace)
  if (response === undefined) return reviewFromDiagnostics('detail', diagnostics, trace, page)
  const list = await evaluateReviewList(ports, input.source, listRule, response.content, response.url, bindings, diagnostics, trace, input.signal, 'replyListRule')
  if (list === undefined) return reviewFromDiagnostics('detail', diagnostics, trace, page)
  const items: ReviewDetailItem[] = []
  for (let index = 0; index < list.length; index += 1) {
    const item = await parseDeclarativeReviewItem(ports, input.source, rule, list[index], response.url, bindings, contentRule, true, diagnostics, trace, input.signal, index)
    if (item !== undefined) items.push(item)
  }
  return { status: items.length === 0 ? 'empty' : statusFromDiagnostics(diagnostics, items.length), value: detailPageResult(page, items, items.length === 0 ? undefined : { index: page + 1 }), diagnostics, trace }
}

async function parseDeclarativeReviewItem(ports: WorkflowPorts, source: NormalizedSource, rule: ReviewRule, raw: unknown, baseUrl: string, bindings: Readonly<Record<string, unknown>>, contentRule: string, isReply: boolean, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], signal: AbortSignal | undefined, index: number): Promise<ReviewDetailItem | undefined> {
  const content = await reviewField(ports, source, contentRule, raw, baseUrl, bindings, diagnostics, trace, signal, `${isReply ? 'reply' : 'detail'}ContentRule:${index}`)
  if (content === undefined || content.trim().length === 0) return undefined
  const id = await optionalReviewField(ports, source, reviewString(rule, isReply ? 'replyIdRule' : 'detailIdRule'), raw, baseUrl, bindings, diagnostics, trace, signal, `${isReply ? 'reply' : 'detail'}IdRule:${index}`)
  const avatar = await optionalReviewField(ports, source, reviewString(rule, isReply ? 'replyAvatarRule' : 'detailAvatarRule'), raw, baseUrl, bindings, diagnostics, trace, signal, `${isReply ? 'reply' : 'detail'}AvatarRule:${index}`)
  const name = await optionalReviewField(ports, source, reviewString(rule, isReply ? 'replyNameRule' : 'detailNameRule'), raw, baseUrl, bindings, diagnostics, trace, signal, `${isReply ? 'reply' : 'detail'}NameRule:${index}`)
  const badge = await optionalReviewField(ports, source, reviewString(rule, isReply ? 'replyBadgeRule' : 'detailBadgeRule'), raw, baseUrl, bindings, diagnostics, trace, signal, `${isReply ? 'reply' : 'detail'}BadgeRule:${index}`)
  const protocol = parseContentProtocol(content, baseUrl)
  const replyListRule = isReply ? undefined : reviewString(rule, 'replyListRule')
  let replies: ReviewDetailItem[] = []
  if (replyListRule !== undefined && reviewString(rule, 'reviewQuoteUrl') === undefined) {
    const nested = await evaluateReviewList(ports, source, replyListRule, raw, baseUrl, bindings, diagnostics, trace, signal, `replyListRule:${index}`)
    if (nested !== undefined) {
      const replyContentRule = reviewString(rule, 'replyContentRule')
      if (replyContentRule !== undefined) {
        const parsed: ReviewDetailItem[] = []
        for (let replyIndex = 0; replyIndex < nested.length; replyIndex += 1) {
          const reply = await parseDeclarativeReviewItem(ports, source, rule, nested[replyIndex], baseUrl, bindings, replyContentRule, true, diagnostics, trace, signal, replyIndex)
          if (reply !== undefined) parsed.push(reply)
        }
        replies = parsed
      }
    }
  }
  const item: ReviewDetailItem = { badges: badge === undefined ? [] : splitBadges(badge), replies }
  if (id !== undefined) item.id = id
  if (avatar !== undefined) item.avatar = resolveReviewUrl(avatar, baseUrl) ?? avatar
  if (name !== undefined) item.name = name
  const normalizedText = protocol === undefined ? content : protocol.text
  if (normalizedText !== undefined && normalizedText.length > 0) item.content = normalizedText
  if (protocol?.replyToName !== undefined) item.replyToName = protocol.replyToName
  if (protocol?.imageUrl !== undefined) item.imageUrl = resolveReviewUrl(protocol.imageUrl, baseUrl) ?? protocol.imageUrl
  if (protocol?.audioUrl !== undefined) item.audioUrl = resolveReviewUrl(protocol.audioUrl, baseUrl) ?? protocol.audioUrl
  if (protocol?.time !== undefined) item.time = protocol.time
  if (protocol?.likeCount !== undefined) item.likeCount = protocol.likeCount
  if (protocol?.replyCount !== undefined) item.replyCount = protocol.replyCount
  return item
}

async function evaluateReviewList(ports: WorkflowPorts, source: NormalizedSource, rule: string, content: unknown, baseUrl: string, bindings: Readonly<Record<string, unknown>>, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], signal: AbortSignal | undefined, field: string): Promise<unknown[] | undefined> {
  const output = await evaluateField(ports, source, stage, field, rule, content, undefined, trace, signal, { baseUrl, redirectUrl: baseUrl, expect: 'nodes', bindings })
  if (output.state === 'value' && Array.isArray(output.value)) return output.value
  if (output.state === 'empty' || output.state === 'missing') return []
  diagnostics.push(reviewDiagnostic(output.state === 'capability-missing' ? 'capability-missing' : output.state === 'cancelled' ? 'cancelled' : 'rule-failed', output.message ?? `${field} 执行失败`, field))
  return undefined
}

async function reviewField(ports: WorkflowPorts, source: NormalizedSource, rule: string, content: unknown, baseUrl: string, bindings: Readonly<Record<string, unknown>>, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], signal: AbortSignal | undefined, field: string): Promise<string | undefined> {
  const output = await evaluateField(ports, source, stage, field, rule, content, undefined, trace, signal, { baseUrl, redirectUrl: baseUrl, bindings })
  if (output.state === 'value') return textValue(output.value).trim()
  if (output.state === 'empty' || output.state === 'missing') return undefined
  diagnostics.push(reviewDiagnostic(output.state === 'capability-missing' ? 'capability-missing' : output.state === 'cancelled' ? 'cancelled' : 'rule-failed', output.message ?? `${field} 执行失败`, field))
  return undefined
}

async function optionalReviewField(ports: WorkflowPorts, source: NormalizedSource, rule: string | undefined, content: unknown, baseUrl: string, bindings: Readonly<Record<string, unknown>>, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], signal: AbortSignal | undefined, field: string): Promise<string | undefined> {
  return rule === undefined ? undefined : reviewField(ports, source, rule, content, baseUrl, bindings, diagnostics, trace, signal, field)
}

async function reviewPage(ports: WorkflowPorts, source: NormalizedSource, urlRule: string, input: ReviewSummaryInput | ReviewDetailInput | ReviewRepliesInput, requestContext: { book: BookMetadata; chapter: ReviewChapter }, replacements: Record<string, unknown>, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]) {
  const values = Object.fromEntries(Object.entries(replacements).map(([key, value]) => [key, String(value)]))
  const expanded = await expandUrl(ports, source, stage, urlRule, values, { ...reviewBindings(input.book, input.chapter), ...replacements }, input.signal)
  if (expanded.url === undefined) {
    diagnostics.push(reviewDiagnostic(expanded.error?.code === 'capability-missing' ? 'capability-missing' : expanded.error?.code === 'cancelled' ? 'cancelled' : 'rule-failed', expanded.error?.message ?? '段评地址展开失败', 'reviewUrl'))
    return undefined
  }
  let requestUrl: string
  try { requestUrl = resolveSourceRequestReference(expanded.url, source.bookSourceUrl) } catch { diagnostics.push(reviewDiagnostic('invalid-config', '段评地址无效', 'reviewUrl')); return undefined }
  return requestPageResponse(ports, source, requestUrl, stage, input, diagnostics, trace, undefined, requestContext)
}

function reviewRules(source: NormalizedSource): ReviewRule | undefined {
  const raw = source.ruleReview
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as ReviewRule
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as ReviewRule : undefined
  } catch { return undefined }
}

function reviewString(rule: ReviewRule | undefined, key: string): string | undefined {
  const value = rule?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function reviewBindings(book: BookMetadata, chapter: ReviewChapter): Readonly<Record<string, unknown>> { return { book, chapter, source: book.sourceId } }

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function parseSummaryArray(value: unknown): ReviewSummaryItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const paragraphIndex = parseInteger(record.paraIndex)
    const count = parseInteger(record.count)
    if (paragraphIndex === undefined || count === undefined || (paragraphIndex !== -1 && paragraphIndex <= 0) || count <= 0) return []
    return [{ paragraphIndex, count, paragraphData: textValue(record.paraData ?? paragraphIndex) }]
  })
}

function parseReviewDetailPage(value: unknown, baseUrl: string): { items: ReviewDetailItem[]; nextPageUrl?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items)) return undefined
  const items = record.items.flatMap((item) => { const parsed = parseReviewItem(item, baseUrl); return parsed === undefined ? [] : [parsed] })
  const nextPageUrl = resolveReviewUrl(stringValue(record.nextPageUrl), baseUrl)
  return { items, ...(nextPageUrl === undefined ? {} : { nextPageUrl }) }
}

function parseReplyArray(value: unknown, baseUrl: string): ReviewDetailItem[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).items)) return undefined
  return flattenReviewItems((value as Record<string, unknown>).items as unknown[], baseUrl)
}

function parseReviewItem(value: unknown, baseUrl: string): ReviewDetailItem | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const rawContent = contentValue(record.content)
  if (rawContent === undefined || rawContent.trim().length === 0) return undefined
  const protocol = parseContentProtocol(rawContent, baseUrl)
  const replies = Array.isArray(record.replies) ? flattenReviewItems(record.replies, baseUrl) : []
  const item: ReviewDetailItem = { badges: stringArray(record.badge).flatMap(splitBadges), replies }
  const id = stringValue(record.id); if (id !== undefined) item.id = id
  const avatar = resolveReviewUrl(stringValue(record.avatar), baseUrl); if (avatar !== undefined) item.avatar = avatar
  const name = stringValue(record.name); if (name !== undefined) item.name = name
  const itemText = protocol?.text ?? (protocol === undefined ? rawContent : undefined); if (itemText !== undefined && itemText.length > 0) item.content = itemText
  if (protocol?.replyToName !== undefined) item.replyToName = protocol.replyToName
  if (protocol?.imageUrl !== undefined) item.imageUrl = protocol.imageUrl
  if (protocol?.audioUrl !== undefined) item.audioUrl = protocol.audioUrl
  if (protocol?.time !== undefined) item.time = protocol.time
  if (protocol?.likeCount !== undefined) item.likeCount = protocol.likeCount
  if (protocol?.replyCount !== undefined) item.replyCount = protocol.replyCount
  return item
}

function flattenReviewItems(values: unknown[], baseUrl: string): ReviewDetailItem[] {
  const result: ReviewDetailItem[] = []
  const stack = [...values].reverse()
  while (stack.length > 0) {
    const value = stack.pop()!
    const item = parseReviewItem(value, baseUrl)
    if (item !== undefined) result.push(item)
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).replies)) stack.push(...((value as Record<string, unknown>).replies as unknown[]).slice().reverse())
  }
  return result
}

function contentValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== undefined && value !== null && typeof value === 'object') return JSON.stringify(value)
  return undefined
}

function parseContentProtocol(raw: string, baseUrl: string): { text?: string; replyToName?: string; imageUrl?: string; audioUrl?: string; time?: string; likeCount?: number; replyCount?: number } | undefined {
  if (!raw.trim().startsWith('{')) return undefined
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { return undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = ['text', 'replyToName', 'img', 'audio', 'time', 'likeCount', 'replyCount']
  if (!keys.some((key) => Object.hasOwn(record, key))) return undefined
  const protocol: { text?: string; replyToName?: string; imageUrl?: string; audioUrl?: string; time?: string; likeCount?: number; replyCount?: number } = {}
  const text = stringValue(record.text); if (text !== undefined) protocol.text = text
  const replyToName = stringValue(record.replyToName); if (replyToName !== undefined) protocol.replyToName = replyToName
  const imageUrl = resolveReviewUrl(stringValue(record.img), baseUrl); if (imageUrl !== undefined) protocol.imageUrl = imageUrl
  const audioUrl = resolveReviewUrl(stringValue(record.audio), baseUrl); if (audioUrl !== undefined) protocol.audioUrl = audioUrl
  const time = stringValue(record.time); if (time !== undefined) protocol.time = time
  const likeCount = parseInteger(record.likeCount); if (likeCount !== undefined) protocol.likeCount = likeCount
  const replyCount = parseInteger(record.replyCount); if (replyCount !== undefined) protocol.replyCount = replyCount
  return protocol
}

function parseInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/u.test(value.trim()) ? Number(value.trim()) : NaN
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function stringValue(value: unknown): string | undefined { return value === undefined || value === null ? undefined : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => { const text = stringValue(item); return text === undefined ? [] : [text] }) : stringValue(value) === undefined ? [] : [stringValue(value)!] }
function splitBadges(value: string): string[] { return value.split(/[|,，、]/u).map((item) => item.trim()).filter(Boolean) }
function resolveReviewUrl(value: string | undefined, baseUrl: string): string | undefined { if (value === undefined || value.trim().length === 0) return undefined; try { return new URL(value, baseUrl).toString() } catch { return undefined } }
function reviewDiagnostic(code: WorkflowDiagnostic['code'], message: string, field?: string): WorkflowDiagnostic { return { code, stage, ...(field === undefined ? {} : { field }), message, retryable: false } }
function emptyReview(diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): RuntimeResult<ReviewSummaryItem[]> { return { status: 'empty', value: [], diagnostics, trace } }
function detailPageResult(page: number, items: ReviewDetailItem[], nextCursor?: { index: number; token?: string }): ReviewDetailPage { return { ...pageResult({ index: page }, items, nextCursor), hasMore: nextCursor !== undefined && items.length > 0 } }
function emptyDetail(diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], page = 1): RuntimeResult<ReviewDetailPage> { return { status: 'empty', value: detailPageResult(page, []), diagnostics, trace } }
function cancelledReview<T>(message: string, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], _page?: number): RuntimeResult<T> { diagnostics.push(reviewDiagnostic('cancelled', message)); return { status: 'cancelled', value: null, diagnostics, trace } }
function failedReview<T>(status: 'failed' | 'capability-missing', message: string, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], _page?: number): RuntimeResult<T> { diagnostics.push(reviewDiagnostic(status === 'capability-missing' ? 'capability-missing' : 'rule-failed', message)); return { status, value: null, diagnostics, trace } }
function reviewFromDiagnostics<T extends ReviewSummaryItem[] | ReviewDetailPage>(kind: 'summary' | 'detail', diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], page = 1): RuntimeResult<T> { const status = statusFromDiagnostics(diagnostics, 0); const value = kind === 'summary' ? [] : detailPageResult(page, []); return { status, value: status === 'cancelled' || status === 'failed' || status === 'capability-missing' ? null : value as T, diagnostics, trace } }
