import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const url = process.env.READER_WEB_TEST_DATABASE_URL

test('单书状态结构变更明确清空旧进度，不回填且只允许一条当前记录', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  const admin = postgres(url!, { max: 1, onnotice: () => undefined })
  t.after(() => admin.end())
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  const migration = await readFile(new URL('../../server/db/migrations/0016_single_book_reading.sql', import.meta.url), 'utf8')
  const rollback = new Error('rollback temporary schema verification')
  await assert.rejects(admin.begin(async (tx) => {
    await tx`alter table reader.books drop column latest_chapter_index, drop column latest_chapter_name, drop column current_chapter_index, drop column current_chapter_name`
    await tx`drop index reader.reading_records_user_book_idx`
    await tx`alter table reader.reading_records add constraint reading_records_user_book_edition_unique unique (user_id, book_id, edition_key)`
    const user = randomUUID(), book = randomUUID()
    for (const edition of ['a', 'b']) await tx`insert into reader.reading_records (user_id,book_id,edition_key,chapter_id,chapter_url,chapter_index,title) values (${user},${book},${edition},'c','/1',0,'第一章')`
    await tx.unsafe(migration)
    assert.equal(Number((await tx`select count(*) as n from reader.reading_records`)[0]!.n), 0)
    const indexes = await tx`select indexdef from pg_indexes where schemaname='reader' and indexname='reading_records_user_book_idx'`
    assert.equal(indexes.length, 1)
    assert.ok(String(indexes[0]!.indexdef).includes('(user_id, book_id)'))
    throw rollback
  }), (error) => error === rollback)
})
