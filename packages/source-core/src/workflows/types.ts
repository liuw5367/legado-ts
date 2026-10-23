import type { JsonObject, NormalizedSource } from '../model/types.ts'
import type { ConcurrencyHost, NetworkHost, NetworkResponse, RequestBudget, RequestPlan } from '../runtime/contracts.ts'
import type { JavaScriptBudget } from '../runtime/javascript.ts'

export type WorkflowStatus = 'success' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'
export type WorkflowStage = 'discover' | 'search' | 'detail'
/** Android Long projection; safe values use number and larger values retain decimal text or bigint. */
export type Int64 = number | bigint | string

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

/** Android ExploreKind 的跨宿主表示；UI 只能根据 type 决定交互方式。 */
export interface ExploreKind {
  title: string
  url?: string
  type?: 'url' | 'text' | 'button' | 'toggle' | 'select' | string
  action?: string
  chars?: Array<string | null>
  default?: string
  viewName?: string
  style?: JsonObject
}

/** Android InfoMap.save/saveNow request captured at the point the script called it. */
export interface InfoMapSaveRequest {
  infoMap: Record<string, string>
  /** TTL in seconds; zero means no expiry. */
  time: number
  need: boolean
  now: boolean
}

export interface ExploreKindsResult {
  kinds: ExploreKind[]
  infoMap: Record<string, string>
  saveRequested: boolean
  saveRequest?: InfoMapSaveRequest | undefined
  diagnostics: WorkflowDiagnostic[]
}

export interface ExploreActionResult {
  infoMap: Record<string, string>
  saveRequested: boolean
  saveRequest?: InfoMapSaveRequest | undefined
  refreshRequested: boolean
  diagnostics: WorkflowDiagnostic[]
}

export interface ExploreViewNameResult {
  value: string
  infoMap: Record<string, string>
  saveRequest?: InfoMapSaveRequest | undefined
  diagnostics: WorkflowDiagnostic[]
}

/** 目录成功后脚本实际使用的书籍状态；仅由目录流程返回，应用可按书源版本持久化。 */
export interface TocPage extends WorkflowPage<Chapter> {
  bookAfter?: BookMetadata
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
  /** Android JS source marshaller 的 BookType 位标记。 */
  type?: number
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
  /** JavaScript 详情返回的可下载地址；仅保留绝对、非 javascript 地址。 */
  downloadUrls?: string[]
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
  code: 'invalid-config' | 'invalid-input' | 'request-failed' | 'rule-failed' | 'cache-failed' | 'capability-missing' | 'identity-missing' | 'item-skipped' | 'duplicate-item' | 'cancelled' | 'empty-page'
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

/** 网络观察只报告真实发出的请求，不改变书源工作流的结果或错误语义。 */
export interface RequestObservationStart {
  id: string
  source: NormalizedSource
  stage: WorkflowStage
  attempt: number
  /** 由 JavaScript bridge 发起的子请求，用于调试面板区分来源。 */
  kind?: 'primary' | 'bridge'
  plan: RequestPlan
  startedAt: number
}

export interface RequestObservationComplete extends RequestObservationStart {
  response: NetworkResponse
  durationMs: number
}

export interface RequestObservationError extends RequestObservationStart {
  error: unknown
  durationMs: number
}

export interface RequestObserver {
  onStart?(event: RequestObservationStart): void
  onComplete?(event: RequestObservationComplete): void
  onError?(event: RequestObservationError): void
}

export type RuntimeObservationPhase = 'planned' | 'not-started' | 'requested' | 'response-received' | 'parsed-empty' | 'success' | 'failed' | 'capability-missing' | 'cancelled' | 'skipped'

/** 一次书源请求或候选跳过的可脱敏运行期证据；不包含请求头、正文和脚本源码。 */
export interface RuntimeObservation {
  id: string
  requestId?: string
  sourceId: string
  stage: WorkflowStage
  phase: RuntimeObservationPhase
  target: string
  attempt?: number
  startedAt: number
  durationMs?: number
  statusCode?: number
  responseBytes?: number
  errorCode?: string
  retryable?: boolean
  itemIndex?: number
}

export interface RuntimeObservationHandle {
  readonly id: string
}

/** Workflow 内部使用的观察收集端口；宿主可通过 RuntimeResult.observations 读取快照。 */
export interface RuntimeObservationCollector {
  begin(input: { sourceId: string; stage: WorkflowStage; target: string; itemIndex?: number }): RuntimeObservationHandle
  markRequested(handle: RuntimeObservationHandle, input: { requestId?: string; attempt?: number; startedAt?: number }): void
  markResponse(handle: RuntimeObservationHandle, response: NetworkResponse, durationMs?: number): void
  markError(handle: RuntimeObservationHandle, input: { code: string; retryable: boolean; durationMs?: number }): void
  markCancelled(handle: RuntimeObservationHandle, durationMs?: number): void
  recordNotStarted(input: { sourceId: string; stage: WorkflowStage; target: string; itemIndex?: number; errorCode?: string }): void
  recordSkipped(input: { sourceId: string; stage: WorkflowStage; target: string; itemIndex?: number }): void
  finalize(status: WorkflowStatus, itemCount: number): void
  observerFor(handle: RuntimeObservationHandle, upstream?: RequestObserver): RequestObserver
  /** 为脚本/bridge 请求按真实网络事件创建独立观测条目。 */
  observerForRequest(input: { sourceId: string; stage: WorkflowStage; target?: string }, upstream?: RequestObserver): RequestObserver
  snapshot(): readonly RuntimeObservation[]
}

export interface RuntimeResult<T> {
  status: WorkflowStatus
  value: T | null
  diagnostics: WorkflowDiagnostic[]
  trace: WorkflowTraceEntry[]
  /** 发现/搜索等工作流的脱敏请求和跳过轨迹；未启用观察时省略。 */
  observations?: readonly RuntimeObservation[]
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
  /** JavaScript 规则片段需要回写的 DTO 绑定；目录字段使用 chapter 保持渐进可见性。 */
  captureBindings?: readonly string[]
  /** 当前规则脚本发起的 bridge 请求观测器；由工作流或请求宿主按调用链传递。 */
  requestObserver?: RequestObserver
  /** 当前请求脚本链共享的 HTTP 预算；仅由请求运行时透传给 bridge 子请求。 */
  requestBudget?: Partial<RequestBudget>
}

export interface WorkflowRuleOutput {
  status: 'success' | 'empty' | 'failed' | 'cancelled' | 'capability-missing'
  value: unknown
  message?: string
}

export type WorkflowJavaScriptStage = 'mainJs' | 'book' | 'chapter' | 'search' | 'content'

export type SourceFunctionName = 'search' | 'explore' | 'getBookInfo' | 'getChapters' | 'getContent' | 'getContentBatch' | 'getReviewSummary' | 'getReviewDetail' | 'getReviewReplies'

export type WorkflowAction = (signal: AbortSignal, input: unknown) => Promise<unknown>

export interface WorkflowJavaScriptRequest {
  source: NormalizedSource
  code: string
  stage: WorkflowJavaScriptStage
  /** Core workflow stage used for request observations and bridge policy; absent for direct host calls. */
  workflowStage?: WorkflowStage
  content?: unknown
  /** 当前脚本访问请求上下文时使用的基准 URL；缺省为书源 URL。 */
  baseUrl?: string
  /** 当前脚本访问请求上下文时使用的最终响应 URL；缺省为 baseUrl。 */
  redirectUrl?: string
  bindings?: Readonly<Record<string, unknown>>
  /** Bindings whose nested plain objects must remain mutable inside the guest realm. */
  mutableBindings?: readonly string[]
  /** Return mutated bindings together with the script result when a hook mutates Java-side DTOs. */
  captureMutations?: readonly string[]
  /** Carry explicitly serializable guest globals between related script executions. */
  captureGlobals?: boolean
  globalState?: Readonly<Record<string, unknown>>
  /** Actions exposed to synchronous source helpers through the asyncified JavaScript bridge. */
  workflowActions?: Readonly<Record<string, WorkflowAction>>
  /** JavaScript execution limits for this hook; separate from HTTP request budgets. */
  javascriptBudget?: Partial<JavaScriptBudget>
  /** 当前脚本发起的 bridge 请求观测器；每个真实请求生成独立 RuntimeObservation。 */
  requestObserver?: RequestObserver
  /** 当前请求脚本链共享的 HTTP 预算；子请求不得重新开始独立的 deadline。 */
  requestBudget?: Partial<RequestBudget>
  signal?: AbortSignal
}

/** Image-only script bridge: it can present Android's cover InputStream shape without burdening generic JS hooks. */
export interface WorkflowImageDecodeRequest {
  source: NormalizedSource
  code: string
  bytes: Uint8Array
  src: string
  book: Readonly<Record<string, unknown>> | null
  resultInputKind: 'bytes' | 'input-stream'
  javascriptBudget?: Partial<JavaScriptBudget>
  signal?: AbortSignal
}

export interface SourceFunctionRequest {
  source: NormalizedSource
  name: SourceFunctionName
  args: readonly unknown[]
  /** 标准函数参数名，用来同时暴露与 Android 相同的全局绑定。 */
  bindings?: Readonly<Record<string, unknown>>
  /** Actions exposed only during this source-function call, such as batch cacheContent. */
  workflowActions?: Readonly<Record<string, WorkflowAction>>
  stage: WorkflowJavaScriptStage
  /** Core workflow stage used for request observations and bridge policy. */
  workflowStage?: WorkflowStage
  /** 当前源函数发起的 bridge 请求观测器。 */
  requestObserver?: RequestObserver
  /** 当前请求脚本链共享的 HTTP 预算；子请求不得重新开始独立的 deadline。 */
  requestBudget?: Partial<RequestBudget>
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
  /** Execute the image decoder with its binary/stream-specific `result` binding. */
  executeImageDecodeScript?(request: WorkflowImageDecodeRequest): Promise<WorkflowRuleOutput>
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
  /** Optional request evidence hook; observer failures are isolated from the workflow. */
  requestObserver?: RequestObserver
  /** Workflow-owned observation collector; hosts normally leave this unset. */
  runtimeObservationCollector?: RuntimeObservationCollector
}

export interface WorkflowOptions {
  signal?: AbortSignal
  budget?: Partial<RequestBudget>
  maxItems?: number
  /** Android 发现脚本和 URL 规则可读写的书源级控件状态。 */
  infoMap?: Readonly<Record<string, string>>
  /** 目录后续页跳过 loginCheckJs；由流程入口标记首次实际网络请求。 */
  skipLoginCheck?: boolean
}

export interface WorkflowRequest {
  /** 原始书源请求地址；宿主可继续解析 URL 后的 JSON options 或 JS。 */
  source: NormalizedSource
  url: string
  stage: WorkflowStage
  options: WorkflowOptions
  /** 书源声明的执行提示；正文请求会携带 `webJs`/`sourceRegex`。 */
  execution?: { webJs?: string; sourceRegex?: string }
  /** URL/options 脚本可见的当前书籍；缺省时不向请求脚本注入书籍状态。 */
  book?: BookCandidate
  /** 仅供 `java.get/put` 使用的内部章节作用域；不会映射为 URL 脚本的全局 `chapter`。 */
  chapter?: ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }
}

/** SourceRuleRuntime 用于请求脚本内部变量作用域的保留绑定名；不会创建 guest 全局变量。 */
export const internalChapterScopeBinding = '__legadoInternalChapterScope'

export interface DiscoveryInput extends WorkflowOptions {
  source: NormalizedSource
  /** Android WebBook.exploreBookAwait 的已选分类 URL；缺省时使用 source.exploreUrl。 */
  url?: string
  cursor?: PageCursor
}

export interface SearchInput extends WorkflowOptions {
  source: NormalizedSource
  keyword: string
  cursor?: PageCursor
  /** 搜索阶段的早期过滤；只读取已解析的书名、作者和分类，后续字段规则不会执行。 */
  acceptSearchFields?: (fields: SearchCandidateFields) => boolean
  /** 只接收满足调用方纯判断的候选；网络、存储和副作用不得放入回调。 */
  acceptCandidate?: (candidate: BookCandidate) => boolean
  /** 接收候选后提前结束当前列表页；返回结果不再声明下一页游标。 */
  shouldStop?: (candidate: BookCandidate, acceptedCount: number) => boolean
}

export interface SearchCandidateFields {
  name: string
  author?: string
  kind?: string
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
  /** 书源规则返回的原始章节地址；旧持久数据缺失时回退到 chapterUrl。 */
  url?: string
  /** 解析该章节规则时的页面基准地址；旧持久数据缺失时由调用方回退。 */
  baseUrl?: string
  /** 由 url + baseUrl 派生的可请求绝对地址。 */
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
  /** Android BookChapter.resourceUrl；音频章节的真实媒体地址。 */
  resourceUrl?: string
  /** Android BookChapter.start/end；本地或 EPUB 章节的范围位置。 */
  start?: Int64
  end?: Int64
  /** Android BookChapter 的 EPUB 起止 fragment id。 */
  startFragmentId?: string
  endFragmentId?: string
  /** Android BookChapter.imgUrl；正文标题规则或目录元数据可更新。 */
  imgUrl?: string
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

export interface ReviewSummaryItem {
  paragraphIndex: number
  count: number
  paragraphData: string
}

export interface ReviewDetailItem {
  id?: string
  avatar?: string
  name?: string
  replyToName?: string
  badges: string[]
  content?: string
  imageUrl?: string
  audioUrl?: string
  time?: string
  likeCount?: number
  replyCount?: number
  replies: ReviewDetailItem[]
}

export interface ReviewDetailPage extends WorkflowPage<ReviewDetailItem> {
  hasMore: boolean
}

export interface ReviewSummaryInput extends WorkflowOptions {
  source: NormalizedSource
  book: BookMetadata
  chapter: ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }
}

export interface ReviewDetailInput extends WorkflowOptions {
  source: NormalizedSource
  book: BookMetadata
  chapter: ChapterIdentity & { title?: string; variable?: string; rawFields?: JsonObject }
  paragraphIndex: number
  paragraphData?: string
  cursor?: PageCursor
}

export interface ReviewRepliesInput extends ReviewDetailInput {
  reviewId: string
}

export interface ChapterContent {
  chapter: ChapterIdentity & { variable?: string }
  contentType: 'text' | 'html'
  raw: string
  cleaned: string
  pages: string[]
  resources: ContentResource[]
  /** 生成该正文时最终收到的响应地址；缓存命中必须原样保留。 */
  finalUrl?: string
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
  /** Optional Android payAction hook for VIP chapters; callers decide whether to persist the purchase result. */
  payAction?: string
}

export interface ChapterContentBatchItem {
  chapter: Chapter
  /** Final text accepted by the host, or returned to the caller when no cache adapter is supplied. */
  content?: string
  /** True only when the host cache callback accepted the write. */
  saved: boolean
  via: 'batch' | 'single' | 'none'
}

export interface ChapterContentBatchResult {
  /** Results retain the caller's chapter order, including chapters not saved after cancellation. */
  items: ChapterContentBatchItem[]
  /** Number of source batch script invocations; singleton fallback does not count. */
  batchCount: number
}

export type ChapterContentCache = (chapter: Chapter, content: string, signal?: AbortSignal) => boolean | Promise<boolean>

/** The source-core batches and parses; hosts decide how to persist accepted chapter text. */
export interface ContentBatchInput extends Omit<ContentInput, 'book' | 'chapter' | 'tocHtml'> {
  book: BookMetadata
  chapters: readonly Chapter[]
  /** Optional persistence adapter. Without it, batch scripts are skipped and single parsing results are returned. */
  cacheContent?: ChapterContentCache
}

/** 最终正文缓存记录；不包含原始 HTTP 响应、Cookie 或宿主路径。 */
export interface ContentCacheRecord {
  /** 已按正文流程清洗、替换后的正文。 */
  content: string
  /** 生成正文时收到的最终响应 URL。 */
  finalUrl: string
  /** 与正文一起产生的章节字段。 */
  chapter: Chapter
  /** 缓存命中时恢复正文的结构化形态；旧记录可以只提供 content。 */
  contentType?: 'text' | 'html'
  raw?: string
  pages?: string[]
  resources?: ContentResource[]
  title?: string
  imgUrl?: string
  /** 音频歌词或视频弹幕。 */
  auxiliary?: { kind: 'lyrics' | 'danmaku'; content: string }
}

export interface ContentIdentity {
  /** 同一应用会话和书籍实例的稳定身份。 */
  sessionId: string
  sourceId: string
  bookUrl: string
  /** 由书源版本、目录 revision、章节地址和索引派生的章节身份。 */
  chapterKey: string
  tocRevision: string
  chapterIndex: number
  /** 正文、图片、音频、视频和文件必须使用不同身份。 */
  resourceKind: 'text' | 'image' | 'audio' | 'video' | 'file'
  /** 书源定义指纹或其他源版本身份。 */
  sourceRevision: string
  /** source-core 正文语义版本；语义变化时不得命中旧缓存。 */
  semanticVersion: string
}

export interface ContentSaveToken {
  /** 一次正文写入操作的身份。 */
  operationId: string
  /** 宿主为目标资源保留的写入代次。 */
  writeVersion: string
  identity: ContentIdentity
  /** 超过该时间后宿主必须拒绝写入。 */
  expiresAt?: number
}

export interface ContentWriteInput {
  token: ContentSaveToken
  record: ContentCacheRecord
  /** 是否提交章节标题、图片和变量等伴随字段。 */
  saveChapterMetadata: boolean
}

export interface StoreWriteResult {
  /** 已确认提交、拒绝、版本过期、取消或无法确认底层结果。 */
  status: 'committed' | 'rejected' | 'stale' | 'cancelled' | 'unknown'
  /** 兼容旧调用方；判断结果必须使用 status。 */
  committed: boolean
  operationId: string
  resourceKey: string
  reason?: string
}

/** 宿主提供最终正文的读取、条件保留和提交能力；核心不持有文件或数据库。 */
export interface ContentStore {
  read(identity: ContentIdentity, signal?: AbortSignal): Promise<ContentCacheRecord | undefined>
  reserve(identity: ContentIdentity, operationId: string, signal?: AbortSignal): Promise<ContentSaveToken>
  write(input: ContentWriteInput, signal?: AbortSignal): Promise<StoreWriteResult>
}

/** 需要最终正文缓存时使用的核心编排入口输入。 */
export interface StoredContentInput extends ContentInput {
  contentStore: ContentStore
  contentIdentity: ContentIdentity
  operationId?: string
  refresh?: boolean
  saveChapterMetadata?: boolean
}

/** 输入已由图片宿主取得；source-core 只执行书源解密脚本，不发起图片下载。 */
export interface ImageDecodeInput {
  source: NormalizedSource
  src: string
  bytes: Uint8Array
  isCover: boolean
  book?: BookMetadata
  /** Android's cover fetch path passes an InputStream; callers using its byte-array overload may select `bytes`. */
  resultInputKind?: 'bytes' | 'input-stream'
  /** Optional override for the JavaScript host's input, output, memory and time limits. */
  javascriptBudget?: Partial<JavaScriptBudget>
  signal?: AbortSignal
}

export interface ContentReplacement {
  pattern: string
  replacement: string
  all?: boolean
}

/** 阅读工作流只依赖通用网络、规则和并发端口；原始页面缓存不属于核心端口。 */
export type ReadingPorts = WorkflowPorts
