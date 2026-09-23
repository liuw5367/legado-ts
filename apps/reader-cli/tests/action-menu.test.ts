import assert from 'node:assert/strict'
import test from 'node:test'
import { actionMenuItems, actionMenuLabel } from '../src/action-menu.ts'

test('书籍上下文菜单固定四个动作并在详情页禁用当前页面动作', () => {
  const items = actionMenuItems({ hasBook: true, hasSources: true, hasToc: true, page: 'detail', busy: false })
  assert.deepEqual(items.map((item) => item.action), ['read', 'detail', 'toc', 'sources'])
  assert.equal(items[0]?.label, '阅读')
  assert.equal(items[1]?.enabled, false)
  assert.match(actionMenuLabel(items[1]!), /当前已经是书籍详情页/)
})

test('异步操作期间菜单动作全部不可执行并保留原因', () => {
  const items = actionMenuItems({ hasBook: true, hasSources: true, hasToc: true, page: 'detail', busy: true })
  assert.equal(items.every((item) => item.enabled === false), true)
  assert.match(actionMenuLabel(items[0]!), /暂不可用/)
})
