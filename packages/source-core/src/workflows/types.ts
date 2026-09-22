import type { JsonObject, NormalizedSource } from '../model/types.ts'
import type { NetworkHost, NetworkResponse, RequestBudget } from '../runtime/contracts.ts'

export type WorkflowStatus = 'success' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'
export type WorkflowStage = 'discover' | 'search' | 'detail'

export interface PageCursor {
  /** 书源内页码；不把页码解释为全局 offset。 */
  index: number
  /** 可选的书源 token，由下一页规则返回。 */
  token?: string
}

export interface WorkflowPage<T> {
  items: T[]
  cursor: PageCursor
  nextCursor?: PageCursor
}

export interface BookIdentity {
  /** 书源身份，跨书源聚合不得复用此值。 */
  sourceId: string
  /** 书源定义的详情 URL；同名书不同 URL 必须保持不同身份。 */
  bookUrl: string
}

export interface BookCandidate extends BookIdentity {
  name?: string
  author?: string
  intro?: string
  coverUrl?: string
  /** 书源搜索或详情规则返回的最新章节标题；来源未提供时保持缺失。 */
  lastChapter?: string
  /** 书源搜索或详情规则返回的更新时间文本；来源未提供时保持缺失。 */
  updateTime?: string
  rawFields: JsonObject
  traceRef: string
}

export interface BookMetadata extends BookCandidate {
  tocUrl?: string
  /** 详情页同时是目录页时保留的临时响应；不应持久化。 */
  tocHtml?: string
  /** 详情规则明确返回空字符串的字段。 */
  emptyFields: string[]
  /** 详情规则执行失败的字段及脱敏原因。 */
  fieldErrors: Readonly<Record<string, string>>
}

export interface WorkflowDiagnostic {
  code: 'invalid-config' | 'invalid-input' | 'request-failed' | 'rule-failed' | 'capability-missing' | 'identity-missing' | 'item-skipped' | 'duplicate-item' | 'cancelled' | 'empty-page'
  stage: WorkflowStage
  message: string
  field?: string
  itemIndex?: number
  retryable: boolean
}

export interface WorkflowTraceEntry {
  stage: WorkflowStage
  event: 'request' | 'rule' | 'candidate' | 'field'
  target: string
  itemIndex?: number
}

export interface RuntimeResult<T> {
  status: WorkflowStatus
  value: T | null
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
}

export interface WorkflowRuleRequest {
  source: NormalizedSource
  stage: WorkflowStage
  field: string
  rule: string
  content: unknown
  /** 当前阶段请求的基准地址，空 URL 按此地址回退。 */
  baseUrl?: string
  /** 当前响应经过重定向后的最终地址。 */
  redirectUrl?: string
  itemIndex?: number
  signal?: AbortSignal
}

export interface WorkflowRuleOutput {
  status: 'success' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'
  value: unknown
  message?: string
}

export interface WorkflowRulePort {
  evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput>
}

export interface WorkflowPorts {
  network: NetworkHost
  rules: WorkflowRulePort
  /** 可选的书源请求适配器；缺省时使用核心的普通 HTTP 请求计划。 */
  request?: (input: WorkflowRequest) => Promise<NetworkResponse>
  decodeResponse?: (response: NetworkResponse, source: NormalizedSource) => string
}

export interface WorkflowOptions {
  signal?: AbortSignal
  budget?: Partial<RequestBudget>
  maxItems?: number
}

export interface WorkflowRequest {
  /** 原始书源请求地址；宿主可继续解析 URL 后的 JSON options 或 JS。 */
  source: NormalizedSource
  url: string
  stage: WorkflowStage
  options: WorkflowOptions
}

export interface DiscoveryInput extends WorkflowOptions {
  source: NormalizedSource
  cursor?: PageCursor
}

export interface SearchInput extends WorkflowOptions {
  source: NormalizedSource
  keyword: string
  cursor?: PageCursor
}

export interface DetailInput extends WorkflowOptions {
  source: NormalizedSource
  candidates: readonly BookCandidate[]
  cursor?: PageCursor
}

export interface ChapterIdentity {
  sourceId: string
  bookUrl: string
  chapterUrl: string
  index: number
  volume?: string
}

export interface Chapter extends ChapterIdentity {
  title: string
  rawFields: JsonObject
  traceRef: string
}

export interface TocInput extends WorkflowOptions {
  source: NormalizedSource
  book: BookMetadata
  cursor?: PageCursor
  maxPages?: number
  maxBytes?: number
}

export interface ContentResource {
  kind: 'image'
  url: string
}

export interface ChapterContent {
  chapter: ChapterIdentity
  contentType: 'text' | 'html'
  raw: string
  cleaned: string
  pages: string[]
  resources: ContentResource[]
}

export interface ContentInput extends WorkflowOptions {
  source: NormalizedSource
  chapter: ChapterIdentity
  contentType?: 'text' | 'html'
  replacements?: readonly ContentReplacement[]
  maxPages?: number
  maxBytes?: number
  maxOutputBytes?: number
}

export interface ContentReplacement {
  pattern: string
  replacement: string
  all?: boolean
}

export interface ContentCache {
  get(key: string, signal?: AbortSignal): Promise<string | undefined>
  set(key: string, value: string, signal?: AbortSignal): Promise<void>
}

export interface ReadingPorts extends WorkflowPorts {
  cache?: ContentCache
}
