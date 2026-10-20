import assert from 'node:assert/strict'
import test from 'node:test'
import { ReadingPositionQueue, type PositionWrite } from '../src/lib/reading-position-queue.ts'
import type { ApiPosition } from '../src/lib/api.ts'

const input: PositionWrite = { bookId: 'b', editionKey: 'e', chapterId: 'c', chapterUrl: 'https://example.test/c', chapterIndex: 0, title: 'chapter', paragraphIndex: 1, offset: 0, version: 0 }
const position = (write: PositionWrite): ApiPosition => ({ ...write, tocRevision: write.tocRevision ?? '', userId: 'a', lastReadAt: '' })
test('queued positions are serial and monotonic across chapter changes', async () => {
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  await Promise.all([queue.enqueue(input), queue.enqueue({ ...input, chapterId: 'c2', paragraphIndex: 9 })])
  assert.deepEqual(calls.map((write) => [write.chapterId, write.version]), [['c', 0], ['c2', 1]])
})
test('failed positions retain the latest anchor for explicit retry, disposal stops queued writes', async () => {
  let fail = true
  let calls = 0
  const queue = new ReadingPositionQueue(async (write) => { calls++; if (fail) throw new Error('offline'); return position(write) })
  await assert.rejects(queue.enqueue({ ...input, paragraphIndex: 7 }), /offline/u)
  fail = false
  assert.equal((await queue.retry('b', 'e'))?.paragraphIndex, 7)
  const pending = queue.enqueue(input); queue.dispose()
  assert.equal(await pending, undefined); assert.equal(calls, 2)
  assert.equal(await queue.retry('b', 'e'), undefined)
})
