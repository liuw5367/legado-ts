import { bookShelfSummary } from '../domain/book-reading-state.ts'
import type { ReaderRepository } from '../db/repository.ts'
import type { ReaderRuntime } from './reader-runtime.ts'
import { shelfChapterSummary, type RefreshShelfChaptersResponse } from '../../shared/shelf-chapters.ts'

export async function refreshShelfChapters(repository: ReaderRepository, runtime: ReaderRuntime, userId: string, bookId: string, editionKey: string): Promise<RefreshShelfChaptersResponse> {
  const previous = await repository.getTocSummary(userId, bookId, editionKey)
  const toc = await runtime.getOrLoadTocSummary(userId, bookId, editionKey, true)
  const position = await repository.getPosition(userId, bookId, editionKey)
  const book = await repository.getBook(userId, bookId)
  const summary = book?.activeEditionKey === editionKey ? bookShelfSummary(book, position !== null) : shelfChapterSummary(toc, position)
  const previousChapterCount = previous === null ? null : shelfChapterSummary(previous, null).chapterCount
  return { ...summary, position: position ? { chapterId: position.chapterId, title: position.title, lastReadAt: position.lastReadAt } : null, previousChapterCount, hasNewChapters: previousChapterCount !== null && summary.chapterCount! > previousChapterCount, ...(toc.runtimeWarning ? { runtimeWarning: toc.runtimeWarning } : {}) }
}
