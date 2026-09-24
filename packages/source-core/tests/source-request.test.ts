import assert from 'node:assert/strict'
import test from 'node:test'
import { importSources, searchBooks } from '../src/index.ts'
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
  if (code.includes('via=js')) return { status: 'success', value: `${request.baseUrl ?? ''}&via=js` }
  if (code.includes('return baseUrl')) return { status: 'success', value: request.baseUrl ?? '' }
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
  return probe
}

test('仅实现 evaluate 的规则宿主可执行请求 js 脚本', async () => {
  const source = await importFixture({ searchUrl: '/search?q={{keyword}},{"js":"return baseUrl"}' })
  const ports = probePorts({ withExecute: false })
  const result = await searchBooks(ports, { source, keyword: 'x' })
  const urlRequest = ports.ruleRequests.find((request) => request.field === 'url' && request.rule.startsWith('@js:'))
  assert.ok(urlRequest, '应回退到 evaluate 执行 js')
  assert.equal(urlRequest.baseUrl, 'https://fixture.invalid/search?q=x')
  assert.equal(ports.calls, 1)
  assert.equal(ports.plans[0]?.url, 'https://fixture.invalid/search?q=x')
  assert.equal(result.status, 'success')
  assert.ok(!result.diagnostics.some((item) => item.code === 'request-failed' || item.code === 'capability-missing'))
})

test('js 收到请求计划地址，bodyJs 收到最终响应地址', async () => {
  const source = await importFixture({
    searchUrl: '/search?q={{keyword}},{"js":"return baseUrl + \\"&via=js\\"","bodyJs":"return redirectUrl"}',
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
  const bodyJs = ports.ruleRequests.find((request) => request.field === 'body' && request.rule.startsWith('@js:'))
  assert.ok(bodyJs, 'bodyJs 应回退到 evaluate')
  assert.equal(bodyJs.baseUrl, 'https://redirect.invalid/final/search')
  assert.equal(bodyJs.redirectUrl, 'https://redirect.invalid/final/search')
  assert.equal(ports.listContent, 'https://redirect.invalid/final/search')
})

test('计划错误映射为不可重试的 invalid-config', async () => {
  const source = await importFixture({ searchUrl: '/search,{"method":"DELETE"}' })
  const ports = probePorts()
  const result = await searchBooks(ports, { source, keyword: 'x' })
  assert.equal(ports.calls, 0)
  assert.equal(result.status, 'failed')
  const diagnostic = result.diagnostics.find((item) => item.code === 'invalid-config')
  assert.ok(diagnostic)
  assert.equal(diagnostic.retryable, false)
  assert.ok(!result.diagnostics.some((item) => item.code === 'request-failed'))
})

test('脚本 cancelled/capability-missing/failed 映射为对应诊断', async () => {
  const statuses = ['cancelled', 'capability-missing', 'failed'] as const
  for (const status of statuses) {
    const source = await importFixture({ searchUrl: '/search,{"js":"return 1"}' })
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

test('动态 header 经 evaluate 回退执行且非法 JSON 报 invalid-config', async () => {
  const working = await importFixture({ header: '@js:return { "X-Token": "abc" }' })
  const okPorts = probePorts({ withExecute: false })
  const okResult = await searchBooks(okPorts, { source: working, keyword: 'x' })
  assert.equal(okResult.status, 'success')
  assert.equal(okPorts.plans[0]?.headers['X-Token'], 'abc')

  const broken = await importFixture({ header: '@js:return "not-json"' })
  const brokenPorts = probePorts({ withExecute: false })
  const brokenResult = await searchBooks(brokenPorts, { source: broken, keyword: 'x' })
  assert.equal(brokenPorts.calls, 0)
  const diagnostic = brokenResult.diagnostics.find((item) => item.code === 'invalid-config')
  assert.ok(diagnostic)
  assert.equal(diagnostic.field, 'header')
  assert.equal(diagnostic.retryable, false)
})
