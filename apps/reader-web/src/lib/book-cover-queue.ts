import type { BookSourceItem } from '../../shared/book-sources.ts'

/** 串行补取详情；取消后不提交迟到结果，也不开始下一来源。 */
export async function readBookCovers(sources: BookSourceItem[], signal: AbortSignal, read: (source: BookSourceItem, signal: AbortSignal) => Promise<string | undefined>, update: (source: BookSourceItem, result: { status: 'loading' | 'ready' | 'empty' | 'failed'; coverUrl?: string; error?: string }) => void): Promise<void> {
  for (const source of sources) {
    if (signal.aborted) return
    update(source, { status: 'loading' })
    try {
      const coverUrl = await read(source, signal)
      if (signal.aborted) return
      update(source, coverUrl ? { status: 'ready', coverUrl } : { status: 'empty' })
    } catch (reason) {
      if (signal.aborted) return
      update(source, { status: 'failed', error: reason instanceof Error ? reason.message : '读取失败' })
    }
  }
}

export function bookCoverSourceKey(source: Pick<BookSourceItem, 'sourceId' | 'sourceFingerprint' | 'bookUrl'>): string {
  return JSON.stringify([source.sourceId, source.sourceFingerprint, source.bookUrl])
}
