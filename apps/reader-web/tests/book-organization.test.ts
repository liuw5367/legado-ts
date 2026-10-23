import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { applyOrganizationCommand, OrganizationError, type OrganizationState } from '../server/domain/book-organization.ts'

const userId = '00000000-0000-0000-0000-000000000001'
function state(): OrganizationState { return { lists: [], items: [], shelf: new Map([['book-a', null]]), bookIds: new Set(['book-a']) } }
function create(value: OrganizationState, name: string, type: 'booklist' | 'shelf_group' = 'booklist') { applyOrganizationCommand(value, userId, { kind: 'create', type, name }); return value.lists.at(-1)! }

test('同书多书单评价独立，重复加入不覆盖评价和加入时间', () => {
  const value = state(); const first = create(value, '重读'); const second = create(value, '科幻')
  for (const id of [first.id, second.id]) applyOrganizationCommand(value, userId, { kind: 'add', id, bookId: 'book-a' })
  applyOrganizationCommand(value, userId, { kind: 'review', id: first.id, bookId: 'book-a', description: '再次阅读' })
  const before = structuredClone(value.items)
  applyOrganizationCommand(value, userId, { kind: 'add', id: first.id, bookId: 'book-a' })
  assert.deepEqual(value.items, before)
  assert.equal(value.items[0]?.description, '再次阅读'); assert.equal(value.items[1]?.description, '')
})
test('移除与恢复保留独立评价和原加入时间；移入仅移出书架', () => {
  const value = state(); const list = create(value, '书单')
  applyOrganizationCommand(value, userId, { kind: 'add', id: list.id, bookId: 'book-a', restore: { description: '书评', addedAt: '2026-01-01T00:00:00Z' } })
  const item = value.items[0]!
  applyOrganizationCommand(value, userId, { kind: 'remove', id: list.id, bookId: 'book-a' }); assert.equal(value.items.length, 0)
  applyOrganizationCommand(value, userId, { kind: 'add', id: list.id, bookId: 'book-a', restore: { description: item.description, addedAt: item.addedAt } })
  assert.equal(value.items[0]?.description, '书评'); assert.equal(value.items[0]?.addedAt, item.addedAt)
  applyOrganizationCommand(value, userId, { kind: 'move', id: list.id, bookId: 'book-a' })
  assert.equal(value.shelf.has('book-a'), false); assert.equal(value.bookIds.has('book-a'), true); assert.equal(value.items.length, 1)
})
test('分组单归属、排序与两种删除语义', () => {
  const value = state(); const a = create(value, '科幻', 'shelf_group'); const b = create(value, '历史', 'shelf_group')
  applyOrganizationCommand(value, userId, { kind: 'assign', bookId: 'book-a', groupId: a.id })
  applyOrganizationCommand(value, userId, { kind: 'order', groupIds: [b.id, a.id] }); assert.equal(b.customOrder, 0); assert.equal(a.customOrder, 1)
  assert.throws(() => applyOrganizationCommand(value, userId, { kind: 'order', groupIds: [a.id] }), OrganizationError)
  applyOrganizationCommand(value, userId, { kind: 'delete', type: 'shelf_group', id: a.id }); assert.equal(value.shelf.get('book-a'), null)
  applyOrganizationCommand(value, userId, { kind: 'assign', bookId: 'book-a', groupId: b.id })
  applyOrganizationCommand(value, userId, { kind: 'delete', type: 'shelf_group', id: b.id, removeBooksFromShelf: true })
  assert.equal(value.shelf.has('book-a'), false); assert.equal(value.bookIds.has('book-a'), true)
})
test('拒绝跨账号、错误类型、重名及未在书架中的归属操作', () => {
  const value = state(); const group = create(value, '科幻', 'shelf_group')
  assert.throws(() => create(value, ' 科幻 ', 'shelf_group'), OrganizationError)
  assert.throws(() => create(value, '默认', 'shelf_group'))
  assert.throws(() => applyOrganizationCommand(value, 'other', { kind: 'delete', type: 'shelf_group', id: group.id }), OrganizationError)
  assert.throws(() => applyOrganizationCommand(value, userId, { kind: 'add', id: group.id, bookId: 'book-a' }), OrganizationError)
  assert.throws(() => applyOrganizationCommand(value, userId, { kind: 'assign', bookId: 'missing', groupId: group.id }), OrganizationError)
})
test('内存仓库失败不提交状态，返回对象不会泄漏内部引用', async () => {
  const repo = new MemoryReaderRepository()
  const created = await repo.mutateBookOrganization(userId, { kind: 'create', type: 'shelf_group', name: '科幻' })
  created.lists[0]!.name = '外部修改'
  assert.equal((await repo.getBookOrganization(userId)).lists[0]?.name, '科幻')
  await assert.rejects(repo.mutateBookOrganization(userId, { kind: 'create', type: 'shelf_group', name: '科幻' }))
  assert.equal((await repo.getBookOrganization(userId)).lists.length, 1)
  assert.deepEqual(await repo.getBookOrganization('other'), { lists: [], items: [] })
})

test('分组书籍移出后重新加入必须回到默认分组', async () => {
  const repo = new MemoryReaderRepository()
  const metadata = { sourceId: 'https://group.test', bookUrl: 'https://group.test/1', name: '测试书', rawFields: {}, traceRef: '', emptyFields: [], fieldErrors: {} }
  const created = await repo.createBook(userId, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: 'edition', sourceFingerprint: 'fp' })
  const org = await repo.mutateBookOrganization(userId, { kind: 'create', type: 'shelf_group', name: '科幻' })
  await repo.mutateBookOrganization(userId, { kind: 'assign', bookId: created.book.id, groupId: org.lists[0]!.id })
  assert.equal((await repo.getHome(userId)).bookshelf[0]?.groupId, org.lists[0]!.id)
  await repo.removeFromBookshelf(userId, created.book.id)
  await repo.addToBookshelf(userId, created.book.id)
  assert.equal((await repo.getHome(userId)).bookshelf[0]?.groupId, null)
})
