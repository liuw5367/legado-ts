import type { ReadingSourceSummary } from './source-management.ts'
import { z } from 'zod'

export interface SourceCacheWarning { code: 'source-cache-failed'; message: string }
/** 搜索发现的候选尚未验证详情；只有保存版本才提供editionKey。 */
export type BookSourceItem = {
  sourceId: string
  sourceFingerprint: string
  name: string
  bookUrl: string
  sourceEnabled: boolean
  coverUrl?: string
  lastChapter?: string
  searchDurationMs?: number
} & ({ status: 'saved'; editionKey: string } | { status: 'discovered'; candidateId: string })
export interface BookSourcesResponse { sources: BookSourceItem[]; sourceSummaries?: ReadingSourceSummary[]; activeEditionKey?: string }

/** 封面只能从当前账号、当前书籍的有效来源中选择；null 恢复跟随书源。 */
export interface BookCoverSelection { sourceId: string; sourceFingerprint: string; bookUrl: string }

export const bookCoverRequestSchema = z.object({
  selection: z.object({ sourceId: z.string().min(1).max(4000), sourceFingerprint: z.string().min(1).max(200), bookUrl: z.string().min(1).max(4000) }).strict().nullable(),
}).strict()
