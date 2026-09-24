import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChapterContent, loadTableOfContents, searchBooks } from '../../source-core/src/index.ts'
import type { BookMetadata } from '../../source-core/src/index.ts'
import type { NetworkHost, NetworkResponse, NormalizedSource, WorkflowPorts } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

/** 语料里常见的真实形态：先清 Cookie，再用 POST JSON 选项搜索。 */
const cookiePrefixUrl = '{{cookie.removeCookie(source.getKey())}}\nhttps://www.22biqu.com/ss/,{\n  "method": "POST",\n  "body": "searchkey={{key}}"\n}'

const book: BookMetadata = {
  sourceId: 'https://fixture.test',
  bookUrl: 'https://fixture.test/book/1',
  name: '书',
  tocUrl: 'https://fixture.test/toc',
  rawFields: {},
  traceRef: 'detail:0',
  emptyFields: [],
  fieldErrors: {},
}

function response(url: string, body: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
}

function session(network: NetworkHost): { ports: WorkflowPorts; cookies: NodeCookieStore } {
  const cookies = new NodeCookieStore()
  const requestHost = new SourceRequestHost({ network, cookieStore: cookies })
  const ruleHost = new SourceRuleHost({ request: (input, signal, source) => requestHost.requestFromBridge(input, signal, source) })
  requestHost.attachRuleHost(ruleHost)
  return {
    cookies,
    ports: { network, rules: ruleHost, request: (input) => requestHost.request(input), decodeResponse: (input) => requestHost.decodeResponse(input) },
  }
}

test('搜索 URL 的 {{...}} 按内联 JS 求值，不把字面量拼进地址', async () => {
  const calls: Array<{ method: string; url: string; body?: string | Uint8Array }> = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push({ method: plan.method, url: plan.url, ...(plan.body === undefined ? {} : { body: plan.body }) })
      return response(plan.url, '<div class="item"><a class="title" href="/book/1">我本无意成仙</a></div>')
    },
  }
  const { ports, cookies } = session(network)
  await cookies.set('https://www.22biqu.com', 'sid=stale; Path=/')
  const source = {
    bookSourceUrl: 'https://www.22biqu.com',
    bookSourceName: '笔趣阁',
    searchUrl: cookiePrefixUrl,
    ruleSearch: { bookList: '.item', name: '.title@text', bookUrl: 'a@href' },
  } as unknown as NormalizedSource

  const result = await searchBooks(ports, { source, keyword: '我本无意成仙' })
  assert.equal(result.status, 'success')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://www.22biqu.com/ss/')
  assert.equal(calls[0]?.method, 'POST')
  // Android AnalyzeUrl 会先把表单字段按 UTF-8 URL 编码，再发送表单请求体。
  assert.equal(new TextDecoder().decode(calls[0]?.body as Uint8Array), 'searchkey=%E6%88%91%E6%9C%AC%E6%97%A0%E6%84%8F%E6%88%90%E4%BB%99')
  // {{cookie.removeCookie(...)}} 在 Android 返回 Unit，展开为空串而不是 "true"。
  assert.equal(await cookies.get('https://www.22biqu.com/ss/'), undefined)
})

test('搜索 URL 支持 java.encodeURI 等内联 JS 表达式和页码算术', async () => {
  const calls: string[] = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push(plan.url)
      return response(plan.url, '<div class="item"><a class="title" href="/book/1">书</a></div>')
    },
  }
  const { ports } = session(network)
  const source = {
    bookSourceUrl: 'https://api.test',
    bookSourceName: '接口源',
    searchUrl: 'https://api.test/search?q={{java.encodeURI(key)}}&offset={{(page-1)*10}}&t={{Date.now()}}',
    ruleSearch: { bookList: '.item', name: '.title@text', bookUrl: 'a@href' },
  } as unknown as NormalizedSource

  const result = await searchBooks(ports, { source, keyword: '中文 词' })
  assert.equal(result.status, 'success')
  const url = new URL(calls[0]!)
  assert.equal(url.searchParams.get('offset'), '0')
  assert.equal(decodeURIComponent(url.searchParams.get('q') ?? ''), '中文 词')
  assert.match(url.searchParams.get('t') ?? '', /^\d+$/)
  assert.ok(!calls[0]!.includes('{{'))
})

test('页面产出的章节地址里的 {{...}} 与书源地址一样执行（Android AnalyzeUrl 能力面）', async () => {
  const calls: Array<{ url: string; authorization: string | undefined }> = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push({ url: plan.url, authorization: (plan.headers as Record<string, string> | undefined)?.['Authorization'] })
      if (plan.url === 'https://probe.test/token') return response(plan.url, 'probe-token')
      return response(plan.url, plan.url.includes('/c/1') ? '<div class="body">正文</div>' : '<a href="/c/1#{{java.ajax(\'https://probe.test/token\')}}">第一章</a>')
    },
  }
  const { ports } = session(network)
  const source = {
    bookSourceUrl: 'https://fixture.test',
    bookSourceName: 'fixture',
    header: JSON.stringify({ Authorization: 'Bearer SOURCE-CREDENTIAL' }),
    ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href' },
    ruleContent: { content: '.body@text' },
  } as unknown as NormalizedSource
  const toc = await loadTableOfContents(ports, { source, book })
  // 目录阶段不展开章节地址，模板保留在章节链接里。
  assert.match(toc.value?.items[0]?.chapterUrl ?? '', /#\{\{java\.ajax/)

  const chapter = toc.value!.items[0]!
  const content = await loadChapterContent(ports, { source, chapter })
  assert.equal(content.status, 'success')
  // Android 对页面产出的地址做同样的内联 JS 展开：表达式会被执行（能力面已登记在威胁模型文档）。
  const probe = calls.find((call) => call.url === 'https://probe.test/token')
  assert.ok(probe !== undefined)
  // 该外连带着书源凭据，这是已登记的设计取舍。
  assert.equal(probe?.authorization, 'Bearer SOURCE-CREDENTIAL')
  // 正文请求发生在展开后的地址上，不再保留模板字面量。
  assert.ok(calls.some((call) => call.url === 'https://fixture.test/c/1#probe-token'))
  assert.ok(!calls.some((call) => call.url.includes('{{')))
})

test('页面链接里的表达式求值失败时不发出带字面量的地址', async () => {
  const calls: string[] = []
  const network: NetworkHost = {
    request: async (plan) => {
      calls.push(plan.url)
      return response(plan.url, plan.url.includes('/c/2') ? '正文' : '<a href="/c/2#{{notDefinedHere(\'x\')}}">第二章</a>')
    },
  }
  const { ports } = session(network)
  const source = {
    bookSourceUrl: 'https://fixture.test',
    bookSourceName: 'fixture',
    ruleToc: { chapterList: 'a', chapterName: 'text', chapterUrl: 'href' },
    ruleContent: { content: '.body@text' },
  } as unknown as NormalizedSource
  const toc = await loadTableOfContents(ports, { source, book })
  const chapter = toc.value!.items[0]!
  const result = await loadChapterContent(ports, { source, chapter })
  assert.equal(result.status, 'failed')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'rule-failed'))
  assert.ok(!calls.some((call) => call.includes('{{')))
})

test('没有 JavaScript 能力时 URL 表达式展开失败可诊断，不静默保留字面量', async () => {
  const source = {
    bookSourceUrl: 'https://api.test',
    bookSourceName: '接口源',
    searchUrl: 'https://api.test/search?q={{java.base64Encode(key)}}',
    ruleSearch: { bookList: '.item', name: '.title@text', bookUrl: 'a@href' },
  } as unknown as NormalizedSource
  const calls: string[] = []
  const ports: WorkflowPorts = {
    network: { request: async (plan) => { calls.push(plan.url); return response(plan.url, '') } },
    rules: { evaluate: async () => ({ status: 'capability-missing', value: null, message: '没有 JavaScript 能力' }) },
  }
  const result = await searchBooks(ports, { source, keyword: '关键词' })
  assert.equal(result.status, 'capability-missing')
  assert.equal(calls.length, 0)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'capability-missing'))
})
