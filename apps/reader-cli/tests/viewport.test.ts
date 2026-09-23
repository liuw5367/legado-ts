import assert from 'node:assert/strict'
import test from 'node:test'
import { clampContentLine, keepIndexVisible, moveIndex, pageIndex, pageIndexForKey, pagePosition, terminalLayout, viewportFor } from '../src/viewport.ts'

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
  assert.equal(pageIndexForKey(4, 20, 5, 'previous'), 0)
  assert.equal(pageIndexForKey(0, 20, 5, 'next'), 4)
  assert.deepEqual(viewportFor(0, 0, 5, 3), { start: 0, end: 0 })
})

test('页面骨架按终端高度分配固定栏和正文视口', () => {
  assert.deepEqual(terminalLayout(120, 30), { bodyHeight: 27, separator: true, supported: true })
  assert.deepEqual(terminalLayout(80, 17), { bodyHeight: 15, separator: false, supported: true })
  assert.deepEqual(terminalLayout(40, 12), { bodyHeight: 10, separator: false, supported: true })
  assert.equal(terminalLayout(39, 12).supported, false)
  assert.equal(terminalLayout(80, 11).supported, false)
})

test('阅读页首行、当前页和总页数共用可见视口边界', () => {
  assert.equal(clampContentLine(100, 100, 20), 80)
  assert.equal(clampContentLine(-4, 100, 20), 0)
  assert.deepEqual(pagePosition(100, 100, 20), { current: 5, total: 5 })
  assert.deepEqual(pagePosition(0, 21, 20), { current: 1, total: 2 })
  assert.deepEqual(pagePosition(100, 101, 20), { current: 6, total: 6 })
  assert.deepEqual(pagePosition(0, 0, 20), { current: 1, total: 1 })
})
