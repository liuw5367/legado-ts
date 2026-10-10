export interface SourceCacheWarning { code: 'source-cache-failed'; message: string }
/** 搜索发现的候选尚未验证详情；只有保存版本才提供editionKey。 */
export type BookSourceItem = {
  sourceId: string
  sourceFingerprint: string
  name: string
  bookUrl: string
} & ({ status: 'saved'; editionKey: string } | { status: 'discovered'; candidateId: string })
export interface BookSourcesResponse { sources: BookSourceItem[]; activeEditionKey?: string }
