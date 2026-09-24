import assert from 'node:assert/strict'
import test from 'node:test'
import { exportSource, importSources, sameSourceDefinition } from '../src/index.ts'

const source = {
  bookSourceUrl: 'https://example.test/books',
  bookSourceName: 'Example',
  ruleSearch: JSON.stringify({ bookList: '.book', name: '.title' }),
  unknownNested: { preserve: true },
}

test('导入对象保留未知字段并接受缺省名称', async () => {
  const candidates = await importSources(JSON.stringify({ bookSourceUrl: 'A', customField: { value: 1 } }))
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.status, 'ready')
  assert.equal(candidates[0]?.source?.bookSourceName, '')
  assert.deepEqual(candidates[0]?.unknownFields, { customField: { value: 1 } })
})

test('加载候选分配 UUID，重名源按规则定义而不是名称判重', async () => {
  const renamed = await importSources(JSON.stringify({ ...source, bookSourceName: 'Other name' }))
  const changed = await importSources(JSON.stringify({ ...source, ruleSearch: { bookList: '.different' } }))
  const sameNameDifferentRules = await importSources(JSON.stringify([source, { ...source, ruleSearch: { bookList: '.different' } }]))
  assert.match(renamed[0]!.sourceUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.notEqual(renamed[0]!.sourceUuid, changed[0]!.sourceUuid)
  assert.equal(sameNameDifferentRules.length, 2)
  assert.ok(sameSourceDefinition(renamed[0]!.source!, (await importSources(JSON.stringify({ ...source, bookSourceName: 'Third name' })))[0]!.source!))
  assert.notEqual(renamed[0]!.sourceFingerprint, changed[0]!.sourceFingerprint)
})

test('数组成员逐项产生候选，非法成员不阻断合法成员', async () => {
  const candidates = await importSources(JSON.stringify([source, { bookSourceName: 'bad' }]))
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0]?.status, 'ready')
  assert.equal(candidates[1]?.status, 'invalid')
  assert.equal(candidates[1]?.error?.code, 'source-url-missing')
})

test('规则对象、JSON 字符串、null 和空字符串保持明确语义', async () => {
  const candidates = await importSources(JSON.stringify({ ...source, ruleSearch: { bookList: '.book' }, ruleExplore: null, ruleToc: '' }))
  assert.deepEqual(candidates[0]?.source?.ruleSearch, { bookList: '.book' })
  assert.equal(candidates[0]?.source?.ruleExplore, null)
  assert.equal(candidates[0]?.source?.ruleToc, null)
})

test('导入替换先改变文本，再重新解析规范化源', async () => {
  const candidates = await importSources(JSON.stringify(source), {
    replacements: [{ ruleId: 'rename', search: 'Example', replacement: 'Replaced' }],
  })
  assert.equal(candidates[0]?.source?.bookSourceName, 'Replaced')
  assert.equal(candidates[0]?.replacements[0]?.applied, true)
  assert.equal(candidates[0]?.status, 'ready')
})

test('普通非法文本返回输入错误，不误报为 JavaScript 能力缺失', async () => {
  const candidates = await importSources('not json')
  assert.equal(candidates[0]?.error?.code, 'input-invalid-json')
})

test('未修改 JSON/JavaScript 候选逐字导出', async () => {
  const jsonText = `${JSON.stringify(source)}\n`
  const jsonCandidate = (await importSources(jsonText))[0]
  assert.equal(exportSource(jsonCandidate!, { format: 'json' }).text, jsonText)

  const jsText = `const config = ${JSON.stringify(source)};\nfunction search() { return []; }\n`
  const jsCandidate = (await importSources({ kind: 'javascript', text: jsText }))[0]
  assert.equal(jsCandidate?.status, 'ready')
  assert.equal(exportSource(jsCandidate!, { format: 'javascript' }).text, jsText)
})

test('动态 JavaScript 没有静态配置时显式诊断', async () => {
  const candidates = await importSources({ kind: 'javascript', text: 'const config = await getConfig();' })
  assert.equal(candidates[0]?.status, 'invalid')
  assert.equal(candidates[0]?.diagnostics[0]?.code, 'requires-javascript')
})

test('sourceUrls 只展开一层并使用受控 reader', async () => {
  const calls: string[] = []
  const candidates = await importSources(JSON.stringify({ sourceUrls: ['https://a.test', 'https://b.test'] }), {
    reader: {
      async read(request) {
        calls.push(request.uri)
        return { text: JSON.stringify({ ...source, bookSourceUrl: request.uri }) }
      },
    },
  })
  assert.deepEqual(calls, ['https://a.test', 'https://b.test'])
  assert.deepEqual(candidates.map((item) => item.source?.bookSourceUrl), ['https://a.test', 'https://b.test'])
})

test('读取限制、取消和失败不会产生可写候选', async () => {
  const tooLarge = await importSources({ kind: 'text', text: JSON.stringify(source) }, { limits: { maxBytes: 1 } })
  assert.equal(tooLarge[0]?.error?.code, 'response-too-large')
  const controller = new AbortController()
  controller.abort()
  const cancelled = await importSources(JSON.stringify(source), { signal: controller.signal })
  assert.equal(cancelled[0]?.error?.code, 'cancelled')
  const failed = await importSources({ kind: 'uri', uri: 'https://a.test' }, { reader: { read: async () => { throw new Error('network') } } })
  assert.equal(failed[0]?.error?.code, 'reader-failed')
})
