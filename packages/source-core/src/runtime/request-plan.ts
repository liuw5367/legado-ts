import type { RequestBudget, RequestPlan, RequestPlanInput, RequestPlanResult } from './contracts.ts'

const defaultBudget: RequestBudget = {
  timeoutMs: 15000,
  maxRequests: 32,
  maxPages: 16,
  maxResponseBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRequestBodyBytes: 1024 * 1024,
  maxRedirects: 5,
}

function requestBodyBytes(body: string | Uint8Array | undefined): number {
  if (body === undefined) return 0
  return typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength
}

export function createRequestPlan(input: RequestPlanInput): RequestPlanResult {
  let url: URL
  try {
    url = new URL(input.url, input.baseUrl)
  } catch {
    return { error: { code: 'invalid-url', message: '请求 URL 不是有效的绝对或相对地址' } }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: { code: 'invalid-url', message: '请求只允许 HTTP(S) 协议' } }
  const method = (input.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') return { error: { code: 'invalid-method', message: '请求方法不在允许集合内' } }
  const budget = { ...defaultBudget, ...input.budget }
  const numericLimits = [budget.timeoutMs, budget.maxRequests, budget.maxPages, budget.maxResponseBytes, budget.maxTotalBytes, budget.maxRequestBodyBytes, budget.maxRedirects]
  if (numericLimits.some((value) => !Number.isFinite(value) || value < 0) || numericLimits.some((value) => !Number.isInteger(value)) || (budget.deadlineMs !== undefined && (!Number.isFinite(budget.deadlineMs) || budget.deadlineMs < 0 || !Number.isInteger(budget.deadlineMs)))) return { error: { code: 'invalid-budget', message: '请求预算必须是有限的非负整数' } }
  if (requestBodyBytes(input.body) > budget.maxRequestBodyBytes) return { error: { code: 'request-body-too-large', message: '请求体超过字节预算' } }
  const execution = { useWebView: false, ...input.execution }
  if (execution.useWebView) return { error: { code: 'webview-required', message: '该请求要求 WebView，普通 Node HTTP 宿主不能静默执行' } }
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key, value]))
  const plan: RequestPlan = {
    url: url.toString(),
    method: method as RequestPlan['method'],
    headers,
    followRedirects: input.followRedirects ?? true,
    responseType: input.responseType ?? 'text',
    execution,
    budget,
  }
  if (input.body !== undefined) plan.body = input.body
  if (input.requestCharset !== undefined) plan.requestCharset = input.requestCharset
  if (input.responseCharset !== undefined) plan.responseCharset = input.responseCharset
  return { plan }
}
