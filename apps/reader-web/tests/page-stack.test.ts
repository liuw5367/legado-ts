import assert from 'node:assert/strict'
import test from 'node:test'
import type { Location, NavigationType } from 'react-router-dom'
import { emptyPageStack, pageDelta, previousPageDelta, visitPage } from '../src/lib/page-stack.ts'

const location = (path: string, key: string): Location => { const url = new URL(path, 'https://example.test'); return { pathname: url.pathname, search: url.search, hash: url.hash, state: null, key } }
test('browser history restores instances, replaces entries and discards abandoned forward branches', () => {
  let stack = emptyPageStack()
  const visit = (path: string, key: string, action: 'PUSH' | 'POP' | 'REPLACE' = 'PUSH') => { stack = visitPage(stack, location(path, key), action as NavigationType) }
  visit('/', 'home'); const root = stack.activeId
  visit('/search', 'search'); const search = stack.activeId
  visit('/books/a/details', 'details')
  assert.equal(pageDelta(stack, 'home'), -2)
  visit('/search', 'search', 'POP'); assert.equal(stack.activeId, search)
  visit('/books/a/details', 'details', 'POP'); assert.equal(previousPageDelta(stack), -1)
  visit('/search', 'search', 'POP'); visit('/discover', 'discover')
  assert.equal(stack.entries.some((entry) => entry.key === 'details'), false)
  visit('/', 'home-new'); assert.equal(stack.activeId, root)
  const size = stack.entries.length
  visit('/?view=reading', 'home-replace', 'REPLACE')
  assert.equal(stack.entries.length, size); assert.equal(stack.activeId, root)
  visit('/search', 'unknown', 'POP'); assert.equal(previousPageDelta(stack), undefined)
})
test('content LRU keeps eight frames, reconstructs evicted entries and isolates identical URLs', () => {
  let stack = visitPage(emptyPageStack(), location('/', 'root'), 'POP' as NavigationType)
  for (let index = 0; index < 9; index++) stack = visitPage(stack, location('/search', String(index)), 'PUSH' as NavigationType)
  assert.equal(stack.frames.filter((frame) => frame.kind === 'content').length, 8)
  assert.equal(new Set(stack.frames.map((frame) => frame.id)).size, 9)
  stack = visitPage(stack, location('/search', '0'), 'POP' as NavigationType)
  assert.equal(stack.frames.filter((frame) => frame.kind === 'content').length, 8)
  assert.equal(stack.frames.find((frame) => frame.id === stack.activeId)?.location.key, '0')
})
test('reader chapters replace history, changed books discard old reader and passwords never remain hidden', () => {
  let stack = visitPage(emptyPageStack(), location('/', 'root'), 'POP' as NavigationType)
  stack = visitPage(stack, location('/books/a/read/c1?editionKey=e', 'c1'), 'PUSH' as NavigationType)
  const frame = stack.activeId
  stack = visitPage(stack, location('/books/a/read/c2?editionKey=e', 'c2'), 'REPLACE' as NavigationType)
  assert.equal(stack.activeId, frame); assert.equal(stack.entries.length, 2)
  stack = visitPage(stack, location('/books/b/read/c1?editionKey=e', 'b'), 'PUSH' as NavigationType)
  assert.equal(stack.frames.filter((item) => item.kind === 'reader').length, 1)
  assert.notEqual(stack.activeId, frame)
  stack = visitPage(stack, location('/account/password', 'password'), 'PUSH' as NavigationType)
  stack = visitPage(stack, location('/account/settings', 'settings'), 'PUSH' as NavigationType)
  assert.equal(stack.frames.some((item) => item.kind === 'temporary'), false)
})
test('history metadata is bounded and navigation after unknown POP starts a known interval', () => {
  let stack = emptyPageStack()
  for (let index = 0; index < 101; index++) stack = visitPage(stack, location('/', String(index)), 'PUSH' as NavigationType)
  assert.equal(stack.entries.length, 100); assert.equal(stack.index, 99)
  stack = visitPage(stack, location('/discover', 'outside'), 'POP' as NavigationType)
  assert.equal(stack.entries.length, 1); assert.equal(stack.index, 0)
})

test('replace in the middle preserves the browser forward branch and releases the replaced page', () => {
  let stack = emptyPageStack()
  for (const [path, key] of [['/', 'home'], ['/search', 'search'], ['/sources', 'sources']]) stack = visitPage(stack, location(path!, key!), 'PUSH' as NavigationType)
  const forwardId = stack.activeId
  stack = visitPage(stack, location('/search', 'search'), 'POP' as NavigationType)
  const oldId = stack.activeId
  stack = visitPage(stack, location('/account/settings/general', 'general'), 'REPLACE' as NavigationType)
  assert.equal(stack.entries.length, 3)
  assert.equal(stack.frames.some((frame) => frame.id === oldId), false)
  stack = visitPage(stack, location('/sources', 'sources'), 'POP' as NavigationType)
  assert.equal(stack.activeId, forwardId)
})
