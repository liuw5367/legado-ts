import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { compareCase, differences, summarize, assertProvenance, measureCoverage } from '../scripts/compare.mjs'
import { root, loadCases, sha256, stable, validateCase, validateResult, treeHash, readJson } from '../scripts/common.mjs'
import { Worker } from '../scripts/worker.mjs'
import { collectCorpusRules } from '../scripts/corpus-rules.mjs'

const fixture = { id: 'test', family: 'mechanism', operation: 'encoding.md5', input: { text: 'a' }, reference: { kind: 'jdk-direct', method: 'test' }, tags: [] }
const returned = (value) => ({ id: 'test', execution: 'completed', outcome: 'return', value })
const thrown = (name, message) => ({ id: 'test', execution: 'completed', outcome: 'throw', error: { class: name, message } })

test('方法覆盖只采用本次双端通过的维度证据', () => {
  const basic = { ...fixture, tags: ['normal'] }
  const edge = { ...fixture, id: 'edge', tags: ['boundary'] }
  const entries = [{ caseIds: [basic.id, edge.id], requiredDimensions: ['normal', 'edge', 'error-or-empty'] }]
  const success = returned('ok')
  const empty = { ...returned(''), id: edge.id }
  const cases = [basic, edge]
  const actual = measureCoverage(entries, cases, [compareCase(basic, success, success), compareCase(edge, empty, empty)], [success, empty])[0]
  assert.equal(actual.status, 'verified')
  assert.deepEqual(actual.dimensionEvidence, { normal: [basic.id], edge: [edge.id], 'error-or-empty': [edge.id] })
  const gap = measureCoverage(entries, [basic], [compareCase(basic, success, success)], [success])[0]
  assert.equal(gap.status, 'not-run')
  assert.deepEqual(gap.missingDimensions, ['edge', 'error-or-empty'])
})

test('固定书源规则按原文摘要分组，并保留每个字段及可执行案例来源', async () => {
  const inventory = await collectCorpusRules()
  assert.equal(inventory.sourceCount, 11)
  assert.equal(inventory.rules.length, 177)
  const origins = inventory.rules.flatMap((rule) => rule.origins)
  assert.equal(origins.length, 234)
  assert.equal(new Set(origins.map(({ index, field }) => `${index}:${field}`)).size, origins.length)
  const shared = inventory.rules.find((rule) => rule.text === 'img@src')
  assert.equal(shared.origins.length, 7)
  assert.ok(inventory.rules.find((rule) => rule.text === '@CSS:.name a@text').caseIds.includes('corpus.source-0.search-name'))
  const coverage = await readJson(join(root, 'corpus/coverage.json'))
  const cases = new Map((await loadCases()).map((item) => [item.id, item]))
  const sourceCases = new Set(inventory.rules.flatMap((rule) => rule.caseIds))
  for (const dimension of coverage.dimensions) {
    assert.ok(dimension.caseIds.length > 0, dimension.syntax)
    for (const id of dimension.caseIds) {
      assert.ok(sourceCases.has(id), id)
      assert.equal(cases.get(id).expected.outcome, 'return', id)
    }
  }
  const allSamples = new Set(coverage.dimensions.flatMap((dimension) => dimension.caseIds))
  const scriptRules = inventory.rules.filter((rule) => /<js>|@js:/iu.test(rule.text))
  assert.equal(scriptRules.length, 7)
  for (const rule of scriptRules) {
    assert.equal(rule.caseIds.length, 1, rule.sha256)
    assert.ok(rule.caseIds.some((id) => allSamples.has(id) && cases.get(id).operation === 'corpus.script'), rule.sha256)
  }
})

test('比较忽略对象键顺序，保留数组顺序、空值、Unicode 与大整数文本', () => {
  assert.equal(compareCase(fixture, returned({ a: 1, b: 2 }), returned({ b: 2, a: 1 })).status, 'equal')
  for (const [left, right] of [[null, ''], [[], null], [[1, 2], [2, 1]], ['\ud83d', '?'], [{ type: 'integer', decimal: '9223372036854775807' }, { type: 'integer', decimal: '9223372036854775806' }]]) {
    assert.equal(compareCase(fixture, returned(left), returned(right)).status, 'different')
  }
  assert.deepEqual(differences({ a: 1 }, { a: 2 }), [{ path: '$/a', jvm: 1, ts: 2 }])
})
test('缺失字段不会与实际的 missing 标记对象混同', () => {
  assert.equal(differences({}, { a: null }).length, 1)
  assert.equal(differences({}, { a: { type: 'missing' } }).length, 1)
  assert.equal(differences([], [{ type: 'missing' }]).length, 1)
  assert.equal(differences({ 'a/b~': 1 }, { 'a/b~': 2 })[0].path, '$/a~1b~0')
})
test('异常需要显式的逐案例等价映射，仍保留原始结果', () => {
  const jvm = thrown('IllegalArgumentException', 'bad arg')
  const ts = thrown('RangeError', 'invalid input')
  assert.equal(compareCase(fixture, jvm, ts).status, 'different')
  assert.equal(compareCase({ ...fixture, errorEquivalence: { category: 'invalid-input', jvm: ['IllegalArgumentException'], ts: ['RangeError'] } }, jvm, ts).status, 'equal')
  assert.equal(compareCase(fixture, thrown('Error', 'a'), thrown('Error', 'b')).status, 'different')
  assert.equal(jvm.error.class, 'IllegalArgumentException')
})
test('允许差异必须精确匹配路径和双方值，expected 另行断言', () => {
  const item = { ...fixture, allowedDifferences: [{ path: '$/value', jvm: 1, ts: 2, reason: '明确批准的限制' }] }
  assert.equal(compareCase(item, returned(1), returned(2)).status, 'allowed-difference')
  assert.equal(compareCase(item, returned(1), returned(3)).status, 'different')
  assert.equal(compareCase({ ...fixture, expected: { outcome: 'return', value: 3 } }, returned(2), returned(2)).status, 'different')
})
test('缺失、错误 id、未支持、执行失败不计入通过', () => {
  assert.equal(compareCase(fixture, undefined, returned(1)).status, 'runner-failed')
  assert.equal(compareCase(fixture, { ...returned(1), id: 'wrong' }, returned(1)).status, 'runner-failed')
  assert.equal(compareCase(fixture, { id: 'test', execution: 'unsupported', reason: 'not implemented' }, returned(1)).status, 'unsupported')
  assert.equal(summarize([{ status: 'different' }, { status: 'runner-failed' }]).exitCode, 2)
  assert.equal(summarize([{ status: 'different' }]).exitCode, 1)
  assert.equal(summarize([{ status: 'equal' }]).exitCode, 0)
})
test('摘要绑定输入和执行代码，拒绝过期产物', () => {
  const metadata = { schemaVersion: 1, inputHash: sha256('a'), implementationHash: sha256('b') }
  assert.doesNotThrow(() => assertProvenance(metadata, metadata))
  assert.throws(() => assertProvenance({ ...metadata, inputHash: sha256('c') }, metadata))
  assert.throws(() => assertProvenance({ ...metadata, implementationHash: sha256('d') }, metadata))
  assert.throws(() => assertProvenance({}, metadata))
  assert.notEqual(sha256(stable({ input: 'before' })), sha256(stable({ input: 'after' })))
})
test('构建产物不改变代码摘要，源码变化会改变摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legado-compat-hash-'))
  try {
    await writeFile(join(directory, 'source.txt'), 'a')
    const before = await treeHash(directory)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'output'))
    await writeFile(join(directory, 'output/report.json'), '{}')
    assert.equal(await treeHash(directory), before)
    await writeFile(join(directory, 'source.txt'), 'b')
    assert.notEqual(await treeHash(directory), before)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('案例合法且唯一；坏输入、结果及允许差异被拒绝', async () => {
  const cases = await loadCases()
  assert.ok(cases.length >= 100)
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length)
  assert.throws(() => validateCase({ ...fixture, id: '' }))
  assert.throws(() => validateCase({ ...fixture, input: { text: 42 } }))
  assert.throws(() => validateCase({ ...fixture, input: {} }))
  assert.throws(() => validateCase({ ...fixture, input: { text: 'a', typo: true } }))
  assert.throws(() => validateCase({ ...fixture, allowedDifferences: [{ path: '$' }] }))
  assert.throws(() => validateResult({ id: 'test', execution: 'completed', outcome: 'return' }, 'test'))
})
test('书源快照与摘要一致；语料不冒充流程执行证据', async () => {
  const manifest = await readJson(join(root, 'corpus/manifest.json'))
  const bytes = await readFile(join(root, 'corpus', manifest.file))
  assert.equal(sha256(bytes), manifest.sha256)
  assert.equal(JSON.parse(bytes).length, manifest.count)
  assert.equal(manifest.execution, 'not-run')
  const sources = JSON.parse(bytes)
  for (const item of await loadCases()) {
    if (!item.origin) continue
    const [section, field] = item.origin.field.split('.')
    assert.equal(item.input.rule, sources[item.origin.index][section][field])
  }
})
test('工作进程超时后恢复，下一例不受影响', async () => {
  const code = "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const i=JSON.parse(line);if(i.id==='hang')return;console.log(JSON.stringify({id:i.id,execution:'completed',outcome:'return',value:1}))})"
  const worker = new Worker(process.execPath, ['-e', code], { timeoutMs: 200 })
  try {
    assert.equal((await worker.run({ id: 'hang' })).execution, 'runner-failed')
    assert.equal((await worker.run({ id: 'next' })).value, 1)
  } finally { await worker.close() }
})
test('协议损坏与进程退出归类为执行失败', async () => {
  for (const code of ["process.stdin.once('data',()=>console.log('bad json'))", "process.stdin.once('data',()=>process.exit(3))"]) {
    const worker = new Worker(process.execPath, ['-e', code], { timeoutMs: 500 })
    try { assert.equal((await worker.run(fixture)).execution, 'runner-failed') } finally { await worker.close() }
  }
})

test('真实 CLI 拒绝无效参数和空选择，返回执行不完整状态', () => {
  for (const args of [['--unknown'], ['--runtime', 'invalid'], ['--case', 'does-not-exist']]) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/run.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2, result.stderr)
  }
})

test('行为等价保留原始差异，且错误标记不能匹配缺失方法', () => {
  const item = { ...fixture, errorEquivalence: { category: 'invalid-pattern', jvm: ['PatternSyntaxException'], ts: ['Error'], tsMessageIncludes: ['__LEGADO_PATTERN__invalid-pattern'] } }
  const jvm = thrown('PatternSyntaxException', 'Unclosed class')
  const equal = compareCase(item, jvm, thrown('Error', '__LEGADO_PATTERN__invalid-pattern: bad pattern'))
  assert.equal(equal.status, 'equal')
  assert.equal(equal.rawComparison, 'different')
  assert.equal(equal.errorEquivalent, true)
  assert.ok(equal.rawDifferences.length > 0)
  assert.equal(compareCase(item, jvm, thrown('Error', 'method is not defined')).status, 'different')
  assert.equal(compareCase(item, returned([]), thrown('Error', '__LEGADO_PATTERN__invalid-pattern')).status, 'different')
})
test('内部观察未执行不计入 API 通过，执行器故障始终失败', () => {
  const item = { ...fixture, contractScope: 'reference-observation' }
  const result = compareCase(item, returned(1), { id: 'test', execution: 'unsupported', reason: '没有独立入口' })
  const summary = summarize([result])
  assert.equal(summary.observations, 1)
  assert.equal(summary.equal, 0)
  assert.equal(summary.api.total, 0)
  assert.equal(summary.unsupported, 1)
  assert.equal(summary.exitCode, 0)
  assert.equal(summarize([{ ...result, status: 'runner-failed' }]).exitCode, 2)
})
test('输入 schema、覆盖清单和差异台账与实际案例一致', async () => {
  const { operationSchemas } = await import('../scripts/sync-case-schema.mjs')
  const operations = await readJson(join(root, 'schema/operations.json'))
  const schema = await readJson(join(root, 'schema/case.schema.json'))
  assert.deepEqual(schema.allOf, operationSchemas(operations))
  assert.deepEqual(schema.properties.operation.enum, Object.keys(operations))
  const cases = await loadCases()
  const ids = new Set(cases.map((c) => c.id))
  for (const item of cases) {
    for (const related of item.relatedCases ?? []) assert.ok(ids.has(related), related)
  }
  const coverage = await readJson(join(root, 'coverage.json'))
  const manifest = await readJson(join(root, '../../fixtures/compatibility/method-manifest.json'))
  const memberIds = new Set(manifest.entries.flatMap((entry) => entry.members.map(({ id }) => id)))
  assert.deepEqual([...new Set(coverage.entries.map((e) => e.operation))].sort(), Object.keys(operations).filter((operation) => operation !== 'flow.book').sort())
  const assigned = new Set()
  for (const entry of coverage.entries) {
    assert.ok(entry.caseIds.length > 0)
    for (const member of entry.manifestMembers ?? []) assert.ok(memberIds.has(member), member)
    for (const id of entry.caseIds) {
      assert.ok(ids.has(id), id)
      assert.equal(cases.find((c) => c.id === id).operation, entry.operation)
      assigned.add(id)
    }
  }
  assert.equal(assigned.size, cases.filter((item) => item.contractScope !== 'flow').length)
  const triage = await readJson(join(root, 'triage.json'))
  const observed = new Set()
  for (const entry of triage.entries) {
    for (const id of entry.caseIds) {
      assert.ok(ids.has(id), id)
      assert.equal(observed.has(id), false, id)
      observed.add(id)
    }
  }
  assert.equal(triage.entries.filter((e) => /^[REO][0-9]/u.test(e.id)).flatMap((e) => e.caseIds).length, 36)
  assert.ok(observed.size >= 36)
})

test('流程严格比较请求顺序和阶段结果，只逐例映射原始错误', () => {
  const item = {
    ...fixture,
    contractScope: 'flow',
    flowErrorEquivalence: {
      stage: 'content', category: 'content-empty',
      jvm: { class: 'ContentEmptyException', message: '内容为空' },
      ts: { class: 'empty-page', message: '正文为空' },
    },
  }
  const { category, jvm, ts } = item.flowErrorEquivalence
  const result = (raw, requests = ['detail', 'content']) => returned({
    stages: { content: { status: 'failed', value: null, error: { category, ...raw } } }, requests,
  })
  const equal = compareCase(item, result(jvm), result(ts))
  assert.equal(equal.status, 'equal')
  assert.equal(equal.errorEquivalent, true)
  assert.equal(equal.rawDifferences[0].path, '$/value/stages/content/error/class')
  const different = compareCase(item, result(jvm), result(ts, ['content', 'detail']))
  assert.equal(different.status, 'different')
  assert.equal(different.differences[0].path, '$/value/requests/0')
  assert.equal(compareCase(item, result(jvm), result({ ...ts, message: '网络失败' })).status, 'different')
  assert.equal(summarize([equal, different]).flow.total, 2)
  assert.equal(summarize([equal, different]).api.total, 0)
  assert.equal(summarize([different]).exitCode, 1)
  assert.equal(summarize([{ ...different, status: 'runner-failed' }]).exitCode, 2)
})

test('TS 流程宿主拒绝未声明的完整请求与超预算请求，随后可以重新执行', async () => {
  const item = (await loadCases({ case: 'flow.yiove.html.success' }))[0]
  const worker = new Worker(process.execPath, [join(root, 'scripts/ts-worker.mjs')])
  try {
    const initial = await worker.run(item)
    assert.equal(initial.execution, 'completed')
    const missingQuery = structuredClone(item)
    missingQuery.input.responses.search.url = missingQuery.input.responses.search.url.split('?')[0]
    assert.equal((await worker.run(missingQuery)).execution, 'runner-failed')
    const budget = structuredClone(item)
    budget.input.requestLimit = 1
    assert.equal((await worker.run(budget)).execution, 'runner-failed')
    assert.deepEqual(await worker.run(item), initial)
  } finally {
    await worker.close()
  }
})

test('POST 离线夹具按方法、完整地址和请求体匹配，并记录实际请求字节', async () => {
  const [item] = await loadCases({ case: 'flow.yiove.post.explicit-header' })
  const worker = new Worker(process.execPath, [join(root, 'scripts/ts-worker.mjs')])
  try {
    const { search } = item.input.responses
    item.input.responses.otherBody = { ...search, body: 's=错误&submit=' }
    item.input.responses.otherMethod = { ...search, method: 'GET' }
    validateCase(item)
    const result = await worker.run(item)
    assert.equal(result.execution, 'completed')
    assert.equal(result.value.requests[0].bodyBase64, Buffer.from('s=星河&submit=').toString('base64'))
    delete item.input.responses.search
    assert.equal((await worker.run(item)).execution, 'runner-failed')
  } finally {
    await worker.close()
  }
})
