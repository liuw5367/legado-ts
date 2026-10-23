import assert from 'node:assert/strict'
import test from 'node:test'
import { importSources, searchBooks, SourceRequestRuntime } from '../src/index.ts'
import type { NetworkResponse, NormalizedSource, RequestPlan, WorkflowPorts, WorkflowRuleRequest } from '../src/index.ts'

const baseDefinition = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'source-request',
  exploreUrl: '/explore?page={{page}}',
  searchUrl: '/search?q={{keyword}}&page={{page}}',
  explorePageStart: 1,
  ruleExplore: { bookList: 'bookList', bookName: 'bookName', bookUrl: 'bookUrl' },
  ruleSearch: { bookList: 'bookList', bookName: 'bookName', bookUrl: 'bookUrl' },
}

async function importFixture(overrides: Record<string, unknown> = {}): Promise<NormalizedSource> {
  const imported = await importSources(JSON.stringify({ ...baseDefinition, ...overrides }))
  const source = imported[0]?.source
  assert.ok(source)
  return source
}

function okResponse(url: string, body = 'ok'): NetworkResponse {
  return { url, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, bytes: new TextEncoder().encode(body), redirected: false }
}

/** 模拟只实现 evaluate 的宿主：按脚本正文返回上下文值，不依赖 QuickJS。 */
function evaluateOnlyScript(request: WorkflowRuleRequest): { status: 'success' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'; value: unknown; message?: string } {
  if (!request.rule.startsWith('@js:')) return { status: 'empty', value: null }
  const code = request.rule.slice(4)
  if (code.includes('redirectUrl')) return { status: 'success', value: request.redirectUrl ?? '' }
  if (code.includes('via=js')) return { status: 'success', value: `${String(request.content ?? '')}&via=js` }
  if (code.includes('baseUrl')) return { status: 'success', value: request.baseUrl ?? '' }
  if (code.includes('X-Token')) return { status: 'success', value: { 'X-Token': 'abc' } }
  if (code.includes('not-json')) return { status: 'success', value: 'not-json' }
  return { status: 'success', value: request.baseUrl ?? '' }
}

interface Probe {
  plans: RequestPlan[]
  calls: number
  ruleRequests: WorkflowRuleRequest[]
  listContent?: unknown
}

function probePorts(options?: {
  network?: (plan: RequestPlan, calls: number) => NetworkResponse | Promise<NetworkResponse>
  evaluate?: (request: WorkflowRuleRequest) => ReturnType<NonNullable<WorkflowPorts['rules']['evaluate']>>
  executeWorkflowJavaScript?: WorkflowPorts['rules']['executeWorkflowJavaScript']
  withExecute?: boolean
  defaultUserAgent?: string
}): WorkflowPorts & Probe {
  const probe: WorkflowPorts & Probe = {
    plans: [],
    calls: 0,
    ruleRequests: [],
    network: {
      request: async (plan) => {
        probe.plans.push(plan)
        probe.calls += 1
        return options?.network?.(plan, probe.calls) ?? okResponse(plan.url)
      },
    },
    rules: {
      evaluate: async (request) => {
        probe.ruleRequests.push(request)
        if (options?.evaluate !== undefined) return options.evaluate(request)
        if (request.field === 'bookList') {
          probe.listContent = request.content
          return { status: 'success', value: [{ name: 'Fixture book', author: 'Fixture author', url: '/book/one' }] }
        }
        if (request.field === 'bookName' || request.field === 'bookAuthor' || request.field === 'bookUrl') {
          const item = request.content as { name: string; author: string; url: string }
          return { status: 'success', value: request.field === 'bookName' ? item.name : request.field === 'bookAuthor' ? item.author : item.url }
        }
        if (request.rule.startsWith('@js:')) return evaluateOnlyScript(request)
        return { status: 'empty', value: null }
      },
      ...(options?.withExecute === false || options?.executeWorkflowJavaScript === undefined
        ? {}
        : { executeWorkflowJavaScript: options.executeWorkflowJavaScript }),
    },
  }
  if (options?.defaultUserAgent !== undefined) probe.network.defaultUserAgent = options.defaultUserAgent
  return probe
}

test('仅实现 evaluate 的规则宿主可执行请求 js 脚本', async () => {
  const source = await importFixture({ searchUrl: '/search?q={{keyword}},{"js":"baseUrl"}' })
  const ports = probePorts({ withExecute: false })
  const result = await searchBooks(ports, { source, keyword: 'x' })
  const urlRequest = ports.ruleRequests.find((request) => request.field === 'url' && request.rule.startsWith('@js:'))
  assert.ok(urlRequest, '应回退到 evaluate 执行 js')
  assert.equal(urlRequest.baseUrl, 'https://fixture.invalid')
  assert.equal(urlRequest.content, 'https://fixture.invalid/search?q=x')
  assert.equal(ports.calls, 1)
  assert.equal(ports.plans[0]?.url, 'https://fixture.invalid/')
  assert.equal(result.status, 'success')
  assert.ok(!result.diagnostics.some((item) => item.code === 'request-failed' || item.code === 'capability-missing'))
})

test('SourceRequestRuntime 直调也按 Android 顺序处理任意位置的 @js', async () => {
  const source = await importFixture()
  const seen: WorkflowRuleRequest[] = []
  const ports = probePorts({
    evaluate: async (request) => {
      seen.push(request)
      return { status: 'success', value: `${String(request.content)}&via=js` }
    },
  })
  const runtime = new SourceRequestRuntime({
    network: ports.network,
    rules: ports.rules,
    encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) },
  })
  await runtime.request({ source, url: '/search?q=x@js:result', stage: 'search', options: {} })
  assert.equal(seen[0]?.content, '/search?q=x')
  assert.equal(ports.plans[0]?.url, 'https://fixture.invalid/search?q=x&via=js')
})

test('js 收到请求计划地址，bodyJs 收到最终响应地址', async () => {
  const source = await importFixture({
    searchUrl: '/search?q={{keyword}},{"js":"baseUrl + \\"&via=js\\"","bodyJs":"redirectUrl"}',
  })
  const ports = probePorts({
    withExecute: false,
    network: (plan) => ({
      ...okResponse(plan.url, 'ignored'),
      url: 'https://redirect.invalid/final/search',
      redirected: true,
    }),
  })
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(result.status, 'success')
  assert.equal(ports.plans[0]?.url, 'https://fixture.invalid/search?q=x&via=js')
  const urlJs = ports.ruleRequests.find((request) => request.field === 'url' && request.rule.includes('via=js'))
  assert.ok(urlJs)
  assert.equal(urlJs.baseUrl, 'https://fixture.invalid')
  assert.equal(urlJs.content, 'https://fixture.invalid/search?q=x')
  const bodyJs = ports.ruleRequests.find((request) => request.field === 'body' && request.rule.startsWith('@js:'))
  assert.ok(bodyJs, 'bodyJs 应回退到 evaluate')
  assert.equal(bodyJs.baseUrl, 'https://fixture.invalid')
  assert.equal(bodyJs.redirectUrl, 'https://redirect.invalid/final/search')
  assert.equal(ports.listContent, 'https://redirect.invalid/final/search')
})

test('Android 不识别的 URL method 回退为 GET', async () => {
  const source = await importFixture({ searchUrl: '/search,{"method":"DELETE"}' })
  const ports = probePorts()
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(ports.calls, 1)
  assert.equal(ports.plans[0]?.method, 'GET')
  assert.equal(result.status, 'success')
})

test('URL option String 字段按 Android Gson 规则接收标量和 JSON 对象', async () => {
  const source = await importFixture()
  const plans: RequestPlan[] = []
  const encoding = {
    encode: (value: string, charset = 'utf-8') => {
      if (charset !== 'utf-8') throw new Error(`unsupported charset: ${charset}`)
      return new TextEncoder().encode(value)
    },
    decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  }
  const runtime = new SourceRequestRuntime({
    network: {
      request: async (plan) => {
        plans.push(plan)
        return { ...okResponse(plan.url), bytes: new Uint8Array([0, 255]) }
      },
    },
    encoding,
  })

  await runtime.requestRaw(source, '/method,{"method":123}')
  assert.equal(plans[0]?.method, 'GET', '数字 method 应先按 Gson String 转换，再按 Android 回退 GET')

  const binary = await runtime.requestRaw(source, '/binary,{"type":0}')
  assert.equal(plans[1]?.responseType, 'bytes')
  assert.equal(new TextDecoder().decode(binary.bytes), '00ff')

  await runtime.requestRaw(source, '/blank-type,{"type":"   "}')
  assert.equal(plans[2]?.responseType, 'bytes', 'Gson 直接写入 String 字段后，非 null 的空白 type 仍切换到二进制响应')

  await runtime.requestRaw(source, '/dns,{"resolveIp":123}')
  assert.equal(plans[3]?.execution.dnsIp, '123', 'resolveIp 别名也按 Gson String 字段转换')

  await assert.rejects(
    () => runtime.requestRaw(source, '/charset,{"charset":123}'),
    /不支持 123 编码/,
    '非字符集数字必须在请求前报告能力错误',
  )
  assert.equal(plans.length, 4)

  await assert.rejects(
    () => runtime.requestRaw(source, '/charset-case?q=中文,{"charset":"ESCAPE"}'),
    /不支持 ESCAPE 编码/,
    'Android 只把精确小写 escape 视为 URL escape，其他大小写必须进入字符集解析',
  )

  await assert.rejects(
    () => runtime.requestRaw(source, '/dns-blank,{"dnsIp":"   "}'),
    /dnsIp must contain/,
    '空白 dnsIp 不能被静默当成未配置，Android 会在 DNS 构造阶段失败',
  )
})

test('followRedirects 只接受 Android 定义的布尔值，retry 受请求预算约束', async () => {
  const source = await importFixture()
  const plans: RequestPlan[] = []
  let calls = 0
  const runtime = new SourceRequestRuntime({
    network: {
      request: async (plan) => {
        plans.push(plan)
        calls += 1
        return { ...okResponse(plan.url), status: 503 }
      },
    },
    encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) },
  })

  await runtime.requestRaw(source, '/redirect,{"followRedirects":"false"}')
  assert.equal(plans[0]?.followRedirects, false)
  await runtime.requestRaw(source, '/invalid-redirect,{"followRedirects":"yes"}')
  assert.equal(plans[1]?.followRedirects, true, '非法值应回到 OkHttp 默认跟随重定向')

  await runtime.requestRaw(source, '/retry,{"retry":99}', {}, undefined, { maxRequests: 3 })
  assert.equal(calls, 5, '前两次请求各自一次，预算为 3 的重试请求再执行两次')
  assert.equal(plans.at(-1)?.budget.maxRequests, 3)

  await runtime.requestRaw(source, '/retry-string,{"retry":"2"}')
  assert.equal(calls, 6, 'Android IntJsonDeserializer 不接受字符串 retry，应回到 0 次重试')

  await runtime.requestRaw(source, '/retry-float,{"retry":2.5}', {}, undefined, { maxRequests: 3 })
  assert.equal(calls, 9, 'Android Number.toInt() 会把小数 retry 截断为 2，并受预算限制')
})

test('proxy 只从源级 lowercase Header 提取，URL options 的 proxy 保持普通 Header', async () => {
  const source = await importFixture({ header: JSON.stringify({ proxy: 'http://source-proxy.invalid:8080', 'X-Source': 'yes' }) })
  let plan: RequestPlan | undefined
  const runtime = new SourceRequestRuntime({
    network: {
      request: async (value) => {
        plan = value
        return okResponse(value.url)
      },
    },
    encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) },
  })

  await runtime.requestRaw(source, '/proxy,{"headers":{"proxy":"http://option-proxy.invalid:8080","X-Option":"yes"}}')
  assert.equal(plan?.execution.proxy, 'http://source-proxy.invalid:8080')
  assert.equal(plan?.headers.proxy, 'http://option-proxy.invalid:8080')
  assert.equal(plan?.headers['X-Source'], 'yes')
  assert.equal(plan?.headers['X-Option'], 'yes')
})

test('URL option 的 webView 按 Android 的非通用真假规则判断', async () => {
  const disabledValues: unknown[] = [undefined, null, '', false, 'false']
  for (const value of disabledValues) {
    const suffix = value === undefined ? '' : `,${JSON.stringify({ webView: value })}`
    const source = await importFixture({ searchUrl: `/search${suffix}` })
    const ports = probePorts()
    const result = await searchBooks(ports, { source, keyword: 'x' })
    assert.equal(result.status, 'success', `webView=${String(value)} 应走普通 HTTP`)
    assert.equal(ports.calls, 1)
  }

  for (const value of [0, '0', true, 'true', ' false ', {}]) {
    const source = await importFixture({ searchUrl: `/search,${JSON.stringify({ webView: value })}` })
    const ports = probePorts()
    const result = await searchBooks(ports, { source, keyword: 'x' })
    assert.equal(ports.calls, 0, `webView=${String(value)} 不应静默降级到普通 HTTP`)
    assert.ok(result.diagnostics.some((item) => item.code === 'capability-missing'), `webView=${String(value)} 应报告宿主能力缺失`)
  }
})

test('URL option 的 timeout 和 POST null body 对齐 Android', async () => {
  const source = await importFixture({ searchUrl: '/search,{}' })
  const plans: RequestPlan[] = []
  const runtime = new SourceRequestRuntime({
    network: {
      request: async (plan) => {
        plans.push(plan)
        return okResponse(plan.url, 'plain')
      },
    },
    encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) },
  })

  await runtime.requestRaw(source, '/timeout,{"timeout":"5000"}')
  assert.equal(plans.at(-1)?.budget.timeoutMs, 5000)
  await runtime.requestRaw(source, '/timeout,{"timeout":"5000.0"}')
  assert.equal(plans.at(-1)?.budget.timeoutMs, 30000, 'Android 的 Long.parse 不接受带小数点的字符串')
  await runtime.requestRaw(source, '/timeout,{"timeout":2147483648}')
  assert.equal(plans.at(-1)?.budget.timeoutMs, 30000, 'Android OkHttp timeout 上限为 Int.MAX_VALUE')

  await runtime.requestRaw(source, '/body,{"method":"POST","body":null}')
  const bodyPlan = plans.at(-1)
  assert.equal(bodyPlan?.method, 'POST')
  assert.deepEqual(bodyPlan?.body, new Uint8Array())
  assert.equal(bodyPlan?.headers['Content-Type'], 'application/x-www-form-urlencoded')
})

test('URL option headers 将数组、对象和 null 按 Android toString 传给请求宿主', async () => {
  const source = await importFixture({ searchUrl: '/search,{}' })
  const ports = probePorts()
  const runtime = new SourceRequestRuntime({
    network: ports.network,
    encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) },
  })
  await runtime.requestRaw(source, '/headers,{"headers":{"X-Array":[1,2],"X-Object":{"a":1},"X-Null":null}}')
  assert.equal(ports.plans[0]?.headers['X-Array'], '[1, 2]')
  assert.equal(ports.plans[0]?.headers['X-Object'], '{a=1}')
  assert.equal(ports.plans[0]?.headers['X-Null'], 'null')
})

test('脚本 cancelled/capability-missing/failed 映射为对应诊断', async () => {
  const statuses = ['cancelled', 'capability-missing', 'failed'] as const
  for (const status of statuses) {
    const source = await importFixture({ searchUrl: '/search,{"js":"1"}' })
    const ports = probePorts({
      executeWorkflowJavaScript: async () => ({
        status: status === 'failed' ? 'failed' : status,
        value: null,
        message: `script-${status}`,
      }),
    })
    const result = await searchBooks(ports, { source, keyword: 'x' })
    const expected = status === 'failed' ? 'rule-failed' : status
    const diagnostic = result.diagnostics.find((item) => item.field === 'url')
    assert.ok(diagnostic, `${status} 应产生诊断`)
    assert.equal(diagnostic.code, expected)
    assert.equal(diagnostic.retryable, false)
    assert.equal(ports.calls, 0)
  }
})

test('动态 header 支持 @js 与 js 标签；坏 header 忽略并采用宿主默认 UA', async () => {
  const working = await importFixture({ header: '@js:({ "X-Token": "abc" })' })
  const okPorts = probePorts({ withExecute: false })
  const okResult = await searchBooks(okPorts, { source: working, keyword: 'x' })
  assert.equal(okResult.status, 'success')
  assert.equal(okPorts.plans[0]?.headers['X-Token'], 'abc')

  const tagged = await importFixture({ header: '<js>({ "X-Token": "abc" })</js>' })
  const taggedPorts = probePorts({ withExecute: false })
  const taggedResult = await searchBooks(taggedPorts, { source: tagged, keyword: 'x' })
  assert.equal(taggedResult.status, 'success')
  assert.equal(taggedPorts.plans[0]?.headers['X-Token'], 'abc')

  const explicit = await importFixture({ header: JSON.stringify({ 'User-Agent': 'source-UA' }) })
  const explicitPorts = probePorts({ defaultUserAgent: 'host-UA' })
  const explicitResult = await searchBooks(explicitPorts, { source: explicit, keyword: 'x' })
  assert.equal(explicitResult.status, 'success')
  assert.equal(explicitPorts.plans[0]?.headers['User-Agent'], 'source-UA')

  const broken = await importFixture({ header: '@js:"not-json"' })
  const brokenPorts = probePorts({ withExecute: false, defaultUserAgent: 'Android-compatible UA' })
  const brokenResult = await searchBooks(brokenPorts, { source: broken, keyword: 'x' })
  assert.equal(brokenPorts.calls, 1)
  assert.equal(brokenResult.status, 'success')
  assert.equal(brokenPorts.plans[0]?.headers['User-Agent'], 'Android-compatible UA')
})

test('独立登录凭据头只按初始 URL 同站注入，并由 URL options 覆盖', async () => {
  const source = await importFixture({ header: JSON.stringify({ 'X-Source': 'yes' }) })
  const plans: RequestPlan[] = []
  const providerCalls: string[] = []
  const network = {
    isLoginHeaderSite: (sourceUrl: string, initialUrl: string) => {
      const sourceHost = new URL(sourceUrl).hostname
      const targetHost = new URL(initialUrl, sourceUrl).hostname
      return targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`)
    },
    getLoginHeaders: (sourceId: string) => {
      providerCalls.push(sourceId)
      return { Authorization: 'Bearer login', 'X-Login': 'yes' }
    },
    request: async (plan: RequestPlan): Promise<NetworkResponse> => {
      plans.push(plan)
      return okResponse(plan.url)
    },
  }
  const encoding = { encode: (value: string) => new TextEncoder().encode(value), decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes) }
  const runtime = new SourceRequestRuntime({ network, encoding })

  await runtime.requestRaw(source, '/same')
  assert.equal(plans[0]?.headers.Authorization, 'Bearer login')
  assert.equal(plans[0]?.headers['X-Source'], 'yes')
  await runtime.requestRaw(source, 'https://cdn.fixture.invalid/same-site-subdomain')
  assert.equal(plans[1]?.headers.Authorization, 'Bearer login')
  assert.equal(plans[1]?.headers['X-Source'], 'yes')
  await runtime.requestRaw(source, 'https://cdn.invalid/cross')
  assert.equal(plans[2]?.headers.Authorization, undefined)
  await runtime.requestRaw(source, '/same', { headers: { Authorization: 'Bearer override' } })
  assert.equal(plans[3]?.headers.Authorization, 'Bearer override')
  assert.deepEqual(providerCalls, [source.bookSourceUrl, source.bookSourceUrl, source.bookSourceUrl])

  const rewrittenRuntime = new SourceRequestRuntime({
    network,
    encoding,
    rules: { evaluate: async () => ({ status: 'success', value: 'https://cdn.invalid/rewritten' }) },
  })
  await rewrittenRuntime.requestRaw(source, '/same', { js: 'rewrite' })
  assert.equal(plans[4]?.url, 'https://cdn.invalid/rewritten')
  assert.equal(plans[4]?.headers.Authorization, 'Bearer login', 'Android 只按 URL options 改写前的初始地址判断登录头')
  assert.equal(providerCalls.length, 4)
})

test('缺 XML 声明时先补 Android 声明，再跳过 bodyJs', async () => {
  const source = await importFixture({ searchUrl: '/search,{"bodyJs":"should-not-run"}' })
  const ports = probePorts({ network: (plan) => ({
    ...okResponse(plan.url, '<feed/>'),
    headers: { 'content-type': 'application/atom+xml; charset=utf-8' },
  }) })
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(result.status, 'success')
  assert.equal(ports.listContent, '<?xml version="1.0"?><feed/>')
  assert.equal(ports.ruleRequests.some((request) => request.field === 'body'), false)
})

test('loginCheckJs 看到真实 401，恢复后继续解析', async () => {
  const source = await importFixture({ loginCheckJs: 'login-check' })
  const seen: Array<{ status: number; body: string; header: string | undefined }> = []
  const ports = probePorts({
    network: () => ({
      url: 'https://fixture.invalid/search?q=x',
      status: 401,
      headers: { 'x-probe': 'yes' },
      bytes: new TextEncoder().encode('login-page'),
      redirected: false,
    }),
    executeWorkflowJavaScript: async (request) => {
      if (request.code !== 'login-check') return { status: 'failed', value: null, message: 'unexpected script' }
      const content = request.content as { status: number; body: string; headers: Record<string, string> }
      seen.push({ status: content.status, body: content.body, header: content.headers['x-probe'] ?? undefined })
      return { status: 'success', value: { status: 200, body: 'recovered-ok', headers: { 'content-type': 'text/plain; charset=utf-8' } } }
    },
  })
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(result.status, 'success')
  assert.deepEqual(seen, [{ status: 401, body: 'login-page', header: 'yes' }])
  assert.equal(ports.listContent, 'recovered-ok')
})

test('loginCheckJs 未恢复时仍把真实 4xx/5xx 正文交给解析器', async () => {
  for (const status of [403, 503] as const) {
    const source = await importFixture({ loginCheckJs: 'login-check' })
    const ports = probePorts({
      network: () => ({
        url: 'https://fixture.invalid/search?q=x',
        status,
        headers: {},
        bytes: new TextEncoder().encode('error-page'),
        redirected: false,
      }),
      executeWorkflowJavaScript: async (request) => {
        if (request.code !== 'login-check') return { status: 'failed', value: null, message: 'unexpected script' }
        const content = request.content as { status: number }
        assert.equal(content.status, status, 'loginCheckJs 应看到真实状态码')
        return { status: 'success', value: { status, body: 'still-error', headers: {} } }
      },
    })
    const result = await searchBooks(ports, { source, keyword: 'x' })
    assert.equal(result.status, 'success')
    assert.equal(ports.listContent, 'still-error')
    assert.equal(result.diagnostics.some((item) => item.code === 'request-failed'), false)
  }
})

test('HTTP 错误正文无法解析时报告解析结果而不是状态码请求失败', async () => {
  const source = await importFixture({ loginCheckJs: 'login-check' })
  const bodies: string[] = []
  const ports = probePorts({
    network: () => ({
      url: 'https://fixture.invalid/search?q=x',
      status: 503,
      headers: {},
      bytes: new TextEncoder().encode('error-page'),
      redirected: false,
    }),
    evaluate: async (request) => {
      if (request.field === 'bookList') {
        bodies.push(String(request.content))
        return { status: 'empty', value: null }
      }
      return { status: 'empty', value: null }
    },
    executeWorkflowJavaScript: async (request) => {
      if (request.code !== 'login-check') return { status: 'failed', value: null, message: 'unexpected script' }
      const content = request.content as { status: number }
      assert.equal(content.status, 503)
      return { status: 'success', value: { status: 503, body: 'error-page', headers: {} } }
    },
  })
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(result.status, 'empty')
  assert.deepEqual(bodies, ['error-page'])
  assert.equal(result.diagnostics.some((item) => item.code === 'request-failed'), false)
})

test('缺少 encodeCharset 时非 UTF-8 查询明确失败且不发请求', async () => {
  const source = await importFixture({ searchUrl: '/search?q={{keyword}},{"charset":"gbk"}' })
  const ports = probePorts()
  assert.equal(ports.network.encodeCharset, undefined)
  const result = await searchBooks(ports, { source, keyword: '中文' })
  assert.equal(ports.calls, 0)
  const diagnostic = result.diagnostics.find((item) => item.code === 'capability-missing' || item.code === 'invalid-config' || item.code === 'request-failed')
  assert.ok(diagnostic, '应产生能力或配置诊断')
  assert.equal(diagnostic.retryable, false)
  assert.ok(!ports.plans.some((plan) => plan.url.includes('%E4%B8%AD%E6%96%87')), '不得静默按 UTF-8 编码查询')
})

test('默认工作流与运行时直调对同一 POST 表单产生相同字节', async () => {
  const definitionSearch = '/search?q={{keyword}},{"method":"POST","body":"q=a b"}'
  const viaWorkflow = await importFixture({ searchUrl: definitionSearch })
  const workflowPorts = probePorts()
  const result = await searchBooks(workflowPorts, { source: viaWorkflow, keyword: 'x' })
  assert.equal(result.status, 'success')
  const workflowBody = workflowPorts.plans[0]?.body
  assert.ok(workflowBody instanceof Uint8Array)
  assert.equal(new TextDecoder().decode(workflowBody), 'q=a+b')

  const runtimePorts = probePorts()
  const runtime = new SourceRequestRuntime({
    network: runtimePorts.network,
    encoding: {
      encode: (value, charset) => {
        assert.equal(charset, 'utf-8')
        return new TextEncoder().encode(value)
      },
      decode: (bytes, charset) => new TextDecoder(charset).decode(bytes),
    },
  })
  await runtime.request({ source: viaWorkflow, url: definitionSearch.replace('/search?q={{keyword}},', '/search,'), stage: 'search', options: {} })
  const runtimeBody = runtimePorts.plans[0]?.body
  assert.ok(runtimeBody instanceof Uint8Array)
  assert.deepEqual([...(runtimeBody as Uint8Array)], [...(workflowBody as Uint8Array)])
})

test('source.header 的 proxy 进入 execution 提示且不会作为普通请求头发送', async () => {
  const source = await importFixture({ header: JSON.stringify({ proxy: 'http://user:secret@proxy.invalid:8080', 'X-Probe': 'yes' }) })
  const ports = probePorts()
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(result.status, 'success')
  assert.equal(ports.plans[0]?.execution.proxy, 'http://user:secret@proxy.invalid:8080')
  assert.equal(ports.plans[0]?.headers.proxy, undefined)
  assert.equal(ports.plans[0]?.headers['X-Probe'], 'yes')
})

test('proxy 与 dnsIp 冲突时在网络请求前报配置错误', async () => {
  const source = await importFixture({
    header: JSON.stringify({ proxy: 'http://proxy.invalid:8080' }),
    searchUrl: '/search?q={{keyword}},{"dnsIp":"203.0.113.8"}',
  })
  const ports = probePorts()
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(ports.calls, 0)
  assert.ok(result.diagnostics.some((item) => item.code === 'invalid-config' && item.field === 'header'))
})

test('请求 charset 不覆盖响应 charset，CookieJar 默认开启且可显式关闭', async () => {
  const source = await importFixture()
  assert.equal(source.enabledCookieJar, true)
  const plans: RequestPlan[] = []
  const network = {
    request: async (plan: RequestPlan): Promise<NetworkResponse> => {
      plans.push(plan)
      return okResponse(plan.url, 'response 中文')
    },
  }
  const encoding = {
    encode: (value: string) => new TextEncoder().encode(value),
    decode: (bytes: Uint8Array, charset: string) => new TextDecoder(charset).decode(bytes),
  }
  const runtime = new SourceRequestRuntime({ network, encoding })
  const response = await runtime.requestRaw(source, '/search,{"charset":"gbk"}')
  assert.equal(plans[0]?.requestCharset, 'gbk')
  assert.equal(plans[0]?.responseCharset, undefined)
  assert.equal(response.headers['x-legado-response-charset'], undefined)
  assert.equal(runtime.decodeResponse(response), 'response 中文')
  const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
  const bomGbk: NetworkResponse = {
    url: 'https://fixture.invalid/',
    status: 200,
    headers: { 'content-type': 'text/html; charset=gbk' },
    bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...gbkBytes]),
    redirected: false,
  }
  assert.equal(runtime.decodeResponse(bomGbk), '中文')
  const metaPrefix = new TextEncoder().encode('<meta charset="gbk">')
  assert.equal(runtime.decodeResponse({ ...bomGbk, headers: { 'content-type': 'text/html' }, bytes: new Uint8Array([...metaPrefix, ...gbkBytes]) }), '<meta charset="gbk">中文')
  assert.equal(plans[0]?.execution.cookieJar, true)

  const disabled = await importFixture({ enabledCookieJar: false })
  await runtime.requestRaw(disabled, '/search')
  assert.equal(plans[1]?.execution.cookieJar, false)
  const nullDisabled = await importFixture({ enabledCookieJar: null })
  await runtime.requestRaw(nullDisabled, '/search')
  assert.equal(plans[2]?.execution.cookieJar, false)
  await runtime.requestRaw(source, '/search,{"charset":"gbk","responseCharset":"windows-1252"}')
  assert.equal(plans[3]?.requestCharset, 'gbk')
  assert.equal(plans[3]?.responseCharset, 'windows-1252')

  const workflowSource = await importFixture({ searchUrl: '/search?q={{keyword}},{"charset":"gbk"}' })
  const workflowPorts = probePorts({ network: (plan) => ({
    ...okResponse(plan.url),
    headers: { 'content-type': 'text/plain; charset=gbk' },
    bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0xd6, 0xd0, 0xce, 0xc4]),
  }) })
  workflowPorts.network.encodeCharset = (value) => new TextEncoder().encode(value)
  const result = await searchBooks(workflowPorts, { source: workflowSource, keyword: 'x' })
  assert.equal(result.status, 'success')
  assert.equal(workflowPorts.listContent, '中文', '响应 Content-Type 优先于 URL 请求 charset')
})

test('HTTP 非 2xx/3xx 响应按 option retry 重试，传输异常不重试', async () => {
  const source = await importFixture()
  for (const status of [404, 503]) {
    const ports = probePorts({ network: (plan) => ({ ...okResponse(plan.url), status }) })
    const runtime = new SourceRequestRuntime({ network: ports.network, encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) } })
    const response = await runtime.requestRaw(source, '/search,{"retry":2}')
    assert.equal(response.status, status)
    assert.equal(ports.calls, 3, `HTTP ${status} 应执行 1 次初始请求和 2 次重试`)
  }
  for (const status of [200, 302]) {
    const ports = probePorts({ network: (plan) => ({ ...okResponse(plan.url), status }) })
    const runtime = new SourceRequestRuntime({ network: ports.network, encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) } })
    const response = await runtime.requestRaw(source, status === 302 ? '/search,{"retry":2,"followRedirects":false}' : '/search,{"retry":2}')
    assert.equal(response.status, status)
    assert.equal(ports.calls, 1, `HTTP ${status} 不应重试`)
  }

  let calls = 0
  const runtime = new SourceRequestRuntime({
    network: { request: async () => { calls += 1; throw new Error('transport failure') } },
    encoding: { encode: (value) => new TextEncoder().encode(value), decode: (bytes) => new TextDecoder().decode(bytes) },
  })
  await assert.rejects(() => runtime.requestRaw(source, '/search,{"retry":2}'), /transport failure/)
  assert.equal(calls, 1)
})
