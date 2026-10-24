import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { createImportPreview, publicImportPreview } from '../server/runtime/source-management.ts'

const baseSource = { bookSourceUrl: 'https://source.example/books', bookSourceName: '示例书源', bookSourceType: 0, lastUpdateTime: 10, searchUrl: 'https://source.example/search?q={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }

async function candidates(source: unknown) { return importSources({ kind: 'text', text: JSON.stringify(source) }) }

test('import skips sources containing NUL without persisting their unsafe preview data', async (t) => {
  const definitions = [
    baseSource,
    { ...baseSource, bookSourceComment: 'comment\u0000' },
    { ...baseSource, bookSourceName: 'bad\u0000name', bookSourceGroup: 'bad\u0000group', exploreUrl: 'url\u0000' },
    { ...baseSource, bookSourceUrl: 'https://nested.example', extra: [{ ['key\u0000']: 'value' }] },
    { ...baseSource, bookSourceUrl: 'https://literal.example', bookSourceComment: 'literal \\u0000', bookSourceName: '正常中文📚' },
  ]
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(definitions)))
  const repository = new MemoryReaderRepository()
  const preview = await createImportPreview(repository, 'user-a', 'https://8.8.8.8/sources.json')
  assert.equal(preview.writableCount, 2)
  const skipped = preview.candidates.filter((candidate) => candidate.skippedReason === 'invalid')
  assert.equal(skipped.length, 3)
  for (const candidate of skipped) {
    assert.equal(candidate.disposition, undefined)
    assert.equal(candidate.reason, '书源包含数据库不支持的空字符 U+0000，已跳过')
    assert.deepEqual(candidate.rawSource, {})
    assert.deepEqual(candidate.normalizedSource, {})
  }
  // JSON 转义会隐藏实际空字符，反序列化后检查所有字符串和对象键。
  const assertSafe = (value: unknown): void => {
    if (typeof value === 'string') assert.equal(value.includes('\u0000'), false)
    else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { assertSafe(key); assertSafe(item) }
  }
  assertSafe(JSON.parse(JSON.stringify(await repository.getImportPreview('user-a', preview.previewId))))
  const selected = preview.candidates.filter((candidate) => candidate.disposition !== undefined)
  assert.equal((await repository.commitImportPreview('user-a', preview.previewId, selected.map((candidate) => candidate.id))).imported, 2)
  const saved = await repository.listAllSourcesForUser('user-a')
  assert.equal(saved.length, 2)
  assert.equal(saved.find((source) => source.sourceId === 'https://literal.example')?.normalizedSource.bookSourceComment, 'literal \\u0000')
})

test('import preview follows HTTP redirects through the real network host', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
      calls += 1
      if (calls === 1) return new Response(null, { status, headers: { location: '/sources.json' } })
      assert.equal(String(url), 'https://8.8.8.8/sources.json')
      return new Response(JSON.stringify([baseSource]))
    })
    const repository = new MemoryReaderRepository()
    const preview = await createImportPreview(repository, 'user-a', 'https://8.8.8.8/start')
    assert.equal(preview.writableCount, 1)
    assert.equal(calls, 2)
    assert.equal((await repository.listSourcesForUser('user-a')).length, 0)
    t.mock.restoreAll()
  }
})

test('import accepts five redirects and rejects loops and private redirect targets', async (t) => {
  for (const redirects of [0, 5, 6]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => ++calls <= redirects
      ? new Response(null, { status: 302, headers: { location: `/hop-${calls}` } })
      : new Response(JSON.stringify([baseSource])))
    const operation = createImportPreview(new MemoryReaderRepository(), 'user-a', 'https://8.8.8.8/start')
    if (redirects <= 5) assert.equal((await operation).writableCount, 1)
    else assert.equal((await operation).writableCount, 0)
    assert.equal(calls, Math.min(redirects + 1, 6))
    t.mock.restoreAll()
  }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) })
  const preview = await createImportPreview(new MemoryReaderRepository(), 'user-a', 'https://8.8.8.8/start')
  assert.equal(preview.writableCount, 0)
  assert.equal(calls, 1)
})

test('redirect import supports another public host and rejects invalid final responses', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    calls += 1
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://8.8.4.4/final.json' } })
    assert.equal(String(url), 'https://8.8.4.4/final.json')
    return new Response(JSON.stringify([baseSource]))
  })
  assert.equal((await createImportPreview(new MemoryReaderRepository(), 'user-a', 'https://8.8.8.8/start')).writableCount, 1)
  t.mock.restoreAll()
  for (const finalResponse of [() => new Response('<html>login</html>'), () => new Response('unavailable', { status: 503 }), () => new Response('x'.repeat(20 * 1024 * 1024 + 1))]) {
    calls = 0
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/final.json' } }) : finalResponse())
    const repository = new MemoryReaderRepository()
    assert.equal((await createImportPreview(repository, 'user-a', 'https://8.8.8.8/start')).writableCount, 0)
    assert.equal((await repository.listSourcesForUser('user-a')).length, 0)
    t.mock.restoreAll()
  }
})

test('cancelled import does not make a network request or write sources', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(JSON.stringify([baseSource])) })
  const repository = new MemoryReaderRepository()
  try {
    const preview = await createImportPreview(repository, 'user-a', 'https://8.8.8.8/start', AbortSignal.abort())
    assert.equal(preview.writableCount, 0)
  } catch (reason) { assert.equal((reason as Error).name, 'AbortError') }
  assert.equal(calls, 0)
  assert.equal((await repository.listSourcesForUser('user-a')).length, 0)
})

test('source comparison keeps identical content out of the writable list and accepts a newer definition', async () => {
  const local = await candidates(baseSource)
  const same = await candidates(baseSource)
  const newer = await candidates({ ...baseSource, lastUpdateTime: 20, searchUrl: 'https://source.example/search-v2?q={{key}}' })
  const localSource = local[0]?.source
  assert.ok(localSource)
  const state = { source: { sourceId: localSource.bookSourceUrl, name: localSource.bookSourceName, fingerprint: local[0]?.sourceFingerprint ?? '', enabled: true, rawSource: localSource, normalizedSource: localSource }, sourceRevision: 'revision-1' }
  const sameResult = compareImportCandidates(same, new Map([[state.source.sourceId, state]]))
  assert.equal(sameResult[0]?.skippedReason, 'same-version')
  const newerResult = compareImportCandidates(newer, new Map([[state.source.sourceId, state]]))
  assert.equal(newerResult[0]?.disposition, 'update')
  assert.equal(newerResult[0]?.sourceRevision, 'revision-1')
})

test('source comparison refuses equal-time content conflicts and old versions', async () => {
  const local = await candidates({ ...baseSource, searchUrl: 'https://source.example/local?q={{key}}' })
  const equalTime = await candidates({ ...baseSource, searchUrl: 'https://source.example/remote?q={{key}}' })
  const old = await candidates({ ...baseSource, lastUpdateTime: 5, searchUrl: 'https://source.example/old?q={{key}}' })
  const localSource = local[0]?.source
  assert.ok(localSource)
  const state = { source: { sourceId: localSource.bookSourceUrl, name: localSource.bookSourceName, fingerprint: local[0]?.sourceFingerprint ?? '', enabled: true, rawSource: localSource, normalizedSource: localSource }, sourceRevision: 'revision-1' }
  assert.equal(compareImportCandidates(equalTime, new Map([[state.source.sourceId, state]]))[0]?.skippedReason, 'conflict')
  assert.equal(compareImportCandidates(old, new Map([[state.source.sourceId, state]]))[0]?.skippedReason, 'old-version')
})

test('deleted source records still guard old imports and allow explicit restore', async () => {
  const local = await candidates(baseSource)
  const source = local[0]?.source
  assert.ok(source)
  const state = { source: { sourceId: source.bookSourceUrl, name: source.bookSourceName, fingerprint: local[0]?.sourceFingerprint ?? '', enabled: true, rawSource: source, normalizedSource: source }, sourceRevision: 'deleted-revision', deleted: true }
  const sameResult = compareImportCandidates(await candidates(baseSource), new Map([[source.bookSourceUrl, state]]))
  assert.equal(sameResult[0]?.disposition, 'restore')
  const oldResult = compareImportCandidates(await candidates({ ...baseSource, lastUpdateTime: 5, searchUrl: 'https://source.example/old' }), new Map([[source.bookSourceUrl, state]]))
  assert.equal(oldResult[0]?.skippedReason, 'old-version')
})

test('memory source actions are isolated per account and do not expose shared defaults', async () => {
  const parsed = await candidates(baseSource)
  const source = parsed[0]?.source
  assert.ok(source)
  const repository = new MemoryReaderRepository()
  await saveNewSource(repository, 'user-a', source, parsed[0]?.sourceFingerprint ?? '', 'source-actions')
  const before = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all' })
  assert.equal(before.sources[0]?.origin, 'account')
  await repository.applySourceActions('user-a', 'disable', [{ sourceId: source.bookSourceUrl, expectedSourceRevision: before.sources[0]!.sourceRevision }])
  assert.equal((await repository.listSourcesForUser('user-a')).length, 0)
  assert.equal((await repository.listSourcesForUser('user-b')).length, 0)
  const disabled = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all' })
  await repository.applySourceActions('user-a', 'enable', [{ sourceId: source.bookSourceUrl, expectedSourceRevision: disabled.sources[0]!.sourceRevision }])
  assert.equal((await repository.listSourcesForUser('user-a')).length, 1)
})

test('source updates preserve account management fields while replacing remote rules', async () => {
  const localParsed = await candidates({ ...baseSource, bookSourceName: '本地名称', bookSourceGroup: '本地分组', enabledExplore: true, customOrder: 7, weight: 9 })
  const remoteParsed = await candidates({ ...baseSource, bookSourceName: '远端名称', bookSourceGroup: '远端分组', lastUpdateTime: 20, searchUrl: 'https://source.example/search-v2?q={{key}}' })
  const local = localParsed[0]?.source
  const remote = remoteParsed[0]?.source
  assert.ok(local); assert.ok(remote)
  const repository = new MemoryReaderRepository()
  await saveNewSource(repository, 'user-a', local, localParsed[0]?.sourceFingerprint ?? '', 'source-update')
  const before = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all' })
  await repository.applySourceActions('user-a', 'disable', [{ sourceId: local.bookSourceUrl, expectedSourceRevision: before.sources[0]!.sourceRevision }])
  const disabled = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all' })
  await repository.saveImportPreview('user-a', { previewId: 'preview-update', expiresAt: new Date(Date.now() + 60_000).toISOString(), writableCount: 1, candidates: [{ id: 'candidate-update', sourceId: remote.bookSourceUrl, name: remote.bookSourceName, ...(typeof remote.bookSourceGroup === 'string' ? { group: remote.bookSourceGroup } : {}), fingerprint: remoteParsed[0]?.sourceFingerprint ?? '', normalizedSource: remote, rawSource: remote, disposition: 'update', sourceRevision: disabled.sources[0]!.sourceRevision, reason: '远端版本较新，可更新' }] }, 'https://source.example/update.json')
  await repository.commitImportPreview('user-a', 'preview-update', ['candidate-update'])
  const saved = (await repository.listAllSourcesForUser('user-a'))[0]
  assert.ok(saved)
  assert.equal(saved.name, '本地名称')
  assert.equal(saved.group, '本地分组')
  assert.equal(saved.enabled, false)
  assert.equal(saved.normalizedSource.searchUrl, 'https://source.example/search-v2?q={{key}}')
  assert.equal(saved.normalizedSource.enabledExplore, true)
  assert.equal(saved.normalizedSource.customOrder, 7)
  assert.equal(saved.normalizedSource.weight, 9)
})

test('same-domain imports keep one default implementation and explicit switching disables its sibling', async () => {
  const parsed = await candidates([
    { ...baseSource, bookSourceUrl: 'https://same-domain.example/older', bookSourceName: '同名书源', lastUpdateTime: 100 },
    { ...baseSource, bookSourceUrl: 'https://same-domain.example/newer', bookSourceName: '同名书源', lastUpdateTime: 200 },
  ])
  const repository = new MemoryReaderRepository()
  const previewId = 'same-domain-import'
  const importCandidates = compareImportCandidates(parsed, new Map())
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates: importCandidates, writableCount: importCandidates.length }, 'https://same-domain.example/list.json')
  await repository.commitImportPreview('user-a', previewId, importCandidates.map((candidate) => candidate.id))

  const saved = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all', all: true })
  assert.equal(saved.sources.length, 2)
  assert.equal(saved.sources.filter((source) => source.enabled).length, 1)
  assert.equal(saved.sources.find((source) => source.sourceId.endsWith('/newer'))?.enabled, true)
  assert.equal((await repository.listSourcesForUser('user-a')).length, 1)
  await assert.rejects(repository.applySourceActions('user-a', 'enable', saved.sources.map((source) => ({ sourceId: source.sourceId, expectedSourceRevision: source.sourceRevision }))), /同一域名只能启用一个/u)

  const older = saved.sources.find((source) => source.sourceId.endsWith('/older'))!
  await repository.applySourceActions('user-a', 'enable', [{ sourceId: older.sourceId, expectedSourceRevision: older.sourceRevision }])
  const switched = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all', all: true })
  assert.equal(switched.sources.find((source) => source.sourceId.endsWith('/older'))?.enabled, true)
  assert.equal(switched.sources.find((source) => source.sourceId.endsWith('/newer'))?.enabled, false)
  assert.deepEqual((await repository.listSourcesForUser('user-a')).map((source) => source.sourceId), [older.sourceId])
})

test('new source imports do not replace an already enabled same-domain implementation', async () => {
  const existingParsed = await candidates({ ...baseSource, bookSourceUrl: 'https://active-domain.example/current', bookSourceName: '当前规则', lastUpdateTime: 100 })
  const nextParsed = await candidates({ ...baseSource, bookSourceUrl: 'https://active-domain.example/alternate', bookSourceName: '候选规则', lastUpdateTime: 200 })
  const existing = existingParsed[0]?.source
  const next = nextParsed[0]?.source
  assert.ok(existing); assert.ok(next)
  const repository = new MemoryReaderRepository()
  await saveNewSource(repository, 'user-a', existing, existingParsed[0]?.sourceFingerprint ?? '', 'active-domain-existing')
  await saveNewSource(repository, 'user-a', next, nextParsed[0]?.sourceFingerprint ?? '', 'active-domain-next')
  const states = await repository.listManagedSources('user-a', { page: 1, pageSize: 50, query: '', status: 'all', all: true })
  assert.equal(states.sources.find((source) => source.sourceId === existing.bookSourceUrl)?.enabled, true)
  assert.equal(states.sources.find((source) => source.sourceId === next.bookSourceUrl)?.enabled, false)
  assert.deepEqual((await repository.listSourcesForUser('user-a')).map((source) => source.sourceId), [existing.bookSourceUrl])
})

async function saveNewSource(repository: MemoryReaderRepository, userId: string, source: NonNullable<Awaited<ReturnType<typeof candidates>>[number]['source']>, fingerprint: string, previewId: string): Promise<void> {
  await repository.saveImportPreview(userId, { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), writableCount: 1, candidates: [{ id: `${previewId}-candidate`, sourceId: source.bookSourceUrl, name: source.bookSourceName, ...(typeof source.bookSourceGroup === 'string' ? { group: source.bookSourceGroup } : {}), fingerprint, normalizedSource: source, rawSource: source, disposition: 'new', reason: '可导入' }] }, `https://source.example/${previewId}.json`)
  await repository.commitImportPreview(userId, previewId, [`${previewId}-candidate`])
}

test('memory import preview commits only selected candidates and is idempotent', async () => {
  const parsed = await candidates({ ...baseSource, bookSourceUrl: 'https://source.example/new', bookSourceName: '新书源' })
  const source = parsed[0]?.source
  assert.ok(source)
  const repository = new MemoryReaderRepository()
  const previewId = 'preview-1'
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), writableCount: 1, candidates: [{ id: 'candidate-1', sourceId: source.bookSourceUrl, name: source.bookSourceName, fingerprint: parsed[0]?.sourceFingerprint ?? '', normalizedSource: source, rawSource: source, disposition: 'new', reason: '可导入' }] }, 'https://source.example/list.json')
  assert.equal((await repository.commitImportPreview('user-a', previewId, ['candidate-1'])).imported, 1)
  assert.equal((await repository.commitImportPreview('user-a', previewId, ['candidate-1'])).imported, 1)
  assert.equal((await repository.listSourcesForUser('user-a')).length, 1)
})

test('public import previews do not expose raw source configuration', () => {
  const preview = publicImportPreview({ previewId: 'preview-1', expiresAt: new Date(Date.now() + 60_000).toISOString(), writableCount: 1, candidates: [{ id: 'candidate-1', sourceId: 'https://source.example/new', name: '新书源', fingerprint: 'fp', normalizedSource: { bookSourceUrl: 'https://source.example/new', mainJs: 'secret' }, rawSource: { password: 'secret' }, disposition: 'new', reason: '可导入' }] })
  assert.equal('rawSource' in preview.candidates[0]!, false)
  assert.equal('normalizedSource' in preview.candidates[0]!, false)
})

test('all source summaries bypass pagination while preserving filters and the default page contract', async () => {
  const repository = new MemoryReaderRepository()
  const imported = await importSources({ kind: 'text', text: JSON.stringify(Array.from({ length: 65 }, (_, index) => ({ bookSourceUrl: `https://all-source-${index}.test/source`, bookSourceName: '全量书源' + String(index).padStart(2, '0'), bookSourceType: 0, searchUrl: '/search' }))) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('all-user', { previewId, expiresAt: new Date(Date.now() + 60000).toISOString(), candidates, writableCount: candidates.length }, 'https://all-source.test')
  await repository.commitImportPreview('all-user', previewId, candidates.map((item) => item.id))
  const params = { page: 1, pageSize: 50, query: '', status: 'all' as const }
  assert.equal((await repository.listManagedSources('all-user', params)).sources.length, 50)
  const all = await repository.listManagedSources('all-user', { ...params, all: true })
  assert.equal(all.sources.length, 65)
  assert.equal(all.total, 65)
  assert.equal((await repository.listManagedSources('other-user', { ...params, all: true })).sources.length, 0)
  assert.equal((await repository.listManagedSources('all-user', { ...params, all: true, query: '书源00' })).sources.length, 1)
  assert.equal((await repository.listManagedSources('all-user', { ...params, all: true, status: 'disabled' })).sources.length, 0)
})

test('web source order is persisted, returned in summaries, and checked by revision', async () => {
  const repository = new MemoryReaderRepository()
  const imported = await importSources({ kind: 'text', text: JSON.stringify([
    { ...baseSource, bookSourceUrl: 'https://order-a.example/source', bookSourceName: '甲' },
    { ...baseSource, bookSourceUrl: 'https://order-b.example/source', bookSourceName: '乙' },
  ]) })
  const previewId = randomUUID()
  const candidates = compareImportCandidates(imported, new Map())
  await repository.saveImportPreview('order-user', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, 'https://order.example/list')
  await repository.commitImportPreview('order-user', previewId, candidates.map((item) => item.id))
  const before = await repository.listManagedSources('order-user', { page: 1, pageSize: 50, query: '', status: 'all', all: true })
  const first = before.sources.find((source) => source.name === '甲')!
  const second = before.sources.find((source) => source.name === '乙')!
  await repository.applySourceOrder('order-user', [{ sourceId: first.sourceId, expectedSourceRevision: first.sourceRevision, customOrder: 20 }, { sourceId: second.sourceId, expectedSourceRevision: second.sourceRevision, customOrder: -1 }])
  const after = await repository.listManagedSources('order-user', { page: 1, pageSize: 50, query: '', status: 'all', all: true })
  assert.deepEqual(after.sources.map((source) => [source.name, source.customOrder]), [['乙', -1], ['甲', 20]])
  assert.deepEqual((await repository.listSourcesForUser('order-user')).map((source) => source.name), ['乙', '甲'])
  await assert.rejects(repository.applySourceOrder('order-user', [{ sourceId: first.sourceId, expectedSourceRevision: first.sourceRevision, customOrder: 0 }]), /已更新/u)
})

test('import preview accepts the 20 MiB boundary and rejects larger responses', async (t) => {
  const limit = 20 * 1024 * 1024
  const text = JSON.stringify([baseSource])
  for (const size of [4 * 1024 * 1024 + 1, limit, limit + 1]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(text + ' '.repeat(size - Buffer.byteLength(text))))
    const preview = await createImportPreview(new MemoryReaderRepository(), 'user-a', 'https://8.8.8.8/sources.json')
    assert.equal(preview.writableCount, size <= limit ? 1 : 0, JSON.stringify({ size, candidates: preview.candidates.map((candidate) => candidate.reason) }))
    t.mock.restoreAll()
  }
})

test('import preview filters non-text media before preview and commit', async (t) => {
  const definitions = [undefined, 0, 1, 2, 3, 99].map((type, index) => ({ ...baseSource, bookSourceUrl: `https://media-${index}.example/books`, bookSourceType: type }))
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(definitions)))
  const repository = new MemoryReaderRepository()
  const preview = await createImportPreview(repository, 'user-a', 'https://8.8.8.8/sources.json')
  assert.equal(preview.candidates.length, 2)
  assert.equal(preview.writableCount, 2)
  assert.deepEqual(preview.candidates.map((candidate) => candidate.sourceId), definitions.slice(0, 2).map((source) => source.bookSourceUrl))
  const result = await repository.commitImportPreview('user-a', preview.previewId, preview.candidates.map((candidate) => candidate.id))
  assert.equal(result.imported, 2)
  assert.ok((await repository.listAllSourcesForUser('user-a')).every((source) => source.normalizedSource.bookSourceType === 0))
})


test('import read failures expose classified diagnostics without private URLs or raw errors', async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  const cases = [
    { error: new TypeError('fetch failed secret-token', { cause: Object.assign(new Error('private-detail'), { code: 'ENOTFOUND' }) }), expected: 'ENOTFOUND' },
    { error: new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('private-detail'), { code: 'ECONNRESET' })]) }), expected: 'ECONNRESET' },
    { error: new DOMException('private-detail', 'TimeoutError'), expected: 'timeout' },
    { error: new DOMException('private-detail', 'AbortError'), expected: 'cancelled' },
    { error: Object.assign(new Error('private-detail'), { code: 'CERT_HAS_EXPIRED' }), expected: 'CERT_HAS_EXPIRED' },
    { error: new Error('private network request is not allowed'), expected: 'private-network' },
    { error: new Error('response exceeds byte budget'), expected: 'response-too-large' },
    { error: new Error('redirect budget exceeded'), expected: 'redirect-limit' },
    { error: new Error('secret-token https://private.example/path'), expected: 'network-error' },
    { status: 403, expected: 'HTTP-403' },
    { status: 429, expected: 'HTTP-429' },
    { status: 503, expected: 'HTTP-503' },
  ]
  for (const scenario of cases) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      if ('error' in scenario) throw scenario.error
      return new Response('secret-token', { status: scenario.status })
    })
    const preview = await createImportPreview(new MemoryReaderRepository(), 'user-a', 'https://8.8.8.8/private-path?token=secret-token')
    assert.equal(preview.writableCount, 0)
    const reason = publicImportPreview(preview).candidates[0]?.reason ?? ''
    assert.ok(reason.includes(scenario.expected), reason)
    assert.ok(reason.includes('诊断编号'))
    assert.ok(!reason.includes('受控读取失败'))
    assert.ok(!reason.includes('secret-token'))
    fetch.mock.restore()
  }
  assert.equal(logs.length, cases.length)
  const output = JSON.stringify(logs)
  assert.ok(output.includes('ENOTFOUND'))
  assert.ok(output.includes('8.8.8.8'))
  for (const secret of ['secret-token', 'private-path', 'private-detail', 'private.example']) assert.ok(!output.includes(secret))
})

test('nested subscription read failures retain successful members and identify the failed member', async (t) => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => {
    const path = new URL(String(url)).pathname
    if (path === '/collection') return Response.json({ sourceUrls: ['https://8.8.8.8/good', 'https://8.8.8.8/bad?token=secret-token'] })
    if (path === '/good') return Response.json(baseSource)
    return new Response('', { status: 403 })
  })
  const preview = await createImportPreview(new MemoryReaderRepository(), 'user-a', 'https://8.8.8.8/collection')
  assert.equal(preview.writableCount, 1)
  const failed = publicImportPreview(preview).candidates.find((candidate) => candidate.disposition === undefined)
  assert.ok(failed)
  assert.ok(failed.reason.includes('HTTP-403'))
  assert.ok(!failed.reason.includes('secret-token'))
})


test('local JSON imports without network reads and preserves the required management link', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('local import must not fetch') })
  const repository = new MemoryReaderRepository()
  const link = 'https://shuyuan-api.yiove.com/import/collection?token=private-value'
  const preview = await createImportPreview(repository, 'local-user', link, undefined, JSON.stringify([baseSource]))
  assert.equal(preview.writableCount, 1)
  assert.equal(preview.candidates[0]?.originLocation, link)
  const imported = await repository.commitImportPreview('local-user', preview.previewId, preview.candidates.map((candidate) => candidate.id))
  assert.equal(imported.imported, 1)
  assert.equal((await repository.listImportLinks('local-user')).links.length, 1)
  const history = await repository.listImportItems('local-user', imported.batchId, (await import('../shared/source-management.ts')).importHistoryQuerySchema.parse({}))
  assert.ok(history.items[0]?.displayUrl.includes('token=已隐藏'))
  assert.ok(!JSON.stringify(publicImportPreview(preview)).includes('private-value'))
  const nested = await createImportPreview(repository, 'local-user', link, undefined, JSON.stringify({ sourceUrls: ['https://8.8.8.8/blocked'] }))
  assert.equal(nested.writableCount, 0)
  assert.equal(fetch.mock.calls.length, 0)
})

test('local JSON requires a valid source link and rejects empty, invalid and oversized content', async () => {
  const { importPreviewRequestSchema } = await import('../shared/source-management.ts')
  const { IMPORT_FILE_MAX_BYTES } = await import('../shared/source-import-limits.ts')
  for (const url of ['', ' ', 'not-a-url']) assert.equal(importPreviewRequestSchema.safeParse({ url, jsonText: '{}' }).success, false)
  assert.equal(importPreviewRequestSchema.safeParse({ url: 'https://example.test', jsonText: '' }).success, false)
  const repository = new MemoryReaderRepository()
  for (const url of ['', ' ', 'not-a-url', 'file:///sources.json', 'https://user:password@example.test']) {
    await assert.rejects(createImportPreview(repository, 'local-user', url, undefined, JSON.stringify(baseSource)))
  }
  for (const text of ['', '  ', '{bad-json']) await assert.rejects(createImportPreview(repository, 'local-user', 'https://example.test', undefined, text), /JSON/u)
  const tooLarge = JSON.stringify({ text: '中'.repeat(Math.ceil(IMPORT_FILE_MAX_BYTES / 3)) })
  await assert.rejects(createImportPreview(repository, 'local-user', 'https://example.test', undefined, tooLarge), /20 MiB/u)
})


test('local JSON accepts exactly 20 MiB and rejects an extra byte', async (t) => {
  const { IMPORT_FILE_MAX_BYTES } = await import('../shared/source-import-limits.ts')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('local import must not fetch') })
  const text = JSON.stringify([baseSource])
  const atLimit = text + ' '.repeat(IMPORT_FILE_MAX_BYTES - Buffer.byteLength(text))
  const repository = new MemoryReaderRepository()
  const preview = await createImportPreview(repository, 'large-local-user', 'https://example.test/collection', undefined, atLimit)
  assert.equal(preview.writableCount, 1)
  await assert.rejects(createImportPreview(repository, 'large-local-user', 'https://example.test/collection', undefined, atLimit + ' '), /20 MiB/u)
  assert.equal(fetch.mock.calls.length, 0)
})

test('large source rules fit the preview budget as well as the input budget', async (t) => {
  const jsonText = JSON.stringify([{ ...baseSource, bookSourceComment: 'x'.repeat(9 * 1024 * 1024) }])
  const repository = new MemoryReaderRepository()
  t.mock.method(globalThis, 'fetch', async () => new Response(jsonText))
  const remote = await createImportPreview(repository, 'large-rules', 'https://8.8.8.8/sources.json')
  assert.equal(remote.writableCount, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(remote.candidates)) > 16 * 1024 * 1024)
  const local = await createImportPreview(repository, 'large-rules', 'https://example.test/collection', undefined, jsonText)
  assert.equal(local.writableCount, 1)
})
