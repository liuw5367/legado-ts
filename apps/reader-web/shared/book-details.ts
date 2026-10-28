export interface BookDetailsPosition { title: string; lastReadAt: string }

/** 详情接口只返回可展示字段，禁止携带书源脚本变量与运行状态。 */
export interface BookDetailsResponse {
  book: { id: string; userId: string; name: string; author?: string; intro?: string; coverUrl?: string; customCoverUrl?: string; activeEditionKey?: string; createdAt: string; updatedAt: string }
  edition: { editionKey: string; sourceId: string; sourceFingerprint: string; bookUrl: string; metadata: Partial<Record<'name' | 'author' | 'intro' | 'coverUrl' | 'kind' | 'lastChapter' | 'updateTime' | 'wordCount', string>> & { searchDurationMs?: number } }
  sourceName: string
  onBookshelf: boolean
  reading?: BookDetailsPosition | null
}

export interface BookReadingInfo {
  book: { id: string; name: string; author?: string; activeEditionKey?: string }
  edition: { editionKey: string; name?: string }
}
