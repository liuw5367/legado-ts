#!/usr/bin/env node

import { access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const defaultProject = resolve(repositoryRoot, '..')
const defaultOutput = '/private/tmp/legado-conformance-android/app/build/conformance'
const options = parseArgs(process.argv.slice(2))
const projectRoot = resolve(options.project ?? defaultProject)
const outputDirectory = resolve(options.output ?? defaultOutput)
const checks = {
  projectRoot,
  gradleWrapper: await exists(join(projectRoot, 'gradlew')),
  localProperties: await exists(join(projectRoot, 'local.properties')),
  outputDirectory: await exists(outputDirectory),
  fixtureOutputs: await countFixtureOutputs(outputDirectory),
  adapter: false,
}

// The Android repository has JVM/Android tests, but no adapter that consumes
// fixtures/conformance and writes runner-result.schema.json. Never turn those
// unrelated tests into a false cross-runtime pass.
const report = checks.fixtureOutputs > 0
  ? {
      version: 1,
      runner: 'android-conformance-preflight',
      status: 'available',
      outputDirectory,
      checks,
      reason: '发现已有 Android conformance 输出；请用 compare-source-conformance.mjs 逐条比较。',
    }
  : {
      version: 1,
      runner: 'android-conformance-preflight',
      status: 'not-run',
      outputDirectory,
      checks,
      reason: '当前 Android 仓库没有逐 fixture conformance adapter；普通 JVM/Android 单测不能替代同输入 golden。',
      requiredAdapter: '读取 fixtures/conformance/manifest.json，按 runner-result.schema.json 写出每条 fixture 的实际 result。',
    }
console.log(JSON.stringify(report, null, 2))
if (report.status === 'not-run') process.exitCode = 2

function parseArgs(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--project' || arg === '--output') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} 需要目录`)
      result[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--project=') || arg.startsWith('--output=')) {
      const separator = arg.indexOf('=')
      result[arg.slice(2, separator)] = arg.slice(separator + 1)
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/run-source-conformance-android.mjs [--project <Android 根目录>] [--output <golden 目录>]')
      process.exit(0)
    } else throw new Error(`未知参数: ${arg}`)
  }
  return result
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function countFixtureOutputs(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    let count = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
    const cases = entries.find((entry) => entry.isDirectory() && entry.name === 'cases')
    if (cases) count += (await readdir(join(directory, 'cases'))).filter((name) => name.endsWith('.json')).length
    return count
  } catch {
    return 0
  }
}
