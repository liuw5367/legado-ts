import type { BookDetailsResponse } from '../../shared/book-details.ts'
import type { ReaderRepository } from '../db/repository.ts'

/** 按账号和书籍版本授权读取；详情预览不能激活来源或泄漏脚本变量。 */
export async function getBookDetails(repository: ReaderRepository, userId: string, bookId: string, editionKey?: string): Promise<BookDetailsResponse | null> {
  const book = await repository.getBook(userId, bookId)
  if (book === null) return null
  const edition = await repository.getEdition(userId, bookId, editionKey || book.activeEditionKey)
  if (edition === null) return null
  const [home, sources] = await Promise.all([
    repository.getHome(userId),
    repository.listManagedSources(userId, { page: 1, pageSize: 50, query: '', status: 'all', all: true }),
  ])
  const metadata: BookDetailsResponse['edition']['metadata'] = {}
  for (const key of ['name', 'author', 'intro', 'coverUrl', 'kind', 'lastChapter'] as const) {
    const value = edition.metadata[key]
    if (typeof value === 'string') metadata[key] = value
  }
  return { book, edition: { editionKey: edition.editionKey, sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, bookUrl: edition.bookUrl, metadata }, sourceName: sources.sources.find((source) => source.sourceId === edition.sourceId)?.name ?? edition.sourceId, onBookshelf: home.bookshelf.some((item) => item.book.id === bookId) }
}
