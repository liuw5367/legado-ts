import { z } from 'zod'

export const discoverySourceSchema = z.object({ sourceId: z.string().trim().min(1).max(2000) })
const cursorSchema = z.object({
  index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  token: z.string().max(16000).optional(),
  signature: z.string().min(1).max(100),
})
export const discoveryPageSchema = discoverySourceSchema.extend({
  fingerprint: z.string().min(1).max(200),
  categoryId: z.string().min(1).max(200),
  cursor: cursorSchema.optional(),
})
export const discoveryBookSchema = discoveryPageSchema.extend({ bookUrl: z.string().min(1).max(16000) })
export type DiscoveryPageInput = z.infer<typeof discoveryPageSchema>
export type DiscoveryBookInput = z.infer<typeof discoveryBookSchema>
/** 服务端签发，绑定账号、书源版本及分类；客户端只原样回传。 */
export type DiscoveryCursor = z.infer<typeof cursorSchema>

export interface DiscoverySource { sourceId: string; name: string; group?: string; fingerprint: string }
export interface DiscoveryCategory {
  id: string
  title: string
  group?: string
  type?: string
  action?: string
  chars?: Array<string | null>
  default?: string
  viewName?: string
  style?: Record<string, unknown>
}
export interface DiscoveryCategories {
  source: DiscoverySource
  categories: DiscoveryCategory[]
  /** 源声明了暂不支持的动态分类或分类配置无效时展示原因。 */
  message?: string
}
export interface DiscoveryBook {
  sourceId: string
  bookUrl: string
  name?: string
  author?: string
  intro?: string
  coverUrl?: string
  kind?: string
  lastChapter?: string
  wordCount?: string
}
export interface DiscoveryPage {
  items: DiscoveryBook[]
  cursor: DiscoveryCursor
  nextCursor?: DiscoveryCursor
  status: 'success' | 'partial' | 'empty'
  message?: string
}
export interface DiscoveryBookResult { book: { id: string }; edition: { editionKey: string } }
