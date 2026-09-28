import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedConcurrencyHost } from '../src/runtime/concurrency.ts'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('KeyedConcurrencyHost applies global and per-key limits', async () => {
  const host = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const release = deferred()
  const bothStarted = deferred()
  let active = 0
  let maxActive = 0
  let starts = 0
  const task = async (): Promise<void> => {
    active += 1
    maxActive = Math.max(maxActive, active)
    starts += 1
    if (starts === 2) bothStarted.resolve()
    await release.promise
    active -= 1
  }
  const first = host.run('source', task)
  const sameKey = host.run('source', task)
  const otherKey = host.run('other-source', task)
  await bothStarted.promise
  assert.equal(maxActive, 2)
  assert.equal(starts, 2, 'the second same-key task remains queued')
  release.resolve()
  await Promise.all([first, sameKey, otherKey])
  assert.equal(maxActive, 2)
  assert.equal(starts, 3)
  await host.drain()
})

test('cancel requests abort and drain waits until active task cleanup settles', async () => {
  const host = new KeyedConcurrencyHost({ maxConcurrent: 1 })
  const started = deferred()
  const finishCleanup = deferred()
  let aborted = false
  let drained = false
  const running = host.run('source', async (signal) => {
    started.resolve()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }).catch(async () => {
      aborted = true
      await finishCleanup.promise
      throw new DOMException('aborted', 'AbortError')
    })
  })
  const rejected = assert.rejects(running, { name: 'AbortError' })
  await started.promise
  host.cancel('source')
  const draining = host.drain('source').then(() => { drained = true })
  await Promise.resolve()
  assert.equal(aborted, true)
  assert.equal(drained, false)
  finishCleanup.resolve()
  await Promise.all([rejected, draining])
  assert.equal(drained, true)
  await host.drain()
})

test('setMaxConcurrent releases queued work when capacity increases', async () => {
  const host = new KeyedConcurrencyHost({ maxConcurrent: 1 })
  const firstStarted = deferred()
  const secondStarted = deferred()
  const releaseFirst = deferred()
  const releaseSecond = deferred()
  let active = 0
  let maxActive = 0
  const run = (key: string, started: { resolve: () => void }, release: { promise: Promise<void> }): Promise<void> => host.run(key, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    started.resolve()
    await release.promise
    active -= 1
  })
  const first = run('first', firstStarted, releaseFirst)
  const second = run('second', secondStarted, releaseSecond)
  await firstStarted.promise
  host.setMaxConcurrent(2)
  await secondStarted.promise
  assert.equal(maxActive, 2)
  assert.throws(() => host.setMaxConcurrent(0), /invalid/u)
  releaseFirst.resolve()
  releaseSecond.resolve()
  await Promise.all([first, second])
})
