import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { importSources, refreshSubscription } from '../src/index.ts'
import type { NormalizedSource } from '../src/index.ts'

interface ManifestFixture {
  id: string
  capability: string
  source: string
  input: string
  expected: string
  sensitive: string
  android: string
  typescript: string
}

interface ImportManifest {
  version: number
  fixtures: ManifestFixture[]
}

const manifestUrl = new URL('../../../fixtures/import/manifest.json', import.meta.url)
const fixtureRoot = new URL('../../../fixtures/import/', import.meta.url)

async function fixtureInput(name: string): Promise<string> {
  return readFile(new URL(name, fixtureRoot), 'utf8')
}

test('导入 fixture 清单逐项执行并校验预期', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as ImportManifest
  assert.equal(manifest.version, 1)
  assert.ok(manifest.fixtures.length > 0)

  const ids = new Set<string>()
  const supported = new Set([
    'IMP-001/object',
    'IMP-001/array',
    'IMP-002/unknown-fields',
    'IMP-003/static-js',
    'SUB-001/added',
    'SUB-002/conflict',
  ])

  for (const fixture of manifest.fixtures) {
    assert.equal(ids.has(fixture.id), false, `重复 fixture id: ${fixture.id}`)
    ids.add(fixture.id)
    assert.equal(typeof fixture.capability, 'string')
    assert.equal(typeof fixture.source, 'string')
    assert.equal(typeof fixture.input, 'string')
    assert.equal(typeof fixture.expected, 'string')
    assert.equal(typeof fixture.sensitive, 'string')
    assert.equal(typeof fixture.android, 'string')
    assert.equal(typeof fixture.typescript, 'string')
    assert.ok(supported.has(fixture.id), `fixture 没有执行断言: ${fixture.id}`)

    const text = await fixtureInput(fixture.input)
    if (fixture.id === 'IMP-001/object') {
      const candidates = await importSources(text)
      assert.equal(candidates.length, 1, fixture.expected)
      assert.equal(candidates[0]?.status, 'ready', fixture.expected)
      assert.equal(candidates[0]?.source?.bookSourceUrl, 'https://fixture.test/source', fixture.expected)
    } else if (fixture.id === 'IMP-001/array') {
      const candidates = await importSources(text)
      assert.equal(candidates.length, 2, fixture.expected)
      assert.equal(candidates[0]?.status, 'ready', fixture.expected)
      assert.equal(candidates[1]?.error?.code, 'source-url-missing', fixture.expected)
    } else if (fixture.id === 'IMP-002/unknown-fields') {
      const candidate = (await importSources(text))[0]
      assert.equal(candidate?.status, 'ready', fixture.expected)
      assert.deepEqual(candidate?.unknownFields, { custom: { keep: true } }, fixture.expected)
      assert.deepEqual(candidate?.source?.custom, { keep: true }, fixture.expected)
    } else if (fixture.id === 'IMP-003/static-js') {
      const candidate = (await importSources({ kind: 'javascript', text }))[0]
      assert.equal(candidate?.status, 'ready', fixture.expected)
      assert.equal(candidate?.source?.bookSourceUrl, 'https://fixture.test/js', fixture.expected)
      assert.equal(candidate?.source?.mainJs, text, fixture.expected)
    } else if (fixture.id === 'SUB-001/added') {
      const remote = (await importSources(text))[0]?.source
      assert.ok(remote, fixture.expected)
      const plan = await refreshSubscription({
        subscriptionId: fixture.id,
        operationId: 'fixture-op',
        baseSubscriptionRevision: 'r1',
        baseline: [],
        local: [],
        remoteSources: [remote],
      })
      assert.equal(plan.outcome, 'updated', fixture.expected)
      assert.equal(plan.diffs[0]?.kind, 'added', fixture.expected)
      assert.deepEqual(plan.commitPlan.sourceIds, ['https://fixture.test/added'], fixture.expected)
    } else if (fixture.id === 'SUB-002/conflict') {
      const remote = (await importSources(text))[0]?.source
      assert.ok(remote, fixture.expected)
      const baseline = { ...remote, header: 'base' } as NormalizedSource
      const local = { ...remote, header: 'local' } as NormalizedSource
      const plan = await refreshSubscription({
        subscriptionId: fixture.id,
        operationId: 'fixture-op',
        baseSubscriptionRevision: 'r1',
        baseline: [{ sourceId: remote.bookSourceUrl, source: baseline }],
        local: [{ sourceId: remote.bookSourceUrl, source: local, sourceRevision: 'local-r1' }],
        remoteSources: [remote],
      })
      assert.equal(plan.outcome, 'conflict', fixture.expected)
      assert.deepEqual(plan.diffs[0]?.fields, ['header'], fixture.expected)
      assert.equal(plan.commitPlan.expectedSourceRevisions[remote.bookSourceUrl], 'local-r1', fixture.expected)
    }
  }

  assert.deepEqual([...ids].sort(), [...supported].sort())
})
