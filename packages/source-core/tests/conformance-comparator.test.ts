import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = new URL('../../../', import.meta.url)
const comparator = new URL('scripts/compare-source-conformance.mjs', repositoryRoot)
const fixturesRoot = new URL('fixtures/conformance/', repositoryRoot)

async function expected(fixtureId: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`cases/${fixtureId}/expected.json`, fixturesRoot), 'utf8')) as unknown
}

async function runComparator(androidRoot: string, requireAndroid = false): Promise<{ code: number | null; report: Record<string, any> }> {
  const args = [comparator.pathname, '--android', androidRoot, '--skip-typescript']
  if (requireAndroid) args.push('--require-android')
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(child.error, undefined, child.error?.message)
  assert.equal(child.stderr, '', child.stderr)
  return { code: child.status, report: JSON.parse(child.stdout) as Record<string, any> }
}

async function withAndroidOutput(output: Record<string, unknown> | unknown, fixtureId = 'HTML-FLOW-001'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'legado-conformance-'))
  await mkdir(join(root, 'cases'))
  await writeFile(join(root, 'cases', `${fixtureId}.json`), JSON.stringify(output))
  return root
}

test('runner 结果 schema 固定外层字段和状态枚举', async () => {
  const schema = JSON.parse(await readFile(new URL('fixtures/conformance/runner-result.schema.json', repositoryRoot), 'utf8')) as Record<string, any>
  assert.equal(schema.properties.schemaVersion.const, 1)
  assert.deepEqual(schema.properties.status.enum, ['pass', 'unsupported', 'failed', 'runner-failed'])
  assert.deepEqual(schema.required, ['schemaVersion', 'fixtureId', 'status', 'result'])
})

test('比较器区分 pass、not-run、unsupported 和 runner-failed', async () => {
  const fixtureId = 'HTML-FLOW-001'
  const result = await expected(fixtureId)
  const root = await withAndroidOutput({ schemaVersion: 1, fixtureId, status: 'pass', result })
  try {
    const report = await runComparator(root)
    assert.equal(report.code, 0)
    assert.equal(report.report.summary.passed, 1)
    assert.equal(report.report.summary.missing, 5)
    assert.equal(report.report.summary.blocked, 5)
    assert.equal(report.report.fixtures.find((item: any) => item.id === fixtureId).comparison, 'pass')

    const required = await runComparator(root, true)
    assert.equal(required.code, 2)
    assert.equal(required.report.summary.missing, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const unsupportedRoot = await withAndroidOutput({ schemaVersion: 1, fixtureId, status: 'unsupported', result: { code: 'capability-missing' } })
  try {
    const report = await runComparator(unsupportedRoot, true)
    assert.equal(report.code, 2)
    const item = report.report.fixtures.find((entry: any) => entry.id === fixtureId)
    assert.equal(item.android, 'unsupported')
    assert.equal(item.comparison, 'not-run')
    assert.equal(report.report.summary.unsupported, 1)
  } finally {
    await rm(unsupportedRoot, { recursive: true, force: true })
  }

  const runnerFailedRoot = await withAndroidOutput({ schemaVersion: 1, fixtureId, status: 'runner-failed', result: { code: 'build-failed' } })
  try {
    const report = await runComparator(runnerFailedRoot)
    assert.equal(report.code, 0)
    assert.equal(report.report.summary.runnerFailed, 1)
    assert.equal(report.report.fixtures.find((entry: any) => entry.id === fixtureId).android, 'runner-failed')
  } finally {
    await rm(runnerFailedRoot, { recursive: true, force: true })
  }
})

test('比较器拒绝错 fixtureId，并保留旧版直接 expected JSON 兼容', async () => {
  const fixtureId = 'HTML-FLOW-001'
  const invalidRoot = await withAndroidOutput({ schemaVersion: 1, fixtureId: 'JSON-FLOW-001', status: 'pass', result: await expected(fixtureId) })
  try {
    const report = await runComparator(invalidRoot, true)
    assert.equal(report.code, 1)
    const item = report.report.fixtures.find((entry: any) => entry.id === fixtureId)
    assert.equal(item.android, 'invalid-output')
    assert.equal(item.comparison, 'fail')
    assert.equal(report.report.summary.invalidOutput, 1)
  } finally {
    await rm(invalidRoot, { recursive: true, force: true })
  }

  const legacyRoot = await withAndroidOutput(await expected(fixtureId), fixtureId)
  try {
    const report = await runComparator(legacyRoot, true)
    assert.equal(report.code, 2)
    const item = report.report.fixtures.find((entry: any) => entry.id === fixtureId)
    assert.equal(item.android, 'pass')
    assert.equal(item.comparison, 'pass')
  } finally {
    await rm(legacyRoot, { recursive: true, force: true })
  }
})
