import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { SOURCE_CONCURRENCY, GLOBAL_SOURCE_CONCURRENCY, SEARCH_BATCH_MS, SOURCE_EXECUTION_MS } from '../server/runtime/source-execution.ts'
import { createReaderRuntime } from '../server/runtime/reader-runtime.ts'
import { DEFAULT_SEARCH_CONCURRENCY } from '../shared/search-settings.ts'
import { importBatch, sourceDefinition } from './fixtures/import-history.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'fixture-search-runtime-key-at-least-32-characters'

test('search workers follow link priority, refill across groups and skip stale snapshots', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const groupSize = SOURCE_CONCURRENCY + 2
  await repository.saveSettings(user, { general: { searchConcurrency: SOURCE_CONCURRENCY } })
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
  const result = await runtime.runSearchBatch(user, run.id)
  assert.equal(result.hasPending, false)
  assert.ok(paths.slice(0, SOURCE_CONCURRENCY).every((path) => path.includes('-b-')))
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
  const otherLeases = await Promise.all(Array.from({ length: GLOBAL_SOURCE_CONCURRENCY - SOURCE_CONCURRENCY }, () => repository.acquireExecutionSlot(other, randomUUID())))
  assert.equal(otherLeases.filter(Boolean).length, GLOBAL_SOURCE_CONCURRENCY - SOURCE_CONCURRENCY)
  assert.equal(await repository.acquireExecutionSlot(other, randomUUID()), null)
  const released = leases.find((lease) => lease !== null)!
  await repository.releaseExecutionSlot(user, released)
  const replacement = await repository.acquireExecutionSlot(user, randomUUID())
  assert.ok(replacement)
  await repository.releaseExecutionSlot(user, released)
  assert.equal(await repository.acquireExecutionSlot(randomUUID(), randomUUID()), null)
  assert.equal(leases.filter(Boolean).length + otherLeases.filter(Boolean).length, GLOBAL_SOURCE_CONCURRENCY)
  for (const lease of leases) if (lease) await repository.releaseExecutionSlot(user, lease)
  for (const lease of otherLeases) if (lease) await repository.releaseExecutionSlot(other, lease)
  await repository.releaseExecutionSlot(user, replacement)
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

test('default workers refill one second after completion without waiting for slow sources, and cancellation stops refill', { timeout: 8000 }, async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const runtime = createReaderRuntime(repository)
  await importBatch(repository, user, Array.from({ length: DEFAULT_SEARCH_CONCURRENCY + 2 }, (_, index) => ({ ...sourceDefinition(`https://8.8.4.${index + 1}/source`), searchUrl: '/search', ruleSearch: { bookList: 'article', name: 'h2@text', bookUrl: 'a@href' } })))
  const sources = await repository.listSourcesForUser(user)
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((source) => source.sourceId) })
  let firstWaveReady!: () => void; let refillReady!: () => void; let refillFinished!: () => void
  const firstWave = new Promise<void>((resolve) => { firstWaveReady = resolve })
  const refill = new Promise<void>((resolve) => { refillReady = resolve })
  const finished = new Promise<void>((resolve) => { refillFinished = resolve })
  const requests: Array<{ resolve: () => void; started: number }> = []
  t.mock.method(globalThis, 'fetch', async (_url: URL | string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ resolve: () => resolve(new Response('<article><h2>目标书</h2><a href="/book">详情</a></article>')), started: performance.now() })
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    if (requests.length === DEFAULT_SEARCH_CONCURRENCY) firstWaveReady()
    if (requests.length === DEFAULT_SEARCH_CONCURRENCY + 1) refillReady()
  }))
  const task = runtime.runSearchBatchStream(user, run.id, (source) => {
    if (source.sourceId === sources[DEFAULT_SEARCH_CONCURRENCY]?.sourceId) refillFinished()
  })
  t.after(async () => { await runtime.cancelSearch(user, run.id); await task })
  await firstWave
  const completedAt = performance.now()
  requests[0]!.resolve()
  await refill
  assert.equal(requests.length, DEFAULT_SEARCH_CONCURRENCY + 1)
  assert.ok(requests[DEFAULT_SEARCH_CONCURRENCY]!.started - completedAt >= 990, 'refill must wait one second')
  assert.equal((await repository.getSearch(user, run.id))?.progress.completed, 1, 'other slow sources are still running')
  requests[DEFAULT_SEARCH_CONCURRENCY]!.resolve()
  await finished
  const cancelledAt = performance.now()
  await runtime.cancelSearch(user, run.id)
  const result = await task
  assert.equal(result.search.cancelled, true)
  assert.equal(requests.length, DEFAULT_SEARCH_CONCURRENCY + 1, 'no source may start during cancelled cooldown')
  assert.ok(performance.now() - cancelledAt < 800, 'cancellation must interrupt the one-second wait')
})

test('search workers obey the minimum configured concurrency', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  await repository.saveSettings(user, { general: { searchConcurrency: 5 } })
  await importBatch(repository, user, Array.from({ length: 6 }, (_, index) => ({ ...sourceDefinition(`https://8.8.4.${index + 1}/source`), searchUrl: '/search' })))
  let active = 0; let peak = 0
  t.mock.method(globalThis, 'fetch', async () => {
    active++; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5)); active--
    return new Response('没有结果')
  })
  const sources = await repository.listSourcesForUser(user)
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((source) => source.sourceId) })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)
  assert.equal(peak, 5)
  assert.equal(result.progress.completed, 6)
})

test('request time budget preserves pending sources for the next stream instead of exceeding the deadline', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  await repository.saveSettings(user, { general: { searchConcurrency: SOURCE_CONCURRENCY } })
  await importBatch(repository, user, Array.from({ length: 22 }, (_, index) => ({ ...sourceDefinition(`https://8.8.4.${index + 1}/source`), searchUrl: '/search' })))
  let now = Date.now(); let calls = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) now += SEARCH_BATCH_MS - SOURCE_EXECUTION_MS
    return new Response('没有结果')
  })
  const sources = await repository.listSourcesForUser(user)
  const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: sources.map((source) => source.sourceId) })
  const runtime = createReaderRuntime(repository)
  const first = await runtime.runSearchBatch(user, run.id)
  assert.equal(first.hasPending, true)
  assert.equal(first.progress.completed, SOURCE_CONCURRENCY)
  const final = await runtime.runSearchBatch(user, run.id)
  assert.equal(final.hasPending, false)
  assert.equal(final.progress.completed, 22)
  assert.equal(calls, 22)
})

for (const scenario of ['success', 'checkpoint-failure', 'final-failure', 'cancelled', 'replaced'] as const) {
  test(`search cleanup skips only confirmed final release: ${scenario}`, async (t) => {
    const repository = new MemoryReaderRepository(); const user = randomUUID()
    await importBatch(repository, user, [{ ...sourceDefinition('https://8.8.4.1/source'), searchUrl: '/search' }])
    t.mock.method(globalThis, 'fetch', async () => new Response('没有结果'))
    const sources = await repository.listSourcesForUser(user)
    const run = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: [sources[0]!.sourceId] })
    const update = repository.updateSearch.bind(repository)
    const patches: Parameters<typeof update>[2][] = []
    let injected = false
    t.mock.method(repository, 'updateSearch', async (userId: string, searchId: string, patch: Parameters<typeof update>[2]) => {
      patches.push(patch)
      const checkpoint = patch.status === 'running' && patch.candidates !== undefined
      const final = patch.status !== undefined && patch.operationId === null
      if (!injected && ((scenario === 'checkpoint-failure' && checkpoint) || (scenario === 'final-failure' && final))) {
        injected = true; throw new Error('fixture write failed')
      }
      if (!injected && checkpoint && (scenario === 'cancelled' || scenario === 'replaced')) {
        injected = true
        await update(userId, searchId, scenario === 'cancelled' ? { status: 'cancelled', operationId: null, cancelled: true } : { operationId: 'replacement' })
        return null
      }
      return update(userId, searchId, patch)
    })
    const runtime = createReaderRuntime(repository)
    if (scenario === 'checkpoint-failure' || scenario === 'final-failure') await assert.rejects(runtime.runSearchBatch(user, run.id), /fixture write failed/u)
    else if (scenario === 'replaced') await assert.rejects(runtime.runSearchBatch(user, run.id), /失效/u)
    else assert.equal((await runtime.runSearchBatch(user, run.id)).search.status, scenario === 'cancelled' ? 'cancelled' : 'empty')
    const cleanups = patches.filter((patch) => patch.operationId === null && patch.status === undefined)
    assert.equal(cleanups.length, scenario === 'success' ? 0 : 1)
    const saved = await repository.getSearch(user, run.id)
    assert.equal(saved?.operationId, scenario === 'replaced' ? 'replacement' : undefined)
    if (scenario === 'checkpoint-failure' || scenario === 'final-failure') {
      assert.equal((await runtime.runSearchBatch(user, run.id)).search.status, 'empty', 'failed operation must release its local active marker')
    }
    const leases = await Promise.all(Array.from({ length: SOURCE_CONCURRENCY }, () => repository.acquireExecutionSlot(user, randomUUID())))
    try { assert.equal(leases.filter(Boolean).length, SOURCE_CONCURRENCY) }
    finally { for (const lease of leases) if (lease) await repository.releaseExecutionSlot(user, lease) }
  })
}
