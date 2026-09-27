import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClockHost, RequestPlan } from '../src/runtime/contracts.ts'
import { SourceRateLimiter, withSourceRateLimit } from '../src/runtime/source-rate-limiter.ts'

function plan(signal?: AbortSignal): RequestPlan {
  return {
    url: 'https://fixture.invalid',
    method: 'GET',
    headers: {},
    followRedirects: true,
    responseType: 'text',
    execution: { useWebView: false },
    budget: {
      timeoutMs: 1000,
      maxRequests: 10,
      maxPages: 10,
      maxResponseBytes: 1024,
      maxTotalBytes: 2048,
      maxRequestBodyBytes: 1024,
      maxRedirects: 3,
      ...(signal === undefined ? {} : { signal }),
    },
  }
}

function fakeClock() {
  let currentTime = 0
  const waits: number[] = []
  const clock: ClockHost = {
    now: () => currentTime,
    wait: async (milliseconds, signal) => {
      waits.push(milliseconds)
      if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      currentTime += milliseconds
    },
  }
  return { clock, waits }
}

test('source rate windows support access-count/interval and single-interval forms', async () => {
  const { clock, waits } = fakeClock()
  const limiter = new SourceRateLimiter('2/500', clock)
  await limiter.acquire()
  await limiter.acquire()
  assert.deepEqual(waits, [])
  await limiter.acquire()
  assert.deepEqual(waits, [500])

  const intervalLimiter = new SourceRateLimiter('200', clock)
  await intervalLimiter.acquire()
  await intervalLimiter.acquire()
  assert.deepEqual(waits, [500, 200])
})

test('putConcurrent updates a live window while invalid updates leave its policy intact', async () => {
  const { clock, waits } = fakeClock()
  const limiter = new SourceRateLimiter('0', clock)
  await limiter.acquire()
  limiter.update('1/100')
  await limiter.acquire()
  await limiter.acquire()
  limiter.update('bad')
  await limiter.acquire()
  assert.deepEqual(waits, [100, 100])
})

test('source session rate wrapper preserves host User-Agent configuration', () => {
  const network = withSourceRateLimit({
    defaultUserAgent: 'platform-UA',
    request: async () => ({ url: 'https://fixture.invalid', status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }),
  }, new SourceRateLimiter('0'))
  assert.equal(network.defaultUserAgent, 'platform-UA')
})

test('cancelled source-rate wait does not call the platform network', async () => {
  let rejectWait!: (reason: unknown) => void
  const clock: ClockHost = {
    now: () => 0,
    wait: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
      rejectWait = reject
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  }
  const limiter = new SourceRateLimiter('1/100', clock)
  await limiter.acquire()
  let requests = 0
  const limited = withSourceRateLimit({ request: async () => {
    requests += 1
    return { url: 'https://fixture.invalid', status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }
  } }, limiter)
  const controller = new AbortController()
  const pending = limited.request(plan(controller.signal))
  await Promise.resolve()
  controller.abort()
  rejectWait(new DOMException('aborted', 'AbortError'))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(requests, 0)
})

test('skipRateLimit bypasses the source window but still honors cancellation', async () => {
  const { clock } = fakeClock()
  const limiter = new SourceRateLimiter('1/1000', clock)
  let calls = 0
  const network = withSourceRateLimit({
    request: async (plan) => {
      calls += 1
      return { url: plan.url, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }
    },
  }, limiter)
  const plan = (skipRateLimit: boolean, signal?: AbortSignal) => ({
    url: 'https://fixture.invalid',
    method: 'GET' as const,
    headers: {},
    followRedirects: true,
    responseType: 'text' as const,
    execution: { useWebView: false, ...(skipRateLimit ? { skipRateLimit: true } : {}) },
    budget: { timeoutMs: 1000, maxRequests: 10, maxPages: 10, maxResponseBytes: 100, maxTotalBytes: 100, maxRequestBodyBytes: 100, maxRedirects: 2, ...(signal === undefined ? {} : { signal }) },
  })
  await network.request(plan(false))
  await network.request(plan(true))
  assert.equal(calls, 2)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => network.request(plan(true, controller.signal)), /aborted/i)
  assert.equal(calls, 2)
})
