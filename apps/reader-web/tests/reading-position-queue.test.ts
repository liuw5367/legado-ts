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

test('adjacent identical unsettled positions share a write and retain the highest requested version', async () => {
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  const results = await Promise.all(Array.from({ length: 10 }, (_, version) => queue.enqueue({ ...input, version })))
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.version, 9)
  assert.ok(results.every((result) => result === results[0]))
  await queue.enqueue(input)
  assert.equal(calls.length, 2, 'settled writes must not suppress a later reading timestamp')
  assert.equal(calls[1]?.version, 10)
})

test('identical in-flight positions share settlement without mutating the sent request', async () => {
  let finish!: () => void
  const hold = new Promise<void>((resolve) => { finish = resolve })
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); await hold; return position(write) })
  const first = queue.enqueue(input)
  await Promise.resolve()
  const second = queue.enqueue({ ...input, version: 20 })
  assert.equal(calls[0]?.version, 0)
  finish()
  assert.equal(await first, await second)
  assert.equal(calls.length, 1)
  await queue.enqueue({ ...input, offset: 1 })
  assert.equal(calls[1]?.version, 21)
})

test('position coalescing never crosses an intervening anchor or changes identity fields', async () => {
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  await Promise.all([queue.enqueue(input), queue.enqueue({ ...input, paragraphIndex: 2 }), queue.enqueue(input)])
  assert.deepEqual(calls.map((write) => write.paragraphIndex), [1, 2, 1])
  const variants: Partial<PositionWrite>[] = [{ bookId: 'b2' }, { editionKey: 'e2' }, { chapterId: 'c2' }, { chapterUrl: 'https://example.test/c2' }, { chapterIndex: 2 }, { title: 'other' }, { tocRevision: 'r2' }, { offset: 2 }]
  for (const variant of variants) {
    const before = calls.length
    await Promise.all([queue.enqueue(input), queue.enqueue({ ...input, ...variant })])
    assert.equal(calls.length, before + 2, JSON.stringify(variant))
  }
})

test('shared failures reject every waiter and permit an explicit retry', async () => {
  let fail = true
  let calls = 0
  const queue = new ReadingPositionQueue(async (write) => { calls++; if (fail) throw new Error('offline'); return position(write) })
  const results = await Promise.allSettled([queue.enqueue(input), queue.enqueue({ ...input, version: 8 })])
  assert.ok(results.every((result) => result.status === 'rejected'))
  assert.equal(calls, 1)
  fail = false
  assert.equal((await queue.retry('b', 'e'))?.version, 9)
  assert.equal(calls, 2)
})
