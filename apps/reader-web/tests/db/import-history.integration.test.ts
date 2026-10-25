import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { SOURCE_CONCURRENCY } from '../../server/runtime/source-execution.ts'
import { PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb } from '../../server/db/client.ts'
import { importBatch, sourceDefinition, verifyImportHistory } from '../fixtures/import-history.ts'
import { importHistoryQuerySchema } from '../../shared/source-management.ts'

const url = process.env.READER_WEB_TEST_DATABASE_URL

test('real import transactions, UUIDs, encrypted history, RLS and global execution slots', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  assert.ok(url)
  const admin = postgres(url, { max: 1, onnotice: () => undefined })
  const role = 'reader_import_' + randomUUID().replaceAll('-', '')
  const user = randomUUID(); const outsider = randomUUID()
  let client: ReturnType<typeof postgres> | undefined
  t.after(async () => { await closeReaderDb(); await client?.end(); await admin`drop owned by ${admin(role)}`; await admin`drop role ${admin(role)}`; await admin.end() })
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select, insert, update, delete on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(url); appUrl.username = role
  process.env.DATABASE_URL = appUrl.toString()
  process.env.SOURCE_RUNTIME_STATE_KEY = 'fixture-source-runtime-key-at-least-32-characters'
  client = postgres(appUrl.toString(), { max: 1 })
  const repository = new PostgresReaderRepository()
  await verifyImportHistory(repository, user)
  const history = await repository.listImportHistory(user, importHistoryQuerySchema.parse({}))
  const stored = await admin`select encrypted_url from reader.source_import_links where user_id=${user}`
  assert.ok(stored.length)
  assert.ok(stored.every((row) => !row.encrypted_url.includes('private')))
  await assert.rejects(client.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${outsider}, true)`
    assert.equal((await tx`select * from reader.source_import_batches where user_id=${user}`).length, 0)
    await tx`insert into reader.source_import_settings(user_id,revision) values (${user},'attack')`
  }), /row-level security/u)
  // 多个 Repository 实例在同一个数据库内竞争，不能各自获得完整额度。
  const other = new PostgresReaderRepository(); const operation = randomUUID()
  const leases = await Promise.all(Array.from({ length: SOURCE_CONCURRENCY + 1 }, (_, index) => (index % 2 ? other : repository).acquireExecutionSlot(user, operation)))
  assert.equal(leases.filter(Boolean).length, SOURCE_CONCURRENCY)
  assert.equal(await other.acquireExecutionSlot(outsider, randomUUID()), null)
  const released = leases.find((lease) => lease !== null)!
  await repository.releaseExecutionSlot(user, released)
  const replacement = await other.acquireExecutionSlot(outsider, randomUUID())
  assert.ok(replacement)
  await repository.releaseExecutionSlot(user, released)
  assert.equal(await other.acquireExecutionSlot(randomUUID(), randomUUID()), null)
  for (const lease of leases) if (lease) await repository.releaseExecutionSlot(user, lease)
  await other.releaseExecutionSlot(outsider, replacement)
  process.env.SUPABASE_URL = 'https://8.8.8.8/auth-fixture'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-public-key'
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({ id: new Headers(init?.headers).get('Authorization') === 'Bearer outsider' ? outsider : user, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }))
  const { default: app } = await import('../../server/app.ts')
  assert.equal((await app.request('/api/source-management/import-history')).status, 401)
  const headers = { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }
  const apiHistory = await app.request('/api/source-management/import-history', { headers })
  assert.equal(apiHistory.status, 200)
  assert.ok(!JSON.stringify(await apiHistory.json()).includes('private'))
  assert.equal((await app.request(`/api/source-management/import-history/${history.batches[0]!.id}/items`, { headers: { Authorization: 'Bearer outsider' } })).status, 404)
  assert.equal((await app.request('/api/source-management/import-history/not-a-uuid/items', { headers })).status, 400)
  const linkResponse = await app.request('/api/source-management/import-links', { headers })
  const linkData = await linkResponse.json()
  assert.equal((await app.request('/api/source-management/import-links/order', { method: 'POST', headers, body: JSON.stringify({ orderedIds: linkData.links.map((row: { id: string }) => row.id).reverse(), expectedRevision: linkData.revision }) })).status, 200)
  assert.equal((await app.request('/api/source-management/import-links/order', { method: 'POST', headers, body: JSON.stringify({ orderedIds: [], expectedRevision: linkData.revision }) })).status, 409)
  const fresh = await importBatch(repository, user, sourceDefinition('https://fresh.test'), 'https://8.8.8.8/fresh')
  await admin`delete from reader.source_import_previews where user_id=${user} and id=${fresh.preview.previewId}`
  assert.deepEqual(await repository.commitImportPreview(user, fresh.preview.previewId, fresh.ids), fresh.result)
  const sourceScope = await repository.listSourcesForUser(user)
  const run = await repository.createSearch(user, { keyword: 'fixture', sourceId: sourceScope[0]!.sourceId })
  const claimed = await repository.claimSearch(user, run.id, randomUUID(), run.sourceStates, run.progress, run.version)
  assert.ok(claimed)
  assert.equal(await other.claimSearch(user, run.id, randomUUID(), run.sourceStates, run.progress, run.version), null)
  await admin`update reader.search_runs set operation_lease_until=now()-interval '1 second' where id=${run.id}`
  const recover = await repository.getSearch(user, run.id)
  assert.ok(await other.claimSearch(user, run.id, randomUUID(), recover!.sourceStates, recover!.progress, recover!.version))
  const compactRun = await repository.createSearch(user, { keyword: 'compact', sourceId: sourceScope[0]!.sourceId })
  const compactCandidate = { sourceId: sourceScope[0]!.sourceId, sourceFingerprint: sourceScope[0]!.fingerprint, candidate: { sourceId: sourceScope[0]!.sourceId, bookUrl: '/compact', name: 'compact', rawFields: {}, traceRef: 'fixture' } }
  const compactStates = [{ sourceId: sourceScope[0]!.sourceId, status: 'success' as const, candidates: [compactCandidate], diagnostics: [] }]
  await repository.updateSearch(user, compactRun.id, { knownRun: compactRun, candidates: [compactCandidate], sourceStates: compactStates })
  const [compactRow] = await admin`select source_states from reader.search_runs where id=${compactRun.id}`
  assert.deepEqual(compactRow!.source_states[0].candidates, [])
  const hydrated = await repository.getSearch(user, compactRun.id)
  assert.equal(hydrated!.sourceStates[0]!.candidates[0], hydrated!.candidates[0])
  const before = await repository.getBackupSnapshot(user)
  const uuidById = new Map(before.sources.map((row) => [row.source.sourceId, row.source.sourceUuid]))
  await repository.restoreBackupSnapshot(user, before, ['sources'])
  for (const row of await repository.listSourceStatesForUser(user)) assert.equal(row.source.sourceUuid, uuidById.get(row.source.sourceId))
  assert.equal((await repository.previewImportUndo(user, fresh.result.batchId)).items[0]!.reason, '备份恢复后不可撤销')
  assert.ok(history.total >= 3)
})
