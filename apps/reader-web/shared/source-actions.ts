import { z } from 'zod'

const bookSchema = z.object({
  sourceId: z.string().max(2000).optional(),
  bookUrl: z.string().min(1).max(16_000),
  name: z.string().max(2000).optional(),
  author: z.string().max(2000).optional(),
  variable: z.string().max(16_384).optional(),
  rawFields: z.record(z.string(), z.unknown()).optional(),
})

const chapterSchema = z.object({
  sourceId: z.string().max(2000),
  bookUrl: z.string().min(1).max(16_000),
  chapterUrl: z.string().min(1).max(16_000),
  url: z.string().max(16_000).optional(),
  title: z.string().max(2000).optional(),
  variable: z.string().max(16_384).optional(),
  rawFields: z.record(z.string(), z.unknown()).optional(),
})

const base = z.object({ sourceId: z.string().trim().min(1).max(2000), fingerprint: z.string().trim().min(1).max(200), operationId: z.string().trim().min(1).max(128) })
export const sourcePayActionSchema = base.extend({ book: bookSchema, chapter: chapterSchema, payAction: z.string().max(32_768).optional() })
export const sourceCallbackSchema = base.extend({ event: z.string().trim().min(1).max(128), result: z.unknown().optional(), book: bookSchema.optional(), chapter: chapterSchema.optional(), timeoutMs: z.number().int().min(1).max(60_000).optional() })
export type SourcePayActionInput = z.infer<typeof sourcePayActionSchema>
export type SourceCallbackInput = z.infer<typeof sourceCallbackSchema>

export interface SourceWorkflowAction {
  action: string
}
