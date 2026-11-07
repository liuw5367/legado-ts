import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { compareCase, differences, summarize, assertProvenance } from '../scripts/compare.mjs'
import { root, loadCases, sha256, stable, validateCase, validateResult, treeHash, readJson } from '../scripts/common.mjs'
import { Worker } from '../scripts/worker.mjs'

const fixture = { id: 'test', family: 'mechanism', operation: 'encoding.md5', input: { text: 'a' }, reference: { kind: 'jdk-direct', method: 'test' }, tags: [] }
const returned = (value) => ({ id: 'test', execution: 'completed', outcome: 'return', value })
const thrown = (name, message) => ({ id: 'test', execution: 'completed', outcome: 'throw', error: { class: name, message } })

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
