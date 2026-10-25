import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryReaderRepository, PostgresReaderRepository } from '../../server/db/repository.ts'
import { SOURCE_CONCURRENCY } from '../../server/runtime/source-execution.ts'
import { createReaderRuntime } from '../../server/runtime/reader-runtime.ts'
import { importBatch, sourceDefinition } from '../fixtures/import-history.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'scale-runtime-key-at-least-32-characters'

test('2,000 sources and 40,000 candidates use finite workers and resumable batches', { timeout: 300_000 }, async (t) => {
  const baseline = process.memoryUsage().rss
  const databaseUrl = process.env.READER_WEB_SCALE_DATABASE_URL
  if (databaseUrl) { process.env.DATABASE_URL = databaseUrl; const { closeReaderDb } = await import('../../server/db/client.ts'); t.after(closeReaderDb) }
  const repository = databaseUrl ? new PostgresReaderRepository() : new MemoryReaderRepository(); const user = randomUUID()
  for (let group = 0; group < 3; group++) {
    const offset = group * 700; const length = Math.min(700, 2000 - offset)
    await importBatch(repository, user, Array.from({ length }, (_, i) => {
      const index = offset + i
      return { ...sourceDefinition(`https://8.9.${Math.floor(index / 250)}.${index % 250 + 1}/source`), searchUrl: '/search', ruleSearch: { bookList: 'article', name: 'h2@text', author: '.author@text', bookUrl: 'a@href' } }
    }), `https://8.8.8.8/group-${group}`)
  }
  process.stderr.write('scale-imported rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + '\n')
  const sources = await repository.listSourcesForUser(user)
  assert.equal(sources.length, 2000)
  let active = 0; let peak = 0; let calls = 0; let peakRss = baseline
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch })
  // 压测不使用记录所有请求/响应的 spy，避免测到测试框架本身的保留内存。
  globalThis.fetch = async () => {
    active++; peak = Math.max(peak, active); calls++
    await new Promise((resolve) => setImmediate(resolve))
    active--
    return new Response(Array.from({ length: 20 }, (_, i) => `<article><h2>目标书${i}</h2><span class="author">作者${i}</span><a href="/book-${i}">详情</a></article>`).join(''))
  }
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((source) => source.sourceId), sourceSnapshots: sources.map((source) => ({ sourceId: source.sourceId, sourceFingerprint: source.fingerprint, sourceRevision: source.sourceRevision!, importLinkId: source.importLinkId!, priority: source.priority! })) })
  const runtime = createReaderRuntime(repository)
  let firstResultMs = 0; let maxBatchMs = 0; let batches = 0; let eventBytes = 0
  const started = Date.now()
  let result
  do {
    const batchStart = Date.now()
    result = await runtime.runSearchBatchStream(user, run.id, (source) => {
      firstResultMs ||= Date.now() - started
      eventBytes = Math.max(eventBytes, Buffer.byteLength(JSON.stringify(source)))
    })
    batches++; if (batches % 50 === 0) process.stderr.write('scale batches=' + batches + ' calls=' + calls + ' rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + '\n'); maxBatchMs = Math.max(maxBatchMs, Date.now() - batchStart); peakRss = Math.max(peakRss, process.memoryUsage().rss)
  } while (result.hasPending)
  assert.equal(calls, 2000); assert.equal(result.candidates.length, 40000)
  assert.ok(peak <= SOURCE_CONCURRENCY); assert.ok(maxBatchMs < 30000); assert.ok(firstResultMs < 2000)
  t.diagnostic(JSON.stringify({ finalMemory: process.memoryUsage(), serializedBytes: Buffer.byteLength(JSON.stringify(result.search)), baseline }))
  assert.ok(peakRss - baseline <= 256 * 1024 * 1024, `RSS 增长 ${(peakRss - baseline) / 1024 / 1024} MiB`)
  assert.ok(eventBytes < 100000, 'source-result 不包含完整搜索')
  t.diagnostic(JSON.stringify({ sources: calls, candidates: result.candidates.length, peakConcurrency: peak, batches, firstResultMs, maxBatchMs, elapsedMs: Date.now() - started, maxSourceEventBytes: eventBytes, rssGrowthMiB: Math.round((peakRss - baseline) / 1024 / 1024) }))
})
