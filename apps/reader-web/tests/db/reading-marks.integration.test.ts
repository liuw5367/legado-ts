import { readerMark } from '../../shared/reading-annotations.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb } from '../../server/db/client.ts'
import { markInputSchema } from '../../shared/reading-annotations.ts'
import { createAnchor } from '../../src/lib/reader-annotations.ts'

const url = process.env.READER_WEB_TEST_DATABASE_URL

test('新增迁移业务 DDL 只作用于两张新表', async () => {
  const sql = await readFile(new URL('../../server/db/migrations/0014_reading_annotations.sql', import.meta.url), 'utf8')
  const targets = [...sql.matchAll(/(?:table|on)\s+"reader"\."([a-z_]+)"/gu)].map((r) => r[1])
  assert.ok(targets.length >= 10)
  assert.ok(targets.every((name) => name === 'reading_annotations' || name === 'reading_bookmarks'))
  assert.doesNotMatch(sql, /(?:drop|truncate|update|delete from|insert into)\s/iu)
})

test('真实Postgres新增表RLS、约束、游标、并发与回滚', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  assert.ok(url)
  const admin = postgres(url, { max: 1, onnotice: () => undefined }); const role = 'marks_' + randomUUID().replaceAll('-', '')
  let client: ReturnType<typeof postgres> | undefined
  t.after(async () => { await closeReaderDb(); await client?.end(); await admin`drop owned by ${admin(role)}`; await admin`drop role ${admin(role)}`; await admin.end() })
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`; await admin`grant usage on schema reader to ${admin(role)}`; await admin`grant select,insert,update,delete on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(url); appUrl.username = role; process.env.DATABASE_URL = appUrl.toString(); client = postgres(appUrl.toString(), { max: 1 })
  const repo = new PostgresReaderRepository(); const user = randomUUID(); const other = randomUUID(); const bookId = randomUUID()
  const input = markInputSchema.parse({ editionKey: 'edition', sourceFingerprint: 'fp', chapterId: 'chapter', chapterUrl: '/chapter', chapterIndex: 0, chapterTitle: '章', tocRevision: 'rev', anchor: createAnchor(['正文'], { paragraphIndex: 0, offset: 0 }, { paragraphIndex: 0, offset: 2 }, 'hash'), note: '100%_字面' })
  const command = { action: 'save' as const, kind: 'annotations' as const, bookId, id: randomUUID(), input, bookName: '书', author: null, sourceName: '书源', cachedChapter: null }
  const saved = await repo.mutateReadingMark(user, command)
  assert.deepEqual(await repo.listReaderMarks(user, { kind: 'annotations', bookId, editionKey: input.editionKey, chapterUrl: input.chapterUrl }), [readerMark(saved)])
  assert.deepEqual(await repo.listReaderMarks(other, { kind: 'annotations', bookId, editionKey: input.editionKey, chapterUrl: input.chapterUrl }), [])
  assert.equal((await repo.listReadingMarks(user, { kind: 'annotations', q: '%_' })).items.length, 1)
  assert.equal((await repo.listReadingMarks(other, { kind: 'annotations' })).items.length, 0)
  await client.begin(async (sql) => { await sql`select set_config('app.user_id', ${other}, true)`; assert.equal((await sql`select * from reader.reading_annotations`).length, 0) })
  await assert.rejects(client.begin(async (sql) => { await sql`select set_config('app.user_id', ${other}, true)`; await sql`insert into reader.reading_annotations (user_id,id,book_id,edition_key,chapter_url,data) values (${user},${saved.id},${bookId},'edition','/chapter',${JSON.stringify(saved)}::jsonb)` }), /row-level security/u)
  const update = { ...command, input: { ...input, expectedVersion: saved.version, color: 'blue' as const } }
  const results = await Promise.allSettled([repo.mutateReadingMark(user, update), repo.mutateReadingMark(user, update)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  await assert.rejects(repo.mutateReadingMark(user, { ...command, bookId: randomUUID() }))
  const removed = await repo.mutateReadingMark(user, { action: 'delete', kind: 'annotations', id: saved.id, bookId, expectedVersion: 1 })
  assert.ok(removed.deletedAt)
  assert.equal((await repo.listReadingMarks(user, { kind: 'annotations' })).items.length, 0)
  const restored = await repo.mutateReadingMark(user, { action: 'restore', kind: 'annotations', id: saved.id, bookId, expectedVersion: 2 })
  assert.equal(restored.color, 'blue'); assert.equal(restored.note, input.note)
  for (let index = 1; index < 56; index++) await repo.mutateReadingMark(user, { ...command, id: randomUUID(), input: { ...input, chapterIndex: index, chapterUrl: '/chapter/' + index } })
  const first = await repo.listReadingMarks(user, { kind: 'annotations' }); assert.equal(first.items.length, 50); assert.ok(first.nextCursor)
  const second = await repo.listReadingMarks(user, { kind: 'annotations', cursor: first.nextCursor }); assert.equal(second.items.length, 6)
  assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 56)
  await assert.rejects(repo.listReadingMarks(user, { kind: 'annotations', q: 'changed', cursor: first.nextCursor }))
  await admin`delete from reader.reading_annotations where user_id = ${user}`
})
