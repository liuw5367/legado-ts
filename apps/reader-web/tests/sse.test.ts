import assert from 'node:assert/strict'
import test from 'node:test'
import { createSearchStreamRequest, SseDecoder } from '../src/lib/api.ts'

test('SSE decoder handles split UTF-8 bytes and event boundaries', () => {
  const source = new TextEncoder().encode('event: source-result\ndata: {"title":"中文"}\n\nevent: done\ndata: {"ok":true}\n\n')
  const decoder = new SseDecoder()
  const events = []
  for (let index = 0; index < source.length; index += 2) events.push(...decoder.push(source.slice(index, index + 2)))
  events.push(...decoder.finish())
  assert.deepEqual(events, [{ type: 'source-result', data: { title: '中文' } }, { type: 'done', data: { ok: true } }])
})

test('search stream requests carry cancellation to initial and next-page fetches', () => {
  const controller = new AbortController()
  const initial = createSearchStreamRequest('search id', { access_token: 'token' }, controller.signal)
  assert.equal(initial.path, '/api/searches/search%20id/stream')
  assert.equal(initial.init.signal, controller.signal)
  assert.equal(new Headers(initial.init.headers).get('authorization'), 'Bearer token')

  const nextPage = createSearchStreamRequest('search id', { access_token: 'token' }, controller.signal, { nextPage: true })
  assert.equal(nextPage.path, '/api/searches/search%20id/batches')
  assert.equal(nextPage.init.method, 'POST')
  assert.equal(nextPage.init.signal, controller.signal)
  assert.equal(nextPage.init.body, JSON.stringify({ nextPage: true }))
})
