import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { importSources, loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '../../source-core/src/index.ts'
import type { BookMetadata, Chapter, NetworkHost, NetworkResponse, NormalizedSource, RuntimeResult, WorkflowPorts } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const conformanceRoot = new URL('../../../fixtures/conformance/', import.meta.url)

interface ConformanceFixture {
  id: string
  capability: string
  source: string
  input: string
  expected: string
  sensitive: string
  android: string
  typescript: string
  case: string
}

interface ConformanceManifest {
  version: number
  schema: string
  fixtures: ConformanceFixture[]
}

interface FixtureResponse {
  contentType?: string
  status?: number
  body?: string
  finalUrl?: string
  redirected?: boolean
  error?: string
}

interface CaseExpected {
  status: string
  search?: Record<string, unknown>
  details?: Record<string, unknown>
  toc?: Array<Record<string, unknown>>
  content: Record<string, unknown>
  diagnostics?: string[]
  requests: string[]
}

interface CasePorts {
  ports: WorkflowPorts
  requests: string[]
  activeRequests: () => number
}

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, conformanceRoot), 'utf8')) as T
}

function bookFromInput(value: unknown): BookMetadata {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as BookMetadata
}

function chapterFromInput(value: unknown): Chapter {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Chapter
}

function responseFor(planUrl: string, response: FixtureResponse): NetworkResponse {
  return {
    url: response.finalUrl ?? planUrl,
    status: response.status ?? 200,
    headers: { 'content-type': response.contentType ?? 'text/plain; charset=utf-8' },
    bytes: new TextEncoder().encode(response.body ?? ''),
    redirected: response.redirected ?? false,
  }
}

function createPorts(responses: Record<string, FixtureResponse>): CasePorts {
  const requests: string[] = []
  let active = 0
  const network: NetworkHost = {
    request: async (plan) => {
      active += 1
      try {
        const requestUrl = new URL(plan.url)
        const exactKey = `${requestUrl.pathname}${requestUrl.search}`
        const fixture = responses[exactKey] ?? responses[requestUrl.pathname]
        requests.push(exactKey)
        if (fixture === undefined) throw new Error(`fixture response missing: ${exactKey}`)
        if (fixture.error !== undefined) throw new Error(fixture.error)
        return responseFor(plan.url, fixture)
      } finally {
        active -= 1
      }
    },
  }
  let requestHost: SourceRequestHost
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => requestHost.requestFromBridge(input, signal, requestSource) })
  requestHost = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  requestHost.attachRuleHost(ruleHost)
  return {
    ports: {
      network,
      rules: ruleHost,
      request: (input) => requestHost.request(input),
      decodeResponse: (input) => requestHost.decodeResponse(input),
    },
    requests,
    activeRequests: () => active,
  }
}

function assertWorkflowResult<T>(result: RuntimeResult<T>, expectedStatus: string, label: string): void {
  assert.equal(result.status, expectedStatus, `${label}: ${JSON.stringify(result.diagnostics)}`)
  assert.ok(result.trace.length > 0, `${label} must expose a non-empty trace`)
}

async function loadCase(fixture: ConformanceFixture): Promise<{ source: NormalizedSource; input: Record<string, unknown>; expected: CaseExpected; responses: Record<string, FixtureResponse> }> {
  assert.equal(fixture.typescript, 'source-cross-runtime.test.ts')
  assert.equal(fixture.android, 'not-run')
  assert.equal(fixture.sensitive, 'none')
  assert.equal(fixture.case, `cases/${fixture.id}`)
  const [sourceDefinition, input, expected, responses] = await Promise.all([
    readJson<Record<string, unknown>>(`${fixture.case}/source.json`),
    readJson<Record<string, unknown>>(`${fixture.case}/input.json`),
    readJson<CaseExpected>(`${fixture.case}/expected.json`),
    readJson<Record<string, FixtureResponse>>(`${fixture.case}/responses.json`),
  ])
  const imported = await importSources(JSON.stringify(sourceDefinition))
  assert.equal(imported.length, 1, fixture.id)
  assert.equal(imported[0]?.status, 'ready', fixture.id)
  assert.ok(imported[0]?.source, fixture.id)
  return { source: imported[0]!.source!, input, expected, responses }
}

async function executeCase(fixture: ConformanceFixture): Promise<void> {
  const { source, input, expected, responses } = await loadCase(fixture)
  const { ports, requests, activeRequests } = createPorts(responses)

  if (fixture.id === 'HTML-FLOW-001' || fixture.id === 'JSON-FLOW-001') {
    const keyword = String(input.keyword)
    const search = await searchBooks(ports, { source, keyword })
    assertWorkflowResult(search, expected.status, `${fixture.id}/search`)
    const candidate = search.value?.items[0]
    assert.ok(candidate)
    assert.deepEqual({ name: candidate.name, author: candidate.author, bookUrl: candidate.bookUrl }, expected.search)

    const details = await loadBookDetails(ports, { source, candidates: [candidate] })
    assertWorkflowResult(details, expected.status, `${fixture.id}/details`)
    const book = details.value?.items[0]
    assert.ok(book)
    assert.deepEqual({ name: book.name, author: book.author, tocUrl: book.tocUrl }, expected.details)

    const toc = await loadTableOfContents(ports, { source, book })
    assertWorkflowResult(toc, expected.status, `${fixture.id}/toc`)
    assert.deepEqual(toc.value?.items.map((item) => ({ title: item.title, chapterUrl: item.chapterUrl, ...(item.isVip === true ? { isVip: true } : fixture.id === 'JSON-FLOW-001' ? { isVip: false } : {}) })), expected.toc)
    const chapter = toc.value?.items[0]
    assert.ok(chapter)

    const content = await loadChapterContent(ports, { source, book, chapter, maxPages: 3 })
    assertWorkflowResult(content, expected.status, `${fixture.id}/content`)
    if (fixture.id === 'HTML-FLOW-001') {
      assert.deepEqual({ contentType: content.value?.contentType, cleaned: content.value?.cleaned }, expected.content)
    } else {
      assert.deepEqual({ contentType: content.value?.contentType, pages: content.value?.pages }, expected.content)
    }
  } else if (fixture.id === 'XPATH-CONTENT-001') {
    const content = await loadChapterContent(ports, { source, chapter: chapterFromInput(input.chapter) })
    assertWorkflowResult(content, expected.status, fixture.id)
    assert.deepEqual({ contentType: content.value?.contentType, cleaned: content.value?.cleaned, pages: content.value?.pages }, expected.content)
  } else if (fixture.id === 'JS-TOC-001') {
    const book = bookFromInput(input.book)
    const toc = await loadTableOfContents(ports, { source, book })
    assertWorkflowResult(toc, expected.status, `${fixture.id}/toc`)
    assert.deepEqual(toc.value?.items.map((item) => ({ title: item.title, chapterUrl: item.chapterUrl, isVolume: item.isVolume, isVip: item.isVip, isPay: item.isPay })), expected.toc)
    const chapter = toc.value?.items[1]
    assert.ok(chapter)
    const content = await loadChapterContent(ports, { source, book, chapter, nextChapterUrl: String(input.nextChapterUrl) })
    assertWorkflowResult(content, expected.status, `${fixture.id}/content`)
    assert.deepEqual({ contentType: content.value?.contentType, cleaned: content.value?.cleaned }, expected.content)
  } else if (fixture.id === 'TOC-EDGE-001') {
    const toc = await loadTableOfContents(ports, { source, book: bookFromInput(input.book), maxPages: 3 })
    assertWorkflowResult(toc, expected.status, fixture.id)
    assert.deepEqual(toc.value?.items.map((item) => ({ title: item.title, chapterUrl: item.chapterUrl, isVolume: item.isVolume, isVip: item.isVip, isPay: item.isPay })), expected.toc)
    assert.ok(toc.diagnostics.some((item) => item.code === 'duplicate-item'))
  } else if (fixture.id === 'CONTENT-EDGE-001') {
    const content = await loadChapterContent(ports, { source, chapter: chapterFromInput(input.chapter), maxPages: Number(input.maxPages) })
    assertWorkflowResult(content, expected.status, fixture.id)
    assert.deepEqual({ contentType: content.value?.contentType, pages: content.value?.pages, cleaned: content.value?.cleaned }, expected.content)
    const expectedDiagnostic = expected.diagnostics?.[0]
    assert.ok(expectedDiagnostic)
    assert.ok(content.diagnostics.some((item) => item.message === expectedDiagnostic))
  } else {
    assert.fail(`未注册 conformance case: ${fixture.id}`)
  }

  const observedRequests = expected.requests.some((value: string) => value.includes('?')) ? requests : requests.map((value) => value.split('?')[0])
  assert.deepEqual(observedRequests, expected.requests, `${fixture.id}/requests`)
  assert.equal(activeRequests(), 0, `${fixture.id} must close all network work before returning`)
}

test('跨规则书源 fixture 使用真实 Node 规则宿主和离线响应执行', async () => {
  const manifest = await readJson<ConformanceManifest>('manifest.json')
  assert.equal(manifest.version, 2)
  assert.equal(manifest.schema, 'schema.json')
  const schema = await readJson<{ properties?: { version?: { const?: number } } }>(manifest.schema)
  assert.equal(schema.properties?.version?.const, 2)
  const fixtures = manifest.fixtures.filter((fixture) => fixture.typescript === 'source-cross-runtime.test.ts')
  assert.deepEqual(fixtures.map((fixture) => fixture.id).sort(), [
    'CONTENT-EDGE-001',
    'HTML-FLOW-001',
    'JS-TOC-001',
    'JSON-FLOW-001',
    'TOC-EDGE-001',
    'XPATH-CONTENT-001',
  ])
  for (const fixture of fixtures) await executeCase(fixture)
})
