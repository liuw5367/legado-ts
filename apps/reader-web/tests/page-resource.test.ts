import assert from 'node:assert/strict'
import test from 'node:test'
import { PageResource, mutationDomains } from '../src/lib/page-data.ts'

test('settled page reads survive effect cleanup, invalidation reads again and cancelled reads can resume', () => {
  const resource = new PageResource()
  const first = resource.begin('book:e:0')!
  first.settle(); first.cancel()
  assert.equal(resource.begin('book:e:0'), undefined)
  const invalidated = resource.begin('book:e:1')!
  invalidated.cancel(); invalidated.settle()
  assert.notEqual(resource.begin('book:e:1'), undefined)
  const newer = resource.begin('other:e:1')!
  first.settle(); newer.settle()
  assert.equal(resource.begin('other:e:1'), undefined)
})
test('mutation invalidation distinguishes domain queries, positions and source changes', () => {
  assert.deepEqual(mutationDomains('/api/discovery/page', 'POST'), [])
  assert.deepEqual(mutationDomains('/api/books/a/position', 'POST'), ['bookshelf', 'reading-history', 'booklist-books'])
  assert.deepEqual(mutationDomains('/api/books/a/bookshelf', 'DELETE'), ['bookshelf', 'groups', 'books'])
  assert.deepEqual(mutationDomains('/api/books/a/toc?refresh=true', 'GET'), [])
  assert.ok(mutationDomains('/api/source-management/actions', 'POST').includes('content'))
})

test('cancel failure is retained until explicit retry and blocks a new server search', async () => {
  const { SearchOperation } = await import('../src/lib/search-operation.ts')
  let fail = true
  let ready!: () => void
  const streaming = new Promise<void>((resolve) => { ready = resolve })
  const operation = new SearchOperation({
    create: async () => 'search-1',
    stream: async (_id, _event, signal) => { ready(); await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
    cancel: async () => { if (fail) throw new Error('offline') },
  })
  const running = operation.start('book', false, () => {}, () => {})
  const failed = assert.rejects(running, /offline/u)
  await streaming
  await assert.rejects(operation.cancel(), /offline/u); await failed
  assert.equal(operation.hasPendingCancellation, true)
  await assert.rejects(operation.start('new', false, () => {}, () => {}), /重试取消/u)
  fail = false; await operation.cancel()
  assert.equal(operation.hasPendingCancellation, false)
})
