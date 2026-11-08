import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { root, repository, readJson, sha256, stable, git, treeHash, loadCases } from './common.mjs'
import { prepare } from './prepare-jvm.mjs'
import { Worker } from './worker.mjs'
import { compareCase, summarize, assertProvenance, measureCoverage } from './compare.mjs'

const options = {}
try {
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--') continue
  if (key === '--help') { console.log('用法: test [--family <族>] [--case <id>] [--upstream <目录>] [--runtime ts|jvm]'); process.exit(0) }
  if (!['--family', '--case', '--upstream', '--runtime'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`未知参数或缺少值: ${key}`)
  options[key.slice(2)] = process.argv[++i]
}
if (options.runtime && !['ts', 'jvm'].includes(options.runtime)) throw new Error('--runtime 必须为 ts 或 jvm')
} catch (error) { console.error(error.message); process.exit(2) }
let directory
const workers = {}
try {
  const cases = await loadCases(options)
  if (!cases.length) throw new Error('所选案例为空，不能报告通过')
  await mkdir(join(root, 'output'), { recursive: true })
  directory = await mkdtemp(join(root, 'output/run-'))
  await writeFile(join(directory, 'cases.json'), JSON.stringify(cases, null, 2) + '\n')
  let coreBuildHash
  if (options.runtime !== 'jvm') {
    // SourceRuleHost 通过包导出加载 core/dist；先构建并记录产物，防止执行旧 JS 却声明新源码。
    execFileSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(repository, 'tsconfig.build.json')], { cwd: repository, stdio: 'pipe' })
    coreBuildHash = await treeHash(join(repository, 'packages/source-core/dist'))
  }
  const lock = await readJson(join(root, 'reference-sources.json'))
  const base = {
    schemaVersion: 1,
    ...(coreBuildHash ? { coreBuildHash } : {}),
    inputHash: sha256(stable(cases)),
    implementationHash: sha256(stable([await treeHash(root), await treeHash(join(repository, 'packages/source-core/src')), await treeHash(join(repository, 'packages/source-node/src')), sha256(await readFile(join(repository, 'pnpm-lock.yaml')))])),
    tsCommit: git(repository, 'rev-parse', 'HEAD').trim(),
    tsDiffHash: sha256(git(repository, 'diff', 'HEAD', '--', 'packages/source-core', 'packages/source-node', 'pnpm-lock.yaml')),
    referenceCommit: lock.commit,
    startedAt: new Date().toISOString(),
    node: process.version,
    command: process.argv,
  }
  await writeFile(join(directory, 'metadata.json'), JSON.stringify(base, null, 2) + '\n')
  const runtimes = options.runtime ? [options.runtime] : ['jvm', 'ts']
  const results = {}
  for (const runtime of runtimes) {
    let setupError
    let build
    try {
      if (runtime === 'jvm') {
        build = await prepare(options.upstream)
        const classpath = (await readFile(join(root, 'jvm/target/classpath.txt'), 'utf8')).trim()
        workers.jvm = new Worker(build.java, ['-Dfile.encoding=UTF-8', '-cp', `${join(root, 'jvm/target/classes')}:${classpath}`, 'compat.MainKt'], { cwd: root })
        const version = spawnSync(build.java, ['-version'], { encoding: 'utf8' })
        if (version.status !== 0) throw new Error('无法读取 JDK 版本')
        build = { ...build, javaVersion: `${version.stdout}${version.stderr}`.trim() }
      } else workers.ts = new Worker(process.execPath, [join(root, 'scripts/ts-worker.mjs')], { cwd: repository })
    } catch (error) { setupError = error.message }
    results[runtime] = []
    for (const item of cases) {
      const result = setupError ? { id: item.id, execution: 'runner-failed', reason: setupError } : await workers[runtime].run(item)
      results[runtime].push(result)
      console.log(`${runtime.padEnd(3)} ${item.id}: ${result.execution}/${result.outcome ?? '-'}`)
    }
    const metadata = { ...base, runtime, ...(build ? { build } : {}), finishedAt: new Date().toISOString() }
    const payload = { metadata, results: results[runtime] }
    await writeFile(join(directory, `${runtime}.json`), JSON.stringify(payload, null, 2) + '\n')
    if (workers[runtime]) {
      await workers[runtime].close()
      await writeFile(join(directory, `${runtime}.stderr.log`), workers[runtime].stderr)
    }
  }
  if (options.runtime) {
    console.log(`单端执行结束，不代表兼容通过。产物: ${directory}`)
    process.exitCode = results[options.runtime].some((r) => r.execution !== 'completed') ? 2 : 0
  } else {
    for (const runtime of runtimes) assertProvenance((await readJson(join(directory, `${runtime}.json`))).metadata, base)
    const comparisons = cases.map((item, index) => ({ ...compareCase(item, results.jvm[index], results.ts[index]), operation: item.operation, ...(item.input.stopAfter ? { stopAfter: item.input.stopAfter } : {}), reference: item.reference, ...(item.origin ? { origin: item.origin } : {}), ...(item.flowOrigin ? { flowOrigin: item.flowOrigin } : {}) }))
    const summary = summarize(comparisons)
    summary.flow.byOperation = Object.fromEntries(['flow.book', 'flow.toc', 'flow.contentLifecycle', 'flow.contentBatch', 'flow.loginHeader', 'flow.discover', 'flow.mainJs'].map((operation) => {
      const selected = comparisons.filter((item) => item.operation === operation)
      return [operation, { total: selected.length, equal: selected.filter((item) => item.status === 'equal').length }]
    }))
    summary.flow.byScope = Object.fromEntries(['complete', 'stage'].map((scope) => {
      const selected = comparisons.filter((item) => item.contractScope === 'flow'
        && (['flow.book', 'flow.mainJs'].includes(item.operation) && !item.stopAfter ? 'complete' : 'stage') === scope)
      return [scope, { total: selected.length, equal: selected.filter((item) => item.status === 'equal').length }]
    }))
    const coverage = await readJson(join(root, 'coverage.json'))
    const coverageReport = measureCoverage(coverage.entries, cases, comparisons, results.jvm)
    const corpus = await readJson(join(root, 'corpus/coverage.json'))
    const caseStatus = new Map(comparisons.map(({ id, status }) => [id, status]))
    const corpusCoverage = corpus.dimensions.map((dimension) => ({
      ...dimension,
      status: dimension.caseIds.every((id) => caseStatus.has(id))
        ? dimension.caseIds.every((id) => caseStatus.get(id) === 'equal') ? 'verified' : 'different'
        : 'not-run',
    }))
    await writeFile(join(directory, 'coverage.json'), JSON.stringify({ entries: coverageReport }, null, 2) + '\n')
    await writeFile(join(directory, 'corpus-coverage.json'), JSON.stringify({ dimensions: corpusCoverage, excluded: corpus.excluded }, null, 2) + '\n')
    await writeFile(join(directory, 'report.json'), JSON.stringify({ metadata: base, summary, cases: comparisons }, null, 2) + '\n')
    const lines = ['# JVM / TS 差异报告', '', `- 总数：${summary.total}`, `- 流程案例：${summary.flow.total}；一致：${summary.flow.equal}；完整流程：${summary.flow.byScope.complete.total}；阶段用例：${summary.flow.byScope.stage.total}`, `- API 契约案例：${summary.api.total}；内部观察：${summary.observations}`, `- 原始差异：${summary.rawDifferent}；异常语义等价：${summary.errorEquivalent}`, `- 一致：${summary.equal}`, `- 差异：${summary.different}`, `- 允许差异：${summary['allowed-difference']}`, `- 未支持：${summary.unsupported}`, `- 执行失败：${summary['runner-failed']}`, '', '| 案例 | 功能族 | 状态 |', '| --- | --- | --- |', ...comparisons.map((c) => `| ${c.id} | ${c.family} | ${c.status} |`), '', '逐字段差异、双方原始结果、异常和版本记录见同目录 JSON 文件。', '']
    lines.push('## 方法覆盖', '', '| 方法 | 状态 | 缺少维度 |', '| --- | --- | --- |')
    for (const entry of coverageReport) lines.push(`| ${entry.method.replaceAll('|', '\\|')} | ${entry.status} | ${entry.missingDimensions.join(', ') || '—'} |`)
    lines.push('')
    for (const item of comparisons.filter((c) => c.status !== 'equal')) {
      lines.push(`## ${item.id}`, '', `操作：${item.operation}；参考：${item.reference.kind} / ${item.reference.method}`, '', '```json', JSON.stringify(item, null, 2), '```', '')
    }
    await writeFile(join(directory, 'report.md'), lines.join('\n'))
    console.log(JSON.stringify(summary, null, 2))
    console.log(`报告: ${join(directory, 'report.md')}`)
    process.exitCode = summary.exitCode
  }
} catch (error) {
  console.error(error.message)
  if (directory) await writeFile(join(directory, 'runner-error.json'), JSON.stringify({ error: error.message }, null, 2) + '\n')
  process.exitCode = 2
} finally {
  for (const worker of Object.values(workers)) await worker.close()
}
