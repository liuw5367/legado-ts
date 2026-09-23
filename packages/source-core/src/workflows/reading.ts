import type { JsonObject, NormalizedSource } from '../model/types.ts'
import { compileRule } from '../rules/compiler.ts'
import { compileSourcePattern } from '../rules/pattern-guard.ts'
import type { CompiledRule } from '../rules/types.ts'
import { resolveSourceRequestReference } from '../runtime/request-url.ts'
import { evaluateField, executeSourceFunction, executeWorkflowJavaScript, expandUrl, expansionDiagnostic, expansionStatus, jsonValue, requestPageResponse, ruleString, sourceNumber, sourceString, statusFromDiagnostics, textValue } from './helpers.ts'
import type { BookMetadata, Chapter, ChapterContent, ContentInput, ContentResource, ReadingPorts, RuntimeResult, TocInput, WorkflowDiagnostic, WorkflowOptions, WorkflowPage, WorkflowPorts, WorkflowStage, WorkflowTraceEntry } from './types.ts'

export async function loadTableOfContents(ports: ReadingPorts, input: TocInput): Promise<RuntimeResult<WorkflowPage<Chapter>>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const cursor = input.cursor ?? { index: 0 }
  if (sourceString(input.source, 'mainJs') !== undefined) return javascriptTableOfContents(ports, input, diagnostics, trace)
  let book = input.book
  const preUpdateJs = ruleString(input.source, 'ruleToc', 'preUpdateJs')
  if (input.runPerJs === true && preUpdateJs !== undefined) {
    const preUpdate = await executeWorkflowJavaScript(ports, input.source, `${preUpdateJs}\n;book`, stage, 'book', trace, { bindings: { book: { ...book }, isFromBookInfo: input.isFromBookInfo === true }, ...(input.signal === undefined ? {} : { signal: input.signal }) })
    if (preUpdate.state === 'cancelled' || input.signal?.aborted === true) return cancelled('目录预处理脚本已取消', diagnostics, trace)
    if (preUpdate.state === 'capability-missing' || preUpdate.state === 'failed') {
      diagnostics.push({ code: preUpdate.state === 'capability-missing' ? 'capability-missing' : 'rule-failed', stage, field: 'preUpdateJs', message: preUpdate.message ?? '目录预处理脚本失败', retryable: false })
      return { status: preUpdate.state === 'capability-missing' ? 'capability-missing' : 'failed', value: null, diagnostics, trace }
    }
    if (typeof preUpdate.value === 'object' && preUpdate.value !== null && !Array.isArray(preUpdate.value)) book = mergeBookScriptValues(book, preUpdate.value as Record<string, unknown>)
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
  const expandedBookUrl = await expandUrl(ports, input.source, stage, rawBookUrl, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl }, input.signal)
  if (expandedBookUrl.url === undefined) {
    diagnostics.push(expansionDiagnostic(expandedBookUrl.error, stage, 'tocUrl', '目录地址展开失败'))
    return { status: expansionStatus(expandedBookUrl.error), value: null, diagnostics, trace }
  }
  const bookBaseUrl = expandedBookUrl.url
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
    // 明确刷新时详情阶段暂存的目录响应也可能过期，必须重新请求第一页。
    const page = pageIndex === 0 && input.refresh !== true && book.tocHtml !== undefined && normalizedUrl === bookBaseUrl
      ? { body: book.tocHtml, url: normalizedUrl }
      : await cachedPage(ports, input.source, normalizedUrl, 'toc', stage, pageOptions(input, maxBytes, totalBytes), diagnostics, trace, undefined, input.refresh === true)
    if (page === undefined) break
    const body = page.body
    totalBytes += new TextEncoder().encode(body).byteLength
    if (totalBytes > maxBytes) {
      diagnostics.push({ code: 'item-skipped', stage, message: '目录累计响应超过字节预算', retryable: false })
      break
    }
    const responseUrl = resolveUrl(page.url, normalizedUrl) ?? normalizedUrl
    visited.add(responseUrl)
    const context = { baseUrl: normalizedUrl, redirectUrl: responseUrl }
    const list = await evaluateField(ports, input.source, stage, 'chapterList', listRuleBody, body, pageIndex, trace, input.signal, { ...context, expect: 'nodes' })
    if (list.state === 'cancelled') return cancelled('目录规则执行已取消', diagnostics, trace)
    if (list.state === 'capability-missing') {
      diagnostics.push({ code: 'capability-missing', stage, field: 'chapterList', message: list.message ?? '目录规则能力不可用', retryable: false })
      break
    }
    if (list.state === 'failed') {
      diagnostics.push({ code: 'rule-failed', stage, field: 'chapterList', message: list.message ?? '目录规则失败', retryable: false })
      break
    }
    const rawItems = list.state === 'value' && Array.isArray(list.value) ? list.value.filter((item) => item !== null && item !== undefined) : []
    if (list.state === 'value' && !Array.isArray(list.value)) {
      diagnostics.push({ code: 'item-skipped', stage, field: 'chapterList', message: 'chapterList 规则必须返回列表', retryable: false })
    }
    for (const [itemIndex, rawItem] of rawItems.entries()) {
      const fields = await chapterFields(ports, input.source, rawItem, pageIndex * 100000 + itemIndex, input.signal, diagnostics, trace, volume, context)
      if (input.signal !== undefined && input.signal.aborted) return cancelled('目录工作流已取消', diagnostics, trace)
      if (fields.isVolume === true && fields.title !== undefined && fields.title.length > 0) volume = fields.title
      else if (fields.volume !== undefined && fields.volume.length > 0) volume = fields.volume
      if (fields.title === undefined || fields.title.length === 0) {
        diagnostics.push({ code: 'identity-missing', stage, itemIndex, message: '章节缺少标题', retryable: false })
        continue
      }
      const chapterIndex = chapters.length
      const isVolume = fields.isVolume === true
      const chapterUrl = isVolume && (fields.url === undefined || fields.url.length === 0 || fields.url === fields.title)
        ? `${fields.title}${chapterIndex}`
        : fields.url === undefined || fields.url.length === 0
          ? normalizedUrl
          : resolveUrl(fields.url, responseUrl)
      if (chapterUrl === undefined) {
        diagnostics.push({ code: 'item-skipped', stage, itemIndex, message: '章节 URL 无效', retryable: false })
        continue
      }
      const chapter: Chapter = {
        sourceId: input.source.bookSourceUrl,
        bookUrl: book.bookUrl,
        chapterUrl,
        index: chapterIndex,
        title: fields.title,
        rawFields: fields.rawFields,
        traceRef: `toc:${chapterIndex}`,
        isVolume,
        isVip: fields.isVip ?? false,
        isPay: fields.isPay ?? false,
        ...(fields.updateTime === undefined ? {} : { updateTime: fields.updateTime }),
      }
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
    const resolvedNextUrls = new Set<string>()
    for (const value of nextValues) {
      const resolved = resolveUrl(value, responseUrl)
      const expandedNext = resolved === undefined ? undefined : await expandUrl(ports, input.source, stage, resolved, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl }, input.signal)
      const nextUrl = expandedNext?.url
      if (nextUrl === undefined) {
        if (expandedNext?.error?.code === 'cancelled') return cancelled('目录下一页地址展开已取消', diagnostics, trace)
        diagnostics.push({ code: expandedNext?.error?.code ?? 'item-skipped', stage, field: 'nextTocUrl', message: expandedNext?.error?.message ?? '目录下一页 URL 无效', retryable: false })
        continue
      }
      resolvedNextUrls.add(nextUrl)
    }
    const followNext = resolvedNextUrls.size === 1
    for (const nextUrl of resolvedNextUrls) if (!visited.has(nextUrl) && !pendingPages.some((item) => item.url === nextUrl)) pendingPages.push({ url: nextUrl, followNext })
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
  const value: WorkflowPage<Chapter> = { items: uniqueChapters, cursor, ...(pendingPages.length > 0 ? { nextCursor: { index: cursor.index + 1 } } : {}) }
  const status = uniqueChapters.length === 0 && diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed') ? 'failed' : statusFromDiagnostics(diagnostics, uniqueChapters.length)
  // 取消的调用不能拿到半份目录。
  return { status, value: status === 'cancelled' ? null : value, diagnostics, trace }
}

async function javascriptTableOfContents(ports: ReadingPorts, input: TocInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<RuntimeResult<WorkflowPage<Chapter>>> {
  const cursor = input.cursor ?? { index: 0 }
  const book = { ...input.book.rawFields, ...input.book, origin: input.book.sourceId, originName: input.source.bookSourceName, type: sourceNumber(input.source, 'bookSourceType') ?? 0 }
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
      chapterUrl,
      index: chapters.length,
      title,
      rawFields: jsonValue(record) as JsonObject,
      traceRef: `toc:${chapters.length}`,
      isVolume,
      isVip: booleanValue(record.isVip),
      isPay: booleanValue(record.isPay),
    }
    const volume = typeof record.volume === 'string' ? record.volume : undefined
    if (volume !== undefined && volume.length > 0) chapter.volume = volume
    const updateTime = typeof record.updateTime === 'string' ? record.updateTime : typeof record.tag === 'string' ? record.tag : undefined
    if (updateTime !== undefined && updateTime.length > 0) chapter.updateTime = updateTime
    chapters.push(chapter)
  }
  chapters.forEach((chapter, index) => { chapter.index = index })
  if (chapters.length === 0) diagnostics.push({ code: 'empty-page', stage: 'detail', message: 'JS 目录为空', retryable: false })
  const value: WorkflowPage<Chapter> = { items: chapters, cursor }
  return { status: statusFromDiagnostics(diagnostics, chapters.length), value, diagnostics, trace }
}

export async function loadChapterContent(ports: ReadingPorts, input: ContentInput): Promise<RuntimeResult<ChapterContent>> {
  const diagnostics: WorkflowDiagnostic[] = []
  const trace: WorkflowTraceEntry[] = []
  const stage: WorkflowStage = 'detail'
  const chapterTitle = input.chapter.title ?? ''
  const isVolumePlaceholder = input.chapter.isVolume === true && chapterTitle.length > 0 && input.chapter.chapterUrl.startsWith(chapterTitle)
  if (isVolumePlaceholder) {
    if (input.signal?.aborted === true) return cancelled('正文工作流已取消', diagnostics, trace)
    diagnostics.push({ code: 'empty-page', stage, message: '卷节点没有正文', retryable: false })
    return { status: 'empty', value: { chapter: input.chapter, contentType: 'text', raw: '', cleaned: '', pages: [], resources: [] }, diagnostics, trace }
  }
  if (sourceString(input.source, 'mainJs') !== undefined) return javascriptChapterContent(ports, input, diagnostics, trace)
  const contentRule = ruleString(input.source, 'ruleContent', 'content') ?? sourceString(input.source, 'ruleContent')
  if (contentRule === undefined) {
    const url = input.chapter.chapterUrl
    return { status: 'success', value: { chapter: input.chapter, contentType: 'text', raw: url, cleaned: url, pages: [url], resources: [] }, diagnostics, trace }
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
  const visited = new Set<string>()
  const pages: string[] = []
  const cleanedPages: string[] = []
  const resources: ContentResource[] = []
  const bookUrl = resolveUrl(input.chapter.bookUrl, input.source.bookSourceUrl) ?? input.source.bookSourceUrl
  const rawFirstPageUrl = resolveUrl(input.chapter.chapterUrl, bookUrl) ?? input.chapter.chapterUrl
  const expandedFirstPage = await expandUrl(ports, input.source, stage, rawFirstPageUrl, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl }, input.signal)
  if (expandedFirstPage.url === undefined) {
    diagnostics.push(expansionDiagnostic(expandedFirstPage.error, stage, 'chapterUrl', '章节地址展开失败'))
    return { status: expansionStatus(expandedFirstPage.error), value: null, diagnostics, trace }
  }
  const firstPageUrl = expandedFirstPage.url
  const pendingPages = [{ url: firstPageUrl, followNext: true }]
  const contentBaseUrl = resolveUrl(firstPageUrl, bookUrl) ?? bookUrl
  let lastResponseUrl = contentBaseUrl
  let totalBytes = 0
  let stoppedByLimit = false
  // 命中下一章时终止分页（Android BookContent 的 nextChapterUrl 护栏）。
  let reachedNextChapter = false
  let nextChapterAbsolute: string | undefined
  // Android 用第一页响应求值 ruleContent.title。
  let firstPage: { body: string; url: string; context: { baseUrl: string; redirectUrl: string } } | undefined
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
    const page = pageIndex === 0 && input.tocHtml !== undefined && normalizedUrl === bookUrl
      ? { body: input.tocHtml, url: normalizedUrl }
      : await cachedPage(ports, input.source, normalizedUrl, 'content', stage, pageOptions(input, maxBytes, totalBytes), diagnostics, trace, pageIndex === 0 ? firstPageExecution : pagedExecution)
    if (page === undefined) break
    const body = page.body
    const responseUrl = resolveUrl(page.url, normalizedUrl) ?? normalizedUrl
    lastResponseUrl = responseUrl
    const context = { baseUrl: normalizedUrl, redirectUrl: responseUrl }
    if (pageIndex === 0) firstPage = { body, url: responseUrl, context }
    // Android BookContent 固定用第一页的最终响应地址解析下一章地址。
    if (pageIndex === 0 && input.nextChapterUrl !== undefined) nextChapterAbsolute = resolveUrl(input.nextChapterUrl, responseUrl)
    totalBytes += new TextEncoder().encode(body).byteLength
    if (totalBytes > maxBytes) {
      diagnostics.push({ code: 'item-skipped', stage, message: '正文累计响应超过字节预算', retryable: false })
      stoppedByLimit = true
      break
    }
    const result = await evaluateField(ports, input.source, stage, 'content', contentRule, body, pageIndex, trace, input.signal, context)
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
    if (contentPage.length > 0) {
      pages.push(contentPage)
      const cleanedPage = cleanContent(contentPage, contentType, responseUrl)
      cleanedPages.push(cleanedPage)
      resources.push(...extractResources(cleanedPage, contentType, responseUrl))
    }
    if (!pendingPage.followNext) continue
    const nextContentRule = ruleString(input.source, 'ruleContent', 'nextContentUrl')
    const nextRule = nextContentRule ?? ruleString(input.source, 'ruleContent', 'nextPage')
    const nextField = nextContentRule !== undefined ? 'nextContentUrl' : 'nextPage'
    if (nextRule === undefined) continue
    const next = await evaluateField(ports, input.source, stage, nextField, nextRule, body, pageIndex, trace, input.signal, context)
    if (next.state === 'cancelled') return cancelled('正文下一页规则已取消', diagnostics, trace)
    if (next.state !== 'value') continue
    const nextValues = listValues(next.value)
    const resolvedNextUrls = new Set<string>()
    for (const value of nextValues) {
      const resolvedNext = resolveUrl(value, responseUrl)
      const expandedNext = resolvedNext === undefined ? undefined : await expandUrl(ports, input.source, stage, resolvedNext, { 'source.bookSourceUrl': input.source.bookSourceUrl }, { 'source.bookSourceUrl': input.source.bookSourceUrl }, input.signal)
      const nextUrl = expandedNext?.url
      if (nextUrl === undefined) {
        if (expandedNext?.error?.code === 'cancelled') return cancelled('正文下一页地址展开已取消', diagnostics, trace)
        diagnostics.push({ code: expandedNext?.error?.code ?? 'item-skipped', stage, field: nextField, message: expandedNext?.error?.message ?? '正文下一页 URL 无效', retryable: false })
        stoppedByLimit = true
        continue
      }
      resolvedNextUrls.add(nextUrl)
    }
    const uniqueNextUrls = [...resolvedNextUrls]
    if (uniqueNextUrls.length === 1 && nextChapterAbsolute !== undefined && uniqueNextUrls[0] === nextChapterAbsolute) {
      reachedNextChapter = true
      pendingPages.length = 0
      break
    }
    const followNext = uniqueNextUrls.length === 1
    for (const nextUrl of uniqueNextUrls) {
      if (visited.has(nextUrl)) {
        diagnostics.push({ code: 'item-skipped', stage, field: nextField, message: '正文下一页形成循环', retryable: false })
        stoppedByLimit = true
      } else if (!pendingPages.some((item) => item.url === nextUrl)) pendingPages.push({ url: nextUrl, followNext })
    }
  }
  // 请求被取消时不能把半截正文当成成功或空结果交付，状态必须与目录流程一致。
  // 诊断已经在请求层压过一条，这里只改状态，不再重复报告。
  if (diagnostics.some((item) => item.code === 'cancelled')) return { status: 'cancelled', value: null, diagnostics, trace }
  if (pendingPages.length > 0) stoppedByLimit = true
  if (reachedNextChapter) trace.push({ stage, event: 'field', target: 'nextChapterUrl' })
  const raw = pages.join(contentType === 'html' ? '\n' : '\n\n')
  const joined = cleanedPages.join(contentType === 'html' ? '\n' : '\n\n')
  // Android 先逐行 trim，再把源级 replaceRegex 当规则对正文求值（可含 ##匹配##替换 或 @js:）。
  let sourceReplaced = joined
  if (replaceRule !== undefined) {
    const trimmed = joined.split('\n').map((line) => line.trim()).join('\n')
    const field = await evaluateField(ports, input.source, stage, 'replaceRegex', replaceRule, trimmed, undefined, trace, input.signal, firstPage?.context)
    if (field.state === 'cancelled') return cancelled('正文替换规则执行已取消', diagnostics, trace)
    if (field.state === 'value' || field.state === 'empty') sourceReplaced = textValue(field.value)
    else {
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage, field: 'replaceRegex', message: field.message ?? '正文替换规则失败', retryable: false })
      stoppedByLimit = true
    }
  }
  let replaced = sourceReplaced
  const replacements = applyReplacements(sourceReplaced, input.replacements ?? [])
  replaced = replacements.text
  for (const message of replacements.errors) {
    diagnostics.push({ code: 'invalid-config', stage, field: 'replacements', message, retryable: false })
    stoppedByLimit = true
  }
  const cleaned = cleanContent(replaced, contentType, lastResponseUrl)
  let title: string | undefined
  if (titleRule !== undefined && firstPage !== undefined) {
    const field = await evaluateField(ports, input.source, stage, 'title', titleRule, firstPage.body, undefined, trace, input.signal, firstPage.context)
    if (field.state === 'cancelled') return cancelled('章节标题规则执行已取消', diagnostics, trace)
    if (field.state === 'value') title = titleText(textValue(field.value))
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
  if (cleaned.length === 0) {
    diagnostics.push({ code: 'empty-page', stage, message: '正文为空', retryable: false })
    const capabilityMissing = diagnostics.some((item) => item.code === 'capability-missing')
    const failed = diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed')
    return { status: capabilityMissing ? 'capability-missing' : failed ? 'failed' : 'empty', value: capabilityMissing || failed ? null : { chapter: input.chapter, contentType, raw, cleaned, pages, resources: [] }, diagnostics, trace }
  }
  const value: ChapterContent = { chapter: input.chapter, contentType, raw, cleaned, pages, resources: uniqueResources(resources), ...(title === undefined ? {} : { title }) }
  const status = stoppedByLimit || diagnostics.some((item) => item.code === 'request-failed' || item.code === 'rule-failed' || item.code === 'item-skipped') ? 'partial' : 'success'
  return { status, value, diagnostics, trace }
}

async function javascriptChapterContent(ports: ReadingPorts, input: ContentInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<RuntimeResult<ChapterContent>> {
  const book: BookMetadata = input.book ?? {
    sourceId: input.chapter.sourceId,
    bookUrl: input.chapter.bookUrl,
    name: '',
    rawFields: {},
    traceRef: 'content:book',
    emptyFields: [],
    fieldErrors: {},
    tocUrl: input.chapter.bookUrl,
  }
  const chapterData = input.chapter as ContentInput['chapter'] & { rawFields?: JsonObject }
  const chapter = {
    ...(chapterData.rawFields ?? {}),
    ...input.chapter,
    url: input.chapter.chapterUrl,
    baseUrl: book.tocUrl ?? input.chapter.bookUrl,
    index: input.chapter.index,
    title: input.chapter.title ?? '',
  }
  const bookValue = { ...book.rawFields, ...book, origin: book.sourceId, originName: input.source.bookSourceName, type: sourceNumber(input.source, 'bookSourceType') ?? 0 }
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
    if (input.chapter.isVolume === true) return { status: 'empty', value: { chapter: input.chapter, contentType: 'text', raw, cleaned: '', pages: [], resources: [] }, diagnostics, trace }
    return { status: 'failed', value: null, diagnostics, trace }
  }
  return { status: 'success', value: { chapter: input.chapter, contentType: 'text', raw, cleaned: raw, pages: [raw], resources: [] }, diagnostics, trace }
}

async function formatChapterTitles(ports: WorkflowPorts, source: NormalizedSource, chapters: Chapter[], code: string, book: BookMetadata, input: TocInput, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): Promise<void> {
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const script = await executeWorkflowJavaScript(ports, source, code, 'detail', 'chapter', trace, {
      bindings: { gInt: 0, index: chapterIndex + 1, chapter: { ...chapter, url: chapter.chapterUrl, baseUrl: book.tocUrl ?? book.bookUrl }, title: chapter.title },
      captureMutations: ['chapter'],
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
      if (captured !== undefined && Object.hasOwn(captured, '__legadoWorkflowBindings')) {
        const outputValue = captured.__legadoWorkflowValue
        const mutatedChapter = captured.__legadoWorkflowBindings?.chapter
        const mutatedTitle = typeof mutatedChapter === 'object' && mutatedChapter !== null && !Array.isArray(mutatedChapter)
          ? (mutatedChapter as Record<string, unknown>).title
          : undefined
        if (outputValue !== null && outputValue !== undefined) chapter.title = textValue(outputValue)
        else if (javascriptPrimitiveText(mutatedTitle) !== undefined) chapter.title = javascriptPrimitiveText(mutatedTitle)!
      } else chapter.title = textValue(script.value)
    }
  }
}

function mergeBookScriptValues(book: BookMetadata, values: Record<string, unknown>): BookMetadata {
  const merged: BookMetadata = { ...book }
  for (const key of ['name', 'author', 'intro', 'kind', 'wordCount', 'lastChapter', 'updateTime', 'coverUrl', 'tocUrl'] as const) {
    const value = values[key]
    if (typeof value === 'string') merged[key] = value
  }
  if (typeof values.latestChapterTitle === 'string') merged.lastChapter = values.latestChapterTitle
  if (merged.coverUrl !== undefined) merged.coverUrl = resolveUrl(merged.coverUrl, book.bookUrl) ?? merged.coverUrl
  if (merged.tocUrl !== undefined) merged.tocUrl = resolveUrl(merged.tocUrl, book.bookUrl) ?? merged.tocUrl
  return merged
}

async function cachedPage(ports: ReadingPorts, source: NormalizedSource, url: string, scope: 'toc' | 'content', stage: WorkflowStage, options: WorkflowOptions, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], execution?: { webJs?: string; sourceRegex?: string }, refresh = false): Promise<{ body: string; url: string } | undefined> {
  const cacheKey = `${source.bookSourceUrl}\u0000${scope}\u0000${url}`
  const responseUrlKey = `${cacheKey}\u0000response-url`
  if (ports.cache !== undefined && !refresh) {
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
  const value = await requestPageResponse(ports, source, url, stage, options, diagnostics, trace, execution)
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
  return { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }), budget }
}

interface ChapterFields {
  title?: string
  url?: string
  volume?: string
  isVolume?: boolean
  isVip?: boolean
  isPay?: boolean
  updateTime?: string
  rawFields: JsonObject
}

async function chapterFields(ports: ReadingPorts, source: NormalizedSource, content: unknown, itemIndex: number, signal: AbortSignal | undefined, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[], inheritedVolume: string | undefined, context: { baseUrl: string; redirectUrl: string }): Promise<ChapterFields> {
  const result: ChapterFields = { rawFields: {} }
  for (const ruleField of ['chapterName', 'chapterUrl', 'chapterVolume', 'updateTime', 'isVolume', 'isVip', 'isPay'] as const) {
    const outputField = ruleField === 'chapterName'
      ? 'title'
      : ruleField === 'chapterUrl'
        ? 'url'
        : ruleField === 'chapterVolume'
          ? 'volume'
          : ruleField
    const rule = ruleString(source, 'ruleToc', ruleField)
    if (rule === undefined) continue
    const field = await evaluateField(ports, source, 'detail', ruleField, rule, content, itemIndex, trace, signal, context)
    if (field.state === 'cancelled') return result
    if (field.state === 'failed' || field.state === 'capability-missing') {
      diagnostics.push({ code: field.state === 'capability-missing' ? 'capability-missing' : 'item-skipped', stage: 'detail', field: ruleField, itemIndex, message: field.message ?? '章节字段失败', retryable: false })
      if (ruleField === 'chapterName') return result
      continue
    }
    if (field.state === 'value' || field.state === 'empty' || field.state === 'missing') {
      if (ruleField === 'isVolume') {
        result.isVolume = field.state === 'value' ? booleanValue(field.value) : false
        result.rawFields.isVolume = result.isVolume
        continue
      }
      if (ruleField === 'isVip') {
        result.isVip = field.state === 'value' ? booleanValue(field.value) : false
        result.rawFields.isVip = result.isVip
        continue
      }
      if (ruleField === 'isPay') {
        result.isPay = field.state === 'value' ? booleanValue(field.value) : false
        result.rawFields.isPay = result.isPay
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
    }
    if (ruleField === 'chapterName' && (field.state !== 'value' || result.title === undefined || result.title.length === 0)) return result
  }
  if (result.volume === undefined && inheritedVolume !== undefined) result.volume = inheritedVolume
  return result
}

function listValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value.flatMap((item) => textValue(item).split('\n')) : typeof value === 'string' ? value.split('\n') : []
  return values.map((item) => item.trim()).filter((item) => item.length > 0)
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

/** Android BookChapter.equals 只比较 url：同地址不同标题也折叠，保留反转后最先出现的条目。 */
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
  if (value.trimStart().startsWith('<') && !/^<(?:js>|\d+(?:,\d+)*>)/i.test(value.trimStart())) return undefined
  try {
    return resolveSourceRequestReference(value, baseUrl)
  } catch {
    return undefined
  }
}

/**
 * Android `AppPattern.imgRegex`：标题里带图片时取图片地址前的文本作为标题；
 * 只有图片没有文本时保留目录标题（这里返回 undefined，由调用方沿用目录标题）。
 */
function titleText(value: string): string | undefined {
  const match = /(.*)((?:data|https?):[\s\S]+)$/u.exec(value)
  const title = match === null ? value : (match[1] ?? '')
  return title.length > 0 ? title : undefined
}

function uniqueResources(resources: readonly ContentResource[]): ContentResource[] {
  const seen = new Set<string>()
  return resources.filter((resource) => !seen.has(resource.url) && seen.add(resource.url))
}

function cancelled(message: string, diagnostics: WorkflowDiagnostic[], trace: WorkflowTraceEntry[]): RuntimeResult<never> {
  diagnostics.push({ code: 'cancelled', stage: 'detail', message, retryable: false })
  return { status: 'cancelled', value: null, diagnostics, trace }
}
