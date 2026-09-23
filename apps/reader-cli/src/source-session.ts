import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks, sourceDefinitionFingerprint } from '@legado/source-core'
import type { BookCandidate, BookMetadata, Chapter, ContentCache, NormalizedSource, WorkflowPorts } from '@legado/source-core'
import { NodeCookieStore, NodeNetworkHost, SourceRequestHost, SourceRuleHost } from '@legado/source-node'
import type { ReaderSourceSession } from './application-model.ts'
import { ReaderStorage } from './storage.ts'

export class SourceSession implements ReaderSourceSession {
  private readonly source: NormalizedSource
  private readonly cookieStore: NodeCookieStore
  private readonly network: NodeNetworkHost

  public constructor(source: NormalizedSource) {
    this.source = source
    this.cookieStore = new NodeCookieStore()
    this.network = new NodeNetworkHost({ cookieStore: this.cookieStore })
  }

  public async search(keyword: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof searchBooks>>> {
    const operation = this.createOperation()
    operation.rules.setBindings({ key: keyword })
    return searchBooks(operation.ports, { source: this.source, keyword, ...(signal === undefined ? {} : { signal }), maxItems: 100 })
  }

  public async detail(candidate: BookCandidate, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadBookDetails>>> {
    this.tocPage = undefined
    const operation = this.createOperation()
    operation.rules.setBindings({ key: candidate.name ?? '', book: candidate })
    const result = await loadBookDetails(operation.ports, { source: this.source, candidates: [candidate], ...(signal === undefined ? {} : { signal }) })
    const metadata = result.value?.items[0]
    if (metadata?.tocHtml !== undefined && metadata.tocUrl !== undefined) this.tocPage = { bookUrl: candidate.bookUrl, url: metadata.tocUrl, html: metadata.tocHtml }
    return result
  }

  public async toc(book: BookMetadata, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof loadTableOfContents>>> {
    const operation = this.createOperation()
    operation.rules.setBindings({ key: book.name ?? '', book })
    const cachedPage = this.tocPage?.bookUrl === book.bookUrl ? this.tocPage : undefined
    const inputBook = cachedPage !== undefined && cachedPage.url === book.tocUrl ? { ...book, tocHtml: cachedPage.html } : book
    return loadTableOfContents({ ...operation.ports, cache: this.cache }, { source: this.source, book: inputBook, ...(signal === undefined ? {} : { signal }), maxPages: 32 })
  }

  public async content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string }): Promise<Awaited<ReturnType<typeof loadChapterContent>>> {
    const operation = this.createOperation()
    operation.rules.setBindings({ key: book.name ?? '', book, chapter })
    const cache: ContentCache = options?.refresh === true ? { get: async () => undefined, set: (key, value, cacheSignal) => this.cache.set(key, value, cacheSignal) } : this.cache
    const tocHtml = this.tocPage?.bookUrl === book.bookUrl && chapter.chapterUrl === book.bookUrl ? this.tocPage.html : undefined
    const nextChapterUrl = options?.nextChapterUrl
    return loadChapterContent({ ...operation.ports, cache }, { source: this.source, chapter, ...(tocHtml === undefined ? {} : { tocHtml }), ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }), ...(signal === undefined ? {} : { signal }), maxPages: 32, maxOutputBytes: 4 * 1024 * 1024 })
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

  private createOperation(): { rules: SourceRuleHost; ports: WorkflowPorts } {
    const request = new SourceRequestHost({ network: this.network, cookieStore: this.cookieStore })
    const rules = new SourceRuleHost({ request: (input, signal, source) => request.requestFromBridge(input, signal, source) })
    request.attachRuleHost(rules)
    return {
      rules,
      ports: {
        network: this.network,
        rules,
        request: (input) => request.request(input),
        decodeResponse: (response) => request.decodeResponse(response),
      },
    }
  }
}
