#!/usr/bin/env node

import { readFile, access } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const defaultFixtures = resolve(repositoryRoot, 'fixtures/conformance')
const defaultAndroid = '/private/tmp/legado-conformance-android/app/build/conformance'

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(`用法：node scripts/compare-source-conformance.mjs [选项]

选项：
  --android <目录>       Android runner 输出目录；默认 ${defaultAndroid}
  --fixtures <目录>      conformance fixture 根目录；默认 ${defaultFixtures}
  --require-android      Android 输出缺失时以退出码 2 失败
  --skip-typescript      不重新执行 Node/TypeScript conformance 测试
  --help                 显示帮助

Android runner 输出约定：每个 fixture 可写为 <id>.json、cases/<id>.json、
<id>/result.json 或 <id>.golden.json；新协议使用
{"schemaVersion":1,"fixtureId":"...","status":"pass","result":<JSON>}，
旧版直接 expected JSON 仍仅作为迁移兼容。`)
  process.exit(0)
}

const fixturesRoot = resolve(options.fixtures ?? defaultFixtures)
const androidRoot = resolve(options.android ?? defaultAndroid)
const manifest = await readJson(join(fixturesRoot, 'manifest.json'))
if (manifest.version !== 2 || !Array.isArray(manifest.fixtures)) throw new Error('conformance manifest version 必须为 2')

let typescript = { status: 'skipped', output: '', fixtures: [] }
if (!options.skipTypescript) typescript = runTypescriptConformance()
const cases = manifest.fixtures.filter((fixture) => typeof fixture.case === 'string' && fixture.typescript === 'source-cross-runtime.test.ts')
const fixtures = []
for (const fixture of cases) {
  const expectedPath = join(fixturesRoot, fixture.expected)
  const expected = await readJson(expectedPath)
  const typescriptFixture = typescript.fixtures.find((item) => item.id === fixture.id)
  const typescriptStatus = typescriptFixture?.status ?? typescript.status
  const typescriptComparison = typescriptFixture?.comparison ?? (typescript.status === 'pass' ? 'pass' : 'not-run')
  const output = await findAndroidOutput(androidRoot, fixture.id)
  if (output.kind === 'missing') {
    fixtures.push({ id: fixture.id, typescript: typescriptStatus, typescriptComparison, android: 'not-run', comparison: typescriptComparison === 'fail' ? 'fail' : 'not-run', expected: expectedPath })
    continue
  }
  if (output.kind === 'invalid-json') {
    fixtures.push({ id: fixture.id, typescript: typescriptStatus, typescriptComparison, android: 'invalid-output', comparison: 'fail', output: output.path, error: output.error })
    continue
  }
  const normalized = normalizeAndroidOutput(fixture.id, output.value)
  if (normalized.error !== undefined) {
    fixtures.push({ id: fixture.id, typescript: typescriptStatus, typescriptComparison, android: 'invalid-output', comparison: 'fail', output: output.path, error: normalized.error })
    continue
  }
  if (normalized.status !== 'pass') {
    fixtures.push({ id: fixture.id, typescript: typescriptStatus, typescriptComparison, android: normalized.status, comparison: typescriptComparison === 'fail' ? 'fail' : 'not-run', output: output.path })
    continue
  }
  const equal = stableJson(normalized.result) === stableJson(expected)
  const comparisonPass = equal && typescriptComparison !== 'fail'
  fixtures.push({ id: fixture.id, typescript: typescriptStatus, typescriptComparison, android: equal ? 'pass' : 'fail', comparison: comparisonPass ? 'pass' : 'fail', output: output.path, ...(equal ? {} : { difference: { expected, actual: normalized.result } }) })
}

const missing = fixtures.filter((item) => item.android === 'not-run').length
const failed = fixtures.filter((item) => item.comparison === 'fail').length
const blocked = fixtures.filter((item) => ['not-run', 'unsupported', 'runner-failed'].includes(item.android)).length
const report = {
  version: 1,
  fixtures,
  summary: {
    total: fixtures.length,
    passed: fixtures.filter((item) => item.comparison === 'pass').length,
    missing,
    blocked,
    unsupported: fixtures.filter((item) => item.android === 'unsupported').length,
    runnerFailed: fixtures.filter((item) => item.android === 'runner-failed').length,
    invalidOutput: fixtures.filter((item) => item.android === 'invalid-output').length,
    failed,
    typescriptFailed: fixtures.filter((item) => item.typescriptComparison === 'fail').length,
    typescript: typescript.status,
    androidRoot,
  },
}
console.log(JSON.stringify(report, null, 2))
if (typescript.status === 'fail') process.exit(1)
if (failed > 0) process.exit(1)
if (blocked > 0 && options.requireAndroid) process.exit(2)

function parseArgs(args) {
  const result = { help: false, requireAndroid: false, skipTypescript: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--require-android') result.requireAndroid = true
    else if (arg === '--skip-typescript') result.skipTypescript = true
    else if (arg === '--android' || arg === '--fixtures') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} 需要目录`)
      result[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--android=') || arg.startsWith('--fixtures=')) {
      const separator = arg.indexOf('=')
      result[arg.slice(2, separator)] = arg.slice(separator + 1)
    } else throw new Error(`未知参数: ${arg}`)
  }
  return result
}

function runTypescriptConformance() {
  const command = spawnSync(process.execPath, ['scripts/run-source-conformance-typescript.mjs'], { cwd: repositoryRoot, encoding: 'utf8' })
  const output = `${command.stdout ?? ''}${command.stderr ?? ''}`
  try {
    const report = JSON.parse(command.stdout)
    return { status: command.status === 0 && report.summary?.failed === 0 ? 'pass' : 'fail', fixtures: report.fixtures ?? [], output: output.slice(-8_000) }
  } catch {
    return { status: 'fail', fixtures: [], output: output.slice(-8_000) }
  }
}

async function findAndroidOutput(root, id) {
  const safeId = id.replaceAll('/', '__')
  const candidates = [
    join(root, `${id}.json`),
    join(root, `${safeId}.json`),
    join(root, 'cases', `${id}.json`),
    join(root, id, 'result.json'),
    join(root, `${id}.golden.json`),
  ]
  for (const path of candidates) {
    try {
      await access(path)
    } catch {
      continue
    }
    try {
      return { kind: 'json', path, value: await readJson(path) }
    } catch (error) {
      return { kind: 'invalid-json', path, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { kind: 'missing' }
}

function normalizeAndroidOutput(id, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'schemaVersion')) {
    const unknownKeys = Object.keys(value).filter((key) => !['schemaVersion', 'fixtureId', 'status', 'result'].includes(key))
    if (unknownKeys.length > 0) return { error: `runner 输出包含未知字段: ${unknownKeys.join(',')}` }
    if (value.schemaVersion !== 1) return { error: `schemaVersion 必须为 1: ${String(value.schemaVersion)}` }
    if (value.fixtureId !== id) return { error: `fixtureId 不匹配: expected=${id}, actual=${String(value.fixtureId)}` }
    if (!['pass', 'unsupported', 'failed', 'runner-failed'].includes(value.status)) return { error: `runner status 无效: ${String(value.status)}` }
    if (!Object.hasOwn(value, 'result')) return { error: 'runner result 缺失' }
    return { status: value.status, result: value.result }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'result') && (Object.hasOwn(value, 'id') || Object.hasOwn(value, 'fixtureId'))) return { status: 'pass', result: value.result }
    if (Object.hasOwn(value, 'output') && (Object.hasOwn(value, 'id') || Object.hasOwn(value, 'fixtureId'))) return { status: 'pass', result: value.output }
  }
  return { status: 'pass', result: value }
}

function stableJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]))
  return value
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
