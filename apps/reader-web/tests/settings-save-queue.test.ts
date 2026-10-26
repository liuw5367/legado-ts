import assert from 'node:assert/strict'
import test from 'node:test'
import { SettingsSaveQueue, type SettingsPatch } from '../src/lib/settings-save-queue.ts'
import { DEFAULT_READER_SETTINGS } from '../server/domain/types.ts'
import type { ApiSettings } from '../src/lib/api.ts'

const initial = (): ApiSettings => ({ ...DEFAULT_READER_SETTINGS, general: { ...DEFAULT_READER_SETTINGS.general }, userId: 'a', updatedAt: '' })
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('display edits preview outside the queue and twenty updates persist as one final patch after 500ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: SettingsPatch[] = []
  const queue = new SettingsSaveQueue(async (patch) => { calls.push(patch); return { ...initial(), ...patch, general: initial().general } })
  t.after(() => queue.dispose())
  const tasks = Array.from({ length: 20 }, (_, i) => queue.enqueue({ fontSize: 18 + i % 10, marginTop: i }, true))
  t.mock.timers.tick(499); await settle(); assert.equal(calls.length, 0)
  t.mock.timers.tick(1)
  const results = await Promise.all(tasks)
  assert.deepEqual(calls, [{ fontSize: 27, marginTop: 19 }])
  assert.ok(results.every((saved) => saved === results[0]))
})

test('continuous changes save within two seconds and a new window starts afterwards', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: SettingsPatch[] = []
  const queue = new SettingsSaveQueue(async (patch) => { calls.push(patch); return initial() })
  t.after(() => queue.dispose())
  const tasks = [queue.enqueue({ fontSize: 18 }, true)]
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(400); tasks.push(queue.enqueue({ fontSize: 19 + i }, true)) }
  t.mock.timers.tick(400); await Promise.all(tasks)
  assert.deepEqual(calls, [{ fontSize: 22 }])
  const next = queue.enqueue({ lineHeight: 2 }, true)
  t.mock.timers.tick(499); await settle(); assert.equal(calls.length, 1)
  t.mock.timers.tick(1); await next; assert.equal(calls.length, 2)
})

test('immediate settings merge pending display fields and flush cancels both timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: SettingsPatch[] = []
  const queue = new SettingsSaveQueue(async (patch) => { calls.push(patch); return initial() })
  t.after(() => queue.dispose())
  await Promise.all([queue.enqueue({ fontSize: 22 }, true), queue.enqueue({ readingMode: 'paged' })])
  const edit = queue.enqueue({ marginLeft: 30 }, true)
  await Promise.all([edit, queue.flush()])
  t.mock.timers.tick(3000); await settle()
  assert.deepEqual(calls, [{ fontSize: 22, readingMode: 'paged' }, { marginLeft: 30 }])
})

test('a slow write stays serial while all ready but unsent changes keep merging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: () => void
  const hold = new Promise<void>((resolve) => { finish = resolve })
  const calls: SettingsPatch[] = []
  const queue = new SettingsSaveQueue(async (patch) => { calls.push(patch); if (calls.length === 1) await hold; return initial() })
  t.after(() => queue.dispose())
  const first = queue.enqueue({ theme: 'dark' }); await settle()
  const tasks = [queue.enqueue({ fontSize: 20 }, true)]
  t.mock.timers.tick(2000); await settle()
  tasks.push(queue.enqueue({ fontSize: 24 }, true), queue.enqueue({ marginTop: 30 }, true))
  assert.equal(calls.length, 1)
  finish(); await Promise.all([first, ...tasks])
  assert.deepEqual(calls, [{ theme: 'dark' }, { fontSize: 24, marginTop: 30 }])
})

test('failure rejects every caller, keeps unsynced fields and never retries without an edit or explicit retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let fail = true
  const calls: SettingsPatch[] = []
  const queue = new SettingsSaveQueue(async (patch) => { calls.push(patch); if (fail) throw new Error('offline'); return initial() })
  t.after(() => queue.dispose())
  const failed = Promise.allSettled([queue.enqueue({ fontSize: 22 }, true), queue.enqueue({ marginLeft: 30 }, true)])
  t.mock.timers.tick(500)
  assert.ok((await failed).every((result) => result.status === 'rejected'))
  await settle(); t.mock.timers.tick(10000); await settle()
  assert.equal(calls.length, 1)
  assert.equal(await queue.flush(), undefined, 'closing the panel must not silently retry a failed save')
  fail = false
  await queue.flush(true)
  assert.deepEqual(calls[1], { fontSize: 22, marginLeft: 30 })
  fail = true
  await assert.rejects(queue.enqueue({ fontSize: 23, marginRight: 40 }), /offline/u)
  fail = false
  await queue.enqueue({ fontSize: 24 })
  assert.deepEqual(calls[3], { fontSize: 24, marginRight: 40 })
})

test('account disposal rejects unsent edits and prevents a not-yet-started immediate writer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const queue = new SettingsSaveQueue(async () => { calls++; return initial() })
  const delayed = assert.rejects(queue.enqueue({ fontSize: 22 }, true), /账号已切换/u)
  queue.dispose(); await delayed
  t.mock.timers.tick(3000); assert.equal(calls, 0)
  queue.resume()
  const immediate = assert.rejects(queue.enqueue({ theme: 'dark' }), /账号已切换/u)
  queue.dispose(); await immediate; assert.equal(calls, 0)
  await assert.rejects(queue.enqueue({ theme: 'light' }), /账号已切换/u)
})

test('disposing an account with an in-flight save drops its waiting batch and failed patch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: () => void
  const hold = new Promise<void>((resolve) => { finish = resolve })
  let calls = 0
  const queue = new SettingsSaveQueue(async () => { calls++; await hold; throw new Error('old account failed') })
  const old = assert.rejects(queue.enqueue({ theme: 'dark' }), /old account failed/u)
  await settle()
  const pending = assert.rejects(queue.enqueue({ fontSize: 22 }, true), /账号已切换/u)
  t.mock.timers.tick(2000)
  queue.dispose(); await pending
  finish(); await old; await settle()
  assert.equal(calls, 1)
  assert.equal(queue.hasFailed, false)
  assert.equal(await queue.flush(true), undefined)
})

test('immediate actions keep their own confirmed snapshot and are not overwritten by later edits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: () => void
  const hold = new Promise<void>((resolve) => { finish = resolve })
  const calls: SettingsPatch[] = []
  let state = initial()
  const queue = new SettingsSaveQueue(async (patch) => {
    calls.push(patch)
    if (calls.length === 1) await hold
    state = { ...state, ...patch, general: { ...state.general, ...patch.general } }
    return state
  })
  t.after(() => queue.dispose())
  const first = queue.enqueue({ theme: 'dark' }); await settle()
  const preview = queue.enqueue({ fontSize: 20 }, true)
  const mode = queue.enqueue({ readingMode: 'paged' })
  const laterPreview = queue.enqueue({ fontSize: 24 }, true)
  const laterMode = queue.enqueue({ readingMode: 'scroll' })
  const flushed = queue.flush()
  finish()
  const results = await Promise.all([first, preview, mode, laterPreview, laterMode, flushed])
  assert.deepEqual(calls, [{ theme: 'dark' }, { fontSize: 20, readingMode: 'paged' }, { fontSize: 24, readingMode: 'scroll' }])
  assert.equal(results[2]?.readingMode, 'paged')
  assert.equal(results[2]?.fontSize, 20)
  assert.equal(results[4]?.readingMode, 'scroll')
  assert.equal(results[5], results[4])
})
