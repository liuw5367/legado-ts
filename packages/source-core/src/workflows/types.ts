import type { JsonObject, NormalizedSource } from '../model/types.ts'
import type { ConcurrencyHost, NetworkHost, NetworkResponse, RequestBudget } from '../runtime/contracts.ts'
import type { JavaScriptBudget } from '../runtime/javascript.ts'

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
  /** SearchBook.infoHtml 的运行期对应物；详情完成后必须丢弃，不属于持久化字段。 */
  infoPage?: { body: string; requestUrl: string; responseUrl: string }
  rawFields: JsonObject
  traceRef: string
}

export interface BookReadConfig {
  /** 刷新和持久化目录时使用的顺序开关。 */
  reverseToc?: boolean
}

export interface BookMetadata extends Omit<BookCandidate, 'infoPage'> {
  /** Android BookType 位标记；与 NormalizedSource.bookSourceType 枚举不同。 */
  type?: number
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
  /** 当前脚本访问请求上下文时使用的基准 URL；缺省为书源 URL。 */
  baseUrl?: string
  /** 当前脚本访问请求上下文时使用的最终响应 URL；缺省为 baseUrl。 */
  redirectUrl?: string
  bindings?: Readonly<Record<string, unknown>>
  /** Return mutated bindings together with the script result when a hook mutates Java-side DTOs. */
  captureMutations?: readonly string[]
  /** Carry explicitly serializable guest globals between related script executions. */
  captureGlobals?: boolean
  globalState?: Readonly<Record<string, unknown>>
  /** Actions exposed to synchronous source helpers through the asyncified JavaScript bridge. */
  workflowActions?: Readonly<Record<string, (signal: AbortSignal, input: unknown) => Promise<unknown>>>
  /** JavaScript execution limits for this hook; separate from HTTP request budgets. */
  javascriptBudget?: Partial<JavaScriptBudget>
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
  /** 会话层读取本次操作产生的持久变量，用于提交 source 作用域。 */
  snapshotVariables?(scope: 'source'): Readonly<Record<string, string>>
  /** JavaScript 源函数执行能力；未实现的宿主应把 mainJs 报告为 capability-missing。 */
  executeSourceFunction?(request: SourceFunctionRequest): Promise<SourceFunctionOutput>
  /** 精确脚本钩子，如 loginCheckJs、preUpdateJs 和 formatJs。 */
  executeWorkflowJavaScript?(request: WorkflowJavaScriptRequest): Promise<WorkflowRuleOutput>
}

export interface WorkflowPorts {
  network: NetworkHost
  rules: WorkflowRulePort
  /**
   * 可选的完整书源请求适配器，覆盖 URL/options、JS、Cookie、编码、重试、预算和响应语义。
   * 它不只是原始 HTTP transport；使用者负责遵守书源限流。缺省时核心经 network 执行这些语义。
   */
  request?: (input: WorkflowRequest) => Promise<NetworkResponse>
  decodeResponse?: (response: NetworkResponse, source: NormalizedSource) => string
  /** 应用提供的调度容量；独立于 source.concurrentRate 的时间窗口限制。 */
  concurrency?: ConcurrencyHost
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
  /** Android BookChapter.tag 对 updateTime 的目录投影。 */
  tag?: string
  /** 当 tocCountWords 开启且 updateTime 可识别时提取的字数。 */
  wordCount?: string
}

export interface Chapter extends ChapterIdentity {
  title: string
  /** JSON 字符串形式的书源章节变量，与 Android BookChapter.variable 对齐。 */
  variable?: string
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
  /** Android AppConfig.tocCountWords；缺省按目录更新时间中的字数提取。 */
  tocCountWords?: boolean
}

export interface ContentResource {
  kind: 'image'
  url: string
}

export interface ChapterContent {
  chapter: ChapterIdentity & { variable?: string }
  contentType: 'text' | 'html'
  raw: string
  cleaned: string
  pages: string[]
  resources: ContentResource[]
  /** 音频歌词或视频弹幕；与 chapter.variable 的 lyric/danmaku 值同步，chapter.variable 是章节持久化字段。 */
  auxiliary?: { kind: 'lyrics' | 'danmaku'; content: string }
  /** 书源 `ruleContent.title` 从正文提取的章节标题；未配置或提取为空时缺失。 */
  title?: string
  /** Android BookChapter.imgUrl；由 `ruleContent.title` 中的 data/http URL 提取。 */
  imgUrl?: string
}

export interface ContentInput extends WorkflowOptions {
  source: NormalizedSource
  chapter: ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }
  /** JS 源 getContent 需要完整 Book；旧调用方缺省时运行时提供最小书对象。 */
  book?: BookMetadata
  /** 章节链接指向详情页时，可复用详情请求的响应正文。 */
  tocHtml?: string
  /** 下一章地址；命中正文下一页规则时停止抓取，避免把下一章并入本章。 */
  nextChapterUrl?: string
  contentType?: 'text' | 'html'
  /** Android AppConfig.adaptSpecialStyle；缺省启用，关闭时不保护 `<usehtml>` 区块。 */
  adaptSpecialStyle?: boolean
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
