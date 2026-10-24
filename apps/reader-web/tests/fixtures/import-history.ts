import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { importSources } from '@legado/source-core'
import type { ReaderRepository } from '../../server/db/repository.ts'
import { compareImportCandidates } from '../../server/runtime/source-comparison.ts'
import { importHistoryQuerySchema } from '../../shared/source-management.ts'

export const sourceDefinition = (id = 'https://history.example/source', time = 10) => ({ bookSourceUrl: id, bookSourceName: '历史书源', bookSourceType: 0, lastUpdateTime: time, searchUrl: '/search?q={{key}}&v=' + time, ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: '.name@href' }, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} })
export async function importBatch(repository: ReaderRepository, userId: string, definitions: unknown, url = 'https://8.8.8.8/sources?token=private') {
  const candidates = compareImportCandidates(await importSources({ kind: 'text', text: JSON.stringify(definitions) }), new Map((await repository.listSourceStatesForUser(userId)).map((row) => [row.source.sourceId, row])))
  const previewId = randomUUID()
  const preview = { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.filter((row) => row.disposition).length }
  await repository.saveImportPreview(userId, preview, url)
  const ids = candidates.filter((row) => row.disposition).map((row) => row.id)
  return { result: await repository.commitImportPreview(userId, previewId, ids), preview, ids }
}

export async function verifyImportHistory(repository: ReaderRepository, userId: string) {
  const query = importHistoryQuerySchema.parse({})
  const first = await importBatch(repository, userId, sourceDefinition())
  assert.match(first.result.batchId, /^[0-9a-f-]{36}$/u)
  assert.equal(first.result.newCount, 1)
  const original = (await repository.listSourceStatesForUser(userId))[0]!
  assert.match(original.source.sourceUuid!, /^[0-9a-f-]{36}$/u)
  const history = await repository.listImportHistory(userId, query)
  assert.equal(history.batches.length, 1)
  assert.ok(!JSON.stringify(history).includes('private'))
  assert.deepEqual(await repository.commitImportPreview(userId, first.preview.previewId, first.ids), first.result)
  await repository.orderImportLinks(userId, (await repository.listImportLinks(userId)).links.map((row) => row.id), (await repository.listImportLinks(userId)).revision)
  assert.equal((await repository.previewImportUndo(userId, first.result.batchId)).removable, 1)
  const second = await importBatch(repository, userId, sourceDefinition(undefined, 20), 'https://1.1.1.1/b')
  assert.equal(second.result.updatedCount, 1)
  assert.equal((await repository.listSourceStatesForUser(userId))[0]!.source.sourceUuid, original.source.sourceUuid)
  assert.equal((await repository.previewImportUndo(userId, first.result.batchId)).removable, 0)
  const detail = await repository.listImportItems(userId, second.result.batchId, query)
  assert.equal(detail.items[0]!.currentStatus, 'unchanged')
  assert.ok(!('beforeSnapshot' in detail.items[0]!))
  const preview = await repository.previewImportUndo(userId, second.result.batchId)
  const input = { idempotencyKey: randomUUID(), items: preview.items.filter((item) => item.canUndo).map((item) => ({ itemId: item.itemId, expectedRevision: item.expectedRevision! })) }
  assert.equal((await repository.undoImport(userId, second.result.batchId, input)).affected, 1)
  assert.equal((await repository.undoImport(userId, second.result.batchId, input)).affected, 1)
  const restored = (await repository.listSourceStatesForUser(userId))[0]!
  assert.equal(restored.source.sourceUuid, original.source.sourceUuid)
  assert.equal(restored.source.normalizedSource.lastUpdateTime, 10)
  assert.equal(restored.source.importLinkId, original.source.importLinkId)
  assert.equal((await repository.previewImportUndo(userId, first.result.batchId)).removable, 0)
  assert.equal((await repository.listImportHistory(randomUUID(), query)).total, 0)
  await assert.rejects(repository.previewImportUndo(randomUUID(), second.result.batchId), /不存在/u)
  const currentRevision = restored.sourceRevision
  await repository.applySourceActions(userId, 'delete', [{ sourceId: restored.source.sourceId, expectedSourceRevision: currentRevision }])
  const third = await importBatch(repository, userId, sourceDefinition(undefined, 30))
  assert.equal(third.result.restoredCount, 1)
  const undoRestore = await repository.previewImportUndo(userId, third.result.batchId)
  await repository.undoImport(userId, third.result.batchId, { idempotencyKey: randomUUID(), items: undoRestore.items.map((item) => ({ itemId: item.itemId, expectedRevision: item.expectedRevision! })) })
  assert.equal((await repository.listSourceStatesForUser(userId))[0]!.deleted, true)
  assert.equal((await repository.listSourceStatesForUser(userId))[0]!.source.sourceUuid, original.source.sourceUuid)
}
