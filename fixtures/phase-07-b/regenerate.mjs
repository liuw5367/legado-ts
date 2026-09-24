// 按当前 fixtures/source 语料重生 07-B manifest（测试用的快照）。
// 用法：node fixtures/phase-07-b/regenerate.mjs
// 重新生成后请确认 knownBrokenRules 的新增项确实是源本身的写法问题，而不是解析器回归。
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compileRule, importSources } from '../../packages/source-core/src/index.ts'

const sourceRoot = new URL('../source/', import.meta.url)
const manifestPath = fileURLToPath(new URL('./manifest.json', import.meta.url))
const groups = ['ruleExplore', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview']

const files = []
for (const group of ['collection', 'single']) {
  const directory = new URL(`${group}/`, sourceRoot)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) files.push({ relative: `${group}/${entry.name}`, path: fileURLToPath(new URL(entry.name, directory)) })
  }
}
files.sort((left, right) => left.relative.localeCompare(right.relative))

/** 白名单绑规则原文：同一字段换成另一条坏规则时测试必须红，所以记录规则指纹。 */
const ruleFingerprint = (rule) => createHash('sha256').update(rule).digest('hex').slice(0, 16)

const counts = (values) => values.reduce((result, value) => { result[value] = (result[value] ?? 0) + 1; return result }, {})
const fixtures = []
const knownBrokenRules = []
let totalCandidates = 0
for (const file of files) {
  const candidates = await importSources(await readFile(file.path, 'utf8'))
  totalCandidates += candidates.length
  fixtures.push({
    path: file.relative,
    candidates: candidates.length,
    statuses: counts(candidates.map((candidate) => candidate.status)),
    diagnostics: counts(candidates.flatMap((candidate) => candidate.diagnostics.map((item) => item.code))),
  })
  for (const candidate of candidates) {
    const source = candidate.source
    if (source === undefined) continue
    for (const group of groups) {
      const value = source[group]
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      for (const [field, rule] of Object.entries(value)) {
        if (typeof rule !== 'string' || rule.length === 0) continue
        for (const diagnostic of compileRule(rule).diagnostics) {
          knownBrokenRules.push({ path: file.relative, sourceName: source.bookSourceName, group, field, code: diagnostic.code, ruleHash: ruleFingerprint(rule) })
        }
      }
    }
  }
}

await writeFile(manifestPath, `${JSON.stringify({ version: 2, totalCandidates, fixtures, knownBrokenRules }, null, 2)}\n`)
console.log(`文件 ${files.length}；候选 ${totalCandidates}；已知坏规则 ${knownBrokenRules.length}`)
for (const entry of knownBrokenRules) console.log(' ', entry.path, entry.sourceName, `${entry.group}.${entry.field}`, entry.code)
