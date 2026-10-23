import { randomUUID } from 'node:crypto'
import type { BookListOrganizationSnapshot, BookListRestore, StoredBookList } from '../../shared/book-lists.ts'
import { createBookListSchema, updateBookListSchema, bookListReviewSchema, addBookListItemSchema } from '../../shared/book-lists.ts'
import { shelfGroupNameSchema, shelfGroupOrderSchema } from '../../shared/bookshelf-groups.ts'

type ListType = StoredBookList['type']
export type OrganizationCommand =
  | { kind: 'create'; id?: string; type: ListType; name: string; description?: string }
  | { kind: 'edit'; type: ListType; id: string; name?: string; description?: string }
  | { kind: 'delete'; type: ListType; id: string; removeBooksFromShelf?: boolean }
  | { kind: 'order'; groupIds: string[] }
  | { kind: 'assign'; bookId: string; groupId: string | null }
  | { kind: 'add' | 'remove' | 'review' | 'move'; id: string; bookId: string; description?: string; restore?: BookListRestore }
export class OrganizationError extends Error {
  public readonly status: 404 | 409
  public constructor(status: 404 | 409, message: string) { super(message); this.status = status }
}
export interface OrganizationState extends BookListOrganizationSnapshot { shelf: Map<string, string | null>; bookIds: Set<string> }

/** 调用方只在全部校验通过后提交；数据库与内存仓库共用业务不变量。 */
export function applyOrganizationCommand(state: OrganizationState, userId: string, command: OrganizationCommand): void {
  const now = new Date().toISOString()
  const find = (id: string, type: ListType) => {
    const row = state.lists.find((item) => item.id === id && item.userId === userId && item.type === type)
    if (!row) throw new OrganizationError(404, '书单或分组不存在')
    return row
  }
  const groupName = (name: string, except?: string) => {
    const value = shelfGroupNameSchema.parse(name)
    if (state.lists.some((row) => row.type === 'shelf_group' && row.name === value && row.id !== except)) throw new OrganizationError(409, '分组名称已存在')
    return value
  }
  if (command.kind === 'create') {
    const input = command.type === 'booklist' ? createBookListSchema.parse({ name: command.name, description: command.description }) : { name: groupName(command.name), description: '' }
    state.lists.push({ id: command.id ?? randomUUID(), userId, type: command.type, ...input, isPublic: false, customOrder: command.type === 'booklist' ? 0 : Math.max(-1, ...state.lists.filter((row) => row.type === 'shelf_group').map((row) => row.customOrder)) + 1, createdAt: now, updatedAt: now })
    return
  }
  if (command.kind === 'order') {
    const { groupIds } = shelfGroupOrderSchema.parse({ groupIds: command.groupIds })
    const groups = state.lists.filter((row) => row.type === 'shelf_group')
    if (groups.length !== groupIds.length || groups.some((row) => !groupIds.includes(row.id))) throw new OrganizationError(409, '分组已变化，请刷新后重新排序')
    for (const [index, id] of groupIds.entries()) find(id, 'shelf_group').customOrder = index
    return
  }
  if (command.kind === 'assign') {
    if (!state.shelf.has(command.bookId)) throw new OrganizationError(404, '书籍不在书架中')
    if (command.groupId !== null) find(command.groupId, 'shelf_group')
    state.shelf.set(command.bookId, command.groupId)
    return
  }
  const row = find(command.id, 'type' in command ? command.type : 'booklist')
  if (command.kind === 'edit') {
    const input = command.type === 'shelf_group' ? { name: groupName(command.name ?? row.name, row.id) } : updateBookListSchema.parse({ ...(command.name === undefined ? {} : { name: command.name }), ...(command.description === undefined ? {} : { description: command.description }) })
    if (Object.entries(input).some(([key, value]) => row[key as 'name' | 'description'] !== value)) Object.assign(row, input, { updatedAt: now })
    return
  }
  if (command.kind === 'delete') {
    if (row.type === 'shelf_group') for (const [bookId, groupId] of state.shelf) if (groupId === row.id) {
      if (command.removeBooksFromShelf) state.shelf.delete(bookId)
      else state.shelf.set(bookId, null)
    }
    state.items = state.items.filter((item) => item.bookListId !== row.id)
    state.lists = state.lists.filter((item) => item.id !== row.id)
    return
  }
  if (!state.bookIds.has(command.bookId)) throw new OrganizationError(404, '书籍不存在')
  const member = state.items.find((item) => item.bookListId === row.id && item.bookId === command.bookId)
  if (command.kind === 'remove') {
    if (member) { state.items = state.items.filter((item) => item !== member); row.updatedAt = now }
  } else if (command.kind === 'review') {
    if (!member) throw new OrganizationError(404, '书籍不在书单中')
    const { description } = bookListReviewSchema.parse({ description: command.description })
    if (member.description !== description) { member.description = description; member.updatedAt = now; row.updatedAt = now }
  } else {
    const { restore } = addBookListItemSchema.parse({ ...(command.restore === undefined ? {} : { restore: command.restore }) })
    if (!member) {
      state.items.push({ userId, bookListId: row.id, bookId: command.bookId, description: restore?.description ?? '', addedAt: restore?.addedAt ?? now, updatedAt: now })
      row.updatedAt = now
    }
    if (command.kind === 'move') state.shelf.delete(command.bookId)
  }
}
