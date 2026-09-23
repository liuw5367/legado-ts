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
  /** 下一页游标；只在地址模板引用页码或 nextPage 规则命中时出现（没有页码占位符时下一页还是同一地址）。 */
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
  /** 书源搜索或详情规则返回的分类；来源未提供时保持缺失。 */
  kind?: string
  /** 书源搜索或详情规则返回的字数文本；来源未提供时保持缺失。 */
  wordCount?: string
  /** 书源搜索或详情规则返回的最新章节标题；来源未提供时保持缺失。 */
  lastChapter?: string
  /** 书源搜索或详情规则返回的更新时间文本；来源未提供时保持缺失。 */
  updateTime?: string
  /** JavaScript 源搜索函数可直接返回目录地址。 */
  tocUrl?: string
  /** JavaScript 源通过 SearchBook.variable 传递的变量 JSON。 */
  variable?: string
  rawFields: JsonObject
  traceRef: string
}

export interface BookReadConfig {
  /** 刷新和持久化目录时使用的顺序开关。 */
  reverseToc?: boolean
}

export interface BookMetadata extends BookCandidate {
  tocUrl?: string
  /** 详情页同时是目录页时保留的临时响应；不应持久化。 */
  tocHtml?: string
  /** 由上层书籍状态提供的阅读配置；书源流程只读取目录顺序开关。 */
  readConfig?: BookReadConfig
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
  /** 期望的返回形态：列表规则取 `nodes`（元素节点），字段规则保持 `text`。 */
  expect?: 'text' | 'nodes'
  /** 本次求值附加的 JS 绑定，例如 URL 展开需要的 `key`、`page`。 */
  bindings?: Readonly<Record<string, unknown>>
}

export interface WorkflowRuleOutput {
  status: 'success' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'
  value: unknown
  message?: string
}

export type WorkflowJavaScriptStage = 'mainJs' | 'book' | 'chapter' | 'search' | 'content'

export type SourceFunctionName = 'search' | 'explore' | 'getBookInfo' | 'getChapters' | 'getContent'

export interface WorkflowJavaScriptRequest {
  source: NormalizedSource
  code: string
  stage: WorkflowJavaScriptStage
  content?: unknown
  bindings?: Readonly<Record<string, unknown>>
  /** Return mutated bindings together with the script result when a hook mutates Java-side DTOs. */
  captureMutations?: readonly string[]
  signal?: AbortSignal
}

export interface SourceFunctionRequest {
  source: NormalizedSource
  name: SourceFunctionName
  args: readonly unknown[]
  /** 标准函数参数名，用来同时暴露与 Android 相同的全局绑定。 */
  bindings?: Readonly<Record<string, unknown>>
  stage: WorkflowJavaScriptStage
  signal?: AbortSignal
}

export interface SourceFunctionOutput extends WorkflowRuleOutput {
  exists: boolean
}

export interface WorkflowRulePort {
  evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput>
  /** JavaScript 源函数执行能力；未实现的宿主应把 mainJs 报告为 capability-missing。 */
  executeSourceFunction?(request: SourceFunctionRequest): Promise<SourceFunctionOutput>
  /** 精确脚本钩子，如 loginCheckJs、preUpdateJs 和 formatJs。 */
  executeWorkflowJavaScript?(request: WorkflowJavaScriptRequest): Promise<WorkflowRuleOutput>
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
  /** 书源声明的执行提示；正文请求会携带 `webJs`/`sourceRegex`。 */
  execution?: { webJs?: string; sourceRegex?: string }
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
  /** Android 允许刷新时控制 getBookInfo 是否可覆盖名称和作者。 */
  canReName?: boolean
}

export interface ChapterIdentity {
  sourceId: string
  bookUrl: string
  chapterUrl: string
  index: number
  volume?: string
  /** 是否为卷节点；卷节点不应请求正文。 */
  isVolume?: boolean
  /** 是否为 VIP 章节。 */
  isVip?: boolean
  /** 是否已购买。 */
  isPay?: boolean
  /** 书源提供的章节更新时间或附加标签。 */
  updateTime?: string
}

export interface Chapter extends ChapterIdentity {
  title: string
  rawFields: JsonObject
  traceRef: string
}

export interface TocInput extends WorkflowOptions {
  source: NormalizedSource
  book: BookMetadata
  /** 显式刷新时跳过目录响应缓存，并在成功请求后更新缓存。 */
  refresh?: boolean
  cursor?: PageCursor
  maxPages?: number
  maxBytes?: number
  /** 对齐 Android getChapterList(runPerJs)：默认不执行 preUpdateJs。 */
  runPerJs?: boolean
  isFromBookInfo?: boolean
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
  /** 书源 `ruleContent.title` 从正文提取的章节标题；未配置或提取为空时缺失。 */
  title?: string
}

export interface ContentInput extends WorkflowOptions {
  source: NormalizedSource
  chapter: ChapterIdentity & { title?: string; rawFields?: JsonObject }
  /** JS 源 getContent 需要完整 Book；旧调用方缺省时运行时提供最小书对象。 */
  book?: BookMetadata
  /** 章节链接指向详情页时，可复用详情请求的响应正文。 */
  tocHtml?: string
  /** 下一章地址；命中正文下一页规则时停止抓取，避免把下一章并入本章。 */
  nextChapterUrl?: string
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
