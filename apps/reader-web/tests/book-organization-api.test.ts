import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { registerBookOrganizationApi } from '../server/book-organization-api.ts'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import type { ApiBookList, ApiShelfGroup } from '../src/lib/api.ts'

const userId = '00000000-0000-0000-0000-000000000001'
function setup() {
  const repository = new MemoryReaderRepository(); const app = new Hono<{ Variables: { userId: string } }>()
  registerBookOrganizationApi(app, () => repository, async (c) => { const user = c.req.header('X-Test-User'); if (!user) return c.json({ error: { code: 'unauthenticated' } }, 401); c.set('userId', user); return undefined })
  const request = (path: string, method = 'GET', body?: unknown, user = userId) => app.request('http://localhost' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Test-User': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { repository, app, request }
}
test('书单 API 校验、创建、查询、修改、跨账号隔离和删除', async () => {
  const { request, app } = setup()
  assert.equal((await app.request('http://localhost/api/book-lists')).status, 401)
  assert.equal((await request('/api/book-lists', 'POST', { name: 'x', userId: 'other' })).status, 400)
  assert.equal((await request('/api/book-lists', 'POST', { name: ' ' })).status, 400)
  const created = await request('/api/book-lists', 'POST', { name: ' 重读 ', description: '推荐' }); assert.equal(created.status, 201)
  const { list } = await created.json() as { list: ApiBookList }; assert.equal(list.name, '重读')
  assert.equal((await request(`/api/book-lists/${list.id}`, 'GET', undefined, 'other')).status, 404)
  const detail = await request(`/api/book-lists/${list.id}`); assert.equal(detail.status, 200); assert.deepEqual((await detail.json()).items, [])
  assert.equal((await request(`/api/book-lists/${list.id}`, 'PATCH', { name: '再读' })).status, 200)
  assert.equal((await request(`/api/book-lists/${list.id}`, 'DELETE')).status, 200)
  assert.equal((await request(`/api/book-lists/${list.id}`)).status, 404)
})
test('分组 API 与普通书单类型隔离、排序和重名校验', async () => {
  const { request } = setup()
  const first = await (await request('/api/bookshelf-groups', 'POST', { name: '科幻' })).json() as { group: ApiShelfGroup }
  const second = await (await request('/api/bookshelf-groups', 'POST', { name: '历史' })).json() as { group: ApiShelfGroup }
  assert.equal((await request(`/api/book-lists/${first.group.id}`)).status, 404)
  assert.equal((await request('/api/bookshelf-groups', 'POST', { name: '科幻' })).status, 409)
  assert.equal((await request('/api/bookshelf-groups', 'POST', { name: '默认' })).status, 400)
  assert.equal((await request('/api/bookshelf-groups/order', 'PATCH', { groupIds: [second.group.id] })).status, 409)
  assert.equal((await request('/api/bookshelf-groups/order', 'PATCH', { groupIds: [second.group.id, first.group.id] })).status, 200)
  const groups = await (await request('/api/bookshelf-groups')).json(); assert.equal(groups.groups[0].id, second.group.id)
  assert.deepEqual((await (await request('/api/book-lists')).json()).lists, [])
})

test('100 个书单与单书单 1000 本书完整返回，封面查询仅读取四本', async (t) => {
  const { repository, request } = setup()
  let listId = ''
  for (let index = 0; index < 100; index++) {
    const value = await repository.mutateBookOrganization(userId, { kind: 'create', type: 'booklist', name: `书单${index}` })
    if (index === 0) listId = value.lists[0]!.id
  }
  for (let index = 0; index < 1000; index++) {
    const metadata = { sourceId: 'https://scale.test', bookUrl: `https://scale.test/${index}`, name: `书籍${index}`, author: '测试作者', rawFields: {}, traceRef: '', emptyFields: [], fieldErrors: {} }
    const created = await repository.createBook(userId, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: String(index), sourceFingerprint: 'fp', addToBookshelf: false })
    await repository.mutateBookOrganization(userId, { kind: 'add', id: listId, bookId: created.book.id })
  }
  const library = t.mock.method(repository, 'getOrganizationLibrary', async () => { throw new Error('展示查询不得加载完整书库') })
  const lists = await (await request('/api/book-lists')).json()
  assert.equal(lists.lists.length, 100)
  const populated = lists.lists.find((row: ApiBookList) => row.id === listId)
  assert.equal(populated.bookCount, 1000); assert.equal(populated.coverBooks.length, 4)
  const choices = await (await request('/api/book-lists?purpose=picker')).json()
  assert.ok(choices.lists.every((row: object) => !('coverBooks' in row)))
  assert.equal(choices.lists.find((row: { id: string }) => row.id === listId).bookCount, 1000)
  const details = await (await request(`/api/book-lists/${listId}`)).json()
  assert.equal(details.items.length, 1000)
  await request('/api/bookshelf-groups')
  assert.equal(library.mock.callCount(), 0)
})

test('数据库失败仍返回统一 JSON 错误且不伪装为空列表', async (t) => {
  const { repository, request } = setup()
  t.mock.method(repository, 'getBookOrganization', async () => { throw new Error('test database unavailable') })
  const response = await request('/api/book-lists')
  assert.equal(response.status, 500)
  assert.equal((await response.json()).error.code, 'server-error')
})

test('展示查询使用必要字段，书单选择器省去封面且特殊字符按字面筛选', async () => {
  const { repository, request } = setup()
  const metadata = { sourceId: 'https://display.test', bookUrl: '/b', name: '显示书籍', author: '作者', intro: '大简介', rawFields: { secret: '执行字段' }, traceRef: '', emptyFields: [], fieldErrors: {} }
  const { book } = await repository.createBook(userId, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: 'edition', sourceFingerprint: 'fp', addToBookshelf: true })
  const result = await (await request('/api/book-lists', 'POST', { name: '100%_书单', description: '描述' })).json()
  const id = result.list.id
  await request(`/api/book-lists/${id}/books/${book.id}`, 'PUT', {})
  const choices = await (await request(`/api/book-lists?purpose=picker&bookId=${book.id}&q=${encodeURIComponent('%_')}`)).json()
  assert.equal(choices.lists.length, 1); assert.equal(choices.lists[0].containsBook, true)
  assert.equal('coverBooks' in choices.lists[0], false)
  const list = (await (await request('/api/book-lists')).json()).lists[0]
  assert.deepEqual(Object.keys(list.coverBooks[0]).sort(), ['id', 'name'])
  const details = await (await request(`/api/book-lists/${id}`)).json()
  assert.equal('edition' in details.items[0], false); assert.equal('position' in details.items[0], false)
  assert.equal('intro' in details.items[0].book, false)
  const groups = await (await request(`/api/bookshelf-groups?bookId=${book.id}`)).json()
  assert.equal(groups.onBookshelf, true); assert.equal(groups.currentGroupId, null); assert.equal(groups.ungroupedCount, 1)
  const identities = await repository.listBookIdentities(userId)
  assert.deepEqual(identities, [{ id: book.id, name: metadata.name, author: metadata.author, onBookshelf: true }])
  assert.deepEqual(await repository.getReadingEntry(userId, book.id), { activeEditionKey: 'edition' })
  assert.equal(await repository.getReadingEntry('other', book.id), null)
})
