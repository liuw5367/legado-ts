import { z } from 'zod'

const text = (max: number) => z.string().trim().normalize().refine((value) => [...value].length <= max, '内容过长')
export const bookListNameSchema = text(100).refine((value) => value.length > 0, '请填写名称')
export const bookListDescriptionSchema = text(2000)
export const createBookListSchema = z.object({ name: bookListNameSchema, description: bookListDescriptionSchema.default('') }).strict()
export const updateBookListSchema = createBookListSchema.partial().refine((value) => Object.keys(value).length > 0, '没有修改内容')
export const bookListReviewSchema = z.object({ description: bookListDescriptionSchema }).strict()
export const addBookListItemSchema = z.object({ restore: z.object({ description: bookListDescriptionSchema, addedAt: z.iso.datetime({ offset: true }) }).strict().optional() }).strict()

export interface StoredBookList {
  id: string
  userId: string
  type: 'booklist' | 'shelf_group'
  name: string
  description: string
  isPublic: boolean
  customOrder: number
  createdAt: string
  updatedAt: string
}
export interface StoredBookListItem {
  userId: string
  bookListId: string
  bookId: string
  description: string
  addedAt: string
  updatedAt: string
}
export interface BookListOrganizationSnapshot {
  lists: StoredBookList[]
  items: StoredBookListItem[]
}
export type BookListRestore = { description: string; addedAt: string }

export const bookOrganizationBackupSchema = z.object({
  lists: z.array(z.object({ id: z.uuid(), userId: z.string(), type: z.enum(['booklist', 'shelf_group']), name: bookListNameSchema, description: bookListDescriptionSchema, isPublic: z.boolean(), customOrder: z.number().int().min(0).default(0), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }) })),
  items: z.array(z.object({ userId: z.string(), bookListId: z.uuid(), bookId: z.uuid(), description: bookListDescriptionSchema, addedAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }) })),
})
