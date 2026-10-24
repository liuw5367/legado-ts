import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { importHistoryQuerySchema } from '../shared/source-management.ts'
import { importBatch, sourceDefinition, verifyImportHistory } from './fixtures/import-history.ts'

test('import history snapshots, safe undo, stable UUIDs, origins and account isolation', async () => { await verifyImportHistory(new MemoryReaderRepository(), randomUUID()) })

test('partial undo, runtime leases and revision races cannot erase newer changes', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const { result } = await importBatch(repository, user, [sourceDefinition('https://first.example'), sourceDefinition('https://second.example')])
  const preview = await repository.previewImportUndo(user, result.batchId)
  const selected = preview.items[0]!
  const source = (await repository.listSourceStatesForUser(user)).find((row) => row.source.name === selected.name)!
  const lease = await repository.acquireSourceRuntimeLease(user, source.source.sourceId, source.source.fingerprint, randomUUID(), 10000)
  assert.ok(lease)
  assert.equal((await repository.previewImportUndo(user, result.batchId)).items.filter((item) => !item.canUndo).length, 1)
  await repository.releaseSourceRuntimeLease(user, source.source.sourceId, source.source.fingerprint, lease.leaseToken)
  await repository.undoImport(user, result.batchId, { idempotencyKey: randomUUID(), items: [{ itemId: selected.itemId, expectedRevision: selected.expectedRevision! }] })
  assert.equal((await repository.listImportHistory(user, importHistoryQuerySchema.parse({}))).batches[0]!.undoStatus, 'partial')
  const remaining = (await repository.listSourceStatesForUser(user)).find((row) => !row.deleted)!
  const pending = await repository.previewImportUndo(user, result.batchId)
  await repository.applySourceActions(user, 'disable', [{ sourceId: remaining.source.sourceId, expectedSourceRevision: remaining.sourceRevision }])
  await assert.rejects(repository.undoImport(user, result.batchId, { idempotencyKey: randomUUID(), items: pending.items.filter((item) => item.canUndo).map((item) => ({ itemId: item.itemId, expectedRevision: item.expectedRevision! })) }), /已修改|版本/u)
})

test('link order determines source order and backup restore preserves UUID but invalidates undo', async () => {
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  const a = await importBatch(repository, user, sourceDefinition('https://a.test'), 'https://8.8.8.8/a')
  const b = await importBatch(repository, user, sourceDefinition('https://b.test'), 'https://8.8.8.8/b')
  const links = await repository.listImportLinks(user)
  await repository.orderImportLinks(user, links.links.map((row) => row.id).reverse(), links.revision)
  assert.deepEqual((await repository.listSourcesForUser(user)).map((row) => row.sourceId), ['https://b.test', 'https://a.test'])
  const snapshot = await repository.getBackupSnapshot(user)
  await repository.restoreBackupSnapshot(user, snapshot, ['sources'])
  assert.deepEqual((await repository.listSourceStatesForUser(user)).map((row) => row.source.sourceUuid).sort(), snapshot.sources.map((row) => row.source.sourceUuid).sort())
  assert.equal((await repository.previewImportUndo(user, a.result.batchId)).removable, 0)
  assert.equal((await repository.previewImportUndo(user, b.result.batchId)).items[0]!.reason, '备份恢复后不可撤销')
})

test('redirected child source URLs retain private provenance only in history storage', async (t) => {
  const { createImportPreview, publicImportPreview } = await import('../server/runtime/source-management.ts')
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(String(input))
    if (url.pathname === '/root') return new Response(JSON.stringify({ sourceUrls: ['https://8.8.8.8/child?token=one', 'https://8.8.8.8/child?token=two'] }))
    return new Response(JSON.stringify(sourceDefinition(url.searchParams.get('token') === 'one' ? 'https://one.test' : 'https://two.test')))
  })
  const preview = await createImportPreview(repository, user, 'https://8.8.8.8/root')
  assert.deepEqual(preview.candidates.map((candidate) => candidate.originLocation), ['https://8.8.8.8/child?token=one', 'https://8.8.8.8/child?token=two'])
  assert.ok(!JSON.stringify(publicImportPreview(preview)).includes('token=one'))
  const imported = await repository.commitImportPreview(user, preview.previewId, preview.candidates.map((candidate) => candidate.id))
  const details = await repository.listImportItems(user, imported.batchId, importHistoryQuerySchema.parse({}))
  assert.ok(details.items.every((item) => item.displayUrl.includes('/child?token=已隐藏')))
})

test('an invalid child URL is recorded as skipped without blocking valid selected sources', async (t) => {
  const { createImportPreview } = await import('../server/runtime/source-management.ts')
  const repository = new MemoryReaderRepository(); const user = randomUUID()
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => new URL(String(input)).pathname === '/root'
    ? new Response(JSON.stringify({ sourceUrls: ['invalid-relative-input', 'https://8.8.8.8/valid'] }))
    : new Response(JSON.stringify(sourceDefinition())))
  const preview = await createImportPreview(repository, user, 'https://8.8.8.8/root')
  assert.equal(preview.writableCount, 1)
  const selected = preview.candidates.filter((candidate) => candidate.disposition).map((candidate) => candidate.id)
  const result = await repository.commitImportPreview(user, preview.previewId, selected)
  assert.equal(result.imported, 1)
  const details = await repository.listImportItems(user, result.batchId, importHistoryQuerySchema.parse({ filter: 'skipped' }))
  assert.equal(details.items.length, 1)
  assert.equal(details.items[0]!.displayUrl, '无效来源地址')
})
