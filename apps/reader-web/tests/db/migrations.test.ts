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
