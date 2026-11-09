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

test('reader-web search parses Android balanced inline JSONPath in a source response', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.9'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: '$.items[*]',
      name: "@JSON:书名：{$.labels['title}raw']}",
      bookUrl: '@JSON:$.url',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response(JSON.stringify({ items: [{ labels: { 'title}raw': '第一章' }, url: '/book' }] }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0]?.candidate.name, '书名：第一章')
  assert.equal(result.candidates[0]?.candidate.bookUrl, `${base}/book`)
})

test('reader-web search handles an HTML fragment with the Android XPath position rule', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.10'
  const rows = [
    '<tr><th>书名</th></tr>',
    '<tr><td><a href="/book/1">第一本</a></td></tr>',
    '<tr><td><a href="/book/2">第二本</a></td></tr>',
    '<tr><td><a href="/book/3">第三本</a></td></tr>',
  ].join('')
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: '@xpath://*[@id="bookcon"]//tr[position()>1 and position() < 12]',
      name: 'td@text',
      bookUrl: 'a@href',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response(`<div id="bookcon"><table><tbody>${rows}</tbody></table></div><aside>分页说明</aside>`)
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.deepEqual(result.candidates.map(({ candidate }) => ({ name: candidate.name, bookUrl: candidate.bookUrl })), [
    { name: '第一本', bookUrl: `${base}/book/1` },
    { name: '第二本', bookUrl: `${base}/book/2` },
    { name: '第三本', bookUrl: `${base}/book/3` },
  ])
})

test('reader-web search evaluates Android XPath substring-before-last in book rules', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.11'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: 'article',
      name: "@xpath:substring-before-last(//h2, ' - ')",
      bookUrl: 'a@href',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response('<article><h2>第一本 - 作者甲</h2><a href="/book/1">详情</a></article>')
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.deepEqual(result.candidates.map(({ candidate }) => ({ name: candidate.name, bookUrl: candidate.bookUrl })), [
    { name: '第一本', bookUrl: `${base}/book/1` },
  ])
})

test('reader-web search evaluates Android XPath substring-ex in book rules', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.12'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: 'article',
      name: '@xpath:substring-ex(//h2,0,3)',
      bookUrl: 'a@href',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response('<article><h2>第一本 - 作者甲</h2><a href="/book/1">详情</a></article>')
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.deepEqual(result.candidates.map(({ candidate }) => ({ name: candidate.name, bookUrl: candidate.bookUrl })), [
    { name: '第一本', bookUrl: `${base}/book/1` },
  ])
})

test('reader-web search evaluates Android XPath first() in the book-list rule', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.13'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: '@xpath://article[first()]',
      name: 'h2@text',
      bookUrl: 'a@href',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response('<root><article><h2>第一本</h2><a href="/book/1">详情</a></article><article><h2>第二本</h2><a href="/book/2">详情</a></article></root>')
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.deepEqual(result.candidates.map(({ candidate }) => ({ name: candidate.name, bookUrl: candidate.bookUrl })), [
    { name: '第一本', bookUrl: `${base}/book/1` },
  ])
})

test('reader-web search evaluates Android XPath format-date in book rules', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.14'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: 'article',
      name: "@xpath:format-date('2024-02-29 13:05:06 +0800','yyyy-MM-dd HH:mm:ss Z')",
      bookUrl: 'a@href',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response('<article><h2>日期书</h2><a href="/book/1">详情</a></article>')
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  const candidate = result.candidates[0]?.candidate
  assert.equal(candidate?.bookUrl, `${base}/book/1`)
  const actualDate = /^(\w{3}) (\w{3}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) (\S+) (-?[0-9]+)$/u.exec(candidate?.name ?? '')
  assert.ok(actualDate, `expected Java Date.toString() shape, got ${candidate?.name}`)
  const expectedDate = new Date(Date.UTC(2024, 1, 29, 5, 5, 6))
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  assert.deepEqual({
    weekday: actualDate[1], month: actualDate[2], day: Number(actualDate[3]),
    hour: Number(actualDate[4]), minute: Number(actualDate[5]), second: Number(actualDate[6]),
    year: Number(actualDate[8]),
  }, {
    weekday: weekdays[expectedDate.getDay()], month: months[expectedDate.getMonth()], day: expectedDate.getDate(),
    hour: expectedDate.getHours(), minute: expectedDate.getMinutes(), second: expectedDate.getSeconds(), year: expectedDate.getFullYear(),
  })
})

test('reader-web search evaluates Android XPath concat in book rules', async (t) => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.15'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    searchUrl: `${base}/search?q={{key}}`,
    ruleSearch: {
      bookList: 'article',
      name: "@xpath:concat(//h2, ' - ', //article/@data-author, 1)",
      bookUrl: 'a@href',
    },
  }])
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    assert.equal(new URL(String(url)).pathname, '/search')
    return new Response('<article data-author="作者甲"><h2>第一本</h2><a href="/book/1">详情</a></article>')
  })
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.deepEqual(result.candidates.map(({ candidate }) => ({ name: candidate.name, bookUrl: candidate.bookUrl })), [
    { name: '第一本-作者甲1.0', bookUrl: `${base}/book/1` },
  ])
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = Date.now()
  const pendingBatch = createReaderRuntime(repository).runSearchBatch(user, run.id)
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(SOURCE_EXECUTION_MS)
  const result = await pendingBatch
  assert.equal(result.search.status, 'partial')
  assert.equal(result.candidates.length, 0)
  assert.ok(result.sourceResults.some((state) => state.status === 'empty'))
  assert.ok(result.sourceResults.some((state) => state.diagnostics.some((value) => JSON.stringify(value).includes('超时') || JSON.stringify(value).includes('timeout') || JSON.stringify(value).includes('budget'))))
  assert.ok(Date.now() - started < 2_000)
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

test('reader-web JavaScript source matches Android HashMap.putAll return and null behavior', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.99'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    mainJs: `function search(){
      var defaults = new Packages.java.util.HashMap();
      defaults.put("name", "putAll 测试书"); defaults.put("author", "兼容验证");
      var details = new Packages.java.util.HashMap(); details.put("bookUrl", "${base}/book");
      var result = defaults.putAll(details);
      if (result !== undefined) throw new Error("HashMap.putAll must return undefined");
      var nullThrows = false;
      try { details.putAll(null); } catch (error) { nullThrows = true; }
      if (!nullThrows) throw new Error("HashMap.putAll(null) must throw");
      return [{ name: defaults.get("name"), author: defaults.get("author"), bookUrl: defaults.get("bookUrl") }];
    }`,
  }])
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(
    { name: result.candidates[0]?.candidate.name, author: result.candidates[0]?.candidate.author, bookUrl: result.candidates[0]?.candidate.bookUrl },
    { name: 'putAll 测试书', author: '兼容验证', bookUrl: `${base}/book` },
  )
})

test('reader-web JavaScript source matches Android String.replace empty-target boundaries', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.100'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    mainJs: `function search(){
      var empty = new Packages.java.lang.String("").replace("", "-").toString();
      var astral = new Packages.java.lang.String("A\\uD83D\\uDE00B").replace("", "-").toString();
      if (empty !== "-") throw new Error("empty String.replace target must insert once");
      if (astral.length !== 9 || astral.charCodeAt(3) !== 0xD83D || astral.charCodeAt(4) !== 45 || astral.charCodeAt(5) !== 0xDE00) {
        throw new Error("String.replace must preserve Java UTF-16 boundary insertions");
      }
      return [{ name: "String replace 测试书", author: "兼容验证", bookUrl: "${base}/book" }];
    }`,
  }])
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.equal(result.candidates[0]?.candidate.name, 'String replace 测试书')
  assert.equal(result.candidates[0]?.candidate.bookUrl, `${base}/book`)
})

test('reader-web JavaScript source matches Android String whitespace methods', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'https://8.8.4.101'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    mainJs: `function search(){
      var value = new Packages.java.lang.String("\\u2003正文\\u3000");
      var stripped = value.strip().toString();
      var leading = value.stripLeading().toString();
      var trailing = value.stripTrailing().toString();
      var blank = new Packages.java.lang.String("\\u3000\\t\\u2003").isBlank();
      var nbspBlank = new Packages.java.lang.String("\\u00a0").isBlank();
      var nbspStrip = new Packages.java.lang.String("\\u00a0正文\\u00a0").strip().toString();
      if (stripped !== "正文" || leading !== "正文\\u3000" || trailing !== "\\u2003正文") throw new Error("String strip boundaries differ");
      if (blank !== true || nbspBlank !== false || nbspStrip !== "\\u00a0正文\\u00a0") throw new Error("String Java whitespace classification differs");
      return [{ name: "String whitespace 测试书", author: "兼容验证", bookUrl: "${base}/book" }];
    }`,
  }])
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.equal(result.candidates[0]?.candidate.name, 'String whitespace 测试书')
  assert.equal(result.candidates[0]?.candidate.bookUrl, `${base}/book`)
})

test('reader-web Java String search methods preserve null errors and negative startsWith offsets', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const base = 'http://127.0.0.1:12345'
  await importBatch(repository, user, [{
    ...sourceDefinition(`${base}/source`),
    mainJs: `function search(){
      var value = new Packages.java.lang.String("abc");
      var checks = [
        function(){ value.contains(null); },
        function(){ value.startsWith(null); },
        function(){ value.endsWith(null); },
        function(){ value.indexOf(null); },
        function(){ value.indexOf(null, 1); },
        function(){ value.lastIndexOf(null); },
        function(){ value.lastIndexOf(null, 1); },
        function(){ value.contentEquals(null); }
      ];
      var caught = 0;
      for (var i = 0; i < checks.length; i++) {
        try { checks[i](); } catch (error) { if (error.name === "TypeError") caught++; }
      }
      if (caught !== checks.length) throw new Error("Java String null search arguments must throw");
      if (value.startsWith("ab", -1)) throw new Error("String.startsWith negative offset must return false");
      return [{ name: "String null search compatibility", author: String(caught), bookUrl: "${base}/book" }];
    }`,
  }])
  const source = (await repository.listSourcesForUser(user))[0]!
  const run = await repository.createSearch(user, { keyword: '目标', sourceId: source.sourceId, sourceIds: [source.sourceId] })
  const result = await createReaderRuntime(repository).runSearchBatch(user, run.id)

  assert.equal(result.search.status, 'success')
  assert.equal(result.sourceResults[0]?.status, 'success')
  assert.equal(result.candidates[0]?.candidate.name, 'String null search compatibility')
  assert.equal(result.candidates[0]?.candidate.author, '8')
  assert.equal(result.candidates[0]?.candidate.bookUrl, `${base}/book`)
})
