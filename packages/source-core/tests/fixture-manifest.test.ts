import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { JsonValue } from '../src/index.ts'

test('phase-a fixture manifest has evidence and execution fields', async () => {
  const text = await readFile(new URL('../../../fixtures/phase-a/manifest.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(text) as { version: number; fixtures: JsonValue[] }
  assert.equal(manifest.version, 1)
  assert.ok(manifest.fixtures.length >= 1)
  for (const item of manifest.fixtures) {
    assert.equal(typeof item, 'object')
    assert.ok(item !== null && !Array.isArray(item))
    const record = item as Record<string, JsonValue>
    assert.equal(typeof record.id, 'string')
    assert.equal(typeof record.source, 'string')
    assert.equal(typeof record.input, 'string')
    assert.equal(typeof record.expected, 'string')
    assert.equal(typeof record.sensitive, 'string')
    assert.equal(typeof record.android, 'string')
    assert.equal(typeof record.typescript, 'string')
  }
})
