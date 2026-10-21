import { z } from 'zod'

export const discoverySourceSchema = z.object({ sourceId: z.string().trim().min(1).max(2000) })
const cursorSchema = z.object({
  index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  token: z.string().max(16000).optional(),
  /** 服务端发现分类/控件快照的代次；旧客户端可省略，服务端会拒绝旧游标。 */
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  signature: z.string().min(1).max(100),
})
export const discoveryPageSchema = discoverySourceSchema.extend({
  fingerprint: z.string().min(1).max(200),
  categoryId: z.string().min(1).max(200),
  cursor: cursorSchema.optional(),
})
export const discoveryBookSchema = discoveryPageSchema.extend({ bookUrl: z.string().min(1).max(16000) })
export const discoveryControlSchema = discoveryPageSchema.extend({ value: z.string().max(16_384).optional() })
export type DiscoveryPageInput = z.infer<typeof discoveryPageSchema>
export type DiscoveryBookInput = z.infer<typeof discoveryBookSchema>
export type DiscoveryControlInput = z.infer<typeof discoveryControlSchema>
/** 服务端签发，绑定账号、书源版本及分类；客户端只原样回传。 */
export type DiscoveryCursor = z.infer<typeof cursorSchema>

export interface DiscoverySource { sourceId: string; name: string; group?: string; fingerprint: string }
export interface DiscoveryCategory {
  id: string
  title: string
  group?: string
  type?: string
  /** 服务端执行 viewName 后的展示文本；原始脚本不会下发到浏览器。 */
  label?: string
  action?: string
  chars?: Array<string | null>
  default?: string
  value?: string
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
export interface DiscoveryControlResult {
  categories: DiscoveryCategory[]
  categoryId: string
  value?: string
  refreshed: boolean
  message?: string
}
