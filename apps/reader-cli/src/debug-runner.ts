import type { BookCandidate, BookMetadata, Chapter, ChapterContent, RuntimeResult, WorkflowPage } from '@legado/source-core'
import type { SourceEntry } from './source-catalog.ts'
import type { ReaderSourceSession } from './application-model.ts'
import { DebugCapture, type DebugStage } from './debug-capture.ts'

export interface DebugRunnerState {
  stage: DebugStage
  keyword: string
  candidates: BookCandidate[]
  metadata: BookMetadata | undefined
  chapters: Chapter[]
  content: ChapterContent | undefined
}

export class DebugRunner {
  public readonly source: SourceEntry
  public readonly capture: DebugCapture
  private readonly session: ReaderSourceSession
  private stateValue: DebugRunnerState

  public constructor(source: SourceEntry, session: ReaderSourceSession, mode: 'light' | 'full' = 'full') {
    this.source = source
    this.session = session
    this.capture = new DebugCapture({ sourceId: source.source.bookSourceUrl, sourceName: source.source.bookSourceName, mode })
    this.stateValue = { stage: 'search', keyword: defaultKeyword(source.source), candidates: [], metadata: undefined, chapters: [], content: undefined }
  }

  public get state(): DebugRunnerState {
    return { ...this.stateValue, candidates: [...this.stateValue.candidates], chapters: [...this.stateValue.chapters] }
  }

  public setKeyword(keyword: string): void {
    this.stateValue = { ...this.stateValue, keyword: keyword.trim() || defaultKeyword(this.source.source) }
  }

  public async search(keyword: string, signal?: AbortSignal): Promise<RuntimeResult<WorkflowPage<BookCandidate>>> {
    this.stateValue = { ...this.stateValue, stage: 'search', keyword: keyword.trim() || defaultKeyword(this.source.source), candidates: [], metadata: undefined, chapters: [], content: undefined }
    const result = await this.session.search(this.stateValue.keyword, signal, this.capture)
    this.stateValue = { ...this.stateValue, candidates: result.value?.items ?? [] }
    return result
  }

  public async detail(index: number, signal?: AbortSignal): Promise<RuntimeResult<WorkflowPage<BookMetadata>>> {
    const candidate = this.stateValue.candidates[index]
    if (candidate === undefined) return failedResult('请选择搜索结果')
    this.stateValue = { ...this.stateValue, stage: 'book-info', metadata: undefined, chapters: [], content: undefined }
    const result = await this.session.detail(candidate, signal, this.capture)
    this.stateValue = { ...this.stateValue, metadata: result.value?.items[0] }
    return result
  }

  public async toc(signal?: AbortSignal): Promise<RuntimeResult<WorkflowPage<Chapter>>> {
    const metadata = this.stateValue.metadata
    if (metadata === undefined) return failedResult('请先加载书籍信息')
    this.stateValue = { ...this.stateValue, stage: 'toc', chapters: [], content: undefined }
    const result = await this.session.toc(metadata, signal, { refresh: true }, this.capture)
    this.stateValue = { ...this.stateValue, chapters: result.value?.items ?? [] }
    return result
  }

  public async content(index: number, signal?: AbortSignal): Promise<RuntimeResult<ChapterContent>> {
    const chapter = this.stateValue.chapters[index]
    const metadata = this.stateValue.metadata
    if (chapter === undefined || metadata === undefined) return failedResult('请选择目录章节')
    this.stateValue = { ...this.stateValue, stage: 'content', content: undefined }
    const result = await this.session.content(chapter, metadata, signal, { refresh: true }, this.capture)
    this.stateValue = { ...this.stateValue, content: result.value ?? undefined }
    return result
  }
}

export function defaultKeyword(source: Record<string, unknown>): string {
  const value = source.checkKeyWord
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '我的'
}

function failedResult<T>(message: string): RuntimeResult<T> {
  return { status: 'failed', value: null, diagnostics: [{ code: 'invalid-input', stage: 'search', message, retryable: false }], trace: [] }
}
