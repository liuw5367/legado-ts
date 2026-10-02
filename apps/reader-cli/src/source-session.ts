import { discoverBooks, loadBookDetails, loadChapterContent, loadStoredChapterContent, loadTableOfContents, searchBooks } from '@legado/source-core'
import type { BookCandidate, BookMetadata, Chapter, ConcurrencyHost, ContentIdentity, ContentStore, NormalizedSource, SourceSession as CoreSourceSession, WorkflowPorts } from '@legado/source-core'
import { createNodeSourceSession } from '@legado/source-node'
import type { ReaderSourceSession } from './application-model.ts'
import { ReaderStorage } from './storage.ts'
import type { DebugCapture } from './debug-capture.ts'

export class SourceSession implements ReaderSourceSession {
  private readonly source: NormalizedSource
  private readonly core: CoreSourceSession

  public constructor(source: NormalizedSource, concurrency?: ConcurrencyHost) {
    this.core = createNodeSourceSession(source, concurrency === undefined ? {} : { concurrency })
    this.source = this.core.source
  }

  public async search(keyword: string, signal?: AbortSignal, capture?: DebugCapture): Promise<Awaited<ReturnType<typeof searchBooks>>> {
    capture?.beginStage('search')
    const result = await this.core.run((ports) => searchBooks(ports, { source: this.source, keyword, ...(signal === undefined ? {} : { signal }), maxItems: 100 }), capture === undefined ? undefined : { requestObserver: capture })
    capture?.recordResult('search', result, { candidates: result.value?.items.length ?? 0 })
    return result
  }

  public async discover(signal?: AbortSignal, capture?: DebugCapture): Promise<Awaited<ReturnType<typeof discoverBooks>>> {
    capture?.beginStage('search')
    const source = resolveDiscoverySource(this.source)
    const result = source === undefined
      ? { status: 'failed' as const, value: null, diagnostics: [{ code: 'invalid-config' as const, stage: 'discover' as const, field: 'exploreUrl', message: '发现规则为空', retryable: false }], trace: [] }
      : await this.core.run((ports) => discoverBooks(ports, { source, ...(signal === undefined ? {} : { signal }), maxItems: 100 }), capture === undefined ? undefined : { requestObserver: capture })
    capture?.recordResult('search', result, { candidates: result.value?.items.length ?? 0 })
    return result
  }

  public async detail(candidate: BookCandidate, signal?: AbortSignal, capture?: DebugCapture): Promise<Awaited<ReturnType<typeof loadBookDetails>>> {
    this.tocPage = undefined
    capture?.beginStage('book-info')
    const result = await this.core.run(async (ports) => {
      const result = await loadBookDetails(ports, { source: this.source, candidates: [candidate], ...(signal === undefined ? {} : { signal }) })
      const metadata = result.value?.items[0]
      if (metadata?.tocHtml !== undefined && metadata.tocUrl !== undefined) this.tocPage = { bookUrl: candidate.bookUrl, url: metadata.tocUrl, html: metadata.tocHtml }
      return result
    }, capture === undefined ? undefined : { requestObserver: capture })
    capture?.recordResult('book-info', result, { fields: result.value?.items[0] === undefined ? [] : Object.keys(result.value.items[0].rawFields) })
    return result
  }

  public async toc(book: BookMetadata, signal?: AbortSignal, options: { refresh?: boolean; runPerJs?: boolean; isFromBookInfo?: boolean; tocCountWords?: boolean } = {}, capture?: DebugCapture): Promise<Awaited<ReturnType<typeof loadTableOfContents>>> {
    if (options.refresh === true) this.tocPage = undefined
    const cachedPage = options.refresh !== true && this.tocPage?.bookUrl === book.bookUrl ? this.tocPage : undefined
    const inputBook = cachedPage !== undefined && cachedPage.url === book.tocUrl ? { ...book, tocHtml: cachedPage.html } : book
    capture?.beginStage('toc')
    const result = await this.core.run((ports) => loadTableOfContents(ports, { source: this.source, book: inputBook, ...(signal === undefined ? {} : { signal }), ...(options.refresh === true ? { refresh: true } : {}), ...(options.runPerJs === true ? { runPerJs: true } : {}), ...(options.isFromBookInfo === true ? { isFromBookInfo: true } : {}), ...(options.tocCountWords === undefined ? {} : { tocCountWords: options.tocCountWords }), maxPages: 32 }), capture === undefined ? undefined : { requestObserver: capture })
    capture?.recordResult('toc', result, { chapters: result.value?.items.length ?? 0 })
    return result
  }

  public async content(chapter: Chapter, book: BookMetadata, signal?: AbortSignal, options?: { refresh?: boolean; nextChapterUrl?: string; contentStore?: ContentStore; contentIdentity?: ContentIdentity; operationId?: string; saveChapterMetadata?: boolean }, capture?: DebugCapture): Promise<Awaited<ReturnType<typeof loadChapterContent>>> {
    const tocHtml = this.tocPage?.bookUrl === book.bookUrl && chapter.chapterUrl === book.bookUrl ? this.tocPage.html : undefined
    const nextChapterUrl = options?.nextChapterUrl
    capture?.beginStage('content')
    const run = (ports: WorkflowPorts) => options?.contentStore !== undefined && options.contentIdentity !== undefined
      ? loadStoredChapterContent(ports, { source: this.source, book, chapter, contentStore: options.contentStore, contentIdentity: options.contentIdentity, ...(options.operationId === undefined ? {} : { operationId: options.operationId }), ...(options.refresh === true ? { refresh: true } : {}), ...(options.saveChapterMetadata === undefined ? {} : { saveChapterMetadata: options.saveChapterMetadata }), ...(tocHtml === undefined ? {} : { tocHtml }), ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }), ...(signal === undefined ? {} : { signal }), maxPages: 32, maxOutputBytes: 4 * 1024 * 1024 })
      : loadChapterContent(ports, { source: this.source, book, chapter, ...(tocHtml === undefined ? {} : { tocHtml }), ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }), ...(signal === undefined ? {} : { signal }), maxPages: 32, maxOutputBytes: 4 * 1024 * 1024 })
    const result = await this.core.run(run, capture === undefined ? undefined : { requestObserver: capture })
    capture?.recordResult('content', result, { contentCharacters: result.value?.cleaned.length ?? 0 })
    return result
  }

  private tocPage: { bookUrl: string; url: string; html: string } | undefined

  /** 保留旧应用门面的生命周期调用；最终正文存储在每次正文请求中按书籍身份注入。 */
  public attachCache(_storage: ReaderStorage): void {}

  public close(): void {
    this.core.close()
  }
}

function resolveDiscoverySource(source: NormalizedSource): NormalizedSource | undefined {
  const raw = source.exploreUrl
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const text = raw.trim()
  if (text.startsWith('@js:') || text.toLowerCase().startsWith('<js>')) return source
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      const first = parsed.find((item) => {
        if (typeof item !== 'object' || item === null) return false
        const url = (item as Record<string, unknown>).url
        return typeof url === 'string' && url.trim().length > 0
      }) as Record<string, unknown> | undefined
      return typeof first?.url === 'string' && first.url.trim().length > 0 ? { ...source, exploreUrl: first.url } : undefined
    }
  } catch {
    // Android falls back to the plain text parser for non-JSON exploreUrl values.
  }
  const item = text.split(/&&|\r?\n/u).map((value) => value.trim()).find((value) => value.includes('::') && value.split('::').slice(1).join('::').trim().length > 0)
  const url = item === undefined ? undefined : item.split('::').slice(1).join('::').trim()
  return url === undefined || url.length === 0 ? undefined : { ...source, exploreUrl: url }
}
