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
