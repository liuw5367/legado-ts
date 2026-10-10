import type { BookDetailsResponse } from '../../shared/book-details.ts'
import type { ReaderRepository } from '../db/repository.ts'

/** 按账号和书籍版本授权读取；详情预览不能激活来源或泄漏脚本变量。 */
export async function getBookDetails(repository: ReaderRepository, userId: string, bookId: string, editionKey?: string): Promise<BookDetailsResponse | null> {
  const book = await repository.getBook(userId, bookId)
  if (book === null) return null
  const edition = await repository.getEdition(userId, bookId, editionKey || book.activeEditionKey)
  if (edition === null) return null
  const [onBookshelf, sourceName, reading] = await Promise.all([
    repository.isOnBookshelf(userId, bookId),
    repository.getSourceDisplayName(userId, edition.sourceId),
    repository.getPosition(userId, bookId, edition.editionKey),
  ])
  const metadata: BookDetailsResponse['edition']['metadata'] = {}
  for (const key of ['name', 'author', 'intro', 'coverUrl', 'kind', 'lastChapter', 'updateTime', 'wordCount'] as const) {
    const value = edition.metadata[key]
    if (typeof value === 'string') metadata[key] = value
  }
  if (typeof edition.metadata.searchDurationMs === 'number') metadata.searchDurationMs = edition.metadata.searchDurationMs
  return { book, edition: { editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, metadata }, sourceName: sourceName ?? edition.sourceId, onBookshelf, reading: reading === null ? null : { editionKey: reading.editionKey, chapterId: reading.chapterId, chapterUrl: reading.chapterUrl, chapterIndex: reading.chapterIndex, title: reading.title, ...(reading.tocRevision === undefined ? {} : { tocRevision: reading.tocRevision }), paragraphIndex: reading.paragraphIndex, offset: reading.offset, version: reading.version, lastReadAt: reading.lastReadAt } }
}
