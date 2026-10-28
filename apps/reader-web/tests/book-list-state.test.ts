import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeBookListRows } from '../src/lib/book-list-state.ts'
import type { ApiBookListItem } from '../src/lib/api.ts'
function item(id: string): ApiBookListItem { return { bookId: id, description: id, addedAt: '2026-01-01', book: { id, name: id } } }
test('返回刷新合并新增书籍且保留移除行原位置和独立评价', () => {
  const a = item('a'); const b = item('b'); const c = item('c')
  const next = mergeBookListRows([a, { ...b, removed: true }], [c, { ...a, description: '新评价' }])
  assert.deepEqual(next.map((row) => row.bookId), ['c', 'a', 'b'])
  assert.equal(next[1]?.description, '新评价'); assert.equal(next[2]?.removed, true); assert.equal(next[2]?.description, 'b')
  assert.equal(mergeBookListRows(next, [c, a, b])[2]?.removed, undefined)
})
