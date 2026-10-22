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
  members: Array<{
    id: string
    owner: string
    name: string
    signature: string
    parameters: Array<Record<string, unknown>>
    returnType: string
    implementation: CompatibilityEntry['implementation']
    verification: CompatibilityEntry['verification']
    feasibility: CompatibilityEntry['feasibility']
    decision: CompatibilityEntry['decision']
    fixtures: string[]
    errorCodes: string[]
  }>
}

interface CompatibilityManifest {
  version: number
  memberCount: number
  baseline: { androidCommit: string; tutorialSha256: string }
  entries: CompatibilityEntry[]
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, root), 'utf8')) as T
}

test('兼容方法清单具有唯一 ID、四维状态和可追踪入口', async () => {
  const manifest = await readJson<CompatibilityManifest>('method-manifest.json')
  const schema = await readJson<{ properties?: { version?: { const?: number } } }>('schema.json')
  assert.equal(manifest.version, 2)
  assert.equal(schema.properties?.version?.const, 2)
  assert.match(manifest.baseline.androidCommit, /^[0-9a-f]{40}$/u)
  assert.match(manifest.baseline.tutorialSha256, /^[0-9a-f]{64}$/u)
  assert.ok(manifest.entries.length >= 20)
  assert.equal(manifest.memberCount, manifest.entries.reduce((count, entry) => count + entry.members.length, 0))
  assert.ok(manifest.memberCount >= 200)

  const ids = new Set<string>()
  const memberIds = new Set<string>()
  for (const entry of manifest.entries) {
    assert.equal(ids.has(entry.id), false, `重复兼容项 ID: ${entry.id}`)
    ids.add(entry.id)
    assert.ok(entry.family.length > 0)
    assert.ok(entry.androidOwner.length > 0)
    assert.ok(entry.androidMethods.length > 0)
    assert.ok(entry.tsPaths.length > 0)
    assert.equal(entry.members.length, entry.androidMethods.length, `${entry.id} 的成员清单必须覆盖每个 Android 方法名`)
    for (const [index, member] of entry.members.entries()) {
      assert.equal(member.name, entry.androidMethods[index], `${entry.id} 成员顺序必须对应 Android 方法名`)
      assert.equal(member.owner, entry.androidOwner)
      assert.ok(!memberIds.has(member.id), `重复兼容成员 ID: ${member.id}`)
      memberIds.add(member.id)
      assert.ok(member.signature.length > 0)
      assert.ok(member.returnType.length > 0)
      for (const fixture of member.fixtures) assert.ok(fixture.length > 0)
    }
    for (const divergence of entry.divergences) assert.match(divergence, /^D(?:[0-9]+|OPEN-[0-9]+)$/u)
    for (const fixture of entry.fixtures ?? []) assert.ok(fixture.length > 0)
  }

  assert.ok(manifest.entries.some((entry) => entry.id === 'parser-jsonpath' && entry.verification === 'ts-diff'))
  assert.ok(manifest.entries.some((entry) => entry.id === 'host-webview-device' && entry.feasibility === 'real-host'))
  assert.ok(manifest.entries.some((entry) => entry.id === 'runtime-observation' && entry.decision === 'fix'))
})
