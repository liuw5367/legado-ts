import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { createImportPreview, publicImportPreview } from '../server/runtime/source-management.ts'

const baseSource = { bookSourceUrl: 'https://source.example/books', bookSourceName: '示例书源', bookSourceType: 0, lastUpdateTime: 10, searchUrl: 'https://source.example/search?q={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }

async function candidates(source: Record<string, unknown>) { return importSources({ kind: 'text', text: JSON.stringify(source) }) }

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
  for (const finalResponse of [() => new Response('<html>login</html>'), () => new Response('unavailable', { status: 503 }), () => new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
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
  const imported = await importSources({ kind: 'text', text: JSON.stringify(Array.from({ length: 65 }, (_, index) => ({ bookSourceUrl: 'https://all-source.test/' + index, bookSourceName: '全量书源' + String(index).padStart(2, '0'), bookSourceType: 0, searchUrl: '/search' }))) })
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
    { ...baseSource, bookSourceUrl: 'https://order.example/a', bookSourceName: '甲' },
    { ...baseSource, bookSourceUrl: 'https://order.example/b', bookSourceName: '乙' },
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
