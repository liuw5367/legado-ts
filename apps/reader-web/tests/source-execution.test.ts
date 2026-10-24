import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { createReaderRuntime } from '../server/runtime/reader-runtime.ts'
import { importBatch, sourceDefinition } from './fixtures/import-history.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'fixture-search-runtime-key-at-least-32-characters'

test('search batches enforce link priority, account capacity, stale snapshots and bounded continuation', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  for (const group of ['a', 'b']) await importBatch(repository, user, Array.from({ length: 10 }, (_, index) => ({ ...sourceDefinition(`https://8.8.${group === 'a' ? 8 : 4}.${index + 1}/source`), searchUrl: `/search-${group}-${index}`, ruleSearch: { bookList: 'article', name: 'h2@text', bookUrl: 'a@href' } })), `https://8.8.8.8/${group}`)
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
  assert.equal(paths.length, 8); assert.equal(result.hasPending, true)
  assert.ok(paths.every((path) => path.includes('-b-')))
  result = await runtime.runSearchBatch(user, run.id)
  assert.equal(paths.length, 10); assert.equal(result.hasPending, true)
  assert.ok(paths.every((path) => path.includes('-b-')))
  while (result.hasPending) result = await runtime.runSearchBatch(user, run.id)
  assert.equal(paths.length, 20); assert.equal(result.search.status, 'success'); assert.ok(peak <= 4)
  const frozen = await repository.createSearch(user, { keyword: '目标书', sourceId: sources[0]!.sourceId, sourceIds: [sources[0]!.sourceId], sourceSnapshots: [{ sourceId: sources[0]!.sourceId, sourceFingerprint: sources[0]!.fingerprint, sourceRevision: sources[0]!.sourceRevision! }] })
  await repository.applySourceActions(user, 'disable', [{ sourceId: sources[0]!.sourceId, expectedSourceRevision: sources[0]!.sourceRevision! }])
  await runtime.runSearchBatch(user, frozen.id)
  assert.equal(paths.length, 20)
})

test('global and account execution slots are shared by concurrent operations and release by token', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID(); const other = randomUUID()
  const leases = await Promise.all(Array.from({ length: 8 }, () => repository.acquireExecutionSlot(user, randomUUID())))
  assert.equal(leases.filter(Boolean).length, 4)
  const others = await Promise.all(Array.from({ length: 8 }, () => repository.acquireExecutionSlot(other, randomUUID())))
  assert.equal(others.filter(Boolean).length, 4)
  assert.equal(await repository.acquireExecutionSlot(randomUUID(), randomUUID()), null)
  for (const lease of leases) if (lease) await repository.releaseExecutionSlot(user, lease)
  for (const lease of others) if (lease) await repository.releaseExecutionSlot(other, lease)
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
  const available = await Promise.all(Array.from({ length: 4 }, () => repository.acquireExecutionSlot(user, randomUUID())))
  assert.equal(available.filter(Boolean).length, 4)
  for (const lease of available) if (lease) await repository.releaseExecutionSlot(user, lease)
})
