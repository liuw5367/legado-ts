import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JsonStore } from '../src/json-store.ts'

test('JsonStore writes and reads the versioned envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-json-'))
  try {
    const store = new JsonStore(() => new Date('2026-01-01T00:00:00.000Z'))
    const path = join(root, 'nested', 'state.json')
    await store.writeFile(path, { value: 'ok' })
    assert.deepEqual(await store.readFile(path, undefined), { value: 'ok' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('JsonStore backs up corrupt files before restoring a fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-json-'))
  try {
    const store = new JsonStore(() => new Date('2026-01-01T00:00:00.000Z'))
    const path = join(root, 'state.json')
    await writeFile(path, '{broken', 'utf8')
    assert.deepEqual(await store.readFile(path, []), [])
    assert.equal((await readdir(root)).some((name) => name.startsWith('state.json.corrupt-')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
