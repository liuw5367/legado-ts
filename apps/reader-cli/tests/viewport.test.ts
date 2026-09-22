import assert from 'node:assert/strict'
import test from 'node:test'
import { keepIndexVisible, moveIndex, pageIndex, viewportFor } from '../src/viewport.ts'

test('列表视口会把选中项保持在可见范围', () => {
  assert.deepEqual(keepIndexVisible(0, 100, 5, 0), { start: 0, end: 5 })
  assert.deepEqual(keepIndexVisible(8, 100, 5, 0), { start: 4, end: 9 })
  assert.deepEqual(keepIndexVisible(2, 100, 5, 20), { start: 2, end: 7 })
  assert.deepEqual(keepIndexVisible(99, 100, 5, 20), { start: 95, end: 100 })
})

test('空列表和翻页边界不会产生负索引', () => {
  assert.equal(moveIndex(0, 0, 1), 0)
  assert.equal(moveIndex(0, 3, -1), 0)
  assert.equal(moveIndex(2, 3, 1), 2)
  assert.equal(pageIndex(0, 20, 5, -1), 0)
  assert.equal(pageIndex(0, 20, 5, 1), 4)
  assert.deepEqual(viewportFor(0, 0, 5, 3), { start: 0, end: 0 })
})
