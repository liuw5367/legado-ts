import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'

test('home keeps newest request per normalized keyword before applying the history limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 10) })
  const repository = new MemoryReaderRepository()
  const old = await repository.createSearch('a', { keyword: ' 目标书 ', sourceId: 's' })
  t.mock.timers.tick(1)
  const latest = await repository.createSearch('a', { keyword: '目标书', sourceId: 's', precision: true })
  for (let i = 0; i < 55; i++) { t.mock.timers.tick(1); await repository.createSearch('a', { keyword: '目标书', sourceId: 's' }) }
  t.mock.timers.tick(1)
  const other = await repository.createSearch('a', { keyword: '另一书', sourceId: 's' })
  await repository.createSearch('b', { keyword: '目标书', sourceId: 's' })
  await repository.updateSearch('a', old.id, { status: 'success' })
  const history = (await repository.getHome('a')).searchHistory
  assert.equal(history.length, 2)
  assert.equal(history[0]?.searchId, other.id)
  assert.notEqual(history[1]?.searchId, old.id)
  assert.notEqual(history[1]?.searchId, latest.id)
  assert.equal((await repository.getHome('b')).searchHistory.length, 1)
  assert.equal(await repository.deleteSearchHistory('b', history[1]!.id), false)
  assert.equal(await repository.deleteSearchHistory('a', history[1]!.id), true)
  assert.deepEqual((await repository.getHome('a')).searchHistory.map((item) => item.keyword), ['另一书'])
  assert.notEqual(await repository.getSearch('a', old.id), null)
})

test('home history preserves distinct keywords and applies the 50-keyword limit after deduplication', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 10) })
  const repository = new MemoryReaderRepository()
  for (let i = 0; i < 60; i++) { t.mock.timers.tick(1); await repository.createSearch('a', { keyword: '书' + i, sourceId: 's' }) }
  for (let i = 0; i < 60; i++) { t.mock.timers.tick(1); await repository.createSearch('a', { keyword: '重复', sourceId: 's' }) }
  const history = (await repository.getHome('a')).searchHistory
  assert.equal(history.length, 50)
  assert.equal(history[0]?.keyword, '重复')
  assert.equal(new Set(history.map((item) => item.keyword)).size, 50)
})
