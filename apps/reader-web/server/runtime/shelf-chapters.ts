import { DEFAULT_BOOKSHELF_REFRESH_CONCURRENCY, bookshelfRefreshConcurrencySchema, type ShelfRefreshEvent, type ShelfRefreshTarget } from '../../shared/shelf-chapters.ts'
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

export async function refreshShelfBatch(repository: ReaderRepository, runtime: ReaderRuntime, userId: string, targets: ShelfRefreshTarget[], emit: (event: ShelfRefreshEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
  const concurrency = bookshelfRefreshConcurrencySchema.catch(DEFAULT_BOOKSHELF_REFRESH_CONCURRENCY).parse((await repository.getSettings(userId)).general.bookshelfRefreshConcurrency)
  const books = [...new Map(targets.map((target) => [JSON.stringify([target.bookId, target.editionKey]), target])).values()]
  let index = 0
  let succeeded = 0
  let failed = 0
  let updated = 0
  await emit({ type: 'batch-start', total: books.length })
  await Promise.all(Array.from({ length: Math.min(concurrency, books.length) }, async () => {
    while (!signal.aborted) {
      const target = books[index++]
      if (!target) return
      let event: ShelfRefreshEvent
      try {
        // 排队期间可能移出书架或换源，执行前重新确认当前账号的书架版本。
        const [onShelf, book] = await Promise.all([repository.isOnBookshelf(userId, target.bookId), repository.getBook(userId, target.bookId)])
        if (!onShelf || book?.activeEditionKey !== target.editionKey) throw new Error('书籍已移出书架或已切换书源')
        if (signal.aborted) return
        const result = await refreshShelfChapters(repository, runtime, userId, target.bookId, target.editionKey)
        succeeded++
        if (result.hasNewChapters) updated++
        event = { type: 'book-result', ...target, result }
      } catch (error) {
        failed++
        event = { type: 'book-error', ...target, error: error instanceof Error ? error.message : '刷新失败' }
      }
      if (!signal.aborted) await emit(event)
    }
  }))
  if (!signal.aborted) await emit({ type: 'batch-end', total: books.length, succeeded, failed, updated })
}
