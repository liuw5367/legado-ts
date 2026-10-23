import { z } from 'zod'

export const shelfGroupNameSchema = z.string().trim().normalize().refine((value) => [...value].length > 0 && [...value].length <= 30, '分组名称需要 1–30 个字').refine((value) => value !== '全部' && value !== '默认', '不能使用保留的分组名称')
export const shelfGroupSchema = z.object({ name: shelfGroupNameSchema }).strict()
export const shelfGroupOrderSchema = z.object({ groupIds: z.array(z.uuid()).refine((ids) => new Set(ids).size === ids.length, '分组重复') }).strict()
export const shelfGroupAssignmentSchema = z.object({ groupId: z.uuid().nullable() }).strict()
export const shelfGroupDeleteSchema = z.object({ removeBooksFromShelf: z.boolean().default(false) }).strict()
export const bookshelfInitialGroupSchema = z.union([z.literal('all'), z.literal('ungrouped'), z.uuid()])
