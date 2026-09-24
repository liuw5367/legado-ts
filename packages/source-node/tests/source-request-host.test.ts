import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetworkHost, NetworkResponse, NormalizedSource } from '../../source-core/src/index.ts'
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
  host.attachRuleHost(new SourceRuleHost())
  await host.request({ source, url: 'https://fixture.invalid/search?q=<js>return result + java.encodeURI("中文")</js>', stage: 'search', options: {} })
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
    if (requests === 1) throw new Error('temporary network error')
    return { ...response(plan.url), bytes: new TextEncoder().encode('hello') }
  } } })
  host.attachRuleHost(new SourceRuleHost())
  const body = await host.request({
    source,
    url: '/body,{"method":"GET","js":"return result + \'?signed=1\'","bodyJs":"return result.toUpperCase()","retry":1}',
    stage: 'search',
    options: {},
  })
  assert.deepEqual(urls, ['https://fixture.invalid/body?signed=1', 'https://fixture.invalid/body?signed=1'])
  assert.equal(host.decodeResponse(body), 'HELLO')

  const hexHost = new SourceRequestHost({ network: { request: async (plan) => ({ ...response(plan.url), bytes: new Uint8Array([0, 255]) }) } })
  const binary = await hexHost.request({ source, url: '/binary,{"type":"hex"}', stage: 'search', options: {} })
  assert.equal(host.decodeResponse(binary), '00ff')
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
  assert.equal(host.decodeResponse(make(gbk, { 'content-type': 'text/html; charset=utf-8', 'x-legado-response-charset': 'gbk' })), '中文')
  const metaPrefix = new TextEncoder().encode('<meta charset="gbk">')
  const metaBytes = new Uint8Array([...metaPrefix, ...gbk])
  assert.equal(host.decodeResponse(make(metaBytes, { 'content-type': 'text/html' })), '<meta charset="gbk">中文')
  assert.equal(host.decodeResponse(make(metaBytes, { 'content-type': 'text/html; charset=gbk' })), '<meta charset="gbk">中文')

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

test('动态 header 经 bridge 子请求不重算自身，嵌套深度受限', async () => {
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

  const dynamicHeader = {
    bookSourceUrl: 'https://fixture.invalid',
    bookSourceName: 'fixture',
    header: '@js:java.ajax("https://fixture.invalid/child"); return {"X-Token":"t"}',
  } as unknown as NormalizedSource
  const parent = await host.request({ source: dynamicHeader, url: '/parent', stage: 'search', options: {} })
  assert.equal(new TextDecoder().decode(parent.bytes), 'ok')
  // 子请求 + 父请求各一次；nested 跳过动态 header，不会自递归。
  assert.deepEqual(calls.sort(), ['https://fixture.invalid/child', 'https://fixture.invalid/parent'])
  assert.equal(parent.headers['content-type'], 'text/plain; charset=utf-8')

  // 静态 header 在子请求上仍会合并。
  calls.length = 0
  const staticHeader = {
    bookSourceUrl: 'https://fixture.invalid',
    bookSourceName: 'fixture',
    header: JSON.stringify({ 'X-Static': 'yes' }),
  } as unknown as NormalizedSource
  const host2 = new SourceRequestHost({
    network: {
      request: async (plan) => {
        calls.push(JSON.stringify(plan.headers))
        return response(plan.url)
      },
    },
  })
  const ruleHost2 = new SourceRuleHost({ request: (input, signal, requestSource) => host2.requestFromBridge(input, signal, requestSource) })
  host2.attachRuleHost(ruleHost2)
  await host2.request({ source: staticHeader, url: '/parent2', stage: 'search', options: {} })
  // 父请求含静态头；若曾发出子请求则深度/嵌套语义异常（此处无脚本，应只有 1 次网络调用）。
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? '', /X-Static/)
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
    header: '@js:return {"X-Probe":"1"}',
  } as unknown as NormalizedSource
  await host.request({ source: headerSource, url: '/signal', stage: 'search', options: { signal: controller.signal } })
  assert.ok(seen, 'header 脚本应收到 signal')
  assert.equal(seen?.aborted, false)
})
