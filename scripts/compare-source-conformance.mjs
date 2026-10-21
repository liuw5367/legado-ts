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
<id>/result.json 或 <id>.golden.json；文件内容可以直接是 expected JSON，
也可以是 {"id":"...","result":<expected JSON>} 包装对象。`)
  process.exit(0)
}

const fixturesRoot = resolve(options.fixtures ?? defaultFixtures)
const androidRoot = resolve(options.android ?? defaultAndroid)
const manifest = await readJson(join(fixturesRoot, 'manifest.json'))
if (manifest.version !== 2 || !Array.isArray(manifest.fixtures)) throw new Error('conformance manifest version 必须为 2')

let typescript = { status: 'skipped', output: '' }
if (!options.skipTypescript) typescript = runTypescriptConformance()
const cases = manifest.fixtures.filter((fixture) => typeof fixture.case === 'string' && fixture.typescript === 'source-cross-runtime.test.ts')
const fixtures = []
for (const fixture of cases) {
  const expectedPath = join(fixturesRoot, fixture.expected)
  const expected = await readJson(expectedPath)
  const output = await findAndroidOutput(androidRoot, fixture.id)
  if (output === undefined) {
    fixtures.push({ id: fixture.id, typescript: typescript.status === 'pass' ? 'pass' : typescript.status, android: 'not-run', comparison: 'not-run', expected: expectedPath })
    continue
  }
  const actual = unwrapOutput(output.value)
  const equal = stableJson(actual) === stableJson(expected)
  fixtures.push({ id: fixture.id, typescript: typescript.status === 'pass' ? 'pass' : typescript.status, android: equal ? 'pass' : 'fail', comparison: equal ? 'pass' : 'fail', output: output.path, ...(equal ? {} : { difference: { expected, actual } }) })
}

const missing = fixtures.filter((item) => item.android === 'not-run').length
const failed = fixtures.filter((item) => item.comparison === 'fail').length
const report = {
  version: 1,
  fixtures,
  summary: { total: fixtures.length, passed: fixtures.length - missing - failed, missing, failed, typescript: typescript.status, androidRoot },
}
console.log(JSON.stringify(report, null, 2))
if (typescript.status === 'fail') process.exit(1)
if (failed > 0) process.exit(1)
if (missing > 0 && options.requireAndroid) process.exit(2)

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
  const command = spawnSync(process.execPath, ['--test', 'packages/source-node/tests/source-cross-runtime.test.ts'], { cwd: repositoryRoot, encoding: 'utf8' })
  const output = `${command.stdout ?? ''}${command.stderr ?? ''}`
  return { status: command.status === 0 ? 'pass' : 'fail', output: output.slice(-8_000) }
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
    try { await access(path); return { path, value: await readJson(path) } } catch { /* candidate absent */ }
  }
  return undefined
}

function unwrapOutput(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value
    if (Object.hasOwn(record, 'result') && (Object.hasOwn(record, 'id') || Object.hasOwn(record, 'fixtureId'))) return record.result
    if (Object.hasOwn(record, 'output') && (Object.hasOwn(record, 'id') || Object.hasOwn(record, 'fixtureId'))) return record.output
  }
  return value
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
