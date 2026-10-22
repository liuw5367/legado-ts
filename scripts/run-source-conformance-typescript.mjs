#!/usr/bin/env node

import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const fixturesRoot = resolve(repositoryRoot, 'fixtures/conformance')
const options = parseArgs(process.argv.slice(2))
const manifest = await readJson(join(fixturesRoot, 'manifest.json'))
const cases = manifest.fixtures.filter((fixture) => fixture.typescript === 'source-cross-runtime.test.ts' && typeof fixture.case === 'string')
const outputDirectory = options.output === undefined
  ? await mkdtemp(join(tmpdir(), 'legado-conformance-typescript-'))
  : resolve(options.output)
const { NODE_TEST_CONTEXT: _nodeTestContext, NODE_TEST_NAME: _nodeTestName, ...cleanEnvironment } = process.env
const command = spawnSync(process.execPath, ['--test', options.test], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: { ...cleanEnvironment, LEGADO_CONFORMANCE_OUTPUT_DIR: outputDirectory },
})
const testOutput = `${command.stdout ?? ''}${command.stderr ?? ''}`
const fixtures = []
for (const fixture of cases) {
  const path = join(outputDirectory, `${fixture.id.replaceAll('/', '__')}.json`)
  let value
  try {
    await access(path)
    value = await readJson(path)
  } catch {
    fixtures.push({ id: fixture.id, status: 'runner-failed', comparison: 'not-run', error: 'fixture runner 没有生成结果文件' })
    continue
  }
  if (!isRunnerResult(value, fixture.id)) {
    fixtures.push({ id: fixture.id, status: 'runner-failed', comparison: 'fail', error: 'fixture runner 输出不符合 runner-result.schema.json' })
    continue
  }
  if (value.status !== 'pass') {
    fixtures.push({ id: fixture.id, status: value.status, comparison: 'not-run', result: value.result })
    continue
  }
  const expected = await readJson(join(fixturesRoot, fixture.expected))
  const equal = stableJson(value.result) === stableJson(expected)
  fixtures.push({ id: fixture.id, status: 'pass', comparison: equal ? 'pass' : 'fail', result: value.result, ...(equal ? {} : { expected }) })
}

const report = {
  version: 1,
  runner: 'typescript-node-test',
  test: options.test,
  fixtures,
  summary: {
    total: fixtures.length,
    passed: fixtures.filter((fixture) => fixture.comparison === 'pass').length,
    failed: fixtures.filter((fixture) => fixture.comparison === 'fail').length,
    blocked: fixtures.filter((fixture) => ['not-run', 'unsupported', 'runner-failed'].includes(fixture.status)).length,
    runnerFailed: fixtures.filter((fixture) => fixture.status === 'runner-failed').length,
    processExit: command.status,
    outputDirectory,
  },
  testOutput: testOutput.slice(-8_000),
}
console.log(JSON.stringify(report, null, 2))

if (command.status !== 0 || report.summary.failed > 0 || report.summary.runnerFailed > 0) process.exitCode = 1
if (options.output === undefined) await rm(outputDirectory, { recursive: true, force: true })

function parseArgs(args) {
  const result = { test: 'packages/source-node/tests/source-cross-runtime.test.ts' }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--output' || arg === '--test') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} 需要值`)
      result[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--output=') || arg.startsWith('--test=')) {
      const separator = arg.indexOf('=')
      result[arg.slice(2, separator)] = arg.slice(separator + 1)
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/run-source-conformance-typescript.mjs [--output <目录>] [--test <测试文件>]')
      process.exit(0)
    } else throw new Error(`未知参数: ${arg}`)
  }
  return result
}

function isRunnerResult(value, fixtureId) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1
    && value.fixtureId === fixtureId
    && ['pass', 'unsupported', 'failed', 'runner-failed'].includes(value.status)
    && Object.hasOwn(value, 'result')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function stableJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]))
  return value
}
