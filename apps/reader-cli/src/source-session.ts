import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks, sourceDefinitionFingerprint } from '@legado/source-core'
import type { BookCandidate, BookMetadata, Chapter, ContentCache, NormalizedSource, SourceSession as CoreSourceSession } from '@legado/source-core'
import { createNodeSourceSession } from '@legado/source-node'
import type { ReaderSourceSession } from './application-model.ts'
import { ReaderStorage } from './storage.ts'

export class SourceSession implements ReaderSourceSession {
  private readonly source: NormalizedSource
  private readonly core: CoreSourceSession

  public constructor(source: NormalizedSource) {
    this.core = createNodeSourceSession(source)
    this.source = this.core.source
  }

  public async search(keyword: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof searchBooks>>> {
    return this.core.run((ports) => searchBooks(ports, { source: this.source, keyword, ...(signal === undefined ? {} : { signal }), maxItems: 100 }))
  }

  public async detail(candidate: BookCandidate, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadBookDetails>>> {
    this.tocPage = undefined
    return this.core.run(async (ports) => {
      const result = await loadBookDetails(ports, { source: this.source, candidates: [candidate], ...(signal === undefined ? {} : { signal }) })
      const metadata = result.value?.items[0]
      if (metadata?.tocHtml !== undefined && metadata.tocUrl !== undefined) this.tocPage = { bookUrl: candidate.bookUrl, url: metadata.tocUrl, html: metadata.tocHtml }
      return result
    })
  }

  public async toc(book: BookMetadata, signal?: AbortSignal, options: { refresh?: boolean; runPerJs?: boolean; isFromBookInfo?: boolean; tocCountWords?: boolean } = {}): Promise<Awaited<ReturnType<typeof loadTableOfContents>>> {
    if (options.refresh === true) this.tocPage = undefined
    const cachedPage = options.refresh !== true && this.tocPage?.bookUrl === book.bookUrl ? this.tocPage : undefined
    const inputBook = cachedPage !== undefined && cachedPage.url === book.tocUrl ? { ...book, tocHtml: cachedPage.html } : book
    return this.core.run((ports) => loadTableOfContents({ ...ports, cache: this.cache }, { source: this.source, book: inputBook, ...(signal === undefined ? {} : { signal }), ...(options.refresh === true ? { refresh: true } : {}), ...(options.runPerJs === true ? { runPerJs: true } : {}), ...(options.isFromBookInfo === true ? { isFromBookInfo: true } : {}), ...(options.tocCountWords === undefined ? {} : { tocCountWords: options.tocCountWords }), maxPages: 32 }))
  }

  public async content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string }): Promise<Awaited<ReturnType<typeof loadChapterContent>>> {
    const cache: ContentCache = options?.refresh === true ? { get: async () => undefined, set: (key, value, cacheSignal) => this.cache.set(key, value, cacheSignal) } : this.cache
    const tocHtml = this.tocPage?.bookUrl === book.bookUrl && chapter.chapterUrl === book.bookUrl ? this.tocPage.html : undefined
    const nextChapterUrl = options?.nextChapterUrl
    return this.core.run((ports) => loadChapterContent({ ...ports, cache }, { source: this.source, book, chapter, ...(tocHtml === undefined ? {} : { tocHtml }), ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }), ...(signal === undefined ? {} : { signal }), maxPages: 32, maxOutputBytes: 4 * 1024 * 1024 }))
  }

  public readonly cache = {
    get: async (key: string, signal?: AbortSignal): Promise<string | undefined> => this.cacheStore?.get(key, signal),
    set: async (key: string, value: string, signal?: AbortSignal): Promise<void> => this.cacheStore?.set(key, value, signal),
  }

  private cacheStore?: ReturnType<ReaderStorage['workflowCache']>
  private tocPage: { bookUrl: string; url: string; html: string } | undefined

  public attachCache(storage: ReaderStorage): void {
    this.cacheStore = storage.workflowCache(sourceDefinitionFingerprint(this.source))
  }
}
