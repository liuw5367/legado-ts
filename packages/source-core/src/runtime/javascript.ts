export type JavaScriptStage = 'mainJs' | 'book' | 'chapter' | 'search' | 'content'

export type JavaScriptExecutionMode = 'script' | 'function-body'
export type JavaScriptVariableScope = 'chapter' | 'book' | 'rule-data' | 'source'

export interface JavaScriptBudget {
  /** 单次 JS 求值的硬超时，单位为毫秒。 */
  timeoutMs: number
  /** QuickJS 运行时内存上限，单位为字节。 */
  memoryLimitBytes: number
  /** QuickJS 栈上限，单位为字节。 */
  maxStackSizeBytes: number
  /** 输入代码和 bindings 的最大 UTF-8 字节数。 */
  maxInputBytes: number
  /** 返回值编码后的最大 UTF-8 字节数。 */
  maxOutputBytes: number
  /** 单次执行允许的 bridge 调用次数。 */
  maxBridgeCalls: number
}

export interface JavaScriptBridge {
  /** 读取一个宿主变量；未提供时 JS 中不暴露变量 bridge。 */
  getVariable?: (name: string, signal: AbortSignal, scope?: JavaScriptVariableScope) => unknown | Promise<unknown>
  /** 写入一个宿主变量；未提供时 JS 中不暴露变量 bridge。 */
  setVariable?: (name: string, value: unknown, signal: AbortSignal, scope?: JavaScriptVariableScope) => void | Promise<void>
  /** 执行一条已由宿主进一步校验的请求计划。 */
  request?: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>
  /** 在当前书源上下文中执行一条声明式规则。 */
  evaluateRule?: (rule: string, signal: AbortSignal, options?: { expect?: 'text' | 'nodes'; content?: unknown }) => unknown | Promise<unknown>
}

export interface JavaScriptExecutionInput {
  /** 书源提供的 JS；执行器不得交给 Node eval/Function/vm。 */
  code: string
  /** 当前 JS 生命周期阶段。 */
  stage: JavaScriptStage
  /** 诊断和堆栈使用的逻辑文件名。 */
  filename?: string
  /** 规则脚本使用 script completion；源码函数和旧的直接宿主调用可用函数体模式。 */
  mode?: JavaScriptExecutionMode
  /** 脚本求值后从 globalThis 读取的 DTO 绑定。仅脚本模式支持。 */
  captureBindings?: readonly string[]
  /** Captures serializable script globals so a workflow can carry them into a later execution. */
  captureGlobals?: boolean
  /** 只读输入对象；执行器应深冻结其 guest 副本。 */
  bindings?: Readonly<Record<string, unknown>>
  /** 本次执行开始时的变量快照。 */
  variables?: Readonly<Record<string, unknown>>
  /** 本次执行的预算覆盖。 */
  budget?: Partial<JavaScriptBudget>
  /** 取消执行；取消后 QuickJS context 不得复用。 */
  signal?: AbortSignal
}

export type JavaScriptDiagnosticCode = 'syntax-error' | 'runtime-error' | 'serialization-error' | 'budget-exceeded' | 'cancelled' | 'capability-unavailable' | 'bridge-error'

export interface JavaScriptDiagnostic {
  code: JavaScriptDiagnosticCode
  message: string
  stage: JavaScriptStage
  capability?: 'variables' | 'network' | 'rule' | 'runtime'
}

export interface JavaScriptVariableChange {
  name: string
  scope?: JavaScriptVariableScope
  before?: unknown
  after?: unknown
}

export interface JavaScriptTraceEntry {
  kind: 'execute' | 'bridge'
  name: string
  durationMs?: number
}

export interface JavaScriptExecutionResult {
  status: 'success' | 'failed' | 'cancelled' | 'budget-exceeded' | 'capability-missing'
  value: unknown
  diagnostics: JavaScriptDiagnostic[]
  variableChanges: JavaScriptVariableChange[]
  trace: JavaScriptTraceEntry[]
}

export interface JavaScriptHost {
  /** 每次执行可覆写 bridge，避免并发书源共享可变上下文。 */
  execute(input: JavaScriptExecutionInput, bridge?: JavaScriptBridge): Promise<JavaScriptExecutionResult>
}
