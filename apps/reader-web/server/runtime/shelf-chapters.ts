import { setTimeout as delay } from 'node:timers/promises'
import { SourceRuntimeLeaseBusyError } from './source-session.ts'
import { SOURCE_EXECUTION_MS } from './source-execution.ts'
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
  // 同一账号书源共享 Cookie/变量，按源串行；不同源仍使用设置中的并发上限。
  const groups = new Map<string, ShelfRefreshTarget[]>()
  for (const target of books) {
    if (signal.aborted) return
    const source = await repository.getEditionSource(userId, target.bookId, target.editionKey)
    const key = source ? source.sourceId : JSON.stringify([target.bookId, target.editionKey])
    const group = groups.get(key) ?? []
    group.push(target)
    groups.set(key, group)
  }
  const queue = [...groups.values()]
  let index = 0
  let succeeded = 0
  let failed = 0
  let updated = 0
  await emit({ type: 'batch-start', total: books.length })
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (!signal.aborted) {
      const group = queue[index++]
      if (!group) return
      for (const target of group) {
        if (signal.aborted) return
        let event: ShelfRefreshEvent
        try {
          const waitUntil = Date.now() + SOURCE_EXECUTION_MS
          let result: RefreshShelfChaptersResponse
          while (true) {
            if (signal.aborted) return
            // 每次等待后重新校验，防止书籍在占用期间移出书架或换源。
            const [onShelf, book] = await Promise.all([repository.isOnBookshelf(userId, target.bookId), repository.getBook(userId, target.bookId)])
            if (!onShelf || book?.activeEditionKey !== target.editionKey) throw new Error('书籍已移出书架或已切换书源')
            if (signal.aborted) return
            try {
              result = await refreshShelfChapters(repository, runtime, userId, target.bookId, target.editionKey)
              break
            } catch (error) {
              // 仅重试尚未执行的租约争用；保存冲突和外站失败不得重复执行。
              if (!(error instanceof SourceRuntimeLeaseBusyError)) throw error
              if (Date.now() >= waitUntil) throw new Error('等待书源空闲超时，请稍后重试')
              try { await delay(Math.min(250, waitUntil - Date.now()), undefined, { signal }) } catch (error) { if (signal.aborted) return; throw error }
            }
          }
          succeeded++
          if (result.hasNewChapters) updated++
          event = { type: 'book-result', ...target, result }
        } catch (error) {
          failed++
          event = { type: 'book-error', ...target, error: error instanceof Error ? error.message : '刷新失败' }
        }
        if (!signal.aborted) await emit(event)
      }
    }
  }))
  if (!signal.aborted) await emit({ type: 'batch-end', total: books.length, succeeded, failed, updated })
}
