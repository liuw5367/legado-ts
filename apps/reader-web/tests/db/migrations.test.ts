import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('reader migration defines encrypted per-user source runtime state with RLS', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0000_reader_schema.sql'), 'utf8')
  assert.match(migration, /create table if not exists "reader"\."source_runtime_state"/u)
  assert.match(migration, /"encrypted_state" text not null/u)
  assert.match(migration, /constraint "source_runtime_user_source_unique" unique \("user_id", "source_id", "source_fingerprint"\)/u)
  assert.match(migration, /alter table "reader"\."source_runtime_state" force row level security/u)
  assert.match(migration, /array\['books'.*'source_runtime_state'\]/su)
})

test('search precision is persisted as a migration-backed search option', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0004_search_precision.sql'), 'utf8')
  const journal = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/meta/_journal.json'), 'utf8')
  assert.match(migration, /add column if not exists "precision" boolean not null default false/u)
  assert.match(journal, /"tag": "0004_search_precision"/u)
})

test('source management migration isolates account overrides and previews with RLS', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0005_source_management.sql'), 'utf8')
  const journal = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/meta/_journal.json'), 'utf8')
  assert.match(migration, /create table if not exists "reader"\."user_sources"/u)
  assert.match(migration, /constraint "user_sources_identity_unique" unique/u)
  assert.match(migration, /create table if not exists "reader"\."source_import_previews"/u)
  assert.match(migration, /user_sources_user_isolation/u)
  assert.match(migration, /source_import_previews_user_isolation/u)
  assert.match(journal, /"tag": "0005_source_management"/u)
})

test('reader pagination migration adds a validated per-user reading mode', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0007_reader_pagination.sql'), 'utf8')
  const journal = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/meta/_journal.json'), 'utf8')
  assert.match(migration, /add column if not exists "reading_mode" text not null default 'scroll'/u)
  assert.match(migration, /check \("reading_mode" in \('scroll', 'paged'\)\)/u)
  assert.match(journal, /"tag": "0007_reader_pagination"/u)
})

test('reader margins migration adds validated per-user reading margins', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0008_reader_margins.sql'), 'utf8')
  const journal = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/meta/_journal.json'), 'utf8')
  assert.match(migration, /add column if not exists "margin_top" integer not null default 16/u)
  assert.match(migration, /"margin_right" integer not null default 16/u)
  assert.match(migration, /"margin_bottom" integer not null default 16/u)
  assert.match(migration, /"margin_left" integer not null default 16/u)
  assert.match(migration, /constraint "reader_settings_margin_top_check" check \("margin_top" between 0 and 64\)/u)
  assert.match(migration, /constraint "reader_settings_margin_left_check" check \("margin_left" between 0 and 64\)/u)
  assert.match(journal, /"tag": "0008_reader_margins"/u)
})

test('用户封面迁移保持旧书籍默认行为并注册迁移顺序', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0012_book_cover.sql'), 'utf8')
  const journal = JSON.parse(await readFile(resolve(import.meta.dirname, '../../server/db/migrations/meta/_journal.json'), 'utf8'))
  assert.ok(migration.includes('add column if not exists "custom_cover_url" text'))
  assert.ok(!migration.includes('not null'))
  assert.ok(journal.entries.some((entry: { tag: string }) => entry.tag === '0012_book_cover'))
  assert.ok(journal.entries.at(-1).when > journal.entries.at(-2).when)
})

test('source capacity migration adds the remaining slots without replacing active leases', async () => {
  const migration = await readFile(resolve(import.meta.dirname, '../../server/db/migrations/0013_source_execution_capacity.sql'), 'utf8')
  const journal = JSON.parse(await readFile(resolve(import.meta.dirname, '../../server/db/migrations/meta/_journal.json'), 'utf8'))
  assert.ok(migration.includes('insert into reader.source_execution_slots(slot_id)'))
  assert.ok(migration.includes('select generate_series(9,20)'))
  assert.ok(migration.includes('on conflict (slot_id) do nothing'))
  assert.equal(journal.entries[13].tag, '0013_source_execution_capacity')
  assert.ok(journal.entries.at(-1).when > journal.entries.at(-2).when)
})
