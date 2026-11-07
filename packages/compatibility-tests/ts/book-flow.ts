import {
  importSources, loadBookDetails, loadChapterContent, loadTableOfContents, nextChapterUrlFor, searchBooks,
} from '../../source-core/src/index.ts'
import type { BookCandidate, BookMetadata, NetworkHost, RuntimeResult, WorkflowPorts } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../../source-node/src/cookies.ts'
import { SourceRequestHost } from '../../source-node/src/source-request-host.ts'
import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'

interface ResponseFixture {
  method: string
  url: string
  body: string | null
  response: {
    status: number
    url: string
    headers: Record<string, string>
    base64: string
  }
}

export class FlowFixtureError extends Error {}

function bookFields(book: BookCandidate) {
  const { name, author, bookUrl, tocUrl, coverUrl, intro, kind, wordCount, lastChapter } = book
  return { name, author, bookUrl, tocUrl, coverUrl, intro, kind, wordCount, lastChapter }
}

export async function executeBookFlow(input: Record<string, unknown>, tocOnly = false) {
  const imported = (await importSources(JSON.stringify(input.source)))[0]?.source
  if (!imported) throw new FlowFixtureError('流程书源无法导入')
  const responses = input.responses as Record<string, ResponseFixture>
  const declaredHeaders = typeof imported.header === 'string' ? JSON.parse(imported.header.trim() || '{}') as Record<string, string> : imported.header
  const headerNames = new Set(Object.keys(declaredHeaders ?? {}).map((name) => name.toLowerCase()))
  if (input.requestEvidence === true) {
    headerNames.add('content-type')
    const options = typeof imported.searchUrl === 'string' ? /,\s*(\{.*\})$/su.exec(imported.searchUrl)?.[1] : undefined
    if (options) for (const name of Object.keys(JSON.parse(options).headers ?? {})) headerNames.add(name.toLowerCase())
  }
  const requests: unknown[] = []
  const stages: Record<string, unknown> = {}
  let stage = 'search'
  let fault: FlowFixtureError | undefined
  const network: NetworkHost = {
    request: async (plan) => {
      const { method, url } = plan
      const body = typeof plan.body === 'string' ? plan.body : plan.body ? Buffer.from(plan.body).toString('utf8') : null
      const headers = Object.fromEntries(Object.entries(plan.headers).filter(([name]) => headerNames.has(name.toLowerCase()))
        .map(([name, value]) => [name.toLowerCase(), value]))
      const trace = { stage, method, url, body, headers }
      const entry = Object.values(responses).find((candidate) => candidate.method === method && candidate.url === url && candidate.body === body)
      if (requests.length >= Number(input.requestLimit) || !entry) {
        fault ??= new FlowFixtureError(`离线请求超限或缺少响应: ${stage} ${method} ${url}`)
        throw fault
      }
      const { response } = entry
      requests.push(input.requestEvidence === true ? {
        ...trace, bodyBase64: plan.body === undefined ? null : Buffer.from(plan.body).toString('base64'), responseUrl: response.url,
      } : trace)
      return { url: response.url, status: response.status, headers: response.headers, bytes: Buffer.from(response.base64, 'base64'), redirected: response.url !== url }
    },
  }
  const request = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  const rules = new SourceRuleHost({ request: (input, signal, source) => request.requestFromBridge(input, signal, source) })
  request.attachRuleHost(rules)
  const ports: WorkflowPorts = {
    network, rules, request: (input) => request.request(input), decodeResponse: (input) => request.decodeResponse(input),
  }
  const variableKeys = input.variableKeys as string[] | undefined
  function record<T>(result: RuntimeResult<T>, value: unknown, emptyCategory?: string, book?: BookMetadata) {
    if (fault) throw fault
    const diagnostics = result.diagnostics
    const failure = diagnostics.find((entry) => entry.code === 'empty-page')
    const variables = book?.variable ? JSON.parse(book.variable) as Record<string, unknown> : {}
    stages[stage] = {
      ...(variableKeys && (stage === 'detail' || stage === 'toc') ? {
        variables: Object.fromEntries(variableKeys.filter((key) => Object.hasOwn(variables, key)).map((key) => [key, variables[key]])),
      } : {}),
      status: result.status,
      value,
      ...(emptyCategory && failure ? { error: { category: emptyCategory, class: failure.code, message: failure.message } } : {}),
    }
  }
  const output = { stages, requests }
  let book: BookMetadata | undefined
  if (tocOnly) {
    const initial = input.book as Pick<BookMetadata, 'bookUrl' | 'tocUrl' | 'name'>
    book = {
      ...initial, sourceId: imported.bookSourceUrl, rawFields: {}, traceRef: 'flow.toc',
      emptyFields: [], fieldErrors: {}, variable: JSON.stringify(input.bookVariables),
    }
  } else {
    const search = await searchBooks(ports, { source: imported, keyword: String(input.keyword) })
    const candidate = search.value?.items[0]
    record(search, search.value?.items.map(bookFields) ?? null)
    if (!candidate) return output

    stage = 'detail'
    const details = await loadBookDetails(ports, { source: imported, candidates: [candidate] })
    book = details.value?.items[0]
    record(details, book ? bookFields(book) : null, undefined, book)

  }
  if (!book) return output

  stage = 'toc'
  const toc = await loadTableOfContents(ports, { source: imported, book })
  const chapterIndex = Number(input.chapterIndex ?? 0)
  const chapter = toc.value?.items[chapterIndex]
  if (toc.value?.items.length && !chapter) throw new FlowFixtureError(`目录没有指定章节: ${chapterIndex}`)
  record(toc, toc.value?.items.map(({ title, chapterUrl, index, isVip, isPay, isVolume }) => ({ title, chapterUrl, index, isVip: isVip === true, isPay: isPay === true, isVolume: isVolume === true })) ?? null, 'toc-empty', toc.value?.bookAfter ?? book)
  if (tocOnly || !chapter) return output

  stage = 'content'
  const next = nextChapterUrlFor(toc.value?.items, chapter)
  const content = await loadChapterContent(ports, { source: imported, book, chapter, ...(next === undefined ? {} : { nextChapterUrl: next }) })
  record(content, content.value ? { title: content.value.title ?? chapter.title, pageCount: content.value.pages.length, cleaned: content.value.cleaned } : null, 'content-empty')
  return output
}
