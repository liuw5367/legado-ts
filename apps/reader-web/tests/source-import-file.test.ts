import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareSourceImportJson } from '../src/lib/source-import-file.ts'

test('本地上传过滤非文本类型并保留文本、文本文件和旧书源', () => {
  const sources = [0, 1, 2, 3, 4, 5].map((bookSourceType) => ({ bookSourceType, bookSourceName: `类型 ${bookSourceType}` }))
  const legacy = { bookSourceName: '旧书源', ruleContent: { content: '正文\n保留空白' } }
  const prepared = prepareSourceImportJson(JSON.stringify([...sources, legacy], null, 2))
  assert.equal(prepared.filteredCount, 4)
  assert.deepEqual(JSON.parse(prepared.jsonText), [sources[0], sources[3], legacy])
  assert.equal(prepared.jsonText, JSON.stringify([sources[0], sources[3], legacy]))
})

test('支持单个书源，非书籍全部过滤时不上传', () => {
  assert.deepEqual(JSON.parse(prepareSourceImportJson('{"bookSourceType":0}').jsonText), { bookSourceType: 0 })
  assert.throws(() => prepareSourceImportJson('{"bookSourceType":1}'), /没有可导入/)
  assert.throws(() => prepareSourceImportJson('[{"bookSourceType":2},{"bookSourceType":4}]'), /没有可导入/)
})

test('无效输入保留原有校验，格式异常条目交给服务端诊断', () => {
  assert.throws(() => prepareSourceImportJson('  '), /不能为空/)
  assert.throws(() => prepareSourceImportJson('{'), /有效的 JSON/)
  const value = [null, { bookSourceType: '1' }, { bookSourceType: 1.5 }]
  assert.deepEqual(JSON.parse(prepareSourceImportJson(JSON.stringify(value)).jsonText), value)
})
