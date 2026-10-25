import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { SOURCE_CONCURRENCY, GLOBAL_SOURCE_CONCURRENCY, SEARCH_BATCH_SIZE } from '../server/runtime/source-execution.ts'
import { createReaderRuntime } from '../server/runtime/reader-runtime.ts'
import { importBatch, sourceDefinition } from './fixtures/import-history.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'fixture-search-runtime-key-at-least-32-characters'

test('search batches enforce link priority, account capacity, stale snapshots and bounded continuation', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const groupSize = SEARCH_BATCH_SIZE + 2
  for (const group of ['a', 'b']) await importBatch(repository, user, Array.from({ length: groupSize }, (_, index) => ({ ...sourceDefinition(`https://8.8.${group === 'a' ? 8 : 4}.${index + 1}/source`), searchUrl: `/search-${group}-${index}`, ruleSearch: { bookList: 'article', name: 'h2@text', bookUrl: 'a@href' } })), `https://8.8.8.8/${group}`)
  const links = await repository.listImportLinks(user)
  await repository.orderImportLinks(user, links.links.map((row) => row.id).reverse(), links.revision)
  const sources = await repository.listSourcesForUser(user)
  let active = 0; let peak = 0; const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    active++; peak = Math.max(peak, active); paths.push(new URL(String(url)).pathname)
    await new Promise((resolve) => setTimeout(resolve, 5)); active--
    return new Response('<article><h2>目标书</h2><a href="/book">详情</a></article>')
  })
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((row) => row.sourceId), sourceSnapshots: sources.map((row) => ({ sourceId: row.sourceId, sourceFingerprint: row.fingerprint, sourceRevision: row.sourceRevision!, ...(row.importLinkId ? { importLinkId: row.importLinkId } : {}) })) })
  const runtime = createReaderRuntime(repository)
  let result = await runtime.runSearchBatch(user, run.id)
  assert.equal(paths.length, SEARCH_BATCH_SIZE); assert.equal(result.hasPending, true)
  assert.ok(paths.every((path) => path.includes('-b-')))
  result = await runtime.runSearchBatch(user, run.id)
  assert.equal(paths.length, groupSize); assert.equal(result.hasPending, true)
  assert.ok(paths.every((path) => path.includes('-b-')))
  while (result.hasPending) result = await runtime.runSearchBatch(user, run.id)
  assert.equal(paths.length, groupSize * 2); assert.equal(result.search.status, 'success'); assert.equal(peak, SOURCE_CONCURRENCY)
  const frozen = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: [sources[0]!.sourceId], sourceSnapshots: [{ sourceId: sources[0]!.sourceId, sourceFingerprint: sources[0]!.fingerprint, sourceRevision: sources[0]!.sourceRevision! }] })
  await repository.applySourceActions(user, 'disable', [{ sourceId: sources[0]!.sourceId, expectedSourceRevision: sources[0]!.sourceRevision! }])
  await runtime.runSearchBatch(user, frozen.id)
  assert.equal(paths.length, groupSize * 2)
})

test('global and account execution slots are shared by concurrent operations and release by token', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID(); const other = randomUUID()
  const leases = await Promise.all(Array.from({ length: SOURCE_CONCURRENCY + 1 }, () => repository.acquireExecutionSlot(user, randomUUID())))
  assert.equal(leases.filter(Boolean).length, SOURCE_CONCURRENCY)
  assert.equal(await repository.acquireExecutionSlot(other, randomUUID()), null)
  const released = leases.find((lease) => lease !== null)!
  await repository.releaseExecutionSlot(user, released)
  const replacement = await repository.acquireExecutionSlot(other, randomUUID())
  assert.ok(replacement)
  await repository.releaseExecutionSlot(user, released)
  assert.equal(await repository.acquireExecutionSlot(randomUUID(), randomUUID()), null)
  assert.equal(leases.filter(Boolean).length, GLOBAL_SOURCE_CONCURRENCY)
  for (const lease of leases) if (lease) await repository.releaseExecutionSlot(user, lease)
  await repository.releaseExecutionSlot(other, replacement)
})

test('empty, failing and timed-out sources settle independently and cancellation releases slots', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  await importBatch(repository, user, [0, 1, 2].map((index) => ({ ...sourceDefinition(`https://8.8.4.${index + 1}/source`), searchUrl: '/search', ruleSearch: { bookList: 'article', name: 'h2@text', bookUrl: 'a@href' } })))
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    const host = new URL(String(url)).hostname
    if (host.endsWith('.1')) return new Response('没有书籍')
    if (host.endsWith('.2')) throw new Error('fixture source failure')
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason)
      else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  })
  const sources = await repository.listSourcesForUser(user)
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((source) => source.sourceId) })
  const started = Date.now()
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)
  assert.equal(result.search.status, 'partial')
  assert.equal(result.candidates.length, 0)
  assert.ok(result.sourceResults.some((state) => state.status === 'empty'))
  assert.ok(result.sourceResults.some((state) => state.diagnostics.some((value) => JSON.stringify(value).includes('超时') || JSON.stringify(value).includes('timeout') || JSON.stringify(value).includes('budget'))))
  assert.ok(Date.now() - started < 7000)
  const available = await Promise.all(Array.from({ length: SOURCE_CONCURRENCY }, () => repository.acquireExecutionSlot(user, randomUUID())))
  assert.equal(available.filter(Boolean).length, SOURCE_CONCURRENCY)
  for (const lease of available) if (lease) await repository.releaseExecutionSlot(user, lease)
})

test('stream progress reports active source names before requests finish and clears them on completion', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  await importBatch(repository, user, [{ ...sourceDefinition('https://8.8.4.1/source'), bookSourceName: '实时测试书源', searchUrl: '/search', ruleSearch: { bookList: 'article', name: 'h2@text', bookUrl: 'a@href' } }])
  let started = false
  t.mock.method(globalThis, 'fetch', async () => {
    assert.equal(started, true, 'source name must be emitted before fetching')
    return new Response('<article><h2>目标书</h2><a href="/book">详情</a></article>')
  })
  const sources = await repository.listSourcesForUser(user)
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((source) => source.sourceId) })
  const completed: number[] = []
  const result = await createReaderRuntime(repository).runSearchBatchStream(user, run.id, (_source, search) => {
    completed.push(search.progress.completed)
    assert.deepEqual(search.progress.activeSources, [])
  }, { onProgress: (progress) => {
    started = true
    completed.push(progress.completed)
    assert.deepEqual(progress.activeSources, ['实时测试书源'])
  } })
  assert.equal(result.search.status, 'success')
  assert.deepEqual(completed, [0, 1])
  assert.deepEqual(result.progress.activeSources, [])
})
