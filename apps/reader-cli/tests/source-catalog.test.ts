import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSourceCatalog, usableSources } from '../src/source-catalog.ts'

test('本地书源目录递归导入并过滤文本能力', async () => {
  const catalog = await loadSourceCatalog(new URL('../../../fixtures/source/collection', import.meta.url).pathname)
  assert.ok(catalog.entries.length > 0)
  assert.ok(usableSources(catalog).every((entry) => entry.source.bookSourceType === 0))
  assert.equal(catalog.loadedFromCache, false)
})

test('缺少来源时返回可展示诊断，不发起网络请求', async () => {
  const catalog = await loadSourceCatalog(undefined)
  assert.equal(catalog.entries.length, 0)
  assert.match(catalog.diagnostics[0] ?? '', /没有配置书源/)
})
