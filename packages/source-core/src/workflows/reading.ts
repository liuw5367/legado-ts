import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { compileRule } from '../rules/compiler.ts'
import { compileSourcePattern } from '../rules/pattern-guard.ts'
import type { CompiledRule } from '../rules/types.ts'
import { resolveSourceRequestReference } from '../runtime/request-url.ts'
import { loadBookDetails, searchBooks } from './discovery.ts'
import { formatChapterBody } from './html-format.ts'
import { evaluateField, executeImageDecodeScript, executeSourceFunction, executeWorkflowJavaScript, expandUrl, expansionDiagnostic, expansionStatus, jsonValue, requestPageResponse, ruleString, sourceNumber, sourceString, statusFromDiagnostics, textValue } from './helpers.ts'
import { internalChapterScopeBinding } from './types.ts'
import type { BookMetadata, Chapter, ChapterContent, ChapterContentBatchItem, ChapterContentBatchResult, ContentBatchInput, ContentCacheRecord, ContentIdentity, ContentInput, ContentResource, ImageDecodeInput, ReadingPorts, RuntimeResult, StoredContentInput, TocInput, TocPage, WorkflowDiagnostic, WorkflowOptions, WorkflowPorts, WorkflowRequest, WorkflowStage, WorkflowTraceEntry } from './types.ts'

let paginationBatchSequence = 0

export async function loadTableOfContents(ports: ReadingPorts, input: TocInput): Promise<RuntimeResult<TocPage>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const cursor = input.cursor ?? { index: 0 }
  if (sourceString(input.source, 'mainJs') !== undefined) return javascriptTableOfContents(ports, input, diagnostics, trace)
  let book = cloneBookMetadata(input.book)
  const preUpdateJs = ruleString(input.source, 'ruleToc', 'preUpdateJs')
  if (input.runPerJs === true && preUpdateJs !== undefined) {
    const actionOptions = (signal: AbortSignal) => ({ signal, ...(input.budget === undefined ? {} : { budget: input.budget }) })
    const updateDetails = async (candidate: BookMetadata, signal: AbortSignal): Promise<BookMetadata> => {
      const result = await loadBookDetails(ports, { source: input.source, candidates: [candidate], canReName: false, ...actionOptions(signal) })
      trace.push(...result.trace)
      diagnostics.push(...result.diagnostics)
      const updated = result.value?.items[0]
      if (updated === undefined) throw workflowActionError(result.status, '获取书籍详情失败')
      book = updated
      return updated
    }
    const absorbScriptBook = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      book = mergeBookScriptValues(book, value as Record<string, unknown>)
    }
    const workflowActions = {
      refreshTocUrl: async (signal: AbortSignal, scriptBook: unknown): Promise<unknown> => {
        absorbScriptBook(scriptBook)
        if (input.isFromBookInfo === true) return book
        return updateDetails(book, signal)
      },
      reGetBook: async (signal: AbortSignal, scriptBook: unknown): Promise<unknown> => {
        absorbScriptBook(scriptBook)
        const expectedName = book.name ?? ''
        const expectedAuthor = book.author ?? ''
        const searched = await searchBooks(ports, {
          source: input.source,
          keyword: expectedName,
          acceptCandidate: (candidate) => candidate.name === expectedName && (candidate.author ?? '') === expectedAuthor,
          shouldStop: () => true,
          ...actionOptions(signal),
        })
        trace.push(...searched.trace)
        const exact = searched.value?.items[0]
        if (exact === undefined) throw workflowActionError(searched.status, `没有搜索到 ${book.name ?? ''}(${book.author ?? ''})`)
        diagnostics.push(...searched.diagnostics)
        const candidate: BookMetadata = {
          ...book,
          bookUrl: exact.bookUrl,
          ...(exact.variable === undefined ? {} : { variable: mergeVariableJson(book.variable, exact.variable) }),
        }
        return updateDetails(candidate, signal)
      },
    }
    const preUpdate = await executeWorkflowJavaScript(ports, input.source, `${preUpdateJs}\n;book`, stage, 'book', trace, { bindings: { book: { ...book }, fromBookInfo: input.isFromBookInfo === true, isFromBookInfo: input.isFromBookInfo === true }, captureMutations: ['book'], workflowActions, javascriptBudget: { timeoutMs: 30_000 }, ...(input.signal === undefined ? {} : { signal: input.signal }) })
    if (preUpdate.state === 'cancelled' || input.signal?.aborted === true) return cancelled('目录预处理脚本已取消', diagnostics, trace)
    if (preUpdate.state === 'capability-missing' || preUpdate.state === 'failed') {
      diagnostics.push({ code: preUpdate.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage, field: 'preUpdateJs', message: preUpdate.message ?? '目录预处理脚本失败', retryable: false })
      return { status: preUpdate.state === 'capability-missing' ? 'capability-missing' : 'failed', value: null, diagnostics, trace }
    }
    if (typeof preUpdate.value === 'object' && preUpdate.value !== null && !Array.isArray(preUpdate.value)) {
      const result = preUpdate.value as Record<string, unknown>
      const hasCapture = Object.hasOwn(result, '__legadoWorkflowBindings')
      const returnedBook = hasCapture ? result.__legadoWorkflowValue : result
      const capturedBook = hasCapture && typeof result.__legadoWorkflowBindings === 'object' && result.__legadoWorkflowBindings !== null
        ? (result.__legadoWorkflowBindings as Record<string, unknown>).book
        : undefined
      if (typeof returnedBook === 'object' && returnedBook !== null && !Array.isArray(returnedBook)) {
        const values = { ...(returnedBook as Record<string, unknown>) }
        if (typeof capturedBook === 'object' && capturedBook !== null && typeof (capturedBook as Record<string, unknown>).variable === 'string') {
          values.variable = (capturedBook as Record<string, unknown>).variable
        }
        book = mergeBookScriptValues(book, values)
      }
    }
  }
  const listRule = ruleString(input.source, 'ruleToc', 'chapterList')
  if (listRule === undefined) {
    diagnostics.push({ code: 'invalid-config', stage, message: '缺少 chapterList 规则', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const maxPages = input.maxPages ?? sourceNumber(input.source, 'tocMaxPages') ?? 32
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024
  const visited = new Set<string>()
  const chapters: Chapter[] = []
  const reverseByRule = listRule.startsWith('-')
  const resolvedBookUrl = resolveUrl(book.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  const rawTocUrl = book.tocUrl?.trim() ? book.tocUrl : book.bookUrl
  const rawBookUrl = resolveUrl(rawTocUrl, resolvedBookUrl) ?? resolvedBookUrl
  // 目录地址同样允许 `{{...}}` 内联表达式（Android 对每个 AnalyzeUrl 都做同样的展开）。
  const expandedBookUrl = await expandUrl(ports, input.source, stage, rawBookUrl, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl, book }, input.signal)
  if (expandedBookUrl.url === undefined) {
    diagnostics.push(expansionDiagnostic(expandedBookUrl.error, stage, 'tocUrl', '目录地址展开失败'))
    return { status: expansionStatus(expandedBookUrl.error), value: null, diagnostics, trace }
  }
  const bookBaseUrl = expandedBookUrl.url
  const pendingPages = [{ url: bookBaseUrl, followNext: true }]
  let pagesFetched = 0
  let totalBytes = 0
  let volume: string | undefined
  let paginationMode: 'undecided' | 'serial' | 'parallel' | 'none' = 'undecided'
  let loginCheckConsumed = false
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
    pagesFetched += 1
    // 明确刷新时详情阶段暂存的目录响应也可能过期，必须重新请求第一页。
    const canReuseTocHtml = input.refresh !== true && book.tocHtml !== undefined && book.tocHtml.length > 0 && book.tocUrl !== undefined && book.tocUrl === book.bookUrl
    let page: { body: string; url: string } | undefined
    if (pageIndex === 0 && canReuseTocHtml && normalizedUrl === bookBaseUrl) {
      page = { body: book.tocHtml!, url: normalizedUrl }
    } else {
      const requestOptions = pageOptions(input, maxBytes, totalBytes)
      if (loginCheckConsumed) requestOptions.skipLoginCheck = true
      // 缓存命中不消耗资格；第一个真实网络请求（即使失败）才消耗一次 loginCheckJs。
      loginCheckConsumed = true
      page = await loadPage(ports, input.source, normalizedUrl, stage, requestOptions, diagnostics, trace, undefined, { book })
    }
    if (page === undefined) break
    const body = page.body
    totalBytes += new TextEncoder().encode(body).byteLength
    if (totalBytes > maxBytes) {
      diagnostics.push({ code: 'item-skipped', stage, message: '目录累计响应超过字节预算', retryable: false })
      break
    }
    const responseUrl = resolveUrl(page.url, normalizedUrl) ?? normalizedUrl
    visited.add(responseUrl)
    // Android 串行跟随下一页时把请求 URL 同时作为 baseUrl/redirectUrl；并行分支仍保留最终响应地址。
    const ruleResponseUrl = pageIndex > 0 && pendingPage.followNext ? normalizedUrl : responseUrl
    const parsed = await parseTocPage(ports, input, book, body, pageIndex, normalizedUrl, ruleResponseUrl, volume, listRuleBody, pendingPage.followNext, input.signal)
    diagnostics.push(...parsed.diagnostics)
    appendTocChapters(chapters, parsed.chapters, parsed.trace)
    trace.push(...parsed.trace)
    volume = parsed.volume
    if (parsed.cancelled || isSignalAborted(input.signal)) return cancelled('目录规则执行已取消', diagnostics, trace)
    if (parsed.fatal) break
    if (parsed.nextUrls === undefined) continue
    const resolvedNextUrls = parsed.nextUrls
    if (pageIndex === 0 && paginationMode === 'undecided') {
      paginationMode = resolvedNextUrls.length === 0 ? 'none' : resolvedNextUrls.length === 1 ? 'serial' : 'parallel'
    }
    if (paginationMode === 'none') continue
    const unseenNextUrls = resolvedNextUrls.filter((nextUrl) => !visited.has(nextUrl) && !pendingPages.some((item) => item.url === nextUrl))
    if (paginationMode === 'serial') {
      const nextUrl = unseenNextUrls[0]
      if (nextUrl !== undefined) pendingPages.push({ url: nextUrl, followNext: true })
      continue
    }
    const availablePages = Math.max(0, maxPages - pagesFetched)
    const branchUrls = unseenNextUrls.slice(0, availablePages)
    if (branchUrls.length < unseenNextUrls.length) diagnostics.push({ code: 'item-skipped', stage, message: '目录页数超过限制', retryable: false })
    if (branchUrls.length > 0) {
      for (const branchUrl of branchUrls) visited.add(branchUrl)
      const firstBranchNeedsLoginCheck = !loginCheckConsumed
      const batch = await fetchPageBatch(ports, input.source, branchUrls, stage, { ...pageOptions(input, maxBytes, totalBytes), skipLoginCheck: loginCheckConsumed }, undefined, firstBranchNeedsLoginCheck, { book })
      loginCheckConsumed = true
      if (isSignalAborted(input.signal)) {
        appendBatchDiagnostics(batch, diagnostics, trace, true)
        return cancelled('目录工作流已取消', diagnostics, trace)
      }
      appendBatchDiagnostics(batch, diagnostics, trace)
      pagesFetched += branchUrls.length
      for (const [branchIndex, outcome] of batch.outcomes.entries()) {
        if (outcome.page === undefined) {
          diagnostics.push({ code: 'item-skipped', stage, message: '目录并发分页已中止', retryable: false })
          break
        }
        const branchBytes = new TextEncoder().encode(outcome.page.body).byteLength
        totalBytes += branchBytes
        if (totalBytes > maxBytes) {
          diagnostics.push({ code: 'item-skipped', stage, message: '目录累计响应超过字节预算', retryable: false })
          break
        }
        const branchUrl = resolveUrl(outcome.page.url, branchUrls[branchIndex]!) ?? branchUrls[branchIndex]!
        visited.add(branchUrl)
        const parsedBranch = await parseTocPage(ports, input, book, outcome.page.body, pageIndex + branchIndex + 1, branchUrls[branchIndex]!, branchUrl, undefined, listRuleBody, false, input.signal)
        diagnostics.push(...parsedBranch.diagnostics)
        appendTocChapters(chapters, parsedBranch.chapters, parsedBranch.trace)
        trace.push(...parsedBranch.trace)
        if (parsedBranch.cancelled || isSignalAborted(input.signal)) return cancelled('目录规则执行已取消', diagnostics, trace)
        if (parsedBranch.fatal) break
      }
    }
    break
  }
  if (pendingPages.length > 0 && visited.size >= maxPages) diagnostics.push({ code: 'item-skipped', stage, message: '目录页数超过限制', retryable: false })
  if (!reverseByRule) chapters.reverse()
  const uniqueChapters = deduplicateChapters(chapters, diagnostics, stage)
  if (book.readConfig?.reverseToc !== true) uniqueChapters.reverse()
  uniqueChapters.forEach((chapter, index) => { chapter.index = index })
  const formatJs = ruleString(input.source, 'ruleToc', 'formatJs')
  if (formatJs !== undefined) {
    await formatChapterTitles(ports, input.source, uniqueChapters, formatJs, book, input, diagnostics, trace)
    if (input.signal?.aborted === true || diagnostics.some((item) => item.code === 'cancelled')) return { status: 'cancelled', value: null, diagnostics, trace }
  }
  if (uniqueChapters.length === 0) diagnostics.push({ code: 'empty-page', stage, message: '目录为空', retryable: false })
  const value: TocPage = { items: uniqueChapters, cursor, ...(pendingPages.length > 0 ? { nextCursor: { index: cursor.index + 1 } } : {}) }
  const fatalCode = diagnostics.find((item) => item.code === 'request-failed' || item.code === 'rule-failed' || item.code === 'capability-missing')?.code
  if (fatalCode !== undefined) return { status: fatalCode === 'capability-missing' ? 'capability-missing' : 'failed', value: null, diagnostics, trace }
  if (uniqueChapters.length === 0) {
    const limited = diagnostics.some((item) => item.message.includes('预算') || item.message.includes('限制'))
    return { status: limited ? 'partial' : 'failed', value: limited ? value : null, diagnostics, trace }
  }
  const status = statusFromDiagnostics(diagnostics, uniqueChapters.length)
  // 取消的调用不能拿到半份目录。
  return { status, value: status === 'success' ? { ...value, bookAfter: withoutTransientBookFields(book) } : status === 'cancelled' ? null : value, diagnostics, trace }
}

async function javascriptTableOfContents(ports: ReadingPorts, input: TocInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<RuntimeResult<TocPage>> {
  const cursor = input.cursor ?? { index: 0 }
  const sourceBook = cloneBookMetadata(input.book)
  const book = { ...sourceBook.rawFields, ...sourceBook, origin: sourceBook.sourceId, originName: input.source.bookSourceName, type: javascriptBookType(undefined, input.source) }
  const result = await executeSourceFunction(ports, input.source, 'getChapters', [book], { book }, 'detail', 'chapter', trace, input.signal)
  if (result.state === 'cancelled' || input.signal?.aborted === true) return cancelled('JS 目录工作流已取消', diagnostics, trace)
  if (result.state === 'capability-missing') {
    diagnostics.push({ code: 'capability-missing', stage: 'detail', field: 'getChapters', message: result.message ?? 'JavaScript 源函数宿主不可用', retryable: false })
    return { status: 'capability-missing', value: null, diagnostics, trace }
  }
  if (result.state === 'missing-function' || result.state === 'failed') {
    diagnostics.push({ code: result.state === 'missing-function' ? 'invalid-config' : 'rule-failed', stage: 'detail', field: 'getChapters', message: result.message ?? 'JS 书源缺少 getChapters 函数', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  let rows: unknown = result.value
  if (rows === null || rows === undefined || typeof rows === 'string' && rows.trim().length === 0) rows = []
  else if (typeof rows === 'string') {
    try { rows = JSON.parse(rows) as unknown } catch { /* Android 同样要求 JSONArray。 */ }
  }
  if (!Array.isArray(rows)) {
    diagnostics.push({ code: 'rule-failed', stage: 'detail', field: 'getChapters', message: 'JS 书源 getChapters 必须返回数组', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const tocBaseUrl = resolveUrl(input.book.tocUrl?.trim() ? input.book.tocUrl : input.book.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  const chapters: Chapter[] = []
  for (const [itemIndex, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const title = javascriptPrimitiveText(record.title)?.trim() ?? ''
    const rawUrl = javascriptPrimitiveText(record.url ?? record.chapterUrl)?.trim() ?? ''
    if (title.length === 0 || rawUrl.length === 0) {
      diagnostics.push({ code: 'item-skipped', stage: 'detail', itemIndex, message: 'JS 目录项缺少 title 或 url', retryable: false })
      continue
    }
    const isVolume = booleanValue(record.isVolume)
    const chapterUrl = isVolume && rawUrl === title ? rawUrl : resolveUrl(rawUrl, tocBaseUrl)
    if (chapterUrl === undefined) {
      diagnostics.push({ code: 'item-skipped', stage: 'detail', itemIndex, message: 'JS 目录项 URL 无效', retryable: false })
      continue
    }
    const chapter: Chapter = {
      sourceId: input.source.bookSourceUrl,
      bookUrl: input.book.bookUrl,
      url: isVolume && rawUrl === title ? rawUrl : chapterUrl,
      baseUrl: tocBaseUrl,
      chapterUrl,
      index: chapters.length,
      title,
      rawFields: jsonValue(record) as JsonObject,
      traceRef: `toc:${chapters.length}`,
      isVolume,
      isVip: booleanValue(record.isVip),
      isPay: booleanValue(record.isPay),
    }
    if (typeof record.variable === 'string') chapter.variable = record.variable
    else if (typeof record.variable === 'object' && record.variable !== null && !Array.isArray(record.variable)) chapter.variable = JSON.stringify(record.variable)
    const volume = typeof record.volume === 'string' ? record.volume : undefined
    if (volume !== undefined && volume.length > 0) chapter.volume = volume
    const updateTime = typeof record.updateTime === 'string' ? record.updateTime : typeof record.tag === 'string' ? record.tag : undefined
    if (updateTime !== undefined && updateTime.length > 0) chapter.updateTime = updateTime
    chapters.push(chapter)
  }
  chapters.forEach((chapter, index) => { chapter.index = index })
  if (chapters.length === 0) diagnostics.push({ code: 'empty-page', stage: 'detail', message: 'JS 目录为空', retryable: false })
  const value: TocPage = { items: chapters, cursor }
  const status = statusFromDiagnostics(diagnostics, chapters.length)
  if ((status === 'success' || status === 'partial') && typeof book.variable === 'string') input.book.variable = book.variable
  return chapters.length === 0
    ? { status: 'failed', value: null, diagnostics, trace }
    : { status, value: status === 'success' ? { ...value, bookAfter: withoutTransientBookFields(mergeBookScriptValues(input.book, book)) } : value, diagnostics, trace }
}

function chapterRuleUrl(chapter: Pick<Chapter, 'url' | 'chapterUrl'>): string {
  return typeof chapter.url === 'string' && chapter.url.length > 0 ? chapter.url : chapter.chapterUrl
}

/** 必要正文路径的失败不能降级成 partial；副内容、标题和替换增强均是可选项。 */
function contentFatalStatus(diagnostics: readonly WorkflowDiagnostic[]): 'failed' | 'capability-missing' | undefined {
  const fatal = diagnostics.find((item) => {
    if (item.field === 'subContent' || item.field === 'title' || item.field === 'replaceRegex' || item.field === 'replacements') return false
    return item.code === 'request-failed' || item.code === 'rule-failed' || item.code === 'capability-missing' || item.code === 'invalid-config'
  })
  if (fatal === undefined) return undefined
  return fatal.code === 'capability-missing' ? 'capability-missing' : 'failed'
}

export async function loadChapterContent(ports: ReadingPorts, input: ContentInput): Promise<RuntimeResult<ChapterContent>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const rawChapterUrl = chapterRuleUrl(input.chapter)
  const bookUrl = resolveUrl(input.chapter.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  const chapterBaseReference = input.chapter.baseUrl?.trim() || input.book?.tocUrl?.trim() || input.chapter.bookUrl
  const chapterBaseUrl = resolveUrl(chapterBaseReference, bookUrl) ?? bookUrl
  const chapterTitle = input.chapter.title ?? ''
  const isVolumePlaceholder = input.chapter.isVolume === true && chapterTitle.length > 0 && rawChapterUrl.startsWith(chapterTitle)
  if (isVolumePlaceholder) {
    if (input.signal?.aborted === true) return cancelled('正文工作流已取消', diagnostics, trace)
    diagnostics.push({ code: 'empty-page', stage, message: '卷节点没有正文', retryable: false })
    return { status: 'empty', value: { chapter: input.chapter, contentType: 'text', raw: '', cleaned: '', pages: [], resources: [] }, diagnostics, trace }
  }
  if (sourceString(input.source, 'mainJs') !== undefined) return javascriptChapterContent(ports, input, diagnostics, trace)
  const configuredContentRule = ruleString(input.source, 'ruleContent', 'content')
  // Android uses isNullOrEmpty() for ContentRule.content; an explicit empty
  // string therefore follows the same chapter-link fallback as a missing rule.
  const contentRule = configuredContentRule !== undefined && configuredContentRule.length > 0
    ? configuredContentRule
    : sourceString(input.source, 'ruleContent')
  if (contentRule === undefined) {
    const url = rawChapterUrl
    return { status: 'success', value: { chapter: input.chapter, contentType: 'text', raw: url, cleaned: url, pages: [url], resources: [], finalUrl: input.chapter.chapterUrl }, diagnostics, trace }
  }
  const contentType = input.contentType ?? (input.source.contentType === 'html' || ruleReturnsHtml(contentRule) ? 'html' : 'text')
  const titleRule = ruleString(input.source, 'ruleContent', 'title')
  const replaceRule = ruleString(input.source, 'ruleContent', 'replaceRegex')
  const contentWebJs = ruleString(input.source, 'ruleContent', 'webJs')
  const contentSourceRegex = ruleString(input.source, 'ruleContent', 'sourceRegex')
  // Android 在正文请求上单独传递 contentRule.webJs/sourceRegex，其他阶段不传；
  // 分页请求只带 webJs（BookContent.kt:92 的 getStrResponseAwait(jsStr = webJs)）。
  const firstPageExecution = contentWebJs === undefined && contentSourceRegex === undefined
    ? undefined
    : { ...(contentWebJs === undefined ? {} : { webJs: contentWebJs }), ...(contentSourceRegex === undefined ? {} : { sourceRegex: contentSourceRegex }) }
  const pagedExecution = contentWebJs === undefined ? undefined : { webJs: contentWebJs }
  const maxPages = input.maxPages ?? sourceNumber(input.source, 'contentMaxPages') ?? 32
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024
  const maxOutputBytes = input.maxOutputBytes ?? 4 * 1024 * 1024
  const variableBook: BookMetadata = input.book ?? {
    sourceId: input.chapter.sourceId,
    bookUrl: input.chapter.bookUrl,
    name: '',
    rawFields: {},
    traceRef: 'content:book',
    emptyFields: [],
    fieldErrors: {},
    tocUrl: input.chapter.bookUrl,
  }
  const resultChapter = {
    ...input.chapter,
    url: rawChapterUrl,
    baseUrl: chapterBaseUrl,
    ...(input.chapter.rawFields === undefined ? {} : { rawFields: { ...input.chapter.rawFields } }),
  }
  // AnalyzeRule.setNextChapterUrl 在 Android 中会把该值暴露给每个声明式正文规则。
  const ruleBindings = { book: variableBook, chapter: resultChapter, nextChapterUrl: input.nextChapterUrl ?? null }
  const firstRequestContext: Pick<WorkflowRequest, 'book' | 'chapter'> = { book: variableBook, chapter: resultChapter }
  const laterRequestContext: Pick<WorkflowRequest, 'book'> = { book: variableBook }
  const visited = new Set<string>()
  const pages: string[] = []
  const cleanedPages: string[] = []
  const resources: ContentResource[] = []
  const mediaType = sourceNumber(input.source, 'bookSourceType') ?? 0
  const skipTextFormatting = mediaType === 1 || mediaType === 4
  const appendContentPage = (contentPage: string, responseUrl: string): void => {
    pages.push(contentPage)
    const formattedPage = skipTextFormatting
      ? { content: contentPage, imageUrls: [] }
      : formatChapterBody(contentPage, responseUrl, input.adaptSpecialStyle === undefined ? {} : { adaptSpecialStyle: input.adaptSpecialStyle })
    cleanedPages.push(formattedPage.content)
    resources.push(...formattedPage.imageUrls.map((url) => ({ kind: 'image' as const, url })))
  }
  const rawFirstPageUrl = resolveUrl(rawChapterUrl, chapterBaseUrl) ?? resolveUrl(rawChapterUrl, bookUrl) ?? rawChapterUrl
  const expandedFirstPage = await expandUrl(ports, input.source, stage, rawFirstPageUrl, { 'source.bookSourceUrl': input.source.bookSourceUrl }, {
    'source.bookSourceUrl': input.source.bookSourceUrl,
    book: variableBook,
    [internalChapterScopeBinding]: resultChapter,
  }, input.signal)
  if (expandedFirstPage.url === undefined) {
    diagnostics.push(expansionDiagnostic(expandedFirstPage.error, stage, 'chapterUrl', '章节地址展开失败'))
    return { status: expansionStatus(expandedFirstPage.error), value: null, diagnostics, trace }
  }
  const firstPageUrl = expandedFirstPage.url
  const pendingPages = [{ url: firstPageUrl, followNext: true }]
  let totalBytes = 0
  let stoppedByLimit = false
  let loginCheckConsumed = false
  // 命中下一章时终止分页（Android BookContent 的 nextChapterUrl 护栏）。
  let reachedNextChapter = false
  let nextChapterAbsolute: string | undefined
  // Android 用第一页响应求值 ruleContent.title。
  let firstPage: { body: string; url: string; context: { baseUrl: string; redirectUrl: string } } | undefined
  let finalResponseUrl: string | undefined
  for (let pageIndex = 0; pageIndex < maxPages && pendingPages.length > 0; pageIndex += 1) {
    if (input.signal?.aborted === true) return cancelled('正文工作流已取消', diagnostics, trace)
    const pendingPage = pendingPages.shift()!
    const normalizedUrl = resolveUrl(pendingPage.url, bookUrl)
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
    let page: { body: string; url: string } | undefined
    const canReuseTocHtml = pageIndex === 0 && input.tocHtml !== undefined && normalizedUrl === bookUrl
    if (canReuseTocHtml) {
      page = { body: input.tocHtml!, url: normalizedUrl }
    } else {
      const requestOptions = pageOptions(input, maxBytes, totalBytes)
      if (loginCheckConsumed) requestOptions.skipLoginCheck = true
      // 只有第一个实际网络请求运行 loginCheckJs；详情页复用不消耗资格。
      loginCheckConsumed = true
      page = await loadPage(ports, input.source, normalizedUrl, stage, requestOptions, diagnostics, trace, pageIndex === 0 ? firstPageExecution : pagedExecution, pageIndex === 0 ? firstRequestContext : laterRequestContext)
    }
    if (page === undefined) break
    const body = page.body
    const responseUrl = resolveUrl(page.url, normalizedUrl) ?? normalizedUrl
    const context = { baseUrl: normalizedUrl, redirectUrl: responseUrl }
    finalResponseUrl = responseUrl
    if (pageIndex === 0) firstPage = { body, url: responseUrl, context }
    // Android BookContent 固定用第一页的最终响应地址解析下一章地址。
    if (pageIndex === 0 && input.nextChapterUrl !== undefined) nextChapterAbsolute = resolveUrl(input.nextChapterUrl, responseUrl)
    totalBytes += new TextEncoder().encode(body).byteLength
    if (totalBytes > maxBytes) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文累计响应超过字节预算', retryable: false })
      stoppedByLimit = true
      break
    }
    const result = await evaluateField(ports, input.source, stage, 'content', contentRule, body, pageIndex, trace, input.signal, { ...context, bindings: ruleBindings })
    if (result.state === 'cancelled') return cancelled('正文规则执行已取消', diagnostics, trace)
    if (result.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage, field: 'content', message: result.message ?? '正文规则能力不可用', retryable: false })
      return { status: 'capability-missing', value: null, diagnostics, trace }
    }
    if (result.state === 'failed') {
      diagnostics.push({ code: 'rule-failed', stage, field: 'content', message: result.message ?? '正文规则失败', retryable: false })
      return { status: 'failed', value: null, diagnostics, trace }
    }
    const contentPage = result.state === 'value' ? textValue(result.value) : ''
    appendContentPage(contentPage, responseUrl)
    if (!pendingPage.followNext) continue
    const nextContentRule = ruleString(input.source, 'ruleContent', 'nextContentUrl')
    const nextRule = nextContentRule ?? ruleString(input.source, 'ruleContent', 'nextPage')
    const nextField = nextContentRule !== undefined ? 'nextContentUrl' : 'nextPage'
    if (nextRule === undefined) continue
    const next = await evaluateField(ports, input.source, stage, nextField, nextRule, body, pageIndex, trace, input.signal, { ...context, bindings: ruleBindings })
    if (next.state === 'cancelled') return cancelled('正文下一页规则已取消', diagnostics, trace)
    if (next.state === 'failed' || next.state === 'capability-missing') {
      diagnostics.push({ code: next.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage, field: nextField, message: next.message ?? (next.state === 'capability-missing' ? '正文下一页规则能力不可用' : '正文下一页规则失败'), retryable: false })
      return { status: next.state === 'capability-missing' ? 'capability-missing' : 'failed', value: null, diagnostics, trace }
    }
    if (next.state !== 'value') continue
    const nextValues = listValues(next.value)
    const resolvedNextUrls: string[] = []
    for (const value of nextValues) {
      const resolvedNext = resolveUrl(value, responseUrl)
      const expandedNext = resolvedNext === undefined ? undefined : await expandUrl(ports, input.source, stage, resolvedNext, { 'source.bookSourceUrl': input.source.bookSourceUrl }, {
        'source.bookSourceUrl': input.source.bookSourceUrl,
        book: variableBook,
      }, input.signal)
      const nextUrl = expandedNext?.url
      if (nextUrl === undefined) {
        if (expandedNext?.error?.code === 'cancelled') return cancelled('正文下一页地址展开已取消', diagnostics, trace)
        diagnostics.push({ code: expandedNext?.error?.code ?? 'item-skipped', stage, field: nextField, message: expandedNext?.error?.message ?? '正文下一页 URL 无效', retryable: false })
        stoppedByLimit = true
        continue
      }
      if (!resolvedNextUrls.includes(nextUrl)) resolvedNextUrls.push(nextUrl)
    }
    if (resolvedNextUrls.length === 1 && nextChapterAbsolute !== undefined && resolvedNextUrls[0] === nextChapterAbsolute) {
      reachedNextChapter = true
      pendingPages.length = 0
      break
    }
    if (resolvedNextUrls.length === 1) {
      const nextUrl = resolvedNextUrls[0]!
      if (visited.has(nextUrl)) {
        diagnostics.push({ code: 'item-skipped', stage, field: nextField, message: '正文下一页形成循环', retryable: false })
        stoppedByLimit = true
      } else if (!pendingPages.some((item) => item.url === nextUrl)) pendingPages.push({ url: nextUrl, followNext: true })
      continue
    }
    if (resolvedNextUrls.length > 1) {
      const branchUrls = resolvedNextUrls.filter((nextUrl) => {
        if (visited.has(nextUrl)) {
          diagnostics.push({ code: 'item-skipped', stage, field: nextField, message: '正文下一页形成循环', retryable: false })
          stoppedByLimit = true
          return false
        }
        return true
      })
      const availablePages = Math.max(0, maxPages - pageIndex - 1)
      const scheduledUrls = branchUrls.slice(0, availablePages)
      if (scheduledUrls.length < branchUrls.length) {
        diagnostics.push({ code: 'item-skipped', stage, field: nextField, message: '正文页数超过限制', retryable: false })
        stoppedByLimit = true
      }
      for (const branchUrl of scheduledUrls) visited.add(branchUrl)
      if (scheduledUrls.length > 0) {
        // Android 多 URL 分支调用 getStrResponseAwait() 时不传 webJs/sourceRegex。
        const firstBranchNeedsLoginCheck = !loginCheckConsumed
        const batch = await fetchPageBatch(ports, input.source, scheduledUrls, stage, { ...pageOptions(input, maxBytes, totalBytes), ...(loginCheckConsumed ? { skipLoginCheck: true } : {}) }, undefined, firstBranchNeedsLoginCheck, laterRequestContext)
        loginCheckConsumed = true
        if (isSignalAborted(input.signal)) {
          appendBatchDiagnostics(batch, diagnostics, trace, true)
          return cancelled('正文工作流已取消', diagnostics, trace)
        }
        appendBatchDiagnostics(batch, diagnostics, trace)
        for (const [branchIndex, outcome] of batch.outcomes.entries()) {
          if (outcome.page === undefined) {
            stoppedByLimit = true
            break
          }
          const branchBytes = new TextEncoder().encode(outcome.page.body).byteLength
          totalBytes += branchBytes
          if (totalBytes > maxBytes) {
            diagnostics.push({ code: 'item-skipped', stage, message: '正文累计响应超过字节预算', retryable: false })
            stoppedByLimit = true
            break
          }
          const branchUrl = scheduledUrls[branchIndex]!
          const branchResponseUrl = resolveUrl(outcome.page.url, branchUrl) ?? branchUrl
          finalResponseUrl = branchResponseUrl
          const branchResult = await evaluateField(ports, input.source, stage, 'content', contentRule, outcome.page.body, pageIndex + branchIndex + 1, trace, input.signal, { baseUrl: branchUrl, redirectUrl: branchResponseUrl, bindings: ruleBindings })
          if (branchResult.state === 'cancelled') return cancelled('正文规则执行已取消', diagnostics, trace)
          if (branchResult.state === 'capability-missing') {
            diagnostics.push({ code: 'capability-missing', stage, field: 'content', message: branchResult.message ?? '正文规则能力不可用', retryable: false })
            return { status: 'capability-missing', value: null, diagnostics, trace }
          }
          if (branchResult.state === 'failed') {
            diagnostics.push({ code: 'rule-failed', stage, field: 'content', message: branchResult.message ?? '正文规则失败', retryable: false })
            return { status: 'failed', value: null, diagnostics, trace }
          }
          const branchContent = branchResult.state === 'value' ? textValue(branchResult.value) : ''
          appendContentPage(branchContent, branchResponseUrl)
        }
      }
      break
    }
  }
  // 请求被取消时不能把半截正文当成成功或空结果交付，状态必须与目录流程一致。
  // 诊断已经在请求层压过一条，这里只改状态，不再重复报告。
  if (diagnostics.some((item) => item.code === 'cancelled')) return { status: 'cancelled', value: null, diagnostics, trace }
  if (pendingPages.length > 0) stoppedByLimit = true
  let auxiliary: ChapterContent['auxiliary']
  const subContentRule = ruleString(input.source, 'ruleContent', 'subContent')
  if (subContentRule !== undefined && firstPage !== undefined) {
    const field = await evaluateField(ports, input.source, stage, 'subContent', subContentRule, firstPage.body, undefined, trace, input.signal, { ...firstPage.context, bindings: ruleBindings })
    if (field.state === 'cancelled' || input.signal?.aborted === true) return cancelled('正文副内容规则已取消', diagnostics, trace)
    if (field.state === 'failed') {
      diagnostics.push({ code: 'rule-failed', stage, field: 'subContent', message: field.message ?? '正文副内容规则失败', retryable: false })
      return { status: 'failed', value: null, diagnostics, trace }
    }
    if (field.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage, field: 'subContent', message: field.message ?? '正文副内容规则宿主能力不可用', retryable: false })
      return { status: 'capability-missing', value: null, diagnostics, trace }
    }
    const rawSubContent = field.state === 'value' ? textValue(field.value) : ''
    const bookType = resolvedBookType(input.book, input.source)
    if (isOnlineTextBook(bookType, input.book)) {
      // Android 对在线文本源不 trim、不请求副文，即便文本看起来像 URL。
      pages.push(rawSubContent)
      cleanedPages.push(rawSubContent)
    } else {
      let subContent = rawSubContent.trim()
      let storeAuxiliary = true
      if (/^http/i.test(subContent)) {
        const beforeRequest = diagnostics.length
        const response = await requestPageResponse(ports, input.source, subContent, stage, { ...pageOptions(input, maxBytes, totalBytes), skipLoginCheck: true }, diagnostics, trace, undefined, laterRequestContext)
        const requestDiagnostics = diagnostics.slice(beforeRequest)
        for (const diagnostic of requestDiagnostics) if (diagnostic.field === undefined) diagnostic.field = 'subContent'
        if (isSignalAborted(input.signal) || requestDiagnostics.some((item) => item.code === 'cancelled')) {
          return cancelled('正文副内容请求已取消', diagnostics, trace)
        }
        if (response === undefined) {
          storeAuxiliary = false
        } else {
          const responseBytes = new TextEncoder().encode(response.content).byteLength
          totalBytes += responseBytes
          if (totalBytes > maxBytes) {
            diagnostics.push({ code: 'item-skipped', stage, field: 'subContent', message: '正文累计响应超过字节预算', retryable: false })
            storeAuxiliary = false
          } else {
            subContent = response.content
          }
        }
      }
      if (storeAuxiliary && isAudioBook(bookType)) {
        updateChapterVariable(resultChapter, 'lyric', subContent)
        auxiliary = { kind: 'lyrics', content: subContent }
      } else if (storeAuxiliary && isVideoBook(bookType)) {
        updateChapterVariable(resultChapter, 'danmaku', subContent)
        auxiliary = { kind: 'danmaku', content: subContent }
      }
    }
  }
  if (reachedNextChapter) trace.push({ stage, event: 'field', target: 'nextChapterUrl' })
  const raw = pages.join('\n')
  const joined = cleanedPages.join('\n')
  // Android 先逐行 trim，再把源级 replaceRegex 当规则对正文求值（可含 ##匹配##替换 或 @js:）。
  let sourceReplaced = joined
  if (replaceRule !== undefined) {
    const trimmed = joined.split('\n').map((line) => line.trim()).join('\n')
    const field = await evaluateField(ports, input.source, stage, 'replaceRegex', replaceRule, trimmed, undefined, trace, input.signal, firstPage?.context === undefined ? { bindings: ruleBindings } : { ...firstPage.context, bindings: ruleBindings })
    if (field.state === 'cancelled') return cancelled('正文替换规则执行已取消', diagnostics, trace)
    const replacementSucceeded = field.state === 'value' || field.state === 'empty'
    if (replacementSucceeded) sourceReplaced = textValue(field.value)
    else {
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage, field: 'replaceRegex', message: field.message ?? '正文替换规则失败', retryable: false })
      stoppedByLimit = true
    }
    if (replacementSucceeded && isOnlineTextBook(resolvedBookType(input.book, input.source), input.book)) {
      sourceReplaced = sourceReplaced.split('\n').map((line) => `　　${line}`).join('\n')
    }
  }
  let replaced = sourceReplaced
  const replacements = applyReplacements(sourceReplaced, input.replacements ?? [])
  replaced = replacements.text
  for (const message of replacements.errors) {
    diagnostics.push({ code: 'invalid-config', stage, field: 'replacements', message, retryable: false })
    stoppedByLimit = true
  }
  // Android 不会在 replaceRegex 和调用方替换规则之后再次格式化正文。
  const cleaned = replaced
  let title: string | undefined
  let imgUrl: string | undefined
  if (titleRule !== undefined && firstPage !== undefined) {
    const field = await evaluateField(ports, input.source, stage, 'title', titleRule, firstPage.body, undefined, trace, input.signal, { ...firstPage.context, bindings: ruleBindings })
    if (field.state === 'cancelled') return cancelled('章节标题规则执行已取消', diagnostics, trace)
    if (field.state === 'value') {
      const projection = chapterTitleProjection(textValue(field.value), resultChapter.title)
      title = projection.title
      imgUrl = projection.imgUrl
    }
    else if (field.state === 'failed' || field.state === 'capability-missing') {
      // 标题是可选字段：失败只报告，不阻断正文，调用方沿用目录标题。
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage, field: 'title', message: field.message ?? '章节标题规则失败', retryable: false })
    }
  }
  const outputBytes = new TextEncoder().encode(cleaned).byteLength
  if (outputBytes > maxOutputBytes) {
    diagnostics.push({ code: 'item-skipped', stage, message: '正文清洗结果超过输出预算', retryable: false })
    stoppedByLimit = true
  }
  const fatalStatus = contentFatalStatus(diagnostics)
  if (fatalStatus !== undefined) return { status: fatalStatus, value: null, diagnostics, trace }
  // Kotlin's String.isBlank() treats Unicode whitespace (for example U+3000)
  // as empty; checking only length would incorrectly deliver media chapters
  // whose extracted URL is whitespace.
  if (isAndroidBlank(cleaned)) {
    diagnostics.push({ code: 'empty-page', stage, message: '正文为空', retryable: false })
    if (resultChapter.isVolume === true) return { status: 'empty', value: { chapter: resultChapter, contentType, raw, cleaned, pages, resources: [], ...(finalResponseUrl === undefined ? {} : { finalUrl: finalResponseUrl }), ...(auxiliary === undefined ? {} : { auxiliary }), ...(title === undefined ? {} : { title }), ...(imgUrl === undefined ? {} : { imgUrl }) }, diagnostics, trace }
    return { status: 'failed', value: null, diagnostics, trace }
  }
  const value: ChapterContent = { chapter: resultChapter, contentType, raw, cleaned, pages, resources: uniqueResources(resources), ...(finalResponseUrl === undefined ? {} : { finalUrl: finalResponseUrl }), ...(auxiliary === undefined ? {} : { auxiliary }), ...(title === undefined ? {} : { title }), ...(imgUrl === undefined ? {} : { imgUrl }) }
  // Android catches副内容网络异常、记录日志并继续交付主正文；保留诊断，
  // 但不能把可选副内容失败升级成 partial 正文结果。
  const status = stoppedByLimit ? 'partial' : 'success'
  return { status, value, diagnostics, trace }
}

function isAndroidBlank(value: string): boolean {
  return value.trim().length === 0
}

function contentIdentityMatchesInput(identity: ContentIdentity, input: StoredContentInput): boolean {
  return identity.sourceId === input.source.bookSourceUrl
    && identity.bookUrl === input.chapter.bookUrl
    && identity.chapterIndex === input.chapter.index
    && identity.resourceKind === 'text'
}

function cacheChapter(value: ChapterContent, input: StoredContentInput): Chapter {
  const chapterValue = value.chapter as Chapter & { title?: string; rawFields?: JsonObject; traceRef?: string }
  return {
    ...input.chapter,
    ...chapterValue,
    title: chapterValue.title ?? input.chapter.title ?? '',
    rawFields: chapterValue.rawFields ?? input.chapter.rawFields ?? {},
    traceRef: chapterValue.traceRef ?? `content:${input.contentIdentity.chapterIndex}`,
  }
}

function toContentCacheRecord(value: ChapterContent, input: StoredContentInput): ContentCacheRecord {
  return {
    content: value.cleaned,
    finalUrl: value.finalUrl ?? value.chapter.chapterUrl,
    chapter: cacheChapter(value, input),
    contentType: value.contentType,
    raw: value.raw,
    pages: [...value.pages],
    resources: value.resources.map((resource) => ({ ...resource })),
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.imgUrl === undefined ? {} : { imgUrl: value.imgUrl }),
    ...(value.auxiliary === undefined ? {} : { auxiliary: { ...value.auxiliary } }),
  }
}

function fromContentCacheRecord(record: ContentCacheRecord): ChapterContent {
  return {
    chapter: record.chapter,
    contentType: record.contentType ?? 'text',
    raw: record.raw ?? record.content,
    cleaned: record.content,
    pages: record.pages === undefined ? [record.content] : [...record.pages],
    resources: record.resources === undefined ? [] : record.resources.map((resource) => ({ ...resource })),
    finalUrl: record.finalUrl,
    ...(record.auxiliary === undefined ? {} : { auxiliary: { ...record.auxiliary } }),
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.imgUrl === undefined ? {} : { imgUrl: record.imgUrl }),
  }
}

function cacheDiagnostic(message: string, reason?: string): WorkflowDiagnostic {
  return { code: 'cache-failed', stage: 'detail', field: 'contentStore', message: reason === undefined ? message : `${message}: ${reason}`, retryable: false }
}

function withCacheFailure<T>(result: RuntimeResult<T>, diagnostic: WorkflowDiagnostic): RuntimeResult<T> {
  return {
    ...result,
    status: result.value === null || result.status === 'cancelled' || result.status === 'capability-missing' ? result.status : 'partial',
    diagnostics: [...result.diagnostics, diagnostic],
  }
}

/**
 * 以最终正文存储替代原始页面缓存：命中时不请求网络，未命中时条件保留、提交并重读。
 * 存储失败或版本过期不会覆盖较新的正文；当前请求的正文仍可交付，并以 partial/cache-failed 标记。
 */
export async function loadStoredChapterContent(ports: ReadingPorts, input: StoredContentInput): Promise<RuntimeResult<ChapterContent>> {
  const { contentStore, contentIdentity } = input
  if (!contentIdentityMatchesInput(contentIdentity, input)) {
    const diagnostic = cacheDiagnostic('正文缓存身份与当前书源或章节不一致')
    return { status: 'failed', value: null, diagnostics: [diagnostic], trace: [] }
  }
  const readDiagnostics: WorkflowDiagnostic[] = []
  if (input.refresh !== true) {
    try {
      const cached = await contentStore.read(contentIdentity, input.signal)
      if (cached !== undefined && (cached.content.length > 0 || input.chapter.isVolume === true)) {
        return { status: cached.content.length === 0 ? 'empty' : 'success', value: fromContentCacheRecord(cached), diagnostics: [], trace: [] }
      }
    } catch (error) {
      if (input.signal?.aborted === true) return cancelled('正文缓存读取已取消', readDiagnostics, [])
      readDiagnostics.push(cacheDiagnostic('正文缓存读取失败', error instanceof Error ? error.message : '未知错误'))
    }
  }
  const loaded = await loadChapterContent(ports, input)
  if (loaded.value === null || loaded.status === 'cancelled' || loaded.status === 'capability-missing') {
    return readDiagnostics.length === 0 ? loaded : { ...loaded, diagnostics: [...readDiagnostics, ...loaded.diagnostics] }
  }
  if (input.signal?.aborted === true) return cancelled('正文缓存提交已取消', [...readDiagnostics, ...loaded.diagnostics], [])
  const operationId = input.operationId ?? `${contentIdentity.sessionId}:${contentIdentity.chapterKey}:${Date.now()}`
  let token
  try {
    token = await contentStore.reserve(contentIdentity, operationId, input.signal)
  } catch (error) {
    if (isSignalAborted(input.signal)) return cancelled('正文缓存保留已取消', [...readDiagnostics, ...loaded.diagnostics], [])
    return withCacheFailure({ ...loaded, diagnostics: [...readDiagnostics, ...loaded.diagnostics] }, cacheDiagnostic('正文缓存保留失败', error instanceof Error ? error.message : '未知错误'))
  }
  try {
    const write = await contentStore.write({ token, record: toContentCacheRecord(loaded.value, input), saveChapterMetadata: input.saveChapterMetadata !== false }, input.signal)
    if (write.status !== 'committed') {
      const reason = write.reason ?? write.status
      return withCacheFailure({ ...loaded, diagnostics: [...readDiagnostics, ...loaded.diagnostics] }, cacheDiagnostic('正文缓存未提交', reason))
    }
    const committed = await contentStore.read(contentIdentity, input.signal)
    if (committed === undefined) {
      return withCacheFailure({ ...loaded, diagnostics: [...readDiagnostics, ...loaded.diagnostics] }, cacheDiagnostic('正文缓存提交后无法重读'))
    }
    return { ...loaded, value: fromContentCacheRecord(committed), diagnostics: [...readDiagnostics, ...loaded.diagnostics] }
  } catch (error) {
    if (isSignalAborted(input.signal)) return cancelled('正文缓存写入已取消', [...readDiagnostics, ...loaded.diagnostics], [])
    return withCacheFailure({ ...loaded, diagnostics: [...readDiagnostics, ...loaded.diagnostics] }, cacheDiagnostic('正文缓存写入失败', error instanceof Error ? error.message : '未知错误'))
  }
}

/** 对齐 Android contentBatch/getContentBatch；下载与持久化由 host 的 request/cache 适配器提供。 */
export async function loadChapterContentBatch(ports: ReadingPorts, input: ContentBatchInput): Promise<RuntimeResult<ChapterContentBatchResult>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const chapters = input.chapters.filter((chapter) => chapter.isVolume !== true)
  const items = new Map<number, ChapterContentBatchItem>(chapters.map((chapter) => [chapter.index, { chapter, saved: false, via: 'none' }]))
  const resultValue = (batchCount: number): ChapterContentBatchResult => ({ items: chapters.map((chapter) => items.get(chapter.index)!), batchCount })
  const cancelledResult = (batchCount: number, message: string): RuntimeResult<ChapterContentBatchResult> => {
    diagnostics.push({ code: 'cancelled', stage, field: 'contentBatch', message, retryable: false })
    return { status: 'cancelled', value: resultValue(batchCount), diagnostics, trace }
  }

  if (input.signal?.aborted === true) return cancelledResult(0, '批量正文工作流已取消')
  const indexes = new Set<number>()
  for (const chapter of chapters) {
    if (chapter.sourceId !== input.source.bookSourceUrl || chapter.sourceId !== input.book.sourceId || chapter.bookUrl !== input.book.bookUrl) {
      diagnostics.push({ code: 'invalid-input', stage, field: 'chapters', itemIndex: chapter.index, message: '批量章节必须属于当前书源和书籍', retryable: false })
      return { status: 'failed', value: null, diagnostics, trace }
    }
    if (!Number.isInteger(chapter.index) || chapter.index < 0 || indexes.has(chapter.index)) {
      diagnostics.push({ code: 'invalid-input', stage, field: 'chapters', itemIndex: chapter.index, message: '批量正文章节 index 必须是唯一的非负整数', retryable: false })
      return { status: 'failed', value: null, diagnostics, trace }
    }
    indexes.add(chapter.index)
  }
  if (chapters.length === 0) return { status: 'success', value: resultValue(0), diagnostics, trace }

  const mainJs = sourceString(input.source, 'mainJs')
  const isJavaScriptSource = mainJs !== undefined && mainJs.trim().length > 0
  const contentBatchRule = ruleString(input.source, 'ruleContent', 'contentBatch')
  const ruleContent = typeof input.source.ruleContent === 'object' && input.source.ruleContent !== null && !Array.isArray(input.source.ruleContent)
    ? input.source.ruleContent as Record<string, unknown>
    : undefined
  const declaredBatchSize = input.source.maxBatchSize ?? ruleContent?.maxBatchSize
  const contentBatchRuleReplace = ruleString(input.source, 'ruleContent', 'replaceRegex')
  let batchSize: number | undefined
  const validDeclaredBatchSize = typeof declaredBatchSize === 'number' && Number.isInteger(declaredBatchSize) && declaredBatchSize > 1
  if (validDeclaredBatchSize) {
    batchSize = Math.min(declaredBatchSize, 50)
  } else if (declaredBatchSize !== undefined && declaredBatchSize !== null &&
    (isJavaScriptSource || typeof declaredBatchSize !== 'number' || !Number.isInteger(declaredBatchSize) || declaredBatchSize < 0)) {
    diagnostics.push({ code: 'invalid-config', stage, field: 'maxBatchSize', message: 'maxBatchSize 必须是大于 1 的整数；运行时上限为 50', retryable: false })
  }
  const supportsBatch = batchSize !== undefined && (isJavaScriptSource || contentBatchRule !== undefined)
  if (!isJavaScriptSource && contentBatchRule !== undefined && batchSize === undefined && !diagnostics.some((item) => item.field === 'maxBatchSize')) {
    diagnostics.push({ code: 'invalid-config', stage, field: 'maxBatchSize', message: 'contentBatch 需要配置大于 1 的 maxBatchSize', retryable: false })
  }
  if (supportsBatch && input.cacheContent === undefined) {
    diagnostics.push({ code: 'capability-missing', stage, field: 'cacheContent', message: '批量规则需要宿主缓存适配器，已改用单章正文流程', retryable: false })
  }

  const { chapters: _chapters, cacheContent, ...contentOptions } = input
  const bookBaseUrl = input.book.tocUrl?.trim() ? input.book.tocUrl : input.book.bookUrl
  const bookValue = {
    ...input.book.rawFields,
    ...input.book,
    origin: input.book.sourceId,
    originName: input.source.bookSourceName,
    type: androidBookType(input.book, input.source),
  }
  let batchCount = 0
  const fallbackSuppressed = new Set<number>()

  const fallbackChapter = async (chapter: Chapter): Promise<void> => {
    if (input.signal?.aborted === true) return
    const item = items.get(chapter.index)!
    if (item.saved || fallbackSuppressed.has(chapter.index)) return
    item.via = 'single'
    const single = await loadChapterContent(ports, { ...contentOptions, chapter })
    diagnostics.push(...single.diagnostics)
    trace.push(...single.trace)
    if (single.status === 'cancelled' || isSignalAborted(input.signal)) return
    const value = single.value
    if (value === null || value.cleaned.trim().length === 0) return
    if (new TextEncoder().encode(value.cleaned).byteLength > (input.maxOutputBytes ?? 4 * 1024 * 1024)) return
    if (cacheContent === undefined) {
      item.content = value.cleaned
      return
    }
    try {
      const saved = await cacheContent(chapter, value.cleaned, input.signal)
      if (saved) {
        item.saved = true
        item.content = value.cleaned
      }
      else {
        if (!item.saved) delete item.content
        fallbackSuppressed.add(chapter.index)
        diagnostics.push({ code: 'cache-failed', stage, field: 'cacheContent', itemIndex: chapter.index, message: '宿主缓存拒绝写入；为避免覆盖更新后的正文，跳过兜底重试', retryable: false })
      }
    } catch (error) {
      if (!item.saved) delete item.content
      diagnostics.push({ code: 'cache-failed', stage, field: 'cacheContent', itemIndex: chapter.index, message: error instanceof Error ? error.message : '宿主缓存写入失败', retryable: false })
    }
  }

  const groups: Chapter[][] = []
  const groupSize = supportsBatch ? batchSize! : 1
  for (let offset = 0; offset < chapters.length; offset += groupSize) groups.push(chapters.slice(offset, offset + groupSize))

  for (const group of groups) {
    if (isSignalAborted(input.signal)) return cancelledResult(batchCount, '批量正文工作流已取消')
    if (supportsBatch && cacheContent !== undefined && group.length > 1) {
      const chapterValues = group.map((chapter) => ({
        ...(chapter.rawFields ?? {}),
        ...chapter,
        url: chapterRuleUrl(chapter),
        baseUrl: chapter.baseUrl?.trim() || (typeof chapter.rawFields?.baseUrl === 'string' && chapter.rawFields.baseUrl.length > 0 ? chapter.rawFields.baseUrl : bookBaseUrl),
        index: chapter.index,
        title: chapter.title,
      }))
      const groupByIndex = new Map(group.map((chapter) => [chapter.index, chapter]))
      const chapterUrlIndexes = new Map<string, Set<number>>()
      const addChapterUrl = (url: string | undefined, index: number): void => {
        if (url === undefined || url.trim().length === 0) return
        const indexes = chapterUrlIndexes.get(url) ?? new Set<number>()
        indexes.add(index)
        chapterUrlIndexes.set(url, indexes)
      }
      const batchBaseUrl = input.book.tocUrl?.trim() ? input.book.tocUrl : input.source.bookSourceUrl
      for (const chapter of group) {
        const rawChapterUrl = chapterRuleUrl(chapter)
        addChapterUrl(rawChapterUrl, chapter.index)
        addChapterUrl(chapter.chapterUrl, chapter.index)
        const chapterBaseUrl = chapter.baseUrl?.trim() || (typeof chapter.rawFields?.baseUrl === 'string' && chapter.rawFields.baseUrl.length > 0
          ? chapter.rawFields.baseUrl
          : bookBaseUrl)
        const absolute = chapter.isVolume === true && chapter.title.length > 0 && rawChapterUrl.startsWith(chapter.title)
          ? chapterBaseUrl
          : safeResolveReference(rawChapterUrl, chapterBaseUrl)
        addChapterUrl(absolute, chapter.index)
        addChapterUrl(safeResolveReference(rawChapterUrl, batchBaseUrl), chapter.index)
      }
      let groupOpen = true
      let saveQueue: Promise<void> = Promise.resolve()
      const cacheAction = async (actionSignal: AbortSignal, actionInput: unknown): Promise<boolean> => {
        const operation = saveQueue.then(async () => {
          if (!groupOpen) return false
          if (actionSignal.aborted || isSignalAborted(input.signal)) throw new Error('__LEGADO_CANCELLED__')
          if (typeof actionInput !== 'object' || actionInput === null || Array.isArray(actionInput)) throw new Error('java.cacheContent 参数无效')
          const record = actionInput as Record<string, unknown>
          if (typeof record.content !== 'string') throw new Error('java.cacheContent 正文必须是字符串')
          const identifier = record.chapter
          let chapter: Chapter | undefined
          if (typeof identifier === 'object' && identifier !== null && !Array.isArray(identifier)) {
            const index = (identifier as Record<string, unknown>).index
            if (typeof index === 'number' && Number.isInteger(index)) chapter = groupByIndex.get(index)
          } else if (typeof identifier === 'string') {
            const trimmedUrl = identifier.trim()
            const matched = new Set(chapterUrlIndexes.get(trimmedUrl) ?? [])
            const normalized = safeResolveReference(trimmedUrl, batchBaseUrl)
            for (const index of chapterUrlIndexes.get(normalized ?? '') ?? []) matched.add(index)
            if (matched.size === 1) chapter = groupByIndex.get([...matched][0]!)
          }
          if (chapter === undefined) throw new Error(`java.cacheContent 未唯一匹配到本批次章节；重复 URL 请传带 index 的章节对象: ${String(identifier)}`)
          const selectedRawChapterUrl = chapterRuleUrl(chapter)
          const selectedChapterBaseUrl = chapter.baseUrl?.trim() || (typeof chapter.rawFields?.baseUrl === 'string' && chapter.rawFields.baseUrl.length > 0 ? chapter.rawFields.baseUrl : bookBaseUrl)

          let content = record.content
          if (contentBatchRuleReplace !== undefined) {
            const trimmed = content.split('\n').map((line) => line.trim()).join('\n')
            const replaced = await evaluateField(ports, input.source, stage, 'replaceRegex', contentBatchRuleReplace, trimmed, chapter.index, trace, input.signal, {
              baseUrl: safeResolveReference(selectedRawChapterUrl, selectedChapterBaseUrl) ?? selectedChapterBaseUrl,
              bindings: { book: bookValue, chapter: chapterValues[group.findIndex((item) => item.index === chapter.index)] },
            })
            if (replaced.state === 'cancelled' || actionSignal.aborted || isSignalAborted(input.signal)) throw new Error('__LEGADO_CANCELLED__')
            if (replaced.state === 'failed' || replaced.state === 'capability-missing') {
              diagnostics.push({ code: replaced.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage, field: 'replaceRegex', itemIndex: chapter.index, message: replaced.message ?? '批量正文替换规则执行失败', retryable: false })
              throw new Error(replaced.message ?? '批量正文替换规则执行失败')
            }
            content = textValue(replaced.value)
            if (isOnlineTextBook(androidBookType(input.book, input.source), input.book)) {
              content = content.split('\n').map((line) => `　　${line}`).join('\n')
            }
          }
          if (new TextEncoder().encode(content).byteLength > (input.maxOutputBytes ?? 4 * 1024 * 1024)) {
            diagnostics.push({ code: 'item-skipped', stage, field: 'cacheContent', itemIndex: chapter.index, message: '批量正文超过输出字节预算', retryable: false })
            return false
          }
          if (content.trim().length === 0) return false
          const item = items.get(chapter.index)!
          item.via = 'batch'
          try {
            const saved = await cacheContent(chapter, content, actionSignal)
            if (saved) {
              item.saved = true
              item.content = content
            }
            else {
              if (!item.saved) delete item.content
              fallbackSuppressed.add(chapter.index)
              diagnostics.push({ code: 'cache-failed', stage, field: 'cacheContent', itemIndex: chapter.index, message: '宿主缓存拒绝写入；为避免覆盖更新后的正文，跳过兜底重试', retryable: false })
            }
            return saved
          } catch (error) {
            if (!item.saved) delete item.content
            fallbackSuppressed.add(chapter.index)
            diagnostics.push({ code: 'cache-failed', stage, field: 'cacheContent', itemIndex: chapter.index, message: error instanceof Error ? error.message : '宿主缓存写入失败', retryable: false })
            throw error
          }
        })
        saveQueue = operation.then(() => undefined, () => undefined)
        return operation
      }
      const workflowActions = { cacheContent: cacheAction }
      let batchState: 'value' | 'empty' | 'missing-function' | 'failed' | 'cancelled' | 'capability-missing' = 'value'
      let batchMessage: string | undefined
      const split = isJavaScriptSource ? undefined : splitBatchJavaScript(contentBatchRule!)
      if (split?.error !== undefined) {
        diagnostics.push({ code: 'invalid-config', stage, field: 'contentBatch', message: split.error, retryable: false })
        batchState = 'failed'
        batchMessage = split.error
      } else {
        batchCount += 1
        if (isJavaScriptSource) {
          const batch = await executeSourceFunction(ports, input.source, 'getContentBatch', [chapterValues, bookValue], { chapters: chapterValues, book: bookValue, result: chapterValues }, 'detail', 'content', trace, input.signal, workflowActions)
          batchState = batch.state
          batchMessage = batch.message
        } else {
          for (const code of split!.scripts) {
            const batch = await executeWorkflowJavaScript(ports, input.source, code, stage, 'content', trace, {
              content: chapterValues,
              baseUrl: batchBaseUrl,
              bindings: { chapters: chapterValues, book: bookValue },
              workflowActions,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            })
            batchState = batch.state
            batchMessage = batch.message
            if (batchState === 'failed' || batchState === 'cancelled' || batchState === 'capability-missing') break
          }
        }
      }
      await saveQueue
      groupOpen = false
      if (batchState === 'cancelled' || isSignalAborted(input.signal)) return cancelledResult(batchCount, batchMessage ?? '批量正文脚本已取消')
      if (batchState === 'failed' || batchState === 'capability-missing' || batchState === 'missing-function') {
        const code = batchState === 'capability-missing' ? 'capability-missing' : batchState === 'missing-function' ? 'invalid-config' : 'rule-failed'
        diagnostics.push({ code, stage, field: isJavaScriptSource ? 'getContentBatch' : 'contentBatch', ...(group[0] === undefined ? {} : { itemIndex: group[0].index }), message: batchMessage ?? (batchState === 'missing-function' ? 'JS 书源缺少 getContentBatch 函数' : '批量正文规则执行失败'), retryable: false })
      }
    }

    for (const chapter of group) {
      if (isSignalAborted(input.signal)) return cancelledResult(batchCount, '批量正文工作流已取消')
      await fallbackChapter(chapter)
      if (isSignalAborted(input.signal)) return cancelledResult(batchCount, '单章兜底流程已取消')
    }
  }

  const result = resultValue(batchCount)
  const unresolved = result.items.some((item) => !item.saved && item.content === undefined)
  const cacheRejected = diagnostics.some((item) => item.code === 'cache-failed')
  const hasOutput = result.items.some((item) => item.saved || item.content !== undefined)
  const status = unresolved || cacheRejected ? hasOutput ? 'partial' : 'failed' : 'success'
  return { status, value: result, diagnostics, trace }
}

/** 对齐 Android ImageUtils.decode；图片 bytes 的下载和缓存由调用方负责。 */
export async function decodeImage(ports: WorkflowPorts, input: ImageDecodeInput): Promise<RuntimeResult<Uint8Array>> {
  const trace: WorkflowTraceEntry[] = []
  const diagnostics: WorkflowDiagnostic[] = []
  const stage = 'detail' as const
  const field = input.isCover ? 'coverDecodeJs' : 'imageDecode'
  const rule = input.isCover
    ? sourceString(input.source, 'coverDecodeJs')
    : ruleString(input.source, 'ruleContent', 'imageDecode')

  if (input.signal?.aborted === true) {
    diagnostics.push({ code: 'cancelled', stage, field, message: '图片解密已取消', retryable: false })
    return { status: 'cancelled', value: null, diagnostics, trace }
  }
  if (rule === undefined || rule.trim().length === 0) return { status: 'success', value: input.bytes, diagnostics, trace }

  const book = input.book === undefined ? null : {
    ...input.book.rawFields,
    ...input.book,
    origin: input.book.sourceId,
    originName: input.source.bookSourceName,
    type: androidBookType(input.book, input.source),
  }
  const script = await executeImageDecodeScript(ports, {
    source: input.source,
    code: rule,
    bytes: input.bytes,
    src: input.src,
    book,
    resultInputKind: input.resultInputKind ?? (input.isCover ? 'input-stream' : 'bytes'),
    ...(input.javascriptBudget === undefined ? {} : { javascriptBudget: input.javascriptBudget }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }, stage, trace)
  if (script.state === 'cancelled' || isSignalAborted(input.signal)) {
    diagnostics.push({ code: 'cancelled', stage, field, message: '图片解密已取消', retryable: false })
    return { status: 'cancelled', value: null, diagnostics, trace }
  }
  if (script.state === 'capability-missing') {
    diagnostics.push({ code: 'capability-missing', stage, field, message: script.message ?? 'JavaScript 脚本宿主不可用', retryable: false })
    return { status: 'capability-missing', value: null, diagnostics, trace }
  }
  if (script.state !== 'value' || !(script.value instanceof Uint8Array)) {
    diagnostics.push({ code: 'rule-failed', stage, field, message: script.state === 'failed' ? script.message ?? '图片解密脚本执行失败' : '图片解密脚本必须返回 Uint8Array', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  return { status: 'success', value: script.value, diagnostics, trace }
}

async function javascriptChapterContent(ports: ReadingPorts, input: ContentInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<RuntimeResult<ChapterContent>> {
  const book: BookMetadata = input.book === undefined ? {
    sourceId: input.chapter.sourceId,
    bookUrl: input.chapter.bookUrl,
    name: '',
    rawFields: {},
    traceRef: 'content:book',
    emptyFields: [],
    fieldErrors: {},
    tocUrl: input.chapter.bookUrl,
  } : cloneBookMetadata(input.book)
  const chapterData = input.chapter as ContentInput['chapter'] & { rawFields?: JsonObject }
  const rawChapterUrl = chapterRuleUrl(input.chapter)
  const bookUrl = resolveUrl(input.chapter.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  const chapterBaseReference = input.chapter.baseUrl?.trim() || book.tocUrl?.trim() || input.chapter.bookUrl
  const chapter = {
    ...(chapterData.rawFields === undefined ? {} : cloneJsonObject(chapterData.rawFields)),
    ...input.chapter,
    url: rawChapterUrl,
    baseUrl: resolveUrl(chapterBaseReference, bookUrl) ?? bookUrl,
    index: input.chapter.index,
    title: input.chapter.title ?? '',
  }
  const bookValue = { ...book.rawFields, ...book, origin: book.sourceId, originName: input.source.bookSourceName, type: javascriptBookType(book, input.source) }
  const result = await executeSourceFunction(ports, input.source, 'getContent', [chapter, bookValue, input.nextChapterUrl ?? null], { chapter, book: bookValue, nextChapterUrl: input.nextChapterUrl ?? null }, 'detail', 'content', trace, input.signal)
  if (result.state === 'cancelled' || input.signal?.aborted === true) return cancelled('JS 正文工作流已取消', diagnostics, trace)
  if (result.state === 'capability-missing') {
    diagnostics.push({ code: 'capability-missing', stage: 'detail', field: 'getContent', message: result.message ?? 'JavaScript 源函数宿主不可用', retryable: false })
    return { status: 'capability-missing', value: null, diagnostics, trace }
  }
  if (result.state === 'missing-function' || result.state === 'failed') {
    diagnostics.push({ code: result.state === 'missing-function' ? 'invalid-config' : 'rule-failed', stage: 'detail', field: 'getContent', message: result.message ?? 'JS 书源缺少 getContent 函数', retryable: false })
    return { status: 'failed', value: null, diagnostics, trace }
  }
  let raw = ''
  if (result.value !== null && result.value !== undefined) {
    if (typeof result.value === 'string') raw = result.value
    else {
      try { raw = JSON.stringify(result.value) ?? textValue(result.value) } catch { raw = textValue(result.value) }
    }
  }
  if (raw.trim().length === 0) {
    diagnostics.push({ code: 'empty-page', stage: 'detail', field: 'getContent', message: '正文为空', retryable: false })
    if (input.chapter.isVolume === true) {
      commitJavascriptContentMutations(input, bookValue, chapter)
      return { status: 'empty', value: { chapter, contentType: 'text', raw, cleaned: '', pages: [], resources: [], finalUrl: chapter.chapterUrl }, diagnostics, trace }
    }
    return { status: 'failed', value: null, diagnostics, trace }
  }
  commitJavascriptContentMutations(input, bookValue, chapter)
  return { status: 'success', value: { chapter, contentType: 'text', raw, cleaned: raw, pages: [raw], resources: [], finalUrl: chapter.chapterUrl }, diagnostics, trace }
}

async function formatChapterTitles(ports: WorkflowPorts, source: NormalizedSource, chapters: Chapter[], code: string, book: BookMetadata, input: TocInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<void> {
  const globalState: Record<string, unknown> = {}
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const script = await executeWorkflowJavaScript(ports, source, code, 'detail', 'chapter', trace, {
      bindings: {
        ...globalState,
        gInt: Object.hasOwn(globalState, 'gInt') ? globalState.gInt : 0,
        index: chapterIndex + 1,
        chapter: { ...chapter, url: chapter.url ?? chapter.chapterUrl, baseUrl: chapter.baseUrl ?? book.tocUrl ?? book.bookUrl },
        title: chapter.title,
      },
      captureMutations: ['chapter'],
      captureGlobals: true,
      globalState,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (script.state === 'cancelled' || input.signal?.aborted === true) {
      diagnostics.push({ code: 'cancelled', stage: 'detail', field: 'formatJs', itemIndex: chapterIndex, message: '目录标题格式化已取消', retryable: false })
      return
    }
    if (script.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage: 'detail', field: 'formatJs', itemIndex: chapterIndex, message: script.message ?? '目录标题格式化脚本宿主不可用', retryable: false })
      return
    }
    if (script.state === 'failed') {
      diagnostics.push({ code: 'item-skipped', stage: 'detail', field: 'formatJs', itemIndex: chapterIndex, message: script.message ?? '目录标题格式化失败', retryable: false })
      continue
    }
    if (script.state === 'value') {
      const captured = typeof script.value === 'object' && script.value !== null && !Array.isArray(script.value)
        ? script.value as { __legadoWorkflowValue?: unknown; __legadoWorkflowBindings?: Record<string, unknown> }
        : undefined
      if (captured !== undefined && typeof (captured as Record<string, unknown>).__legadoWorkflowGlobals === 'object' && (captured as Record<string, unknown>).__legadoWorkflowGlobals !== null) {
        for (const name of Object.keys(globalState)) delete globalState[name]
        Object.assign(globalState, serializableFormatGlobals((captured as Record<string, unknown>).__legadoWorkflowGlobals as Record<string, unknown>))
      }
      if (captured !== undefined && Object.hasOwn(captured, '__legadoWorkflowBindings')) {
        const outputValue = captured.__legadoWorkflowValue
        const mutatedChapter = captured.__legadoWorkflowBindings?.chapter
        if (typeof mutatedChapter === 'object' && mutatedChapter !== null && !Array.isArray(mutatedChapter)) mergeFormattedChapter(chapter, mutatedChapter as Record<string, unknown>, book)
        const mutatedTitle = typeof mutatedChapter === 'object' && mutatedChapter !== null && !Array.isArray(mutatedChapter) ? (mutatedChapter as Record<string, unknown>).title : undefined
        const mutatedVariable = typeof mutatedChapter === 'object' && mutatedChapter !== null && !Array.isArray(mutatedChapter) ? (mutatedChapter as Record<string, unknown>).variable : undefined
        if (outputValue !== null && outputValue !== undefined) chapter.title = textValue(outputValue)
        else if (javascriptPrimitiveText(mutatedTitle) !== undefined) chapter.title = javascriptPrimitiveText(mutatedTitle)!
        if (typeof mutatedVariable === 'string') chapter.variable = mutatedVariable
      } else chapter.title = textValue(script.value)
    }
  }
}

function mergeFormattedChapter(chapter: Chapter, mutated: Record<string, unknown>, book: BookMetadata): void {
  const stringFields = ['sourceId', 'bookUrl', 'url', 'baseUrl', 'chapterUrl', 'volume', 'updateTime', 'tag', 'wordCount', 'imgUrl', 'variable'] as const
  for (const field of stringFields) if (typeof mutated[field] === 'string') chapter[field] = mutated[field] as never
  for (const field of ['isVolume', 'isVip', 'isPay'] as const) if (typeof mutated[field] === 'boolean') chapter[field] = mutated[field]
  if (typeof mutated.title === 'string') chapter.title = mutated.title
  const directChapterUrl = typeof mutated.chapterUrl === 'string'
  if (!directChapterUrl || Object.hasOwn(mutated, 'url') || Object.hasOwn(mutated, 'baseUrl')) {
    const baseReference = chapter.baseUrl?.trim() || book.tocUrl?.trim() || book.bookUrl
    const baseUrl = resolveUrl(baseReference, book.bookUrl) ?? book.bookUrl
    const rawUrl = chapter.url?.trim() || chapter.chapterUrl
    chapter.chapterUrl = resolveUrl(rawUrl, baseUrl) ?? rawUrl
  }
}

const formatRuntimeGlobalNames = new Set([
  'result', 'src', 'key', 'page', 'url', 'nextChapterUrl', 'chapters', 'index', 'title', 'fromBookInfo', 'isFromBookInfo',
  'baseUrl', 'redirectUrl', 'sourceKey', 'sourceName', 'sourceData', 'source', 'sourceApi', 'book', 'chapter', 'java',
  'cache', 'Packages', 'bindings', 'cookie', 'getVariable', 'putVariable', 'checkEnv', 'isVs', 'globalThis',
  '__legadoDecode', '__legadoEncode', '__legadoGetVariable', '__legadoSetVariable', '__legadoRequest', '__legadoEvaluateRule',
  '__legadoWorkflowGlobalState',
])

function serializableFormatGlobals(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => !formatRuntimeGlobalNames.has(name)))
}

function mergeBookScriptValues(book: BookMetadata, values: Record<string, unknown>): BookMetadata {
  const merged: BookMetadata = { ...book }
  for (const key of ['bookUrl', 'name', 'author', 'intro', 'kind', 'wordCount', 'lastChapter', 'updateTime', 'coverUrl', 'tocUrl', 'tocHtml', 'variable'] as const) {
    const value = values[key]
    if (typeof value === 'string') merged[key] = value
  }
  if (typeof values.latestChapterTitle === 'string') merged.lastChapter = values.latestChapterTitle
  const bookBaseUrl = resolveUrl(merged.bookUrl, book.bookUrl) ?? book.bookUrl
  merged.bookUrl = bookBaseUrl
  if (merged.coverUrl !== undefined) merged.coverUrl = resolveUrl(merged.coverUrl, bookBaseUrl) ?? merged.coverUrl
  if (merged.tocUrl !== undefined) merged.tocUrl = resolveUrl(merged.tocUrl, bookBaseUrl) ?? merged.tocUrl
  return merged
}

function withoutTransientBookFields(book: BookMetadata): BookMetadata {
  const { tocHtml: _tocHtml, ...persisted } = book
  return {
    ...persisted,
    rawFields: cloneJsonObject(book.rawFields),
    emptyFields: [...book.emptyFields],
    fieldErrors: { ...book.fieldErrors },
  }
}

function cloneBookMetadata(book: BookMetadata): BookMetadata {
  return {
    ...book,
    rawFields: cloneJsonObject(book.rawFields),
    emptyFields: [...book.emptyFields],
    fieldErrors: { ...book.fieldErrors },
    ...(book.readConfig === undefined ? {} : { readConfig: { ...book.readConfig } }),
  }
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return structuredClone(value)
}

function commitJavascriptContentMutations(input: ContentInput, book: Record<string, unknown>, chapter: Record<string, unknown>): void {
  if (input.book !== undefined && typeof book.variable === 'string') input.book.variable = book.variable
  if (typeof chapter.variable === 'string') input.chapter.variable = chapter.variable
}

function mergeVariableJson(current: string | undefined, incoming: string): string {
  const values: Record<string, unknown> = {}
  for (const candidate of [current, incoming]) {
    if (candidate === undefined) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) Object.assign(values, parsed)
    } catch {
      // Android 的 variableMap 只复制可解析的变量项；坏旧值不阻断 reGetBook。
    }
  }
  return JSON.stringify(values)
}

function workflowActionError(status: RuntimeResult<unknown>['status'], message: string): Error {
  if (status === 'cancelled') return new Error('__LEGADO_CANCELLED__')
  if (status === 'capability-missing') return new Error('__LEGADO_CAPABILITY__runtime preUpdate workflow action unavailable')
  return new Error(message)
}

interface TocPageParseResult {
  chapters: Chapter[]
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
  /** 当前页 nextTocUrl 已按响应地址展开；undefined 表示未配置或不应继续分页。 */
  nextUrls?: string[]
  volume?: string
  fatal: boolean
  cancelled: boolean
}

async function parseTocPage(ports: ReadingPorts, input: TocInput, book: BookMetadata, body: string, pageIndex: number, normalizedUrl: string, responseUrl: string, inheritedVolume: string | undefined, listRuleBody: string, readNextUrl: boolean, signal?: AbortSignal): Promise<TocPageParseResult> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  let volume = inheritedVolume
  const context = { baseUrl: normalizedUrl, redirectUrl: responseUrl }
  const list = await evaluateField(ports, input.source, 'detail', 'chapterList', listRuleBody, body, pageIndex, trace, signal, { ...context, expect: 'nodes', bindings: { book } })
  if (list.state === 'cancelled') return { chapters: [], diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: false, cancelled: true }
  if (list.state === 'capability-missing' || list.state === 'failed') {
    diagnostics.push({ code: list.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage: 'detail', field: 'chapterList', message: list.message ?? (list.state === 'capability-missing' ? '目录规则能力不可用' : '目录规则失败'), retryable: false })
    return { chapters: [], diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: true, cancelled: false }
  }
  const rawItems = list.state === 'value' && Array.isArray(list.value) ? list.value.filter((item) => item !== null && item !== undefined) : []
  if (list.state === 'value' && !Array.isArray(list.value)) diagnostics.push({ code: 'item-skipped', stage: 'detail', field: 'chapterList', message: 'chapterList 规则必须返回列表', retryable: false })

  let nextUrls: string[] | undefined
  if (readNextUrl) {
    const nextRule = ruleString(input.source, 'ruleToc', 'nextTocUrl')
    if (nextRule !== undefined) {
      const next = await evaluateField(ports, input.source, 'detail', 'nextTocUrl', nextRule, body, pageIndex, trace, signal, { ...context, bindings: { book } })
      if (next.state === 'cancelled') return { chapters: [], diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: false, cancelled: true }
      if (next.state === 'failed' || next.state === 'capability-missing') {
        diagnostics.push({ code: next.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage: 'detail', field: 'nextTocUrl', message: next.message ?? (next.state === 'capability-missing' ? '目录下一页规则能力不可用' : '目录下一页规则失败'), retryable: false })
        return { chapters: [], diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: true, cancelled: false }
      }
      nextUrls = []
      if (next.state === 'value') {
        for (const value of listValues(next.value)) {
          const resolved = resolveUrl(value, responseUrl)
          const expandedNext = resolved === undefined ? undefined : await expandUrl(ports, input.source, 'detail', resolved, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl, book }, signal)
          const nextUrl = expandedNext?.url
          if (nextUrl === undefined) {
            if (expandedNext?.error?.code === 'cancelled') return { chapters: [], diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: false, cancelled: true }
            diagnostics.push({ code: expandedNext?.error?.code === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage: 'detail', field: 'nextTocUrl', message: expandedNext?.error?.message ?? '目录下一页 URL 无效', retryable: false })
            return { chapters: [], diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: true, cancelled: false }
          }
          if (nextUrl !== responseUrl && !nextUrls.includes(nextUrl)) nextUrls.push(nextUrl)
        }
      }
    }
  }

  const chapters: Chapter[] = []
  for (const [itemIndex, rawItem] of rawItems.entries()) {
    const diagnosticIndex = pageIndex * 100000 + itemIndex
    const fields = await chapterFields(ports, input.source, rawItem, diagnosticIndex, signal, diagnostics, trace, volume, context, book, input.tocCountWords !== false)
    if (signal?.aborted === true) return { chapters, diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: false, cancelled: true }
    if (fields.fatal !== undefined) return { chapters, diagnostics, trace, ...(volume === undefined ? {} : { volume }), fatal: true, cancelled: false }
    if (fields.isVolume === true && fields.title !== undefined && fields.title.length > 0) volume = fields.title
    else if (fields.volume !== undefined && fields.volume.length > 0) volume = fields.volume
    if (fields.title === undefined || fields.title.length === 0) {
      diagnostics.push({ code: 'identity-missing', stage: 'detail', itemIndex: diagnosticIndex, message: '章节缺少标题', retryable: false })
      continue
    }
    const chapterIndex = chapters.length
    const isVolume = fields.isVolume === true
    const rawChapterUrl = isVolume && (fields.url === undefined || fields.url.length === 0 || fields.url === fields.title)
      ? `${fields.title}${itemIndex}`
      : fields.url === undefined || fields.url.length === 0
        ? normalizedUrl
        : fields.url
    const chapterUrl = isVolume && (fields.url === undefined || fields.url.length === 0 || fields.url === fields.title)
      ? `${fields.title}${itemIndex}`
      : fields.url === undefined || fields.url.length === 0
        ? normalizedUrl
        : resolveUrl(fields.url, responseUrl)
    if (chapterUrl === undefined) {
      diagnostics.push({ code: 'item-skipped', stage: 'detail', itemIndex: diagnosticIndex, message: '章节 URL 无效', retryable: false })
      continue
    }
    const chapter: Chapter = {
      sourceId: input.source.bookSourceUrl,
      bookUrl: book.bookUrl,
      url: rawChapterUrl,
      baseUrl: responseUrl,
      chapterUrl,
      index: chapterIndex,
      title: fields.title,
      ...(fields.variable === undefined ? {} : { variable: fields.variable }),
      rawFields: fields.rawFields,
      traceRef: `toc:${chapterIndex}`,
      isVolume,
      isVip: fields.isVip ?? false,
      isPay: fields.isPay ?? false,
      ...(fields.updateTime === undefined ? {} : { updateTime: fields.updateTime }),
      ...chapterInfoProjection(fields.updateTime, isVolume, input.tocCountWords !== false),
      ...(fields.tag === undefined ? {} : { tag: fields.tag }),
      ...(fields.wordCount === undefined ? {} : { wordCount: fields.wordCount }),
    }
    if (volume !== undefined) chapter.volume = volume
    chapters.push(chapter)
    trace.push({ stage: 'detail', event: 'candidate', target: `chapter:${chapterIndex}`, itemIndex: diagnosticIndex })
  }
  return { chapters, diagnostics, trace, ...(nextUrls === undefined ? {} : { nextUrls }), ...(volume === undefined ? {} : { volume }), fatal: false, cancelled: false }
}

function appendTocChapters(target: Chapter[], pageChapters: Chapter[], pageTrace: WorkflowTraceEntry[]): void {
  const offset = target.length
  for (const [index, chapter] of pageChapters.entries()) {
    chapter.index = offset + index
    chapter.traceRef = `toc:${chapter.index}`
    target.push(chapter)
  }
  for (const entry of pageTrace) {
    if (entry.event !== 'candidate') continue
    const localIndex = /^chapter:(\d+)$/u.exec(entry.target)?.[1]
    if (localIndex !== undefined) entry.target = `chapter:${offset + Number(localIndex)}`
  }
}

interface PageBatchOutcome {
  page?: { body: string; url: string }
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
  error?: unknown
}

interface PageBatchResult {
  outcomes: PageBatchOutcome[]
  failed: boolean
}

async function fetchPageBatch(ports: WorkflowPorts, source: NormalizedSource, urls: readonly string[], stage: WorkflowStage, options: WorkflowOptions, execution?: { webJs?: string; sourceRegex?: string }, loginCheckFirstOnly = false, requestContext?: Pick<WorkflowRequest, 'book' | 'chapter'>): Promise<PageBatchResult> {
  const batchController = new AbortController()
  const onAbort = (): void => batchController.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted === true) batchController.abort()
  const batchId = ++paginationBatchSequence
  let failed = false
  const keys = urls.map((_url, index) => `source-pages:${batchId}:${index}`)
  const tasks = urls.map((url, index) => {
    const run = async (signal: AbortSignal): Promise<PageBatchOutcome> => {
      const diagnostics: WorkflowDiagnostic[] = []
      const trace: WorkflowTraceEntry[] = []
      try {
        const branchOptions = batchPageOptions(options, index, urls.length)
        if (loginCheckFirstOnly && index > 0) branchOptions.skipLoginCheck = true
        const page = await loadPage(ports, source, url, stage, { ...branchOptions, signal }, diagnostics, trace, execution, requestContext)
        const fatal = page === undefined && !signal.aborted && diagnostics.some((item) => item.code !== 'cancelled')
        if (fatal) {
          failed = true
          batchController.abort()
        }
        return { ...(page === undefined ? {} : { page }), diagnostics, trace }
      } catch (error) {
        if (!signal.aborted) {
          failed = true
          batchController.abort()
        }
        return { diagnostics, trace, error }
      }
    }
    return ports.concurrency === undefined
      ? run(batchController.signal)
      : ports.concurrency.run(keys[index]!, run, batchController.signal)
  })
  const settled = await Promise.allSettled(tasks)
  if (ports.concurrency !== undefined) await Promise.all(keys.map((key) => ports.concurrency!.drain(key)))
  options.signal?.removeEventListener('abort', onAbort)
  const outcomes = settled.map((result): PageBatchOutcome => result.status === 'fulfilled'
    ? result.value
    : { diagnostics: [], trace: [], error: result.reason })
  if (!options.signal?.aborted && outcomes.some((outcome) => outcome.page === undefined && outcome.error !== undefined && !isAbortError(outcome.error))) failed = true
  return { outcomes, failed }
}

function batchPageOptions(options: WorkflowOptions, index: number, count: number): WorkflowOptions {
  const totalBytes = options.budget?.maxTotalBytes
  if (totalBytes === undefined || !Number.isFinite(totalBytes) || totalBytes < 0 || count < 1) return options
  // 每个并行请求都独立执行 RequestBudget；均分剩余额度才能保证各分支预算之和不超过工作流总额。
  const wholeBytes = Math.floor(totalBytes)
  const sharedBytes = Math.floor(wholeBytes / count)
  const remainder = wholeBytes % count
  return {
    ...options,
    budget: {
      ...options.budget,
      maxTotalBytes: sharedBytes + (index < remainder ? 1 : 0),
    },
  }
}

function appendBatchDiagnostics(batch: PageBatchResult, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], includeCancelled = false): void {
  for (const outcome of batch.outcomes) {
    trace.push(...outcome.trace)
    diagnostics.push(...(batch.failed && !includeCancelled ? outcome.diagnostics.filter((item) => item.code !== 'cancelled') : outcome.diagnostics))
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === 'AbortError'
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function loadPage(ports: WorkflowPorts, source: NormalizedSource, url: string, stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], execution?: { webJs?: string; sourceRegex?: string }, requestContext?: Pick<WorkflowRequest, 'book' | 'chapter'>): Promise<{ body: string; url: string } | undefined> {
  const value = await requestPageResponse(ports, source, url, stage, options, diagnostics, trace, execution, requestContext)
  return value === undefined ? undefined : { body: value.content, url: value.url }
}

function pageOptions(options: WorkflowOptions, maxBytes: number, usedBytes: number): WorkflowOptions {
  const remaining = Math.max(0, maxBytes - usedBytes)
  const budget = { ...options.budget, maxTotalBytes: Math.min(options.budget?.maxTotalBytes ?? remaining, remaining) }
  return { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }), ...(options.skipLoginCheck === true ? { skipLoginCheck: true } : {}), budget }
}

interface ChapterFields {
  title?: string
  url?: string
  variable?: string
  volume?: string
  isVolume?: boolean
  isVip?: boolean
  isPay?: boolean
  updateTime?: string
  tag?: string
  wordCount?: string
  rawFields: JsonObject
  fatal?: 'failed' | 'capability-missing'
}

const tocWordCountPattern = /(?:^|字数[：:、]?|[\u0009-\u000d\u0020]+)([0-9万千百.]{1,6}字)/u

function chapterInfoProjection(updateTime: string | undefined, isVolume: boolean, countWords: boolean): { tag?: string; wordCount?: string } {
  if (updateTime === undefined) return {}
  if (isVolume || !countWords) return { tag: updateTime }
  const match = tocWordCountPattern.exec(updateTime)
  return match === null
    ? { tag: updateTime }
    : { tag: updateTime.replace(match[0], ''), wordCount: match[1]!.trim() }
}

async function chapterFields(ports: ReadingPorts, source: NormalizedSource, content: unknown, itemIndex: number, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], inheritedVolume: string | undefined, context: { baseUrl: string; redirectUrl: string }, book: BookMetadata, countWords: boolean): Promise<ChapterFields> {
  const result: ChapterFields = { rawFields: {} }
  const chapter: Record<string, unknown> = { sourceId: source.bookSourceUrl, bookUrl: book.bookUrl, url: '', baseUrl: context.redirectUrl, chapterUrl: '', index: itemIndex, title: '', isVolume: false, isVip: false, isPay: false, ...(inheritedVolume === undefined ? {} : { volume: inheritedVolume }), rawFields: result.rawFields }
  // Android 的目录解析顺序是标题、地址、更新时间、卷标，然后才读取 VIP/购买状态。
  // chapterVolume 是 TS 运行时保留的卷名扩展，放在 Android 的 isVolume 之后，避免改变
  // 必要字段和付费字段的先后关系。
  for (const ruleField of ['chapterName', 'chapterUrl', 'updateTime', 'isVolume', 'chapterVolume', 'isVip', 'isPay'] as const) {
    const outputField = ruleField === 'chapterName'
      ? 'title'
      : ruleField === 'chapterUrl'
        ? 'url'
        : ruleField === 'chapterVolume'
          ? 'volume'
          : ruleField
    const rule = ruleString(source, 'ruleToc', ruleField)
    if (rule === undefined) continue
    const field = await evaluateField(ports, source, 'detail', ruleField, rule, content, itemIndex, trace, signal, { ...context, bindings: { book, chapter }, captureBindings: ['chapter'] })
    if (field.state === 'cancelled') return result
    if (field.state === 'failed' || field.state === 'capability-missing') {
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage: 'detail', field: ruleField, itemIndex, message: field.message ?? '章节字段失败', retryable: false })
      result.fatal = field.state === 'capability-missing' ? 'capability-missing' : 'failed'
      return result
    }
    if (field.state === 'value' || field.state === 'empty' || field.state === 'missing') {
      if (ruleField === 'isVolume') {
        result.isVolume = field.state === 'value' ? booleanValue(field.value) : false
        result.rawFields.isVolume = result.isVolume
        chapter.isVolume = result.isVolume
        syncChapterFields(result, chapter, countWords)
        continue
      }
      if (ruleField === 'isVip') {
        result.isVip = field.state === 'value' ? booleanValue(field.value) : false
        result.rawFields.isVip = result.isVip
        chapter.isVip = result.isVip
        syncChapterFields(result, chapter, countWords)
        continue
      }
      if (ruleField === 'isPay') {
        result.isPay = field.state === 'value' ? booleanValue(field.value) : false
        result.rawFields.isPay = result.isPay
        chapter.isPay = result.isPay
        syncChapterFields(result, chapter, countWords)
        continue
      }
    }
    if (field.state === 'value') {
      const value = textValue(field.value)
      result.rawFields[outputField] = jsonValue(field.value)
      if (outputField === 'title') result.title = value
      else if (outputField === 'url') result.url = value
      else if (outputField === 'volume') result.volume = value
      else if (outputField === 'updateTime') result.updateTime = value
      if (outputField === 'title') chapter.title = value
      else if (outputField === 'url') chapter.url = value
    }
    syncChapterFields(result, chapter, countWords)
    if (ruleField === 'chapterName' && (field.state !== 'value' || result.title === undefined || result.title.length === 0)) return result
  }
  syncChapterFields(result, chapter, countWords)
  if (result.volume === undefined && inheritedVolume !== undefined) result.volume = inheritedVolume
  return result
}

function syncChapterFields(result: ChapterFields, chapter: Record<string, unknown>, countWords: boolean): void {
  if (typeof chapter.title === 'string') result.title = chapter.title
  if (typeof chapter.url === 'string') result.url = chapter.url
  if (typeof chapter.variable === 'string') result.variable = chapter.variable
  if (typeof chapter.volume === 'string' && chapter.volume.length > 0) result.volume = chapter.volume
  if (typeof chapter.isVolume === 'boolean') result.isVolume = chapter.isVolume
  if (typeof chapter.isVip === 'boolean') result.isVip = chapter.isVip
  if (typeof chapter.isPay === 'boolean') result.isPay = chapter.isPay
  if (typeof chapter.updateTime === 'string') result.updateTime = chapter.updateTime
  if (result.updateTime !== undefined) {
    const projection = chapterInfoProjection(result.updateTime, result.isVolume === true, countWords)
    if (projection.tag !== undefined) {
      result.tag = projection.tag
      chapter.tag = projection.tag
    } else delete result.tag
    if (projection.wordCount !== undefined) {
      result.wordCount = projection.wordCount
      chapter.wordCount = projection.wordCount
    } else delete result.wordCount
  } else {
    if (typeof chapter.tag === 'string') result.tag = chapter.tag
    if (typeof chapter.wordCount === 'string') result.wordCount = chapter.wordCount
  }
  if (result.title !== undefined) chapter.title = result.title
  if (result.url !== undefined) chapter.url = result.url
  if (result.variable !== undefined) chapter.variable = result.variable
  if (result.volume !== undefined) chapter.volume = result.volume
  if (result.isVolume !== undefined) chapter.isVolume = result.isVolume
  if (result.isVip !== undefined) chapter.isVip = result.isVip
  if (result.isPay !== undefined) chapter.isPay = result.isPay
  if (result.updateTime !== undefined) chapter.updateTime = result.updateTime
}

function listValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value.flatMap((item) => textValue(item).split('\n')) : typeof value === 'string' ? value.split('\n') : []
  return values.map((item) => item.trim()).filter((item) => item.length > 0)
}

const BOOK_TYPE_VIDEO = 4
const BOOK_TYPE_TEXT = 8
const BOOK_TYPE_AUDIO = 32
const BOOK_TYPE_IMAGE = 64
const BOOK_TYPE_WEB_FILE = 128
const BOOK_TYPE_LOCAL = 256

function resolvedBookType(book: BookMetadata | undefined, source: NormalizedSource): number {
  return androidBookType(book, source)
}

function androidBookType(book: BookMetadata | undefined, source: NormalizedSource): number {
  const explicitType = book?.type
  if (typeof explicitType === 'number' && Number.isInteger(explicitType) && explicitType > 0) return explicitType
  switch (sourceNumber(source, 'bookSourceType')) {
    case 0: return BOOK_TYPE_TEXT
    case 1: return BOOK_TYPE_AUDIO
    case 2: return BOOK_TYPE_IMAGE
    case 3: return BOOK_TYPE_TEXT | BOOK_TYPE_WEB_FILE
    case 4: return BOOK_TYPE_VIDEO
    default: return 0
  }
}

function javascriptBookType(book: BookMetadata | undefined, source: NormalizedSource): number {
  return androidBookType(book, source) || BOOK_TYPE_TEXT
}

function isLocalBook(type: number, book: BookMetadata | undefined): boolean {
  if (type !== 0) return (type & BOOK_TYPE_LOCAL) !== 0
  const origin = book?.rawFields.origin
  const sourceId = book?.sourceId ?? ''
  const actualOrigin = typeof origin === 'string' ? origin : sourceId
  return actualOrigin === 'loc_book' || actualOrigin.startsWith('webDav::')
}

function isOnlineTextBook(type: number, book: BookMetadata | undefined): boolean {
  return (type & BOOK_TYPE_TEXT) !== 0 && !isLocalBook(type, book)
}

function isAudioBook(type: number): boolean {
  return (type & BOOK_TYPE_AUDIO) !== 0
}

function isVideoBook(type: number): boolean {
  return (type & BOOK_TYPE_VIDEO) !== 0
}

function updateChapterVariable(chapter: ContentInput['chapter'], key: string, value: string | null): void {
  const variables: Record<string, string> = {}
  if (chapter.variable !== undefined) {
    try {
      const parsed: unknown = JSON.parse(chapter.variable)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [name, entry] of Object.entries(parsed)) {
          if (typeof entry === 'string') variables[name] = entry
          else if (typeof entry === 'number' && Number.isFinite(entry)) variables[name] = String(entry)
          else if (typeof entry === 'boolean') variables[name] = String(entry)
        }
      }
    } catch {
      // Android treats malformed BookChapter.variable JSON as an empty map.
    }
  }
  if (value === null) delete variables[key]
  else variables[key] = value
  chapter.variable = JSON.stringify(variables)
}

function normalizeChapterListRule(value: string): string {
  let rule = value
  if (rule.startsWith('-')) rule = rule.slice(1)
  if (rule.startsWith('+')) rule = rule.slice(1)
  return rule
}

/** 仅把编译后 Default 规则末尾的 html/all 输出标记当作正文类型声明。 */
function ruleReturnsHtml(rule: string): boolean {
  try {
    const compiled = compileRule(rule).rule
    return compiled !== undefined && compiledRuleReturnsHtml(compiled)
  } catch {
    // HTML 类型推断失败时保守回退为纯文本，正文规则本身仍按原流程执行。
    return false
  }
}

function compiledRuleReturnsHtml(rule: CompiledRule): boolean {
  if (rule.kind === 'sequence') return rule.children.some(compiledRuleReturnsHtml)
  if (rule.mode === 'Default') {
    const body = rule.body.trim()
    if (body.startsWith('literal:')) return false
    // 只匹配选择器链的末尾输出标记，避免把字面量、属性值或自定义 token 当成 HTML。
    return /(?:^|@)(?:html|all)$/iu.test(body)
  }
  if (rule.mode === 'Js') return javascriptRuleReturnsHtml(rule.body)
  return false
}

function javascriptRuleReturnsHtml(body: string): boolean {
  // JS 规则只有在显式把 @html/@all 作为 java.getString* 的选择器输出时才声明 HTML。
  return /\b(?:java\.)?getString(?:List)?\s*\(\s*(['"`])[^)]*@(?:html|all)(?![A-Za-z0-9_-])[^)]*\1\s*\)/iu.test(body)
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  const text = textValue(value).trim().toLocaleLowerCase('zh-Hans')
  return text.length > 0 && text !== 'null' && !['false', 'no', 'not', '0', '0.0'].includes(text)
}

function javascriptPrimitiveText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined
}

/** Android BookChapter.equals 只比较原始 url：同地址不同标题也折叠，保留反转后最先出现的条目。 */
function deduplicateChapters(chapters: Chapter[], diagnostics: WorkflowDiagnostic[], stage: WorkflowStage): Chapter[] {
  const seen = new Set<string>()
  return chapters.filter((chapter) => {
    if (seen.has(chapterRuleUrl(chapter))) {
      diagnostics.push({ code: 'duplicate-item', stage, itemIndex: chapter.index, message: '重复章节已折叠', retryable: false })
      return false
    }
    seen.add(chapterRuleUrl(chapter))
    return true
  })
}

/** 逐条应用调用方给的正文替换；越界或非法的正则只跳过该条并回报，不能拖垮整篇正文。 */
function applyReplacements(value: string, replacements: readonly { pattern: string; replacement: string; all?: boolean }[]): { text: string; errors: string[] } {
  const errors: string[] = []
  let result = value
  for (const item of replacements) {
    const compiled = compileSourcePattern(item.pattern, { flags: item.all === false ? '' : 'g' })
    if ('error' in compiled) {
      errors.push(`${compiled.error.message}：${item.pattern.slice(0, 40)}`)
      continue
    }
    result = result.replace(compiled.regex, item.replacement)
  }
  return { text: result, errors }
}

function safeResolveReference(value: string, baseUrl: string): string | undefined {
  try {
    return resolveSourceRequestReference(value, baseUrl)
  } catch {
    return undefined
  }
}

function splitBatchJavaScript(rule: string): { scripts: string[]; error?: string } {
  const trimmed = rule.trim()
  if (!/^<js>|^@js:/i.test(trimmed)) return { scripts: [trimmed] }
  const matcher = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/ig
  const scripts: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(trimmed)) !== null) {
    if (trimmed.slice(cursor, match.index).trim().length > 0) return { scripts: [], error: 'contentBatch 只能包含 JavaScript 规则片段' }
    const code = (match[1] ?? match[2] ?? '').trim()
    if (code.length > 0) scripts.push(code)
    cursor = matcher.lastIndex
    if (match[2] !== undefined) break
  }
  if (scripts.length === 0 || trimmed.slice(cursor).trim().length > 0) return { scripts: [], error: 'contentBatch JavaScript 包装不完整或包含非 JavaScript 片段' }
  return { scripts }
}

function resolveUrl(value: string, baseUrl: string): string | undefined {
  if (value.trimStart().startsWith('<') && !/^<(?:js>|\d+(?:,\d+)*>)/i.test(value.trimStart())) return undefined
  try {
    return resolveSourceRequestReference(value, baseUrl)
  } catch {
    return undefined
  }
}

/** Android `AppPattern.imgRegex` projects a title and its trailing image URL. */
function chapterTitleProjection(value: string, fallbackTitle: string | undefined): { title?: string; imgUrl?: string } {
  const match = /(.*)((?:data|https?):[\s\S]+)$/u.exec(value)
  if (match === null) return value.trim().length > 0 ? { title: value } : {}
  const title = match[1] !== undefined && match[1].length > 0 ? match[1] : fallbackTitle
  const imgUrl = match[2]
  return { ...(title === undefined ? {} : { title }), ...(imgUrl === undefined ? {} : { imgUrl }) }
}

function uniqueResources(resources: readonly ContentResource[]): ContentResource[] {
  const seen = new Set<string>()
  return resources.filter((resource) => !seen.has(resource.url) && seen.add(resource.url))
}

function cancelled(message: string, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): RuntimeResult<never> {
  diagnostics.push({ code: 'cancelled', stage: 'detail', message, retryable: false })
  return { status: 'cancelled', value: null, diagnostics, trace }
}
