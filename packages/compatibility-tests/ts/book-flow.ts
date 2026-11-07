import {
  importSources, loadBookDetails, loadChapterContent, loadTableOfContents, nextChapterUrlFor, searchBooks,
} from '../../source-core/src/index.ts'
import type { BookCandidate, NetworkHost, RuntimeResult, WorkflowPorts } from '../../source-core/src/index.ts'
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

export async function executeBookFlow(input: Record<string, unknown>) {
  const imported = (await importSources(JSON.stringify(input.source)))[0]?.source
  if (!imported) throw new FlowFixtureError('流程书源无法导入')
  const responses = input.responses as Record<string, ResponseFixture>
  const declaredHeaders = typeof imported.header === 'string' ? JSON.parse(imported.header.trim() || '{}') as Record<string, string> : imported.header
  const headerNames = Object.keys(declaredHeaders ?? {}).map((name) => name.toLowerCase())
  const requests: unknown[] = []
  const stages: Record<string, unknown> = {}
  let stage = 'search'
  let fault: FlowFixtureError | undefined
  const network: NetworkHost = {
    request: async (plan) => {
      const { method, url } = plan
      const body = typeof plan.body === 'string' ? plan.body : plan.body ? Buffer.from(plan.body).toString('utf8') : null
      const headers = Object.fromEntries(Object.entries(plan.headers).filter(([name]) => headerNames.includes(name.toLowerCase()))
        .map(([name, value]) => [name.toLowerCase(), value]))
      requests.push({ stage, method, url, body, headers })
      const entry = Object.values(responses).find((candidate) => candidate.method === method && candidate.url === url && candidate.body === body)
      if (requests.length > Number(input.requestLimit) || !entry) {
        fault ??= new FlowFixtureError(`离线请求超限或缺少响应: ${stage} ${method} ${url}`)
        throw fault
      }
      const { response } = entry
      return { url: response.url, status: response.status, headers: response.headers, bytes: Buffer.from(response.base64, 'base64'), redirected: response.url !== url }
    },
  }
  const request = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  const rules = new SourceRuleHost({ request: (input, signal, source) => request.requestFromBridge(input, signal, source) })
  request.attachRuleHost(rules)
  const ports: WorkflowPorts = {
    network, rules, request: (input) => request.request(input), decodeResponse: (input) => request.decodeResponse(input),
  }
  function record<T>(result: RuntimeResult<T>, value: unknown, emptyCategory?: string) {
    if (fault) throw fault
    const diagnostics = result.diagnostics
    const failure = diagnostics.find((entry) => entry.code === 'empty-page')
    stages[stage] = {
      status: result.status,
      value,
      ...(emptyCategory && failure ? { error: { category: emptyCategory, class: failure.code, message: failure.message } } : {}),
    }
  }
  const output = { stages, requests }
  const search = await searchBooks(ports, { source: imported, keyword: String(input.keyword) })
  const candidate = search.value?.items[0]
  record(search, search.value?.items.map(bookFields) ?? null)
  if (!candidate) return output

  stage = 'detail'
  const details = await loadBookDetails(ports, { source: imported, candidates: [candidate] })
  const book = details.value?.items[0]
  record(details, book ? bookFields(book) : null)
  if (!book) return output

  stage = 'toc'
  const toc = await loadTableOfContents(ports, { source: imported, book })
  const chapter = toc.value?.items[0]
  record(toc, toc.value?.items.map(({ title, chapterUrl, isVip, isPay, isVolume }) => ({ title, chapterUrl, isVip: isVip === true, isPay: isPay === true, isVolume: isVolume === true })) ?? null, 'toc-empty')
  if (!chapter) return output

  stage = 'content'
  const next = nextChapterUrlFor(toc.value?.items, chapter)
  const content = await loadChapterContent(ports, { source: imported, book, chapter, ...(next === undefined ? {} : { nextChapterUrl: next }) })
  record(content, content.value ? { title: content.value.title ?? chapter.title, pageCount: content.value.pages.length, cleaned: content.value.cleaned } : null, 'content-empty')
  return output
}
