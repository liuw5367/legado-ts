import assert from 'node:assert/strict'
import test from 'node:test'
import { ReadingPositionQueue, type PositionWrite } from '../src/lib/reading-position-queue.ts'
import type { ApiPosition } from '../src/lib/api.ts'

const input: PositionWrite = { bookId: 'b', editionKey: 'e', chapterId: 'c', chapterUrl: 'https://example.test/c', chapterIndex: 0, title: 'chapter', paragraphIndex: 1, offset: 0, version: 0 }
const position = (write: PositionWrite): ApiPosition => ({ ...write, tocRevision: write.tocRevision ?? '', userId: 'a', lastReadAt: '' })
test('接受新位置后淘汰同版本旧防抖任务，其他版本仍正常保存', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  const old = queue.enqueueDebounced({ ...input, offset: 10 })
  const other = queue.enqueueDebounced({ ...input, editionKey: 'other' })
  await queue.enqueue({ ...input, offset: 100, version: 2 })
  t.mock.timers.tick(2000)
  await queue.flush(); await Promise.all([old, other])
  assert.deepEqual(calls.map((write) => [write.editionKey, write.offset, write.version]), [['e', 100, 2], ['other', 0, 0]])
})
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

test('翻页停止两秒后只保存最后位置，每次翻页重新计时', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  const first = queue.enqueueDebounced(input)
  t.mock.timers.tick(1500)
  const last = queue.enqueueDebounced({ ...input, paragraphIndex: 9, version: 9 })
  t.mock.timers.tick(1999)
  await Promise.resolve()
  assert.equal(calls.length, 0)
  t.mock.timers.tick(1)
  const results = await Promise.all([first, last])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.paragraphIndex, 9)
  assert.equal(calls[0]?.version, 9)
  assert.equal(results[0], results[1])
})

test('离开阅读页立即提交待保存位置，账号销毁丢弃未发任务', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  const first = queue.enqueueDebounced(input)
  await queue.flush('b', 'e')
  assert.equal((await first)?.paragraphIndex, 1)
  t.mock.timers.tick(2000)
  assert.equal(calls.length, 1)
  const discarded = queue.enqueueDebounced({ ...input, paragraphIndex: 5 })
  queue.dispose()
  assert.equal(await discarded, undefined)
  t.mock.timers.tick(2000)
  assert.equal(calls.length, 1)
})

test('防抖等待与正在发送的位置串行结算，失败后可立即重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: PositionWrite[] = []
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let fail = false
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); if (calls.length === 1) await hold; if (fail) throw new Error('offline'); return position(write) })
  const first = queue.enqueue(input)
  await Promise.resolve()
  const last = queue.enqueueDebounced({ ...input, paragraphIndex: 4 })
  t.mock.timers.tick(2000)
  assert.equal(calls.length, 1)
  release(); await first; await last
  assert.deepEqual(calls.map((write) => write.version), [0, 1])
  fail = true
  const failed = queue.enqueueDebounced({ ...input, paragraphIndex: 8 })
  const rejected = assert.rejects(failed, /offline/u)
  await queue.flush(); await rejected
  fail = false
  assert.equal((await queue.retry('b', 'e'))?.paragraphIndex, 8)
})

test('不同书籍的防抖计时相互独立，不提前保存后进入的书籍', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: PositionWrite[] = []
  const queue = new ReadingPositionQueue(async (write) => { calls.push(write); return position(write) })
  const first = queue.enqueueDebounced(input)
  t.mock.timers.tick(1000)
  const second = queue.enqueueDebounced({ ...input, bookId: 'other' })
  t.mock.timers.tick(1000)
  await first
  assert.deepEqual(calls.map((write) => write.bookId), ['b'])
  t.mock.timers.tick(1000)
  await second
  assert.deepEqual(calls.map((write) => write.bookId), ['b', 'other'])
})

test('退出刷新等待已经发出的进度保存结算，不提前读取书架', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  const order: string[] = []
  const queue = new ReadingPositionQueue(async (write) => { order.push('save-start'); await hold; order.push('save-end'); return position(write) })
  const saving = queue.enqueue(input)
  await Promise.resolve()
  const refresh = queue.flush().then(() => { order.push('home-read') })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.deepEqual(order, ['save-start'])
  release(); await saving; await refresh
  assert.deepEqual(order, ['save-start', 'save-end', 'home-read'])
})
