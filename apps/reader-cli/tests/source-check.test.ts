import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BookCandidate, BookMetadata, Chapter, ChapterContent, NormalizedSource, RuntimeResult } from '@legado/source-core'
import { ReaderApplication } from '../src/application.ts'
import type { ReaderSourceSession } from '../src/application.ts'
import type { SourceCatalogResult, SourceEntry } from '../src/source-catalog.ts'
import { checkSource } from '../src/source-check.ts'
import { ReaderStorage } from '../src/storage.ts'
import type { SourceCheckConfig } from '../src/storage.ts'

const config: SourceCheckConfig = { timeoutMs: 180_000, checkDomain: false, checkSearch: true, checkDiscovery: false, checkInfo: true, checkCategory: true, checkContent: true, keyword: '我的' }

function source(url: string, name = url): NormalizedSource {
  return { bookSourceUrl: url, bookSourceName: name, bookSourceType: 0, enabled: true, searchUrl: `${url}/search?key={{key}}`, ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }
}

function entry(value: NormalizedSource, index = 0): SourceEntry {
  const fingerprint = `fingerprint-${index}`
  const candidate = { id: `source-${index}`, sourceUuid: `uuid-${index}`, origin: { kind: 'text' as const }, rawText: JSON.stringify(value), raw: { rawText: JSON.stringify(value), kind: 'json' as const, origin: { kind: 'text' as const }, parsed: value, unknownFields: {}, fieldShapes: {} }, source: value, unknownFields: {}, replacements: [], diagnostics: [], writable: true, status: 'ready' as const, sourceFingerprint: fingerprint }
  return { id: `${value.bookSourceUrl}\u0000${fingerprint}`, source: value, candidate, fingerprint, state: 'available' }
}

function runtime<T>(status: RuntimeResult<T>['status'], value: T | null, message = ''): RuntimeResult<T> {
  return { status, value, diagnostics: message === '' ? [] : [{ code: 'request-failed', stage: 'search', message, retryable: false }], trace: [] }
}

function candidate(sourceId: string, bookUrl: string, tocUrl?: string): BookCandidate {
  return { sourceId, bookUrl, name: '测试书', rawFields: {}, traceRef: 'check', ...(tocUrl === undefined ? {} : { tocUrl }) }
}

function chapter(sourceId: string, bookUrl: string, chapterUrl: string, index: number, title: string, isVolume = false): Chapter {
  return { sourceId, bookUrl, chapterUrl, index, title, isVolume, rawFields: {}, traceRef: `chapter-${index}` }
}

test('书源检测按 Android 顺序校验详情、目录、正文并传递下一章地址', async () => {
  const sourceValue = source('https://check.test', '检查书源')
  sourceValue.exploreUrl = '[{"title":"分类","url":"https://check.test/explore"}]'
  const sourceEntry = entry(sourceValue)
  const found = candidate(sourceValue.bookSourceUrl, 'https://check.test/book')
  const metadata: BookMetadata = { ...found, tocUrl: 'https://check.test/book/toc', emptyFields: [], fieldErrors: {} }
  const first = chapter(sourceValue.bookSourceUrl, found.bookUrl, 'https://check.test/book/c1', 0, '卷一', true)
  const second = chapter(sourceValue.bookSourceUrl, found.bookUrl, 'https://check.test/book/c2', 1, '第一章')
  const third = chapter(sourceValue.bookSourceUrl, found.bookUrl, 'https://check.test/book/c3', 2, '第二章')
  let contentOptions: { refresh?: boolean; nextChapterUrl?: string } | undefined
  const events: string[] = []
  const session: ReaderSourceSession = {
    attachCache: () => undefined,
    search: async () => { events.push('search'); return runtime('success', { items: [found], cursor: { index: 1 } }) },
    discover: async () => { events.push('discovery'); return runtime('success', { items: [found], cursor: { index: 1 } }) },
    detail: async () => { events.push('detail'); return runtime('success', { items: [metadata], cursor: { index: 0 } }) },
    toc: async () => { events.push('toc'); return runtime('success', { items: [first, second, third], cursor: { index: 0 } }) },
    content: async (chapterValue, _book, _signal, options) => {
      events.push(`content:${chapterValue.chapterUrl}`)
      contentOptions = options
      const content: ChapterContent = { chapter: chapterValue, contentType: 'text', raw: '正文', cleaned: '正文', pages: ['正文'], resources: [] }
      return runtime('success', content)
    },
  }
  const result = await checkSource({ entry: sourceEntry, session, config: { ...config, checkDiscovery: true } })
  assert.equal(result.status, 'passed')
  assert.deepEqual(contentOptions, { refresh: true, nextChapterUrl: second.chapterUrl })
  assert.deepEqual(events, ['search', 'detail', 'toc', `content:${first.chapterUrl}`, 'discovery', 'detail', 'toc', `content:${first.chapterUrl}`])
  assert.deepEqual(result.failedStages, [])
  assert.deepEqual(result.stages.map((stage) => stage.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
})

test('批量检测中止后保留已完成失败项，失败项可以立即禁用并持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-check-cancel-'))
  const storage = new ReaderStorage({ paths: { dataRoot: join(root, 'data-v1'), cacheRoot: join(root, 'cache-v1') } })
  await storage.initialize()
  const first = entry(source('https://check.test/first', '失败书源'), 0)
  const second = entry(source('https://check.test/second', '未完成书源'), 1)
  first.source = { ...first.source, enabled: false }
  first.state = 'disabled'
  const catalog: SourceCatalogResult = { entries: [first, second], diagnostics: [], sourceLocation: 'fixture', loadedFromCache: false }
  const sessions = new Map<string, ReaderSourceSession>()
  for (const [index, sourceEntry] of [first, second].entries()) {
    sessions.set(sourceEntry.id, {
      attachCache: () => undefined,
      search: async (_keyword, signal) => {
        if (index === 1) await new Promise<void>((resolve) => setTimeout(resolve, 100))
        if (signal?.aborted) return runtime<{ items: BookCandidate[]; cursor: { index: number } }>('cancelled', null)
        return runtime('success', { items: [], cursor: { index: 1 } })
      },
      detail: async () => runtime<{ items: BookMetadata[]; cursor: { index: number } }>('failed', null),
      toc: async () => runtime<{ items: Chapter[]; cursor: { index: number } }>('failed', null),
      content: async () => runtime<ChapterContent>('failed', null),
    })
  }
  const application = new ReaderApplication({ catalog, storage, maxConcurrentSources: 1, sessionFactory: (value) => sessions.get(value.bookSourceUrl === first.source.bookSourceUrl ? first.id : second.id)! })
  const controller = new AbortController()
  try {
    const results = await application.checkSources([first.id, second.id], undefined, controller.signal, (progress) => {
      if (progress.completed === 1) controller.abort()
    })
    assert.equal(results.find((item) => item.sourceId === first.source.bookSourceUrl)?.status, 'failed')
    assert.equal(results.find((item) => item.sourceId === second.source.bookSourceUrl)?.status, 'cancelled')
    assert.equal((await storage.getSourceStates())[first.source.bookSourceUrl]?.check?.status, 'failed')
    assert.equal((await storage.getSourceStates())[first.source.bookSourceUrl]?.enabled, false)
    await application.setSourcesEnabled([first.id], false)
    assert.equal(first.state, 'disabled')
    assert.equal((await storage.getSourceStates())[first.source.bookSourceUrl]?.enabled, false)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
