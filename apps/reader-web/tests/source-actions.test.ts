import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { runSourceCallback, runSourcePayAction } from '../server/runtime/source-actions.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'source-actions-tests-runtime-state-key-32-bytes'

async function setup() {
  const repository = new MemoryReaderRepository()
  const raw = { bookSourceUrl: 'https://actions.fixture.invalid', bookSourceName: '动作测试源', bookSourceType: 0, searchUrl: 'https://actions.fixture.invalid/search?q={{key}}', ruleContent: { payAction: 'java.refreshBookInfo(); true', callBackJs: 'java.refreshContent(); event + ":" + result' }, eventListener: true }
  const imported = await importSources({ kind: 'text', text: JSON.stringify(raw) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, raw.bookSourceUrl)
  await repository.commitImportPreview('user-a', previewId, candidates.map((item) => item.id))
  return { repository, source: (await repository.listAllSourcesForUser('user-a'))[0]! }
}

const book = { bookUrl: 'https://actions.fixture.invalid/book', name: '测试书' }
const chapter = { sourceId: 'https://actions.fixture.invalid', bookUrl: book.bookUrl, chapterUrl: 'https://actions.fixture.invalid/chapter', title: '第一章' }

test('书源 payAction 与 callback 通过人工触发入口执行，并保留重复操作幂等保护', async () => {
  const { repository, source } = await setup()
  const paid = await runSourcePayAction(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, operationId: 'pay-1', book, chapter })
  assert.equal(paid.status, 'success')
  assert.deepEqual(paid.value, { kind: 'success', value: 'true' })
  assert.deepEqual(paid.actions, [{ action: 'refreshBookInfo' }])
  const duplicate = await runSourcePayAction(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, operationId: 'pay-1', book, chapter })
  assert.equal(duplicate.duplicate, true)
  const callback = await runSourceCallback(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, operationId: 'event-1', event: 'startRead', result: 'ok', book, chapter })
  assert.equal(callback.status, 'success')
  assert.deepEqual(callback.value, { handled: true, value: 'startRead:ok' })
  assert.deepEqual(callback.actions, [{ action: 'refreshContent' }])
})
