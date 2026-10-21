import assert from 'node:assert/strict'
import test from 'node:test'
import { executePayAction, executeSourceCallback, loadReviewDetail, loadReviewReplies, loadReviewSummary } from '../src/index.ts'
import type { BookMetadata, Chapter, NormalizedSource, WorkflowPorts } from '../src/index.ts'

const sourceBase = { bookSourceUrl: 'https://source.test', bookSourceName: 'Source' } as NormalizedSource
const book: BookMetadata = { sourceId: sourceBase.bookSourceUrl, bookUrl: 'https://source.test/book', name: 'Book', rawFields: {}, traceRef: 'detail:0', emptyFields: [], fieldErrors: {} }
const chapter: Chapter = { sourceId: sourceBase.bookSourceUrl, bookUrl: book.bookUrl, chapterUrl: 'https://source.test/chapter/1', url: '/chapter/1', baseUrl: 'https://source.test', index: 0, title: '第一章', rawFields: {}, traceRef: 'toc:0' }

function reviewPorts(): WorkflowPorts {
  return {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('fixture'), redirected: false }) },
    request: async (request) => ({ url: request.url, status: 200, headers: {}, bytes: new TextEncoder().encode('fixture'), redirected: false }),
    rules: {
      evaluate: async ({ rule, expect, content }) => {
        if (rule === 'summary-list') return { status: 'success', value: [{ index: '2', count: '3', data: 'paragraph-2' }] }
        if (rule === 'detail-list' || rule === 'reply-list') return { status: 'success', value: [{ id: 'review-1', content: 'unused' }] }
        if (rule === 'index') return { status: 'success', value: (content as { index: string }).index }
        if (rule === 'count') return { status: 'success', value: (content as { count: string }).count }
        if (rule === 'data') return { status: 'success', value: (content as { data: string }).data }
        if (rule === '/detail?page={{page + 1}}') return { status: 'success', value: '/detail?page=2' }
        if (rule === 'content') return { status: 'success', value: (content as { content: string }).content }
        if (rule === 'id') return { status: 'success', value: (content as { id: string }).id }
        return expect === 'nodes' ? { status: 'empty', value: null } : { status: 'empty', value: null }
      },
    },
  }
}

test('声明式段评支持统计、协议内容、嵌套回复和分页地址', async () => {
  const source = { ...sourceBase, ruleReview: { enabled: true, reviewSummaryUrl: '/summary', summaryListRule: 'summary-list', summaryParagraphIndexRule: 'index', summaryParagraphDataRule: 'data', summaryCountRule: 'count', reviewDetailUrl: '/detail?page={{page}}', detailListRule: 'detail-list', detailIdRule: 'id', detailContentRule: 'content', reviewDetailNextPageUrl: '/detail?page={{page + 1}}', reviewQuoteUrl: '/reply', replyListRule: 'reply-list', replyIdRule: 'id', replyContentRule: 'content' } } as NormalizedSource
  const ports = reviewPorts()
  const originalEvaluate = ports.rules.evaluate
  ports.rules.evaluate = async (request) => {
    if (request.rule === 'content' && typeof request.content === 'object' && request.content !== null && 'id' in request.content) return { status: 'success', value: request.field.startsWith('reply') ? '回复' : JSON.stringify({ text: '正文', img: '/img.png', time: '刚刚', likeCount: 2 }) }
    return originalEvaluate(request)
  }
  const summary = await loadReviewSummary(ports, { source, book, chapter })
  assert.equal(summary.status, 'success')
  assert.deepEqual(summary.value, [{ paragraphIndex: 2, count: 3, paragraphData: 'paragraph-2' }])
  const detail = await loadReviewDetail(ports, { source, book, chapter, paragraphIndex: 2, paragraphData: 'paragraph-2' })
  assert.equal(detail.status, 'success')
  assert.equal(detail.value?.items[0]?.content, '正文')
  assert.equal(detail.value?.items[0]?.imageUrl, 'https://source.test/img.png')
  assert.equal(detail.value?.hasMore, true)
  assert.equal(detail.value?.nextCursor?.token, 'https://source.test/detail?page=2')
  const replies = await loadReviewReplies(ports, { source, book, chapter, paragraphIndex: 2, reviewId: 'review-1' })
  assert.equal(replies.status, 'success')
  assert.equal(replies.value?.items[0]?.content, '回复')
})

test('JavaScript 段评函数和 Android 内容协议被规范化', async () => {
  const calls: Array<{ name: string; args: readonly unknown[] }> = []
  const source = { ...sourceBase, mainJs: 'function getReviewSummary() {} function getReviewDetail() {} function getReviewReplies() {}' } as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async () => ({ url: source.bookSourceUrl, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) },
    rules: {
      evaluate: async () => ({ status: 'empty', value: null }),
      executeSourceFunction: async (request) => {
        calls.push({ name: request.name, args: request.args })
        if (request.name === 'getReviewSummary') return { status: 'success', exists: true, value: JSON.stringify([{ paraIndex: -1, count: 1, paraData: 'all' }]) }
        if (request.name === 'getReviewReplies') return { status: 'success', exists: true, value: JSON.stringify({ items: [{ id: 'reply', content: { text: 'hello', img: '/x.png' } }] }) }
        return { status: 'success', exists: true, value: JSON.stringify({ items: [{ id: 'review', content: JSON.stringify({ text: 'detail', audio: '/a.mp3' }), replies: [{ id: 'nested', content: 'nested' }] }], nextPageUrl: '/next' }) }
      },
    },
  }
  const summary = await loadReviewSummary(ports, { source, book, chapter })
  const detail = await loadReviewDetail(ports, { source, book, chapter, paragraphIndex: -1 })
  const replies = await loadReviewReplies(ports, { source, book, chapter, paragraphIndex: -1, reviewId: 'review' })
  assert.deepEqual(summary.value, [{ paragraphIndex: -1, count: 1, paragraphData: 'all' }])
  assert.equal(detail.value?.items[0]?.audioUrl, 'https://source.test/a.mp3')
  assert.equal(detail.value?.items[0]?.replies[0]?.content, 'nested')
  assert.equal(detail.value?.hasMore, true)
  assert.equal(detail.value?.nextCursor, undefined)
  assert.equal(replies.value?.items[0]?.imageUrl, 'https://source.test/x.png')
  assert.deepEqual(calls.map((item) => item.name), ['getReviewSummary', 'getReviewDetail', 'getReviewReplies'])
})

test('段评统计按段索引覆盖重复项，详情函数缺失保留能力错误', async () => {
  const source = { ...sourceBase, mainJs: 'function getReviewSummary() {}' } as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async () => ({ url: source.bookSourceUrl, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) },
    rules: {
      evaluate: async () => ({ status: 'empty', value: null }),
      executeSourceFunction: async (request) => request.name === 'getReviewSummary'
        ? { status: 'success', exists: true, value: JSON.stringify([{ paraIndex: 2, count: 1, paraData: 'old' }, { paraIndex: 2, count: 4, paraData: 'new' }]) }
        : { status: 'empty', exists: false, value: null },
    },
  }
  const summary = await loadReviewSummary(ports, { source, book, chapter })
  assert.deepEqual(summary.value, [{ paragraphIndex: 2, count: 4, paragraphData: 'new' }])
  const detail = await loadReviewDetail(ports, { source, book, chapter, paragraphIndex: 2 })
  assert.equal(detail.status, 'capability-missing')
  assert.equal(detail.value, null)
})

test('支付动作和事件回调保留 Android 的结果与时间预算语义', async () => {
  const source = { ...sourceBase, eventListener: true, ruleContent: { payAction: 'true', callBackJs: 'event + ":" + result' } } as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async () => ({ url: source.bookSourceUrl, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) },
    rules: {
      evaluate: async () => ({ status: 'empty', value: null }),
      executeWorkflowJavaScript: async (request) => ({ status: 'success', value: request.code.includes('true') ? 'true' : 'ok' }),
    },
  }
  const paid = await executePayAction(ports, { source, book, chapter })
  assert.deepEqual(paid.value, { kind: 'success', value: 'true' })
  const callback = await executeSourceCallback(ports, { source, event: 'saveRead', book, chapter, result: 'ok' })
  assert.equal(callback.status, 'success')
  assert.equal(callback.value?.handled, true)
})

test('支付动作支持 URL 内嵌 {{js}} 展开', async () => {
  const source = { ...sourceBase, ruleContent: { payAction: 'https://source.test/pay?id={{chapter.index + 1}}' } } as NormalizedSource
  const ports: WorkflowPorts = {
    network: { request: async () => ({ url: source.bookSourceUrl, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) },
    rules: { evaluate: async () => ({ status: 'success', value: 2 }) },
  }
  const result = await executePayAction(ports, { source, book, chapter })
  assert.deepEqual(result.value, { kind: 'url', value: 'https://source.test/pay?id=2' })
})
