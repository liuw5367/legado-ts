import assert from 'node:assert/strict'
import test from 'node:test'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { publicImportPreview } from '../server/runtime/source-management.ts'

const baseSource = { bookSourceUrl: 'https://source.example/books', bookSourceName: '示例书源', bookSourceType: 0, lastUpdateTime: 10, searchUrl: 'https://source.example/search?q={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }

async function candidates(source: Record<string, unknown>) { return importSources({ kind: 'text', text: JSON.stringify(source) }) }

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
