import assert from 'node:assert/strict'
import test from 'node:test'
import { createSearchStreamRequest, mergeSearchStreamCandidates, SseDecoder, type ApiCandidate } from '../src/lib/api.ts'

test('SSE decoder handles split UTF-8 bytes and event boundaries', () => {
  const source = new TextEncoder().encode('event: source-result\ndata: {"title":"中文"}\n\nevent: done\ndata: {"ok":true}\n\n')
  const decoder = new SseDecoder()
  const events = []
  for (let index = 0; index < source.length; index += 2) events.push(...decoder.push(source.slice(index, index + 2)))
  events.push(...decoder.finish())
  assert.deepEqual(events, [{ type: 'source-result', data: { title: '中文' } }, { type: 'done', data: { ok: true } }])
})

test('search stream requests carry cancellation to initial and next-page fetches', () => {
  const controller = new AbortController()
  const initial = createSearchStreamRequest('search id', { access_token: 'token' }, controller.signal)
  assert.equal(initial.path, '/api/searches/search%20id/stream')
  assert.equal(initial.init.signal, controller.signal)
  assert.equal(new Headers(initial.init.headers).get('authorization'), 'Bearer token')

  const nextPage = createSearchStreamRequest('search id', { access_token: 'token' }, controller.signal, { nextPage: true })
  assert.equal(nextPage.path, '/api/searches/search%20id/batches')
  assert.equal(nextPage.init.method, 'POST')
  assert.equal(nextPage.init.signal, controller.signal)
  assert.equal(nextPage.init.body, JSON.stringify({ nextPage: true }))
})

test('search stream candidates follow the server snapshot order across out-of-order sources and pages', () => {
  const candidate = (sourceId: string, bookUrl: string): ApiCandidate => ({ sourceId, sourceFingerprint: `${sourceId}-fingerprint`, candidate: { sourceId, bookUrl, name: sourceId } })
  const sourceB = candidate('source-b', 'https://books.example.test/b')
  const sourceA = candidate('source-a', 'https://books.example.test/a')
  const afterFastSource = mergeSearchStreamCandidates([], { source: { candidates: [sourceB] }, search: { candidates: [sourceB] } })
  assert.deepEqual(afterFastSource, [sourceB])
  const afterSlowSource = mergeSearchStreamCandidates(afterFastSource, { source: { candidates: [sourceA] }, search: { candidates: [sourceA, sourceB] } })
  assert.deepEqual(afterSlowSource, [sourceA, sourceB])
  const afterNextPage = mergeSearchStreamCandidates(afterSlowSource, { source: { candidates: [candidate('source-a', 'https://books.example.test/a-2')] }, search: { candidates: [sourceA, candidate('source-a', 'https://books.example.test/a-2'), sourceB] } })
  assert.deepEqual(afterNextPage.map((item) => item.candidate.bookUrl), ['https://books.example.test/a', 'https://books.example.test/a-2', 'https://books.example.test/b'])
})

test('incremental results keep frozen source priority despite concurrent completion order', () => {
  const candidate = (sourceId: string, sourceOrder: number): ApiCandidate => ({ sourceId, sourceOrder, sourceFingerprint: 'fp', candidate: { sourceId, bookUrl: '/' + sourceId, name: '目标书', author: '作者' } })
  const latePriority = candidate('slow-priority', 0); const fastLater = candidate('fast-later', 1)
  const ordering = { keyword: '目标书', precision: false }
  const first = mergeSearchStreamCandidates([], { source: { candidates: [fastLater] } }, ordering)
  const final = mergeSearchStreamCandidates(first, { source: { candidates: [latePriority] } }, ordering)
  assert.deepEqual(final.map((item) => item.sourceId), ['slow-priority', 'fast-later'])
  assert.equal(mergeSearchStreamCandidates(final, { source: { candidates: [latePriority] } }, ordering).length, 2)
})

test('search finishes after pending sources settle even when a source offers more pages and SSE stays open', { timeout: 2000 }, async () => {
  const { readFileSync } = await import('node:fs')
  const { runInNewContext } = await import('node:vm')
  const { default: ts } = await import('typescript')
  const module = { exports: {} as { streamSearchAll: (id: string, listener: (event: { type: string }) => void) => Promise<void> } }
  const code = ts.transpileModule(readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  let requests = 0
  let closed = 0
  runInNewContext(code, {
    module, exports: module.exports, Headers, TextDecoder, setTimeout, clearTimeout,
    require: (name: string) => name === './auth.ts' ? { currentSession: async () => null } : {},
    fetch: async () => {
      requests++
      assert.ok(requests <= 2, 'must not follow next-page cursors after all sources finish')
      const data = { hasPending: requests === 1, search: { sourceStates: [{ sourceId: 'source', nextCursor: { index: requests } }] } }
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`event: batch-end\ndata: ${JSON.stringify(data)}\n\nevent: done\ndata: {}\n\n`)) },
        cancel() { closed++ },
      }))
    },
  })
  const events: string[] = []
  await module.exports.streamSearchAll('search', (event) => events.push(event.type))
  assert.equal(requests, 2)
  assert.equal(closed, 2)
  assert.deepEqual(events, ['batch-end', 'batch-end', 'done'])
})

test('搜索流只为命中来源发送一次精简摘要，不查询全量书源', async () => {
  const { readFileSync } = await import('node:fs')
  const { runInNewContext } = await import('node:vm')
  const { default: ts } = await import('typescript')
  const { readingSourceSummary } = await import('../shared/source-management.ts')
  const source = readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source.slice(source.indexOf('function streamSearchResponse(')), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const events: Array<{ event: string; data: string }> = []
  let queries = 0
  const summary = { sourceId: 'https://source.test', name: '命中源', enabled: true, customOrder: 0, sourceRevision: 'r1', fingerprint: 'fp', origin: 'account' as const, importDisplayUrl: 'https://private.test/list?token=secret' }
  const streamSearchResponse = runInNewContext(code + '\nstreamSearchResponse', {
    AbortController, setInterval, clearInterval, readingSourceSummary,
    errorResponse(error: unknown) { throw error },
    streamSSE: (_context: unknown, callback: (stream: unknown) => Promise<void>) => callback({ onAbort() {}, writeSSE: async (event: { event: string; data: string }) => { events.push(event) } }),
    dependencies: {
      repository: { async listManagedSources() { queries++; throw new Error('流式传输不得额外查询书源') } },
      runtime: { async runSearchBatchStream(_user: string, _id: string, listener: (source: unknown, search: unknown, summary?: unknown) => Promise<void>) {
        const progress = { completed: 1, total: 2 }
        await listener({ sourceId: 'empty', candidates: [] }, { progress })
        await listener({ sourceId: summary.sourceId, candidates: [{ candidate: {} }] }, { progress }, readingSourceSummary(summary))
        await listener({ sourceId: summary.sourceId, candidates: [{ candidate: {} }] }, { progress }, readingSourceSummary(summary))
        return { sourceResults: [], search: {}, progress }
      } },
    },
  })
  await streamSearchResponse({}, 'owner', 'search', {})
  assert.equal(queries, 0)
  const batches = events.filter((event) => event.event === 'source-result').map((event) => JSON.parse(event.data))
  assert.equal(batches.length, 3)
  assert.equal(batches.filter((event) => event.sourceSummary !== undefined).length, 1)
  assert.equal(batches[1].sourceSummary.name, '命中源')
  assert.equal('importDisplayUrl' in batches[1].sourceSummary, false)
  assert.equal('fingerprint' in batches[1].sourceSummary, false)
  assert.equal(events.some((event) => event.event === 'error'), false)
})
