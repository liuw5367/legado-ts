import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChapterContentBatch } from '../src/index.ts'
import type { BookMetadata, Chapter, NetworkResponse, NormalizedSource, ReadingPorts } from '../src/index.ts'

function source(overrides: Record<string, unknown> = {}): NormalizedSource {
  return {
    bookSourceUrl: 'https://batch.test/source',
    bookSourceName: 'Batch source',
    bookSourceType: 0,
    ruleContent: { content: 'body@text', contentBatch: '<js>cache-object</js><js>cache-url</js>', maxBatchSize: 2, replaceRegex: 'replace' },
    ...overrides,
  } as unknown as NormalizedSource
}

function book(type = 8): BookMetadata {
  return {
    sourceId: 'https://batch.test/source',
    bookUrl: 'https://batch.test/book',
    tocUrl: 'https://batch.test/toc',
    type,
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

function response(url: string, content = 'single content'): NetworkResponse {
  return { url, status: 200, headers: {}, bytes: new TextEncoder().encode(content), redirected: false }
}

function ports(options: {
  runBatch?: ReadingPorts['rules']['executeWorkflowJavaScript']
  evaluate?: ReadingPorts['rules']['evaluate']
  requests?: string[]
} = {}): ReadingPorts {
  return {
    network: {
      request: async (plan) => {
        options.requests?.push(plan.url)
        return response(plan.url, `page:${plan.url}`)
      },
    },
    rules: {
      evaluate: options.evaluate ?? (async ({ field, content, bindings }) => {
        if (field === 'content') {
          const chapterIndex = (bindings?.chapter as { index?: number } | undefined)?.index
          return { status: 'success', value: `single-${chapterIndex ?? 'unknown'}` }
        }
        if (field === 'replaceRegex') return { status: 'success', value: content }
        return { status: 'empty', value: null }
      }),
      ...(options.runBatch === undefined ? {} : { executeWorkflowJavaScript: options.runBatch }),
    },
  }
}

test('声明式批量规则按 maxBatchSize 分组，对象和唯一 URL 回存，并为尾章调用单章流程', async () => {
  const writes: Array<{ index: number; content: string }> = []
  const requests: string[] = []
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    const chapters = request.content as Array<{ index: number; url: string }>
    const action = request.workflowActions?.cacheContent
    assert.ok(action)
    if (request.code === 'cache-object') await action(request.signal ?? new AbortController().signal, { chapter: chapters[0], content: '  old  \n x ' })
    else if (request.code === 'cache-url') await action(request.signal ?? new AbortController().signal, { chapter: chapters[1]!.url, content: ' next ' })
    return { status: 'success', value: null }
  }
  const result = await loadChapterContentBatch({
    ...ports({ requests, runBatch }),
    rules: {
      ...ports().rules,
      executeWorkflowJavaScript: runBatch,
    },
  }, {
    source: source(),
    book: book(),
    chapters: [chapter(0), chapter(1), chapter(2)],
    cacheContent: async (savedChapter, content) => {
      writes.push({ index: savedChapter.index, content })
      return true
    },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(result.value?.batchCount, 1)
  assert.deepEqual(writes.slice(0, 2), [
    { index: 0, content: '　　old\n　　x' },
    { index: 1, content: '　　next' },
  ])
  assert.equal(result.value?.items[0]?.via, 'batch')
  assert.equal(result.value?.items[2]?.via, 'single')
  assert.equal(result.value?.items[2]?.saved, true)
  assert.equal(requests.length, 1)
})

test('重复 URL 字符串会让整批失败并回退，绝不误写到任一同地址章节', async () => {
  const writes: number[] = []
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    try {
      await request.workflowActions!.cacheContent!(request.signal ?? new AbortController().signal, { chapter: '/shared', content: 'wrong' })
      return { status: 'success', value: null }
    } catch (error) {
      return { status: 'failed', value: null, message: error instanceof Error ? error.message : 'failed' }
    }
  }
  const result = await loadChapterContentBatch({
    ...ports({ runBatch }),
    rules: { ...ports().rules, executeWorkflowJavaScript: runBatch },
  }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: '<js>cache</js>', maxBatchSize: 2 } }),
    book: book(64),
    chapters: [chapter(4, '/shared'), chapter(5, '/shared')],
    cacheContent: async (savedChapter) => { writes.push(savedChapter.index); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(writes, [4, 5])
  assert.ok(result.diagnostics.some((item) => item.field === 'contentBatch' && item.code === 'rule-failed'))
  assert.deepEqual(result.value?.items.map((item) => item.via), ['single', 'single'])
})

test('批量脚本失败时保留已经回存的章，仅对缺失章走单章兜底', async () => {
  const writes: Array<{ index: number; content: string }> = []
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    const chapters = request.content as Array<{ index: number }>
    await request.workflowActions!.cacheContent!(request.signal ?? new AbortController().signal, { chapter: chapters[0], content: 'saved before failure' })
    return { status: 'failed', value: null, message: 'batch error after first save' }
  }
  const result = await loadChapterContentBatch({ ...ports({ runBatch }), rules: { ...ports().rules, executeWorkflowJavaScript: runBatch } }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: 'batch', maxBatchSize: 2 } }),
    book: book(64),
    chapters: [chapter(0), chapter(1)],
    cacheContent: async (savedChapter, content) => { writes.push({ index: savedChapter.index, content }); return true },
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(writes, [
    { index: 0, content: 'saved before failure' },
    { index: 1, content: 'single-1' },
  ])
  assert.deepEqual(result.value?.items.map((item) => item.via), ['batch', 'single'])
})

test('缓存宿主拒绝回存时不再用单章流程覆盖可能已更新的正文', async () => {
  let requests = 0
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    const chapters = request.content as Array<{ index: number }>
    await request.workflowActions!.cacheContent!(request.signal ?? new AbortController().signal, { chapter: chapters[0], content: 'new batch body' })
    return { status: 'success', value: null }
  }
  const localPorts = ports({ runBatch, requests: [] })
  const network = localPorts.network
  const result = await loadChapterContentBatch({
    ...localPorts,
    network: { request: async (plan) => { requests += 1; return network.request(plan) } },
    rules: { ...localPorts.rules, executeWorkflowJavaScript: runBatch },
  }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: 'batch', maxBatchSize: 2 } }),
    book: book(64),
    chapters: [chapter(0), chapter(1)],
    cacheContent: async () => false,
  })

  assert.equal(result.status, 'failed')
  assert.equal(requests, 1)
  assert.equal(result.value?.items[0]?.content, undefined)
  assert.ok(result.diagnostics.some((item) => item.code === 'cache-failed'))
})

test('缺少缓存适配器时跳过批量脚本并返回单章解析结果', async () => {
  let batchExecutions = 0
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async () => {
    batchExecutions += 1
    return { status: 'success', value: null }
  }
  const result = await loadChapterContentBatch({ ...ports({ runBatch }), rules: { ...ports().rules, executeWorkflowJavaScript: runBatch } }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: 'batch', maxBatchSize: 2 } }),
    book: book(64),
    chapters: [chapter(0), chapter(1)],
  })

  assert.equal(result.status, 'success')
  assert.equal(batchExecutions, 0)
  assert.deepEqual(result.value?.items.map((item) => [item.content, item.saved, item.via]), [
    ['single-0', false, 'single'],
    ['single-1', false, 'single'],
  ])
})

test('重复或非法章节 index 在执行脚本前拒绝整批输入', async () => {
  let batchExecutions = 0
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async () => {
    batchExecutions += 1
    return { status: 'success', value: null }
  }
  const result = await loadChapterContentBatch({ ...ports({ runBatch }), rules: { ...ports().rules, executeWorkflowJavaScript: runBatch } }, {
    source: source(),
    book: book(),
    chapters: [chapter(1), chapter(1)],
    cacheContent: async () => true,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.value, null)
  assert.equal(batchExecutions, 0)
})

test('混入其他书籍的章节会在脚本执行前拒绝', async () => {
  let batchExecutions = 0
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async () => {
    batchExecutions += 1
    return { status: 'success', value: null }
  }
  const otherBookChapter = { ...chapter(0), bookUrl: 'https://batch.test/book/other' }
  const result = await loadChapterContentBatch({ ...ports({ runBatch }), rules: { ...ports().rules, executeWorkflowJavaScript: runBatch } }, {
    source: source(),
    book: book(),
    chapters: [otherBookChapter, chapter(1)],
    cacheContent: async () => true,
  })

  assert.equal(result.status, 'failed')
  assert.ok(result.diagnostics.some((item) => item.field === 'chapters' && item.code === 'invalid-input'))
  assert.equal(batchExecutions, 0)
})

test('maxBatchSize 大于 50 时每次脚本最多收到 50 章', async () => {
  const groupSizes: number[] = []
  const saved: number[] = []
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    const chapters = request.content as Array<{ index: number }>
    groupSizes.push(chapters.length)
    const action = request.workflowActions!.cacheContent!
    for (const item of chapters) await action(request.signal ?? new AbortController().signal, { chapter: item, content: `batch-${item.index}` })
    return { status: 'success', value: null }
  }
  const result = await loadChapterContentBatch({ ...ports({ runBatch }), rules: { ...ports().rules, executeWorkflowJavaScript: runBatch } }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: 'batch', maxBatchSize: 500 } }),
    book: book(64),
    chapters: Array.from({ length: 51 }, (_value, index) => chapter(index)),
    cacheContent: async (savedChapter) => { saved.push(savedChapter.index); return true },
  })

  assert.equal(result.status, 'success')
  assert.deepEqual(groupSizes, [50])
  assert.equal(result.value?.batchCount, 1)
  assert.equal(saved.length, 51)
  assert.equal(result.value?.items[50]?.via, 'single')
})

test('批量取消会保留先前成功回存项并停止所有单章兜底', async () => {
  const controller = new AbortController()
  let requests = 0
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    const chapters = request.content as Array<{ index: number }>
    await request.workflowActions!.cacheContent!(request.signal ?? controller.signal, { chapter: chapters[0], content: 'saved before cancel' })
    return { status: 'cancelled', value: null }
  }
  const localPorts = ports({ runBatch })
  const result = await loadChapterContentBatch({
    ...localPorts,
    network: { request: async (plan) => { requests += 1; return response(plan.url) } },
    rules: { ...localPorts.rules, executeWorkflowJavaScript: runBatch },
  }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: 'batch', maxBatchSize: 2 } }),
    book: book(64),
    chapters: [chapter(0), chapter(1)],
    signal: controller.signal,
    cacheContent: async (_savedChapter, _content, signal) => { controller.abort(); assert.equal(signal?.aborted, true); return true },
  })

  assert.equal(result.status, 'cancelled')
  assert.equal(result.value?.items[0]?.saved, true)
  assert.equal(result.value?.items[1]?.saved, false)
  assert.equal(requests, 0)
})

test('批量回存遵守正文输出字节预算', async () => {
  const writes: number[] = []
  const runBatch: NonNullable<ReadingPorts['rules']['executeWorkflowJavaScript']> = async (request) => {
    const chapters = request.content as Array<{ index: number }>
    await request.workflowActions!.cacheContent!(request.signal ?? new AbortController().signal, { chapter: chapters[0], content: 'too much text' })
    return { status: 'success', value: null }
  }
  const localPorts = ports({ runBatch })
  const result = await loadChapterContentBatch({ ...localPorts, rules: { ...localPorts.rules, executeWorkflowJavaScript: runBatch } }, {
    source: source({ ruleContent: { content: 'body@text', contentBatch: 'batch', maxBatchSize: 2 } }),
    book: book(64),
    chapters: [chapter(0), chapter(1)],
    maxOutputBytes: 4,
    cacheContent: async (savedChapter) => { writes.push(savedChapter.index); return true },
  })

  assert.equal(result.status, 'failed')
  assert.deepEqual(writes, [])
  assert.ok(result.diagnostics.some((item) => item.field === 'cacheContent' && item.message.includes('输出字节预算')))
})
