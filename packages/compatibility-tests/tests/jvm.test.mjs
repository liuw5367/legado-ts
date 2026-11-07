import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepare } from '../scripts/prepare-jvm.mjs'
import { root, loadCases } from '../scripts/common.mjs'
import { spawnSync } from 'node:child_process'
import { Worker } from '../scripts/worker.mjs'
let worker
let java
let javaClasspath
before(async () => {
  const build = await prepare()
  const classpath = (await readFile(join(root, 'jvm/target/classpath.txt'), 'utf8')).trim()
  assert.ok(!classpath.includes('android.jar'))
  assert.ok(!classpath.toLowerCase().includes('robolectric'))
  java = build.java
  javaClasspath = `${join(root, 'jvm/target/classes')}:${classpath}`
  worker = new Worker(build.java, ['-cp', `${join(root, 'jvm/target/classes')}:${classpath}`, 'compat.MainKt'])
})
after(async () => { await worker?.close() })
test('参考端协议保留未配对 UTF-16 代码单元', async () => {
  const result = await worker.run({ id: 'unicode', operation: 'string.split', input: { text: '😀a', pattern: '', limit: 0 } })
  assert.equal(result.execution, 'completed')
  assert.deepEqual(result.value, ['\ud83d', '\ude00', 'a'])
})
test('参考端区分被测异常、未支持与后续正常结果', async () => {
  assert.equal((await worker.run({ id: 'bad', operation: 'string.split', input: { text: 'x', pattern: '[', limit: 0 } })).outcome, 'throw')
  assert.equal((await worker.run({ id: 'missing', operation: 'missing', input: {} })).execution, 'unsupported')
  assert.deepEqual((await worker.run({ id: 'next', operation: 'rule.split', input: { rule: 'a&&b', operator: '&&' } })).value, ['a', 'b'])
})
test('参考端保持 null 与超过 JS 安全范围的整数', async () => {
  const empty = await worker.run({ id: 'none', operation: 'regex.first', input: { text: 'a', patterns: ['z'] } })
  assert.equal(empty.value, null)
  const long = await worker.run({ id: 'long', operation: 'integer.parseLong', input: { text: '9223372036854775807' } })
  assert.deepEqual(long.value, { type: 'integer', decimal: '9223372036854775807' })
})

test('XPath 专用 join 适配保持空集合、null、Unicode 和顺序', () => {
  const result = spawnSync(java, ['-cp', javaClasspath, 'compat.MainKt', '--test-join'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['', 'null|中文|😀', '2/1', 'anullb'])
})

test('上游 RuleAnalyzer 的 code 参数改变带引号转义规则的结果', async () => {
  const input = { rule: String.raw`x[foo("a\"&&b")]&&y`, operator: '&&' }
  const plain = await worker.run({ id: 'plain', operation: 'rule.split', input: { ...input, code: false } })
  assert.equal(plain.outcome, 'throw')
  assert.match(plain.error.message, /未平衡/u)
  const code = await worker.run({ id: 'code', operation: 'rule.split', input: { ...input, code: true } })
  assert.equal(code.outcome, 'return')
  assert.deepEqual(code.value, [String.raw`x[foo("a\"&&b")]`, 'y'])
})

test('JVM 流程严格匹配 query 和请求预算，失败后重新执行不污染状态', async () => {
  const [item] = await loadCases({ case: 'flow.yiove.html.success' })
  const initial = await worker.run(item)
  assert.equal(initial.execution, 'completed')
  const missingQuery = structuredClone(item)
  missingQuery.input.responses.search.url = missingQuery.input.responses.search.url.split('?')[0]
  assert.equal((await worker.run(missingQuery)).execution, 'runner-failed')
  const budget = structuredClone(item)
  budget.input.requestLimit = 1
  assert.equal((await worker.run(budget)).execution, 'runner-failed')
  assert.deepEqual(await worker.run(item), initial)
})
