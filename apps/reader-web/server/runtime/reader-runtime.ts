import { createHash } from 'node:crypto'
import { loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '@legado/source-core'
import type { BookMetadata, Chapter, ChapterContent, NormalizedSource, WorkflowStatus } from '@legado/source-core'
import { createNodeSourceSession } from '@legado/source-node'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import { seedConfiguredSources } from '../db/source-seed.ts'
import type { BookCreationInput, SearchBatchResult, SearchRunState, StoredBook, StoredContent, StoredEdition, StoredToc } from '../domain/types.ts'

export class ReaderRuntimeError extends Error {
  public readonly code: 'not-found' | 'invalid-input' | 'source-failed' | 'configuration'
  public constructor(code: 'not-found' | 'invalid-input' | 'source-failed' | 'configuration', message: string) { super(message); this.code = code }
}

export interface ReaderRuntime {
  listSources(): Promise<StoredSourceRecord[]>
  runSearchBatch(userId: string, searchId: string): Promise<SearchBatchResult>
  createBookFromSearch(userId: string, searchId: string, candidateIndex: number): Promise<{ book: StoredBook; edition: StoredEdition }>
  getOrLoadToc(userId: string, bookId: string, editionKey: string, refresh?: boolean): Promise<StoredToc>
  getOrLoadContent(userId: string, bookId: string, editionKey: string, chapterId: string, refresh?: boolean): Promise<StoredContent>
}

export function createReaderRuntime(repository: ReaderRepository): ReaderRuntime {
  return {
    listSources: async () => { await seedConfiguredSources(repository); return repository.listSources() },
    runSearchBatch: (userId, searchId) => runSearchBatch(repository, userId, searchId),
    createBookFromSearch: (userId, searchId, candidateIndex) => createBookFromSearch(repository, userId, searchId, candidateIndex),
    getOrLoadToc: (userId, bookId, editionKey, refresh) => getOrLoadToc(repository, userId, bookId, editionKey, refresh),
    getOrLoadContent: (userId, bookId, editionKey, chapterId, refresh) => getOrLoadContent(repository, userId, bookId, editionKey, chapterId, refresh),
  }
}

async function runSearchBatch(repository: ReaderRepository, userId: string, searchId: string): Promise<SearchBatchResult> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) throw new ReaderRuntimeError('not-found', '搜索任务不存在')
  if (run.status !== 'running') return { search: run, candidates: run.candidates, sourceStatus: toSearchStatus(run.status), diagnostics: [] }
  const source = await requireSource(repository, run.sourceId)
  const session = createNodeSourceSession(source.normalizedSource)
  try {
    const result = await session.run((ports) => searchBooks(ports, {
      source: source.normalizedSource,
      keyword: run.keyword,
      ...(run.cursor === undefined ? {} : { cursor: run.cursor }),
      maxItems: 100,
    }))
    const additions = (result.value?.items ?? []).map((candidate) => ({ sourceId: source.sourceId, sourceFingerprint: source.fingerprint, candidate }))
    const status = result.status === 'cancelled' ? 'cancelled' : result.status === 'capability-missing' ? 'failed' : result.status
    const updated = await repository.updateSearch(userId, searchId, {
      status,
      candidates: [...run.candidates, ...additions],
      ...(result.value?.cursor === undefined ? {} : { cursor: result.value.cursor }),
      ...(result.value?.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
      cancelled: result.status === 'cancelled',
    })
    if (updated === null) throw new ReaderRuntimeError('not-found', '搜索任务已被删除')
    return { search: updated, candidates: additions, sourceStatus: toSearchStatus(result.status), diagnostics: result.diagnostics }
  } finally {
    session.close()
  }
}

async function createBookFromSearch(repository: ReaderRepository, userId: string, searchId: string, candidateIndex: number): Promise<{ book: StoredBook; edition: StoredEdition }> {
  const run = await repository.getSearch(userId, searchId)
  if (run === null) throw new ReaderRuntimeError('not-found', '搜索任务不存在')
  const stored = run.candidates[candidateIndex]
  if (stored === undefined) throw new ReaderRuntimeError('invalid-input', '搜索结果索引无效')
  const source = await requireSource(repository, stored.sourceId)
  if (source.fingerprint !== stored.sourceFingerprint) throw new ReaderRuntimeError('configuration', '书源定义已更新，请重新搜索')
  const session = createNodeSourceSession(source.normalizedSource)
  try {
    const result = await session.run((ports) => loadBookDetails(ports, { source: source.normalizedSource, candidates: [stored.candidate], maxItems: 1 }))
    const metadata = result.value?.items[0]
    if (metadata === undefined) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '没有读取到书籍详情'))
    const candidate: BookCreationInput['candidate'] = stored
    const editionKey = digest(`${stored.sourceId}\u0000${metadata.bookUrl}\u0000${stored.sourceFingerprint}`)
    return repository.createBook(userId, { candidate, metadata, editionKey, sourceFingerprint: stored.sourceFingerprint })
  } finally {
    session.close()
  }
}

async function getOrLoadToc(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, refresh = false): Promise<StoredToc> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, edition.sourceId)
  if (!refresh) {
    const cached = await repository.getToc(userId, bookId, editionKey)
    if (cached !== null && cached.sourceFingerprint === source.fingerprint) return cached
  }
  const session = createNodeSourceSession(source.normalizedSource)
  try {
    const result = await session.run((ports) => loadTableOfContents(ports, { source: source.normalizedSource, book: edition.metadata, refresh, maxPages: 32 }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '目录读取失败'))
    const chapters = result.value.items
    const revision = digest(JSON.stringify(chapters))
    const bookAfter = result.value.bookAfter
    const bookPatch = createBookPatch(chapters)
    return repository.saveToc(userId, { userId, bookId, editionKey, sourceFingerprint: source.fingerprint, revision, chapters, bookPatch, ...(bookAfter === undefined ? {} : { bookAfter }) })
  } finally {
    session.close()
  }
}

async function getOrLoadContent(repository: ReaderRepository, userId: string, bookId: string, editionKey: string, chapterId: string, refresh = false): Promise<StoredContent> {
  const edition = await repository.getEdition(userId, bookId, editionKey)
  if (edition === null) throw new ReaderRuntimeError('not-found', '书籍版本不存在')
  const source = await requireSource(repository, edition.sourceId)
  const toc = await repository.getToc(userId, bookId, editionKey)
  if (toc === null) throw new ReaderRuntimeError('not-found', '目录尚未加载')
  const chapterIndex = toc.chapters.findIndex((chapter) => chapterIdFor(chapter) === chapterId)
  const chapter = chapterIndex < 0 ? undefined : toc.chapters[chapterIndex]
  if (chapter === undefined) throw new ReaderRuntimeError('not-found', '章节不存在')
  if (!refresh) {
    const cached = await repository.getContent(userId, editionKey, toc.revision, chapterId)
    if (cached !== null && cached.sourceFingerprint === source.fingerprint) return cached
  }
  const nextChapterUrl = toc.chapters[chapterIndex + 1]?.chapterUrl
  const session = createNodeSourceSession(source.normalizedSource)
  try {
    const result = await session.run((ports) => loadChapterContent(ports, {
      source: source.normalizedSource,
      book: edition.metadata,
      chapter,
      ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }),
      maxPages: 32,
      maxOutputBytes: 4 * 1024 * 1024,
    }))
    if (result.value === null) throw new ReaderRuntimeError('source-failed', diagnosticsMessage(result.status, '正文读取失败'))
    return repository.saveContent(userId, { userId, bookId, editionKey, chapterId, tocRevision: toc.revision, sourceFingerprint: source.fingerprint, content: result.value })
  } finally {
    session.close()
  }
}

async function requireSource(repository: ReaderRepository, sourceId: string): Promise<StoredSourceRecord> {
  const source = await repository.getSource(sourceId)
  if (source === null) throw new ReaderRuntimeError('configuration', `书源不可用：${sourceId}`)
  return source
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function chapterIdFor(chapter: Chapter): string { return digest(`${chapter.chapterUrl}\u0000${chapter.index}`) }
function createBookPatch(chapters: Chapter[]): { lastCheckTime: number; totalChapterNum: number; latestChapterTitle?: string } { const latest = chapters.at(-1); return { lastCheckTime: Date.now(), totalChapterNum: chapters.length, ...(latest === undefined ? {} : { latestChapterTitle: latest.title }) } }
function diagnosticsMessage(status: WorkflowStatus, fallback: string): string { return status === 'capability-missing' ? '当前书源需要服务器未启用的运行能力' : fallback }
function toSearchStatus(status: WorkflowStatus): SearchBatchResult['sourceStatus'] { return status === 'success' || status === 'empty' || status === 'partial' || status === 'failed' || status === 'capability-missing' ? status : 'failed' }

export type ReaderRuntimeTypes = [BookMetadata, ChapterContent, NormalizedSource, SearchRunState]
