import { randomUUID } from 'node:crypto'
import type { Hono, Context } from 'hono'
import { z } from 'zod'
import type { ReaderRepository } from './db/repository.ts'
import { OrganizationError } from './domain/book-organization.ts'
import { createBookListSchema, updateBookListSchema, addBookListItemSchema, bookListReviewSchema } from '../shared/book-lists.ts'
import { shelfGroupSchema, shelfGroupOrderSchema, shelfGroupAssignmentSchema, shelfGroupDeleteSchema } from '../shared/bookshelf-groups.ts'

type Variables = { userId: string }
export function registerBookOrganizationApi(app: Hono<{ Variables: Variables }>, repository: () => ReaderRepository, requireUser: (context: Context<{ Variables: Variables }>) => Promise<Response | undefined>): void {
  const guard = (action: (c: Context<{ Variables: Variables }>) => Promise<Response>) => async (c: Context<{ Variables: Variables }>) => {
    try { const denied = await requireUser(c); if (denied) return denied; return await action(c) } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: { code: 'invalid-input', message: error.issues[0]?.message ?? '参数无效' } }, 400)
      if (error instanceof SyntaxError) return c.json({ error: { code: 'invalid-input', message: '请求格式无效' } }, 400)
      if (error instanceof OrganizationError) return c.json({ error: { code: 'organization-error', message: error.message } }, error.status)
      return c.json({ error: { code: 'server-error', message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : error instanceof Error ? error.message : '服务器内部错误' } }, 500)
    }
  }
  const id = (c: Context, name: string) => z.uuid().parse(c.req.param(name))
  app.get('/api/book-lists', guard(async (c) => {
    const userId = c.get('userId'); const repo = repository()
    const organization = await repo.getBookOrganization(userId)
    const bookId = c.req.query('bookId'); if (bookId !== undefined) z.uuid().parse(bookId)
    const query = (c.req.query('q') ?? '').trim().toLocaleLowerCase()
    const visibleLists = organization.lists.filter((row) => row.type === 'booklist' && row.name.toLocaleLowerCase().includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    // 只分桶一次，避免书单数量与成员总数相乘的扫描开销。
    const byList = new Map<string, typeof organization.items>()
    for (const member of organization.items) { const members = byList.get(member.bookListId) ?? []; members.push(member); byList.set(member.bookListId, members) }
    for (const members of byList.values()) members.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.bookId.localeCompare(a.bookId))
    const coverIds = visibleLists.flatMap((list) => (byList.get(list.id) ?? []).slice(0, 4).map((row) => row.bookId))
    const snapshot = await repo.getOrganizationLibrary(userId, [...new Set(coverIds)], false)
    const books = new Map(snapshot.books.map((entry) => [entry.book.id, entry.book]))
    return c.json({ lists: visibleLists.map((row) => {
      const members = byList.get(row.id) ?? []
      return { ...row, bookCount: members.length, coverBooks: members.slice(0, 4).flatMap((item) => { const book = books.get(item.bookId); return book ? [book] : [] }), containsBook: members.some((item) => item.bookId === bookId) }
    }) })
  }))

  app.post('/api/book-lists', guard(async (c) => {
    const input = createBookListSchema.parse(await c.req.json()); const createdId = randomUUID()
    const result = await repository().mutateBookOrganization(c.get('userId'), { kind: 'create', id: createdId, type: 'booklist', ...input })
    return c.json({ list: result.lists.find((row) => row.id === createdId) }, 201)
  }))
  app.get('/api/book-lists/:listId', guard(async (c) => {
    const listId = id(c, 'listId'); const repo = repository(); const userId = c.get('userId')
    const organization = await repo.getBookOrganization(userId, listId)
    const list = organization.lists.find((row) => row.id === listId && row.type === 'booklist')
    if (!list) throw new OrganizationError(404, '书单不存在')
    const snapshot = await repo.getOrganizationLibrary(userId, organization.items.map((row) => row.bookId))
    const books = new Map(snapshot.books.map((entry) => [entry.book.id, entry]))
    const items = organization.items.filter((row) => row.bookListId === listId && books.has(row.bookId)).sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.bookId.localeCompare(a.bookId)).map((row) => {
      const entry = books.get(row.bookId)!
      const edition = entry.editions.find((value) => value.editionKey === entry.book.activeEditionKey)
      const position = snapshot.positions.find((value) => value.bookId === row.bookId && value.editionKey === edition?.editionKey)
      return { ...row, book: entry.book, edition: edition ? { id: edition.id, userId: edition.userId, bookId: edition.bookId, editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl } : undefined, position }
    })
    return c.json({ list, items })
  }))
  app.patch('/api/book-lists/:listId', guard(async (c) => {
    const listId = id(c, 'listId'); const input = updateBookListSchema.parse(await c.req.json())
    const result = await repository().mutateBookOrganization(c.get('userId'), { kind: 'edit', type: 'booklist', id: listId, ...(input.name === undefined ? {} : { name: input.name }), ...(input.description === undefined ? {} : { description: input.description }) })
    return c.json({ list: result.lists.find((row) => row.id === listId) })
  }))
  app.delete('/api/book-lists/:listId', guard(async (c) => { await repository().mutateBookOrganization(c.get('userId'), { kind: 'delete', type: 'booklist', id: id(c, 'listId') }); return c.json({ ok: true }) }))
  for (const method of ['put', 'patch', 'delete', 'post'] as const) {
    const path = '/api/book-lists/:listId/books/:bookId' + (method === 'post' ? '/move-from-bookshelf' : '')
    app[method](path, guard(async (c) => {
      const listId = id(c, 'listId'); const bookId = id(c, 'bookId')
      const input = method === 'put' ? addBookListItemSchema.parse(await c.req.json()) : method === 'patch' ? bookListReviewSchema.parse(await c.req.json()) : {}
      const result = await repository().mutateBookOrganization(c.get('userId'), { kind: method === 'put' ? 'add' : method === 'patch' ? 'review' : method === 'delete' ? 'remove' : 'move', id: listId, bookId, ...('description' in input ? { description: input.description } : {}), ...('restore' in input && input.restore !== undefined ? { restore: input.restore } : {}) })
      return c.json({ item: result.items.find((row) => row.bookListId === listId && row.bookId === bookId), listUpdatedAt: result.lists.find((row) => row.id === listId)?.updatedAt })
    }))
  }
  app.get('/api/bookshelf-groups', guard(async (c) => {
    const repo = repository(); const userId = c.get('userId'); const organization = await repo.getBookOrganization(userId, undefined, false); const home = await repo.getOrganizationLibrary(userId, [], false)
    return c.json({ groups: organization.lists.filter((row) => row.type === 'shelf_group').sort((a, b) => a.customOrder - b.customOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((row) => ({ ...row, bookCount: home.bookshelf.filter((item) => item.groupId === row.id).length })), ungroupedCount: home.bookshelf.filter((row) => !row.groupId).length })
  }))
  app.post('/api/bookshelf-groups', guard(async (c) => {
    const input = shelfGroupSchema.parse(await c.req.json()); const repo = repository(); const createdId = randomUUID()
    const result = await repo.mutateBookOrganization(c.get('userId'), { kind: 'create', id: createdId, type: 'shelf_group', ...input })
    return c.json({ group: result.lists.find((row) => row.id === createdId) }, 201)
  }))
  app.patch('/api/bookshelf-groups/order', guard(async (c) => { const input = shelfGroupOrderSchema.parse(await c.req.json()); const result = await repository().mutateBookOrganization(c.get('userId'), { kind: 'order', ...input }); return c.json({ groups: result.lists.filter((row) => row.type === 'shelf_group').sort((a, b) => a.customOrder - b.customOrder) }) }))
  app.patch('/api/bookshelf-groups/:groupId', guard(async (c) => { const input = shelfGroupSchema.parse(await c.req.json()); await repository().mutateBookOrganization(c.get('userId'), { kind: 'edit', type: 'shelf_group', id: id(c, 'groupId'), ...input }); return c.json({ ok: true }) }))
  app.delete('/api/bookshelf-groups/:groupId', guard(async (c) => { const input = shelfGroupDeleteSchema.parse(await c.req.json()); await repository().mutateBookOrganization(c.get('userId'), { kind: 'delete', type: 'shelf_group', id: id(c, 'groupId'), ...input }); return c.json({ ok: true }) }))
  app.put('/api/books/:bookId/bookshelf/group', guard(async (c) => { const input = shelfGroupAssignmentSchema.parse(await c.req.json()); await repository().mutateBookOrganization(c.get('userId'), { kind: 'assign', bookId: id(c, 'bookId'), ...input }); return c.json({ ok: true }) }))
}
