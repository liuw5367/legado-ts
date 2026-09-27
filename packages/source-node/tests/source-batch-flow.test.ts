import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChapterContentBatch } from '../../source-core/src/index.ts'
import type { BookMetadata, Chapter, NetworkHost, NetworkResponse, NormalizedSource, WorkflowPorts } from '../../source-core/src/index.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

function source(overrides: Record<string, unknown> = {}): NormalizedSource {
  return {
    bookSourceUrl: 'https://batch.test/source',
    bookSourceName: 'Batch source',
    bookSourceType: 0,
    ruleContent: {},
    ...overrides,
  } as unknown as NormalizedSource
}

function book(): BookMetadata {
  return {
    sourceId: 'https://batch.test/source',
    bookUrl: 'https://batch.test/book',
    tocUrl: 'https://batch.test/toc',
    type: 64,
    name: 'Book',
    rawFields: {},
    traceRef: 'batch-test',
    emptyFields: [],
    fieldErrors: {},
  }
}

function chapter(index: number, chapterUrl = `/chapter/${index}`): Chapter {
  return {
    sourceId: 'https://batch.test/source',
    bookUrl: 'https://batch.test/book',
    chapterUrl,
    title: `Chapter ${index}`,
    index,
    rawFields: {},
    traceRef: `toc:${index}`,
  }
}

function response(url: string, body: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
}

function workflowPorts(host: SourceRuleHost, calls: string[] = []): WorkflowPorts {
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push(plan.url)
      return response(plan.url, `fallback:${plan.url}`)
    },
  }
  return { network, rules: host }
}

test('QuickJS 执行声明式 contentBatch、包装分段、replaceRegex 和超长列表切批', async () => {
  const host = new SourceRuleHost()
  const calls: string[] = []
  const writes: Array<{ index: number; content: string }> = []
  const result = await loadChapterContentBatch(workflowPorts(host, calls), {
    source: source({
      ruleContent: {
        content: 'text',
        contentBatch: '<js>if (result.length !== chapters.length) throw new Error("result binding missing"); java.cacheContent(chapters[0], "first-" + chapters[0].index)</js><js>java.cacheContent(chapters[1].url, "second-" + chapters[1].index)</js>',
        maxBatchSize: 2,
        replaceRegex: '@js:result.toUpperCase()',
      },
    }),
    book: book(),
    chapters: [chapter(0), chapter(1), chapter(2)],
    cacheContent: async (savedChapter, content) => { writes.push({ index: savedChapter.index, content }); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(result.value?.batchCount, 1)
  assert.deepEqual(writes, [
    { index: 0, content: 'FIRST-0' },
    { index: 1, content: 'SECOND-1' },
    { index: 2, content: 'FALLBACK:HTTPS://BATCH.TEST/CHAPTER/2' },
  ])
  assert.deepEqual(result.value?.items.map((item) => item.via), ['batch', 'batch', 'single'])
  assert.deepEqual(calls, ['https://batch.test/chapter/2'])
})

test('声明式 contentBatch 的全局 baseUrl 使用目录地址，缺省回退书源地址', async () => {
  const host = new SourceRuleHost()
  const writes: string[] = []
  const result = await loadChapterContentBatch(workflowPorts(host), {
    source: source({
      ruleContent: {
        content: 'text',
        contentBatch: 'java.cacheContent(chapters[0], baseUrl);',
        maxBatchSize: 2,
      },
    }),
    book: book(),
    chapters: [chapter(0), chapter(1)],
    cacheContent: async (_savedChapter, content) => { writes.push(content); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(writes, ['https://batch.test/toc', 'fallback:https://batch.test/chapter/1'])

  const noToc = { ...book(), tocUrl: '' }
  const fallbackResult = await loadChapterContentBatch(workflowPorts(new SourceRuleHost()), {
    source: source({
      ruleContent: {
        content: 'text',
        contentBatch: 'java.cacheContent(chapters[0], baseUrl);',
        maxBatchSize: 2,
      },
    }),
    book: noToc,
    chapters: [chapter(0), chapter(1)],
    cacheContent: async (_savedChapter, content) => { writes.push(content); return true },
  })
  assert.equal(fallbackResult.status, 'success', JSON.stringify(fallbackResult))
  assert.equal(writes[2], 'https://batch.test/source')
})

test('QuickJS 的 JS 源 getContentBatch 通过 java.cacheContent 回存，缺章回退 getContent', async () => {
  const host = new SourceRuleHost()
  const writes: Array<[number, string]> = []
  const result = await loadChapterContentBatch(workflowPorts(host), {
    source: source({
      maxBatchSize: 2,
      mainJs: `
        function getContentBatch(chapters, book) {
          if (book.name !== "Book") throw new Error("book argument missing");
          if (baseUrl !== "https://batch.test/source") throw new Error("JS source baseUrl mismatch");
          java.cacheContent(chapters[0], "batch-" + chapters[0].index);
        }
        function getContent(chapter, book, nextChapterUrl) {
          if (chapter.url !== chapter.chapterUrl) throw new Error("chapter url projection missing");
          return "single-" + chapter.index;
        }
      `,
    }),
    book: book(),
    chapters: [chapter(10), chapter(11)],
    cacheContent: async (savedChapter, content) => { writes.push([savedChapter.index, content]); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(result.value?.batchCount, 1)
  assert.deepEqual(writes, [[10, 'batch-10'], [11, 'single-11']])
  assert.deepEqual(result.value?.items.map((item) => item.via), ['batch', 'single'])
})

test('JS 源用重复 URL 调用 cacheContent 会失败并按章节身份回退', async () => {
  const host = new SourceRuleHost()
  const writes: Array<[number, string]> = []
  const result = await loadChapterContentBatch(workflowPorts(host), {
    source: source({
      maxBatchSize: 2,
      mainJs: `
        function getContentBatch(chapters, book) { java.cacheContent(chapters[0].url, "wrong chapter"); }
        function getContent(chapter) { return "single-" + chapter.index; }
      `,
    }),
    book: book(),
    chapters: [chapter(0, '/shared'), chapter(1, '/shared')],
    cacheContent: async (savedChapter, content) => { writes.push([savedChapter.index, content]); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(writes, [[0, 'single-0'], [1, 'single-1']])
  assert.ok(result.diagnostics.some((item) => item.field === 'getContentBatch' && item.code === 'rule-failed'))
})

test('声明式源支持 @js: 与包含字面量 <js> 的裸 JavaScript', async () => {
  const rules = [
    '@js:java.cacheContent(chapters[0], "from-at-js")',
    'const marker = "<js>"; java.cacheContent(chapters[0], marker);',
  ]
  for (const contentBatch of rules) {
    const host = new SourceRuleHost()
    const writes: Array<[number, string]> = []
    const result = await loadChapterContentBatch(workflowPorts(host), {
      source: source({ ruleContent: { content: 'text', contentBatch, maxBatchSize: 2 } }),
      book: book(),
      chapters: [chapter(0), chapter(1)],
      cacheContent: async (savedChapter, content) => { writes.push([savedChapter.index, content]); return true },
    })

    assert.equal(result.status, 'success', JSON.stringify(result))
    assert.equal(writes[0]?.[1], contentBatch.startsWith('@js:') ? 'from-at-js' : '<js>')
    assert.deepEqual(writes.map(([index]) => index), [0, 1])
  }
})

test('JS 源声明批次上限但缺少 getContentBatch 时退回 getContent', async () => {
  const host = new SourceRuleHost()
  const writes: Array<[number, string]> = []
  const result = await loadChapterContentBatch(workflowPorts(host), {
    source: source({
      maxBatchSize: 2,
      mainJs: 'function getContent(chapter) { return "single-" + chapter.index; }',
    }),
    book: book(),
    chapters: [chapter(0), chapter(1)],
    cacheContent: async (savedChapter, content) => { writes.push([savedChapter.index, content]); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(writes, [[0, 'single-0'], [1, 'single-1']])
  assert.ok(result.diagnostics.some((item) => item.field === 'getContentBatch' && item.code === 'invalid-config'))
})

test('java.cacheContent 在批量调用以外没有可写入能力', async () => {
  const host = new SourceRuleHost()
  const result = await host.executeWorkflowJavaScript({
    source: source(),
    code: 'java.cacheContent({ index: 0 }, "must not escape batch scope")',
    stage: 'content',
  })

  assert.equal(result.status, 'capability-missing')
})
