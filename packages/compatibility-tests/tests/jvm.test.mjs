import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepare } from '../scripts/prepare-jvm.mjs'
import { root } from '../scripts/common.mjs'
import { Worker } from '../scripts/worker.mjs'
let worker
before(async () => {
  const build = await prepare()
  const classpath = (await readFile(join(root, 'jvm/target/classpath.txt'), 'utf8')).trim()
  assert.ok(!classpath.includes('android.jar'))
  assert.ok(!classpath.toLowerCase().includes('robolectric'))
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
