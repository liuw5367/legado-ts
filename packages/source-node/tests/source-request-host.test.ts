import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetworkHost, NetworkResponse, NormalizedSource, RequestBudget } from '../../source-core/src/index.ts'
import { NodeCookieStore } from '../src/cookies.ts'
import { NodeCharsetCodec } from '../src/charset.ts'
import { SourceRequestHost } from '../src/source-request-host.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const source = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'fixture',
  header: JSON.stringify({ 'X-Fixture': 'yes' }),
} as unknown as NormalizedSource

function response(url: string): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, bytes: new TextEncoder().encode('ok'), redirected: false }
}

test('书源请求宿主解析 URL 后 JSON options 并保留 POST/body/header', async () => {
  const plans: Array<{ method: string; url: string; body?: string; headers: Readonly<Record<string, string>> }> = []
  const network: NetworkHost = {
    request: async (plan) => {
      plans.push({
        method: plan.method,
        url: plan.url,
        ...(plan.body === undefined ? {} : { body: typeof plan.body === 'string' ? plan.body : new TextDecoder().decode(plan.body) }),
        headers: plan.headers,
      })
      return response(plan.url)
    },
  }
  const host = new SourceRequestHost({ network, cookieStore: new NodeCookieStore() })
  const result = await host.request({ source, url: '/search,{"method":"POST","body":"q=fixture","headers":{"X-Rule":"yes"},"charset":"utf-8"}', stage: 'search', options: {} })
  assert.equal(new TextDecoder().decode(result.bytes), 'ok')
  assert.deepEqual(plans, [{ method: 'POST', url: 'https://fixture.invalid/search', body: 'q=fixture', headers: { 'X-Fixture': 'yes', 'X-Rule': 'yes', 'Content-Type': 'application/x-www-form-urlencoded' } }])
})

test('请求宿主保留普通逗号，并按 charset 编码查询参数和 POST 表单', async () => {
  const plans: Array<{ url: string; method: string; body?: Uint8Array | string; headers: Readonly<Record<string, string>>; requestCharset?: string; followRedirects: boolean; timeoutMs: number }> = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    plans.push({ url: plan.url, method: plan.method, ...(plan.body === undefined ? {} : { body: plan.body }), headers: plan.headers, ...(plan.requestCharset === undefined ? {} : { requestCharset: plan.requestCharset }), followRedirects: plan.followRedirects, timeoutMs: plan.budget.timeoutMs })
    return response(plan.url)
  } } })
  await host.request({ source, url: '/search?tag=a,b&q=中文,{"method":"GET","charset":"gbk","followRedirects":false,"timeout":3210}', stage: 'search', options: {} })
  assert.equal(plans[0]?.url, 'https://fixture.invalid/search?tag=a,b&q=%D6%D0%CE%C4')
  assert.equal(plans[0]?.method, 'GET')
  assert.equal(plans[0]?.requestCharset, 'gbk')
  assert.equal(plans[0]?.followRedirects, false)
  assert.equal(plans[0]?.timeoutMs, 3210)

  await host.request({ source, url: '/post,{"method":"POST","body":"word=中文&space=a b","charset":"gbk"}', stage: 'search', options: {} })
  const form = plans[1]?.body
  assert.ok(form instanceof Uint8Array)
  assert.equal(new NodeCharsetCodec().decode(form, 'ascii'), 'word=%D6%D0%CE%C4&space=a+b')
  assert.equal(plans[1]?.headers['Content-Type'], 'application/x-www-form-urlencoded')
})

test('书源请求宿主兼容 fixture 中常见的单引号 options 写法', async () => {
  let method = ''
  let body: string | undefined
  const host = new SourceRequestHost({ network: { request: async (plan) => { method = plan.method; body = plan.body === undefined ? undefined : typeof plan.body === 'string' ? plan.body : new TextDecoder().decode(plan.body); return response(plan.url) } } })
  await host.request({ source, url: "/search,{'method':'POST','body':'q=it\\'s-ok'}", stage: 'search', options: {} })
  assert.equal(method, 'POST')
  assert.equal(body, 'q=it%27s-ok')
})

test('URL 的嵌入式 JavaScript 在任意位置执行并支持 @result', async () => {
  const urls: string[] = []
  const host = new SourceRequestHost({ network: { request: async (plan) => { urls.push(plan.url); return response(plan.url) } } })
  host.attachRuleHost(new SourceRuleHost({ request: (input, signal, currentSource) => host.requestFromBridge(input, signal, currentSource) }))
  await host.request({ source, url: 'https://fixture.invalid/search?q=<js>result + java.encodeURI("中文")</js>', stage: 'search', options: {} })
  assert.equal(urls[0], 'https://fixture.invalid/search?q=%E4%B8%AD%E6%96%87')
  await host.request({ source, url: 'https://fixture.invalid/search?prefix=<js>result</js>@result', stage: 'search', options: {} })
  assert.equal(urls[1], 'https://fixture.invalid/search?prefix=')
})

test('URL 请求选项执行 js/bodyJs、重试和十六进制响应类型', async () => {
  const urls: string[] = []
  let requests = 0
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    urls.push(plan.url)
    requests += 1
    if (requests < 3) return { ...response(plan.url), status: 503 }
    return { ...response(plan.url), bytes: new TextEncoder().encode('hello') }
  } } })
  host.attachRuleHost(new SourceRuleHost())
  const body = await host.request({
    source,
    url: '/body,{"method":"GET","js":"result + \'?signed=1\'","bodyJs":"result.toUpperCase()","retry":2}',
    stage: 'search',
    options: {},
  })
  assert.deepEqual(urls, ['https://fixture.invalid/body?signed=1', 'https://fixture.invalid/body?signed=1', 'https://fixture.invalid/body?signed=1'])
  assert.equal(host.decodeResponse(body), 'HELLO')

  let transportCalls = 0
  const transportHost = new SourceRequestHost({ network: { request: async () => { transportCalls += 1; throw new Error('temporary network error') } } })
  await assert.rejects(() => transportHost.request({ source, url: '/transport,{"retry":2}', stage: 'search', options: {} }), /temporary network error/)
  assert.equal(transportCalls, 1, 'option retry 不重试传输异常')

  const hexHost = new SourceRequestHost({ network: { request: async (plan) => ({ ...response(plan.url), bytes: new Uint8Array([0, 255]) }) } })
  const binary = await hexHost.request({ source, url: '/binary,{"type":"hex"}', stage: 'search', options: {} })
  assert.equal(host.decodeResponse(binary), '00ff')
})

test('AnalyzeUrl 脚本可以修改 java.url/headerMap 并在上下文中重取 StrResponse', async () => {
  const plans: Array<{ url: string; headers: Readonly<Record<string, string>> }> = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    plans.push({ url: plan.url, headers: plan.headers })
    return { ...response(plan.url), bytes: new TextEncoder().encode(`body:${plan.url}`) }
  } } })
  host.attachRuleHost(new SourceRuleHost({ request: (input, signal, currentSource) => host.requestFromBridge(input, signal, currentSource) }))
  const result = await host.request({
    source,
    url: `/signed,${JSON.stringify({ js: 'java.headerMap.put("X-Auth", "token"); java.url = java.url + "?signed=1"; java.getStrResponse(null, null, false).body' })}`,
    stage: 'search',
    options: {},
  })
  assert.equal(host.decodeResponse(result), 'body:https://fixture.invalid/signed?signed=1')
  assert.deepEqual(plans.map((item) => item.url), ['https://fixture.invalid/signed?signed=1', 'https://fixture.invalid/signed?signed=1'])
  assert.equal(plans[0]?.headers['X-Auth'], 'token')
  assert.equal(plans[1]?.headers['X-Auth'], 'token')
})

test('AnalyzeUrl 上下文 bridge 首层重算动态 source header', async () => {
  const plans: Array<{ url: string; token: string | undefined }> = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    plans.push({ url: plan.url, token: plan.headers['X-Token'] })
    return { ...response(plan.url), bytes: new TextEncoder().encode(`body:${plan.url}`) }
  } } })
  host.attachRuleHost(new SourceRuleHost({ request: (input, signal, currentSource) => host.requestFromBridge(input, signal, currentSource) }))
  const dynamicSource = { ...source, header: '@js:0; ({"X-Token":"dynamic"})' } as unknown as NormalizedSource
  const result = await host.request({
    source: dynamicSource,
    url: `/signed,${JSON.stringify({ js: 'java.url = java.url; java.getStrResponse(null, null, false).body' })}`,
    stage: 'search',
    options: {},
  })
  assert.equal(host.decodeResponse(result), 'body:https://fixture.invalid/signed')
  assert.equal(plans.length, 2)
  assert.ok(plans.every((plan) => plan.token === 'dynamic'), JSON.stringify(plans))
})

test('URL 请求脚本携带书籍和内部章节变量作用域，但不暴露全局 chapter', async () => {
  const plans: string[] = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    plans.push(plan.url)
    return response(plan.url)
  } } })
  host.attachRuleHost(new SourceRuleHost())
  const book = {
    sourceId: source.bookSourceUrl,
    bookUrl: 'https://fixture.invalid/book/one',
    name: '上下文书',
    rawFields: {},
    traceRef: 'detail:0',
    emptyFields: [],
    fieldErrors: {},
    variable: '{"bookToken":"book-initial"}',
  }
  const chapter = {
    sourceId: source.bookSourceUrl,
    bookUrl: book.bookUrl,
    chapterUrl: 'https://fixture.invalid/book/one/chapter/1',
    url: '/chapter/1',
    baseUrl: book.bookUrl,
    index: 0,
    title: '第一章',
    rawFields: {},
    traceRef: 'toc:0',
    variable: '{"chapterToken":"chapter-initial"}',
  }
  const options = JSON.stringify({
    js: 'book.name = "请求后书"; java.put("chapterToken", "chapter-updated"); java.put("bookToken", "book-updated"); result + "?name=" + book.name + "&global=" + typeof chapter + "&chapter=" + java.get("chapterToken") + "&book=" + java.get("bookToken")',
  })
  await host.request({ source, url: `/context,${options}`, stage: 'detail', options: {}, book, chapter })
  assert.equal(plans[0], 'https://fixture.invalid/context?name=%E8%AF%B7%E6%B1%82%E5%90%8E%E4%B9%A6&global=undefined&chapter=chapter-updated&book=book-updated')
  assert.deepEqual(JSON.parse(chapter.variable), { chapterToken: 'chapter-updated', bookToken: 'book-updated' })
  assert.equal(book.name, '请求后书')
  assert.equal(book.variable, '{"bookToken":"book-initial"}')

  const bodyOptions = JSON.stringify({ bodyJs: 'book.name + "/" + typeof chapter + "/" + java.get("chapterToken")' })
  const bodyResponse = await host.request({ source, url: `/body,${bodyOptions}`, stage: 'detail', options: {}, book, chapter })
  assert.equal(host.decodeResponse(bodyResponse), '请求后书/undefined/chapter-updated')

  const laterOptions = JSON.stringify({ js: 'book.name + "/" + typeof chapter' })
  await host.request({ source, url: `/later,${laterOptions}`, stage: 'detail', options: {}, book })
  assert.equal(plans[2], 'https://fixture.invalid/%E8%AF%B7%E6%B1%82%E5%90%8E%E4%B9%A6/undefined')
})

test('非 WebView 请求选项把 dnsIp 传入 RequestPlan', async () => {
  let dnsIp: string | undefined
  const host = new SourceRequestHost({ network: { request: async (plan) => { dnsIp = plan.execution.dnsIp; return response(plan.url) } } })
  await host.request({ source, url: '/search,{"resolveIp":"203.0.113.8"}', stage: 'search', options: {} })
  assert.equal(dnsIp, '203.0.113.8')
})

test('书源请求宿主不会把 WebView 请求静默降级到普通 HTTP', async () => {
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  await assert.rejects(() => host.request({ source, url: '/search,{"webView":true}', stage: 'search', options: {} }), /WebView/)
})

test('响应解码按显式 charset、HTTP header、BOM、HTML meta、自动检测和 UTF-8 依次回退', () => {
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]) // “中文” in GBK.
  const make = (bytes: Uint8Array, headers: NetworkResponse['headers'] = {}): NetworkResponse => ({ ...response('https://fixture.invalid/'), headers, bytes })

  assert.equal(host.decodeResponse(make(gbk, { 'content-type': 'text/html; charset=gbk' })), '中文')
  assert.equal(host.decodeResponse(make(new Uint8Array([0xef, 0xbb, 0xbf, ...gbk]), { 'content-type': 'text/html; charset=gbk' })), '中文')
  assert.equal(host.decodeResponse(make(gbk, { 'content-type': 'text/html; charset=utf-8', 'x-legado-response-charset': 'gbk' })), '中文')
  const metaPrefix = new TextEncoder().encode('<meta charset="gbk">')
  const metaBytes = new Uint8Array([...metaPrefix, ...gbk])
  assert.equal(host.decodeResponse(make(metaBytes, { 'content-type': 'text/html' })), '<meta charset="gbk">中文')
  assert.equal(host.decodeResponse(make(metaBytes, { 'content-type': 'text/html; charset=gbk' })), '<meta charset="gbk">中文')

  assert.equal(host.decodeResponse(make(new TextEncoder().encode('rar-内容'))), 'rar-内容')
  const detectorText = '第一章，故事开始了。主人公走进书房，看到一本古老的书，封面上写着神秘的文字。'
  const detectorBytes = new NodeCharsetCodec().encode(detectorText, 'gbk')
  assert.equal(host.decodeResponse(make(detectorBytes)), detectorText)
  assert.equal(host.decodeResponse(make(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('第一章')]))), '第一章')
  assert.equal(host.decodeResponse(make(new TextEncoder().encode('第一章'))), '第一章')
})

test('cookie-remove 按地址删除，不波及其他书源的 Cookie', async () => {
  const cookies = new NodeCookieStore()
  await cookies.set('https://a.test/', 'sid=a')
  await cookies.set('https://b.test/', 'sid=b')
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) }, cookieStore: cookies })
  const ruleHost = new SourceRuleHost({ request: (input, signal, source) => host.requestFromBridge(input, signal, source) })
  host.attachRuleHost(ruleHost)
  const other = { bookSourceUrl: 'https://a.test', bookSourceName: 'a' } as unknown as NormalizedSource
  const result = await ruleHost.evaluate({ source: other, stage: 'search', field: 'fixture', rule: '@js:cookie.removeCookie(source.getKey())', content: '' })
  assert.notEqual(result.status, 'failed')
  assert.notEqual(result.status, 'capability-missing')
  assert.equal(await cookies.get('https://a.test/'), undefined)
  assert.equal(await cookies.get('https://b.test/'), 'sid=b')
})

test('桥接请求随求值携带书源，共享宿主跨源并发不串源', async () => {
  const seen: Array<string | undefined> = []
  const host = new SourceRuleHost({ request: async (_input, _signal, source) => { seen.push(source?.bookSourceUrl); return 'ok' } })
  const first = { bookSourceUrl: 'https://a.test', bookSourceName: 'a' } as unknown as NormalizedSource
  const second = { bookSourceUrl: 'https://b.test', bookSourceName: 'b' } as unknown as NormalizedSource
  await Promise.all([
    host.evaluate({ source: first, stage: 'search', field: 'fixture', rule: '@js:java.ajax("https://a.test/1")', content: '' }),
    host.evaluate({ source: second, stage: 'search', field: 'fixture', rule: '@js:java.ajax("https://b.test/1")', content: '' }),
  ])
  assert.deepEqual(seen.sort(), ['https://a.test', 'https://b.test'])
})

test('bridge 的 ajaxAll 和 response 请求复用完整网络响应并保持顺序', async () => {
  const started: string[] = []
  const skipFlags: boolean[] = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    started.push(plan.url)
    skipFlags.push(plan.execution.skipRateLimit === true)
    const delay = plan.url.endsWith('/one') ? 10 : 1
    await new Promise((resolve) => setTimeout(resolve, delay))
    return { ...response(plan.url), status: plan.url.endsWith('/two') ? 204 : 200, headers: { Location: plan.url }, bytes: new TextEncoder().encode(`body:${plan.url}`) }
  } } })
  const signal = new AbortController().signal
  const all = await host.requestFromBridge({ kind: 'network-all', urls: ['https://fixture.invalid/one', 'https://fixture.invalid/two'] }, signal, source)
  assert.deepEqual(all, [
    { body: 'body:https://fixture.invalid/one', bytes: new TextEncoder().encode('body:https://fixture.invalid/one'), status: 200, code: 200, headers: { Location: 'https://fixture.invalid/one' }, url: 'https://fixture.invalid/one', redirected: false },
    { body: 'body:https://fixture.invalid/two', bytes: new TextEncoder().encode('body:https://fixture.invalid/two'), status: 204, code: 204, headers: { Location: 'https://fixture.invalid/two' }, url: 'https://fixture.invalid/two', redirected: false },
  ])
  const single = await host.requestFromBridge({ kind: 'network-response', url: 'https://fixture.invalid/one', options: {} }, signal, source)
  assert.deepEqual(single, { body: 'body:https://fixture.invalid/one', bytes: new TextEncoder().encode('body:https://fixture.invalid/one'), status: 200, code: 200, headers: { Location: 'https://fixture.invalid/one' }, url: 'https://fixture.invalid/one', redirected: false })
  assert.deepEqual(started, ['https://fixture.invalid/one', 'https://fixture.invalid/two', 'https://fixture.invalid/one'])
  const skipped = await host.requestFromBridge({ kind: 'network-all', urls: ['https://fixture.invalid/three'], skipRateLimit: true }, signal, source)
  assert.equal(Array.isArray(skipped), true)
  assert.equal(skipFlags.at(-1), true)
})

test('首层 bridge 的 ajaxAll 和 response 也重算动态 source header', async () => {
  const plans: Array<{ url: string; token: string | undefined }> = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    plans.push({ url: plan.url, token: plan.headers['X-Token'] })
    return response(plan.url)
  } } })
  host.attachRuleHost(new SourceRuleHost({ request: (input, signal, currentSource) => host.requestFromBridge(input, signal, currentSource) }))
  const dynamicSource = { ...source, header: '@js:0; ({"X-Token":"dynamic"})' } as unknown as NormalizedSource
  const signal = new AbortController().signal
  await host.requestFromBridge({ kind: 'network-all', urls: ['https://fixture.invalid/one', 'https://fixture.invalid/two'] }, signal, dynamicSource)
  await host.requestFromBridge({ kind: 'network-response', url: 'https://fixture.invalid/three', options: {} }, signal, dynamicSource)
  assert.deepEqual(plans.slice(0, 2).map((plan) => plan.url).sort(), [
    'https://fixture.invalid/one',
    'https://fixture.invalid/two',
  ])
  assert.equal(plans[2]?.url, 'https://fixture.invalid/three')
  assert.ok(plans.every((plan) => plan.token === 'dynamic'), JSON.stringify(plans))
})

test('bridge 子请求继承当前工作流阶段', async () => {
  const observations: Array<{ stage: string; kind?: string }> = []
  const host = new SourceRequestHost({
    network: { request: async (plan) => response(plan.url) },
    requestObserver: { onStart: (event) => observations.push({ stage: event.stage, ...(event.kind === undefined ? {} : { kind: event.kind }) }) },
  })
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => host.requestFromBridge(input, signal, requestSource) })
  host.attachRuleHost(ruleHost)
  const options = JSON.stringify({ js: 'java.ajax("https://fixture.invalid/bridge"); result' })
  await host.request({ source, url: `/detail,${options}`, stage: 'detail', options: {} })
  assert.ok(observations.some((observation) => observation.kind === 'bridge'))
  assert.ok(observations.every((observation) => observation.stage === 'detail'), JSON.stringify(observations))
})

test('bridge 的 ajaxAll 失败时等待所有兄弟请求收尾', async () => {
  let releaseSlow!: () => void
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
  let slowStarted = 0
  let slowSettled = 0
  let resolveAllSettled!: () => void
  const allSettled = new Promise<void>((resolve) => { resolveAllSettled = resolve })
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    if (plan.url.endsWith('/fail')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('batch failure')
    }
    slowStarted += 1
    await Promise.race([
      slowGate,
      new Promise<void>((resolve) => plan.budget.signal?.addEventListener('abort', () => resolve(), { once: true })),
    ])
    slowSettled += 1
    if (slowSettled === 2) resolveAllSettled()
    return response(plan.url)
  } } })

  let failure: unknown
  let settledAtReturn = 0
  try {
    await host.requestFromBridge({ kind: 'network-all', urls: ['https://fixture.invalid/slow-a', 'https://fixture.invalid/fail', 'https://fixture.invalid/slow-b'] }, new AbortController().signal, source)
  } catch (error) {
    failure = error
  } finally {
    settledAtReturn = slowSettled
    releaseSlow()
    await allSettled
  }
  assert.match(String(failure), /batch failure/u)
  assert.equal(slowStarted, 2)
  assert.equal(settledAtReturn, 2)
})

test('四个并发 bridge 根请求分别计算深度，不会互相触发嵌套限制', async () => {
  const calls: string[] = []
  const requestHost = new SourceRequestHost({ network: { request: async (plan) => {
    calls.push(plan.url)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return response(plan.url)
  } } })
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => requestHost.requestFromBridge(input, signal, requestSource) })
  requestHost.attachRuleHost(ruleHost)
  const rootSource = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'fixture' } as unknown as NormalizedSource

  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => ruleHost.evaluate({
    source: rootSource,
    stage: 'search',
    field: 'parallel-bridge',
    rule: `@js:java.ajax("https://fixture.invalid/parallel/${index}")`,
    content: '',
  })))

  assert.ok(results.every((result) => result.status === 'success'))
  assert.equal(calls.length, 4)
})

test('正文 webJs 提示在没有 WebView 宿主时显式失败', async () => {
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  await assert.rejects(
    () => host.request({ source, url: '/book/1/content', stage: 'detail', options: {}, execution: { webJs: 'window.legado=1' } }),
    /WebView/,
  )
  // 只有 sourceRegex 时不要求 WebView。
  const ok = await host.request({ source, url: '/book/1/content', stage: 'detail', options: {}, execution: { sourceRegex: 'id="content"' } })
  assert.equal(new TextDecoder().decode(ok.bytes), 'ok')
})

test('动态 header 在首层 bridge 重算，深层跳过并受限', async () => {
  const calls: Array<{ url: string; token: string | undefined }> = []
  const host = new SourceRequestHost({
    network: {
      request: async (plan) => {
        calls.push({ url: plan.url, token: plan.headers['X-Token'] })
        return response(plan.url)
      },
    },
  })
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => host.requestFromBridge(input, signal, requestSource) })
  host.attachRuleHost(ruleHost)

  const dynamicHeader = {
    bookSourceUrl: 'https://fixture.invalid',
    bookSourceName: 'fixture',
    header: '@js:java.ajax("https://fixture.invalid/child"); ({"X-Token":"t"})',
  } as unknown as NormalizedSource
  const parent = await host.request({ source: dynamicHeader, url: '/parent', stage: 'search', options: {} })
  assert.equal(new TextDecoder().decode(parent.bytes), 'ok')
  // Android 每个 AnalyzeUrl 都会计算动态 header；TS 只允许首层 bridge 重算，
  // 再入层跳过动态脚本，因此同一个 child 会出现一次带头请求和一次无头请求。
  assert.deepEqual(calls.map((item) => item.url).sort(), [
    'https://fixture.invalid/child',
    'https://fixture.invalid/child',
    'https://fixture.invalid/parent',
  ])
  const childTokens = calls.filter((item) => item.url.endsWith('/child')).map((item) => item.token)
  assert.equal(childTokens.filter((token) => token === 't').length, 1)
  assert.equal(childTokens.filter((token) => token === undefined).length, 1)
  assert.equal(calls.find((item) => item.url.endsWith('/parent'))?.token, 't')
  assert.equal(parent.headers['content-type'], 'text/plain; charset=utf-8')

  // 静态 header 在子请求上仍会合并。
  const staticCalls: string[] = []
  const staticHeader = {
    bookSourceUrl: 'https://fixture.invalid',
    bookSourceName: 'fixture',
    header: JSON.stringify({ 'X-Static': 'yes' }),
  } as unknown as NormalizedSource
  const host2 = new SourceRequestHost({
    network: {
      request: async (plan) => {
        staticCalls.push(JSON.stringify(plan.headers))
        return response(plan.url)
      },
    },
  })
  const ruleHost2 = new SourceRuleHost({ request: (input, signal, requestSource) => host2.requestFromBridge(input, signal, requestSource) })
  host2.attachRuleHost(ruleHost2)
  await host2.request({ source: staticHeader, url: '/parent2', stage: 'search', options: {} })
  // 父请求含静态头；若曾发出子请求则深度/嵌套语义异常（此处无脚本，应只有 1 次网络调用）。
  assert.equal(staticCalls.length, 1)
  assert.match(staticCalls[0] ?? '', /X-Static/)
})

test('文件 bridge 首层重算动态 source header，深层跳过并共享保护', async () => {
  const calls: Array<{ url: string; token: string | undefined }> = []
  const deadlines: number[] = []
  let fileRequests = 0
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    calls.push({ url: plan.url, token: plan.headers['X-Token'] })
    deadlines.push(plan.budget.deadlineMs ?? -1)
    return response(plan.url)
  } } })
  const file = {
    execute: async (operation: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal, currentSource: NormalizedSource) => {
      if (operation !== 'downloadFile') throw new Error(`unexpected file operation: ${operation}`)
      fileRequests += 1
      if (fileRequests > 4) throw new Error('unbounded file bridge')
      await host.requestBytes(String(input.url ?? ''), signal, currentSource, undefined, input.budget as Partial<RequestBudget> | undefined)
      return '/downloaded.bin'
    },
  }
  const ruleHost = new SourceRuleHost({
    request: (input, signal, requestSource) => host.requestFromBridge(input, signal, requestSource),
    file,
  })
  host.attachRuleHost(ruleHost)
  const dynamicSource = { ...source, header: '@js:java.downloadFile("https://fixture.invalid/file.bin"); ({"X-Token":"dynamic"})' } as unknown as NormalizedSource
  const deadline = Date.now() + 12_000
  const result = await host.request({ source: dynamicSource, url: '/parent', stage: 'search', options: { budget: { deadlineMs: deadline } } })
  assert.equal(new TextDecoder().decode(result.bytes), 'ok')
  assert.equal(fileRequests, 2)
  assert.deepEqual(new Set(deadlines), new Set([deadline]))
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    'https://fixture.invalid/file.bin',
    'https://fixture.invalid/file.bin',
    'https://fixture.invalid/parent',
  ])
  assert.equal(calls.filter((call) => call.url.endsWith('/file.bin') && call.token === 'dynamic').length, 1)
  assert.equal(calls.filter((call) => call.url.endsWith('/file.bin') && call.token === undefined).length, 1)
  assert.equal(calls.find((call) => call.url.endsWith('/parent'))?.token, 'dynamic')
})

test('字体 URL bridge 首层重算动态 source header，并继承请求预算', async () => {
  const calls: Array<{ url: string; token: string | undefined }> = []
  const deadlines: number[] = []
  const host = new SourceRequestHost({ network: { request: async (plan) => {
    calls.push({ url: plan.url, token: plan.headers['X-Token'] })
    deadlines.push(plan.budget.deadlineMs ?? -1)
    return response(plan.url)
  } } })
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => host.requestFromBridge(input, signal, requestSource) })
  host.attachRuleHost(ruleHost)
  // fixture 返回的不是字体，脚本捕获解析错误；网络请求仍应走完整 font-query bridge。
  const dynamicSource = { ...source, header: '@js:try { java.queryTTF("https://fixture.invalid/font.ttf") } catch (error) {} ; ({"X-Token":"dynamic"})' } as unknown as NormalizedSource
  const deadline = Date.now() + 12_000
  const result = await host.request({ source: dynamicSource, url: '/parent', stage: 'search', options: { budget: { deadlineMs: deadline } } })
  assert.equal(new TextDecoder().decode(result.bytes), 'ok')
  assert.deepEqual(new Set(deadlines), new Set([deadline]))
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    'https://fixture.invalid/font.ttf',
    'https://fixture.invalid/font.ttf',
    'https://fixture.invalid/parent',
  ])
  assert.equal(calls.filter((call) => call.url.endsWith('/font.ttf') && call.token === 'dynamic').length, 1)
  assert.equal(calls.filter((call) => call.url.endsWith('/font.ttf') && call.token === undefined).length, 1)
  assert.equal(calls.find((call) => call.url.endsWith('/parent'))?.token, 'dynamic')
})

test('请求脚本的 bridge 子请求继承同一绝对 deadline', async () => {
  const deadlines: number[] = []
  const host = new SourceRequestHost({
    network: {
      request: async (plan) => {
        deadlines.push(plan.budget.deadlineMs ?? -1)
        return response(plan.url)
      },
    },
  })
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource, observer) => host.requestFromBridge(input, signal, requestSource, observer) })
  host.attachRuleHost(ruleHost)
  const deadline = Date.now() + 12_000
  const dynamicHeader = { ...source, header: '@js:java.ajax("https://fixture.invalid/child"); ({"X-Token":"t"})' } as unknown as NormalizedSource
  await host.request({ source: dynamicHeader, url: '/parent', stage: 'search', options: { budget: { deadlineMs: deadline } } })
  assert.equal(deadlines.length, 3)
  assert.deepEqual(new Set(deadlines), new Set([deadline]))
})

test('bridge 网络子请求超过深度上限时拒绝', async () => {
  const calls: string[] = []
  const host = new SourceRequestHost({
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return response(plan.url)
      },
    },
  })
  const ruleHost = new SourceRuleHost({ request: (input, signal, requestSource) => host.requestFromBridge(input, signal, requestSource) })
  host.attachRuleHost(ruleHost)

  // 用 js 选项沿 URL 链反复 java.ajax，制造 bridge 再入。
  let target = 'https://fixture.invalid/leaf'
  for (let level = 0; level < 8; level += 1) {
    const js = `java.ajax(${JSON.stringify(target)})`
    target = `https://fixture.invalid/n${level},${JSON.stringify({ js })}`
  }
  const deepSource = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'fixture' } as unknown as NormalizedSource
  await assert.rejects(() => host.request({ source: deepSource, url: target, stage: 'search', options: {} }))
  // js 链在发起 HTTP 前就会触达深度上限；即使命中网络，次数也有界。
  assert.ok(calls.length <= 4, `calls=${calls.length}`)
  const afterFailure = await ruleHost.evaluate({
    source: deepSource,
    stage: 'search',
    field: 'after-failure',
    rule: '@js:java.ajax("https://fixture.invalid/after-failure")',
    content: '',
  })
  assert.equal(afterFailure.status, 'success', '失败的递归调用不应污染后续 bridge 根请求')
})

test('外层 AbortSignal 转发到动态 header 脚本', async () => {
  let seen: AbortSignal | undefined
  const host = new SourceRequestHost({ network: { request: async (plan) => response(plan.url) } })
  host.attachRuleHost({
    evaluate: async () => ({ status: 'empty', value: null }),
    executeWorkflowJavaScript: async (request) => {
      if (request.code.includes('X-Probe')) {
        seen = request.signal
        return { status: 'success', value: { 'X-Probe': '1' } }
      }
      return { status: 'failed', value: null, message: 'unexpected' }
    },
  })
  const controller = new AbortController()
  const headerSource = {
    bookSourceUrl: 'https://fixture.invalid',
    bookSourceName: 'fixture',
    header: '@js:({"X-Probe":"1"})',
  } as unknown as NormalizedSource
  await host.request({ source: headerSource, url: '/signal', stage: 'search', options: { signal: controller.signal } })
  assert.ok(seen, 'header 脚本应收到 signal')
  assert.equal(seen?.aborted, false)
})
