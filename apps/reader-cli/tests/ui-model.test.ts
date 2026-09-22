import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDuration, navigationIndex, navigationPage, normalizeChapterTitle, previousPage } from '../src/ui-model.ts'

test('UI model keeps list navigation inside valid bounds', () => {
  assert.equal(navigationIndex(0, 0, 'j', { downArrow: true }, 4), 0)
  assert.equal(navigationIndex(1, 5, 'j', {}, 3), 2)
  assert.equal(navigationIndex(4, 5, 'j', {}, 3), 4)
  assert.equal(navigationPage(0, 20, '', { pageDown: true }, 5), 4)
  assert.equal(navigationPage(19, 20, '', { pageDown: true }, 5), 15)
})

test('UI model formats stable display values and page return paths', () => {
  assert.equal(formatDuration(999), '999ms')
  assert.equal(formatDuration(1000), '1.0s')
  assert.equal(formatDuration(-1), '未知')
  assert.equal(normalizeChapterTitle(' 第一章： 你好！ '), '第一章你好')
  assert.equal(previousPage('reader'), 'toc')
  assert.equal(previousPage('help'), 'home')
})
