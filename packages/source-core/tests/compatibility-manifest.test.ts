import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../fixtures/compatibility/', import.meta.url)

interface CompatibilityEntry {
  id: string
  family: string
  scope: 'source-runtime' | 'host-boundary'
  androidOwner: string
  androidMethods: string[]
  tsPaths: string[]
  implementation: 'implemented' | 'simulated' | 'partial' | 'absent'
  verification: 'unverified' | 'ts-passed' | 'ts-diff' | 'blocked'
  feasibility: 'fixable' | 'simulatable' | 'conditional' | 'real-host' | 'unknown' | 'preserve'
  decision: 'fix' | 'verify' | 'preserve' | 'host' | 'unknown' | 'out-of-scope'
  divergences: string[]
  fixtures?: string[]
  errorCodes?: string[]
}

interface CompatibilityManifest {
  version: number
  baseline: { androidCommit: string; tutorialSha256: string }
  entries: CompatibilityEntry[]
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, root), 'utf8')) as T
}

test('兼容方法清单具有唯一 ID、四维状态和可追踪入口', async () => {
  const manifest = await readJson<CompatibilityManifest>('method-manifest.json')
  const schema = await readJson<{ properties?: { version?: { const?: number } } }>('schema.json')
  assert.equal(manifest.version, 1)
  assert.equal(schema.properties?.version?.const, 1)
  assert.match(manifest.baseline.androidCommit, /^[0-9a-f]{40}$/u)
  assert.match(manifest.baseline.tutorialSha256, /^[0-9a-f]{64}$/u)
  assert.ok(manifest.entries.length >= 20)

  const ids = new Set<string>()
  for (const entry of manifest.entries) {
    assert.equal(ids.has(entry.id), false, `重复兼容项 ID: ${entry.id}`)
    ids.add(entry.id)
    assert.ok(entry.family.length > 0)
    assert.ok(entry.androidOwner.length > 0)
    assert.ok(entry.androidMethods.length > 0)
    assert.ok(entry.tsPaths.length > 0)
    for (const divergence of entry.divergences) assert.match(divergence, /^D(?:[0-9]+|OPEN-[0-9]+)$/u)
    for (const fixture of entry.fixtures ?? []) assert.ok(fixture.length > 0)
  }

  assert.ok(manifest.entries.some((entry) => entry.id === 'parser-jsonpath' && entry.verification === 'ts-diff'))
  assert.ok(manifest.entries.some((entry) => entry.id === 'host-webview-device' && entry.feasibility === 'real-host'))
  assert.ok(manifest.entries.some((entry) => entry.id === 'runtime-observation' && entry.decision === 'fix'))
})
