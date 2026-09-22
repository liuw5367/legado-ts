/** JSON 边界允许的值；导入层不把任意 JavaScript 值伪装成 JSON。 */
export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export type InputKind = 'json' | 'json-array' | 'uri' | 'file' | 'javascript'

export type ImportOriginKind =
  | 'file'
  | 'text'
  | 'url'
  | 'subscription'
  | 'editor'
  | 'api'
  | 'json'
  | 'remote-url'
  | 'uri'
  | 'javascript'

export interface ImportOrigin {
  /** 输入的业务来源，用于诊断和审计，不用于网络请求。 */
  kind: ImportOriginKind
  /** 已脱敏的来源位置；调用方不得放入 Cookie 或私有查询参数。 */
  location?: string
}

export interface SourceRecord extends JsonObject {
  /** 书源唯一身份，按原字符串比较，不做 URL 规范化。 */
  bookSourceUrl: string
  /** JSON 导入允许缺省，规范化后使用空字符串。 */
  bookSourceName: string
}

export type NormalizedSource = SourceRecord

export interface RawSource {
  /** 用户输入的完整文本；未修改导出时优先使用它。 */
  rawText: string
  /** 输入文本在导入流程中的分类。 */
  kind: InputKind
  /** 脱敏来源位置。 */
  origin: ImportOrigin
  /** 解析后但尚未规范化的对象；解析失败时为 null。 */
  parsed: JsonValue | null
  /** 不属于已知书源字段的值，按原结构保留。 */
  unknownFields: JsonObject
  /** 规则字段在原始输入中的形态，区分对象、字符串、null 和缺失。 */
  fieldShapes: Record<string, JsonValue | undefined>
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error'

export type DiagnosticStage =
  | 'input'
  | 'parse'
  | 'normalize'
  | 'replace'
  | 'conflict'
  | 'fetch'
  | 'cleanup'

export type DiagnosticCode =
  | 'input-empty'
  | 'input-invalid-json'
  | 'input-not-object'
  | 'source-url-missing'
  | 'source-name-missing'
  | 'source-type-invalid'
  | 'rule-invalid'
  | 'requires-javascript'
  | 'source-urls-invalid'
  | 'source-urls-limit'
  | 'reader-missing'
  | 'reader-failed'
  | 'response-too-large'
  | 'cancelled'
  | 'replacement-failed'
  | 'duplicate-source-id'
  | 'conflict'
  | 'unsupported-format'

export interface ImportDiagnostic {
  /** 稳定错误码，调用方可据此决定展示和重试策略。 */
  code: DiagnosticCode
  /** 诊断严重级别。 */
  severity: DiagnosticSeverity
  /** 发生诊断的阶段。 */
  stage: DiagnosticStage
  /** 可安全展示的消息，不得包含凭据或完整私有 URL。 */
  message: string
  /** JSON 字段路径或候选索引。 */
  path?: string
  /** 该问题是否允许应用重试。 */
  retryable: boolean
}

export type CandidateStatus = 'ready' | 'invalid' | 'cancelled' | 'persisted'
export type LocalMatch = 'new' | 'same' | 'update' | 'conflict'

export interface ImportReplacementResult {
  /** 替换规则的稳定身份。 */
  ruleId: string
  /** 本次规则是否实际应用。 */
  applied: boolean
  /** 失败时的脱敏原因。 */
  error?: string
}

export interface ImportCandidate {
  /** 本次导入内稳定的候选 ID，不作为持久化 sourceId。 */
  id: string
  /** 本次加载实例的 UUID；不写回书源原文，也不替代兼容层 sourceId。 */
  sourceUuid: string
  /** 忽略展示/管理字段后的规则与请求定义指纹，用于判定同一份书源定义。 */
  sourceFingerprint?: string
  /** 原始输入来源。 */
  origin: ImportOrigin
  /** 候选对应的输入文本或数组成员文本。 */
  rawText: string
  /** 原始输入和字段形态。 */
  raw: RawSource
  /** 规范化后可供运行时使用的源；无效候选没有该字段。 */
  source?: NormalizedSource
  /** 可供编辑器展示和回写的未知字段。 */
  unknownFields: JsonObject
  /** 已执行的替换规则结果。 */
  replacements: ImportReplacementResult[]
  /** 输入、解析、规范化和替换诊断。 */
  diagnostics: ImportDiagnostic[]
  /** 与本地快照比较后的状态。 */
  localMatch?: LocalMatch
  /** 是否允许提交到 Repository。 */
  writable: boolean
  /** 候选生命周期状态。 */
  status: CandidateStatus
  /** 便于 UI 展示的主错误；详细信息仍在 diagnostics。 */
  error?: { code: DiagnosticCode; message: string; canRetry: boolean }
}

export interface SourceSnapshot {
  /** 用户作用域身份；不拼接到 sourceId。 */
  userId: string
  /** 原始 bookSourceUrl。 */
  sourceId: string
  /** 用户保存版本，用于并发比较。 */
  sourceRevision: string
  /** 已规范化的源配置。 */
  source: NormalizedSource
  /** 不属于 source 配置的用户状态。 */
  userState?: JsonObject
}

export interface ImportLimits {
  /** 一次导入允许的最大候选数。 */
  maxCandidates: number
  /** 单份文本的最大 UTF-8 字节数。 */
  maxBytes: number
  /** sourceUrls 只允许展开一层。 */
  maxSourceUrls: number
}

export interface ImportReaderRequest {
  /** 受控 URI 或 URL；实现层必须自行执行协议和 SSRF 策略。 */
  uri: string
  /** 本次读取的字节上限。 */
  maxBytes: number
  /** 取消信号。 */
  signal?: AbortSignal
}

export interface ImportReaderResponse {
  /** 读取的文本内容。 */
  text: string
  /** 脱敏后的最终来源位置。 */
  location?: string
}

export interface ImportReader {
  /** 读取一个受控来源；不得读取任意本地路径。 */
  read(request: ImportReaderRequest): Promise<ImportReaderResponse>
}

export interface ImportInputText {
  kind: 'text' | 'javascript'
  text: string
  origin?: ImportOrigin
}

export interface ImportInputUri {
  kind: 'uri' | 'file' | 'url'
  uri: string
  origin?: ImportOrigin
}

export type ImportInput = string | JsonValue | ImportInputText | ImportInputUri

export interface ImportReplacementRule {
  /** 替换规则身份。 */
  ruleId: string
  /** 仅用于匹配书源名称的正则文本；缺省时匹配全部。 */
  namePattern?: string
  /** 仅用于匹配书源 URL 的正则文本；缺省时匹配全部。 */
  urlPattern?: string
  /** 对原文执行的字符串替换。 */
  search: string
  /** 替换文本。 */
  replacement: string
  /** 是否替换全部匹配。 */
  all?: boolean
}

export interface ImportOptions {
  /** URI/file/url 输入所使用的受控读取端口。 */
  reader?: ImportReader
  /** 读取和展开限制。 */
  limits?: Partial<ImportLimits>
  /** 取消导入和在途读取。 */
  signal?: AbortSignal
  /** 可选的原始文本替换规则。 */
  replacements?: readonly ImportReplacementRule[]
  /** 用原始 sourceId 查找本地版本。 */
  localSnapshots?: ReadonlyMap<string, SourceSnapshot>
  /** 测试或上层会话可注入 UUID 生成器；默认使用运行时 UUID。 */
  sourceUuidFactory?: () => string
}

export interface ExportOptions {
  /** 导出格式。 */
  format: 'json' | 'javascript'
  /** 只对规范化源应用显式字段修改，不改变候选原文。 */
  patch?: JsonObject
}

export interface ExportResult {
  /** 生成的文本。 */
  text: string
  /** 实际输出格式。 */
  format: ExportOptions['format']
  /** 导出过程中的安全提示。 */
  diagnostics: ImportDiagnostic[]
}

export interface SourceDiff {
  /** 远程/本地比较使用的 sourceId。 */
  sourceId: string
  /** 变化类别。 */
  kind: 'added' | 'updated' | 'unchanged' | 'conflict' | 'remote-missing'
  /** 发生变化的顶层字段路径。 */
  fields: string[]
  /** 本项可安全展示的错误。 */
  error?: string
}

export interface SubscriptionSourceSnapshot {
  /** sourceId 与 bookSourceUrl 相同。 */
  sourceId: string
  /** 采用的远程基线源。 */
  source: NormalizedSource
  /** 本地源版本。 */
  sourceRevision?: string
}

export interface SubscriptionRefreshInput {
  /** 订阅身份。 */
  subscriptionId: string
  /** 操作身份；重试时保持不变。 */
  operationId: string
  /** 当前订阅版本。 */
  baseSubscriptionRevision: string
  /** 订阅下载地址。 */
  url?: string
  /** 已有远程快照；提供时不读取网络。 */
  remoteSources?: readonly NormalizedSource[]
  /** 上次成功采用的远程快照。 */
  baseline: readonly SubscriptionSourceSnapshot[]
  /** 当前本地源快照。 */
  local: readonly SubscriptionSourceSnapshot[]
  /** 受控读取端口。 */
  reader?: ImportReader
  /** 取消刷新。 */
  signal?: AbortSignal
  /** 读取限制。 */
  limits?: Partial<ImportLimits>
}

export interface SubscriptionRefreshPlan {
  /** 订阅身份。 */
  subscriptionId: string
  /** 操作身份。 */
  operationId: string
  /** 计算时看到的订阅版本。 */
  baseSubscriptionRevision: string
  /** 刷新结果。 */
  outcome: 'unchanged' | 'updated' | 'partial' | 'conflict' | 'failed' | 'cancelled' | 'stale' | 'unknown'
  /** 每个 sourceId 的变化。 */
  diffs: SourceDiff[]
  /** 提交前计划；本阶段不执行。 */
  commitPlan: {
    sourceIds: string[]
    expectedSourceRevisions: Record<string, string | undefined>
    requiresConfirmation: boolean
  }
  /** 下载和解析诊断。 */
  diagnostics: ImportDiagnostic[]
}
