import { loadChapterContentBatch } from '../../source-core/src/index.ts'
import type { BookMetadata, Chapter, NetworkHost, NetworkResponse, NormalizedSource, WorkflowPorts } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../../source-node/src/cookies.ts'
import { SourceRequestHost } from '../../source-node/src/source-request-host.ts'
import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'
import { FlowFixtureError } from './book-flow.ts'

interface FixtureResponse {
  method: string
  url: string
  body: string | null
  requestHeaders?: Record<string, string | null>
  response: { status: number; url: string; headers: Record<string, string>; base64: string }
}
interface ChapterFixture extends Record<string, unknown> {
  index: number
  title: string
  url: string
}

/** TS 端走实际 loadChapterContentBatch、QuickJS bridge、RequestHost 和单章取文入口。 */
export async function executeContentBatchFlow(input: Record<string, unknown>) {
  const source = input.source as NormalizedSource
  const bookInput = input.book as Record<string, unknown>
  const sourceId = source.bookSourceUrl
  const bookUrl = String(bookInput.bookUrl)
  const chaptersInput = (input.chapters as { items: ChapterFixture[] }).items
  const chapters: Chapter[] = chaptersInput.map((row) => ({
    sourceId,
    bookUrl,
    url: row.url,
    chapterUrl: typeof row.chapterUrl === 'string' ? row.chapterUrl : row.url,
    ...(typeof row.baseUrl === 'string' ? { baseUrl: row.baseUrl } : {}),
    title: row.title,
    index: row.index,
    rawFields: JSON.parse(JSON.stringify(row)) as NonNullable<Chapter['rawFields']>,
    traceRef: `batch:${row.index}`,
    ...(row.isVolume === true ? { isVolume: true } : {}),
  }))
  const book = {
    sourceId,
    bookUrl,
    tocUrl: typeof bookInput.tocUrl === 'string' ? bookInput.tocUrl : bookUrl,
    type: typeof bookInput.type === 'number' ? bookInput.type : 0,
    name: typeof bookInput.name === 'string' ? bookInput.name : 'Fixture book',
    rawFields: {},
    traceRef: 'content-batch-fixture',
    emptyFields: [],
    fieldErrors: {},
  } as BookMetadata

  const responses = input.responses as Record<string, FixtureResponse>
  const requests: string[] = []
  const requestLimit = Number(input.requestLimit)
  let fixtureFault: FlowFixtureError | undefined
  const network: NetworkHost = {
    request: async (plan) => {
      const body = typeof plan.body === 'string' ? plan.body : plan.body ? Buffer.from(plan.body).toString('utf8') : null
      const responseFixture = Object.values(responses).find((candidate) => candidate.method === plan.method
        && candidate.url === plan.url && candidate.body === body
        && Object.entries(candidate.requestHeaders ?? {}).every(([name, value]) => (plan.headers[name] ?? null) === value))
      if (requests.length >= requestLimit || responseFixture === undefined) {
        fixtureFault ??= new FlowFixtureError(`批量正文离线请求超限或缺少响应: ${plan.method} ${plan.url}`)
        throw fixtureFault
      }
      requests.push(plan.url)
      const { response } = responseFixture
      const result: NetworkResponse = {
        url: response.url,
        status: response.status,
        headers: response.headers,
        bytes: Buffer.from(response.base64, 'base64'),
        redirected: response.url !== plan.url,
      }
      return result
    },
  }
  const request = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  const rules = new SourceRuleHost({ request: (item, signal, currentSource) => request.requestFromBridge(item, signal, currentSource) })
  request.attachRuleHost(rules)
  const ports: WorkflowPorts = {
    network,
    rules,
    request: (item) => request.request(item),
    decodeResponse: (item) => request.decodeResponse(item),
  }

  const faults = (input.faults ?? {}) as { staleIndexes?: number[]; cancelAfterIndex?: number }
  const staleIndexes = new Set(faults.staleIndexes ?? [])
  const controller = new AbortController()
  const writes: Array<{ index: number; content: string; accepted: boolean }> = []
  const result = await loadChapterContentBatch(ports, {
    source,
    book,
    chapters,
    signal: controller.signal,
    cacheContent: async (chapter, content) => {
      const accepted = !staleIndexes.has(chapter.index)
      writes.push({ index: chapter.index, content, accepted })
      if (accepted && chapter.index === faults.cancelAfterIndex) controller.abort(new Error('fixture cancellation'))
      return accepted
    },
  })
  if (fixtureFault !== undefined) throw fixtureFault
  const batchDiagnostic = result.diagnostics.find(({ field }) => field === 'contentBatch' || field === 'getContentBatch')
  const batchOutcome = result.status === 'cancelled' || batchDiagnostic?.code === 'cancelled'
    ? 'cancelled'
    : batchDiagnostic?.message?.includes('缺少 getContentBatch') ? 'missing-function'
      : batchDiagnostic ? 'failed' : 'success'
  return {
    status: result.status,
    batchCount: result.value?.batchCount ?? 0,
    batchOutcome,
    items: result.value?.items.map(({ chapter, content, saved, via }) => ({
      index: chapter.index,
      ...(content === undefined ? {} : { content }),
      saved,
      via,
    })) ?? [],
    requests,
    writes,
  }
}
