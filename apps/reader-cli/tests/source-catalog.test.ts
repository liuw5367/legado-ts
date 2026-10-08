import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadSourceCatalog, usableSources } from '../src/source-catalog.ts'
import { ReaderStorage } from '../src/storage.ts'
import { setEmbeddedSourceInputs } from '../src/embedded-sources.ts'

test('本地书源目录递归导入并过滤文本能力', async () => {
  const catalog = await loadSourceCatalog(new URL('../../../fixtures/source/collection', import.meta.url).pathname)
  assert.ok(catalog.entries.length > 0)
  assert.ok(usableSources(catalog).every((entry) => entry.source.bookSourceType === 0))
  assert.equal(catalog.loadedFromCache, false)
})

test('缺少来源时返回可展示诊断，不发起网络请求', async () => {
  setEmbeddedSourceInputs([])
  try {
    const catalog = await loadSourceCatalog(undefined)
    assert.equal(catalog.entries.length, 0)
    assert.match(catalog.diagnostics[0] ?? '', /没有配置书源/)
  } finally {
    setEmbeddedSourceInputs([])
  }
})

test('未配置外部来源时加载构建入口提供的内置书源', async () => {
  setEmbeddedSourceInputs([{ location: 'builtin:test.json', text: JSON.stringify({ bookSourceUrl: 'https://builtin.test', bookSourceName: '内置书源', bookSourceType: 0, enabled: true, searchUrl: 'https://builtin.test/search?key={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }) }])
  try {
    const catalog = await loadSourceCatalog(undefined)
    assert.equal(catalog.sourceLocation, '内置书源')
    assert.equal(catalog.entries[0]?.source.bookSourceName, '内置书源')
  } finally {
    setEmbeddedSourceInputs([])
  }
})

test('书源目录加载时应用持久化的启用状态、优先级和同版本检测结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-catalog-state-'))
  const dataRoot = join(root, 'data-v1')
  const cacheRoot = join(root, 'cache-v1')
  const sourcePath = join(root, 'source.json')
  const source = { bookSourceUrl: 'https://state.test', bookSourceName: '状态书源', bookSourceType: 0, enabled: true, customOrder: 9, searchUrl: 'https://state.test/search?key={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }
  const storage = new ReaderStorage({ paths: { dataRoot, cacheRoot } })
  await storage.initialize()
  try {
    await writeFile(sourcePath, JSON.stringify(source), 'utf8')
    const initial = await loadSourceCatalog(sourcePath)
    const fingerprint = initial.entries[0]!.fingerprint
    await storage.saveSourceStates({
      [source.bookSourceUrl]: {
        fingerprint,
        enabled: false,
        enabledExplore: true,
        customOrder: -3,
        weight: 0,
        searchHealth: { fingerprint, consecutiveFailures: 2 },
        check: { fingerprint, sessionId: 'session', status: 'failed', startedAt: '2026-01-01T00:00:00.000Z', checkedAt: '2026-01-01T00:00:01.000Z', failedStages: ['search'], stages: [{ stage: 'search', status: 'failed', detail: '搜索失效' }] },
      },
    })
    const catalog = await loadSourceCatalog(sourcePath, { storage })
    assert.equal(catalog.entries[0]?.state, 'disabled')
    assert.equal(catalog.entries[0]?.customOrder, -3)
    assert.equal(catalog.entries[0]?.searchHealth?.consecutiveFailures, 2)
    assert.equal(catalog.entries[0]?.check?.status, 'failed')
    assert.equal(catalog.entries[0]?.source.enabled, false)
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
