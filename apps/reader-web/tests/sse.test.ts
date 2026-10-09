import assert from 'node:assert/strict'
import test from 'node:test'
import { SseDecoder } from '../src/lib/api.ts'

test('SSE decoder handles split UTF-8 bytes and event boundaries', () => {
  const source = new TextEncoder().encode('event: source-result\ndata: {"title":"中文"}\n\nevent: done\ndata: {"ok":true}\n\n')
  const decoder = new SseDecoder()
  const events = []
  for (let index = 0; index < source.length; index += 2) events.push(...decoder.push(source.slice(index, index + 2)))
  events.push(...decoder.finish())
  assert.deepEqual(events, [{ type: 'source-result', data: { title: '中文' } }, { type: 'done', data: { ok: true } }])
})
