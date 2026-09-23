import type { JsonObject, JsonValue, NormalizedSource } from '../model/types.ts'

export type RuleMode = 'Default' | 'XPath' | 'Json' | 'Js' | 'Regex' | 'WebJs'

export type RuleCapability = 'text' | 'variables' | 'regex' | 'parser:html' | 'parser:xpath' | 'parser:json' | 'javascript' | 'webview'

export interface RuleSpan {
  /** 规则原文中的 UTF-16 起始偏移，包含起点。 */
  start: number
  /** 规则原文中的 UTF-16 结束偏移，不包含终点。 */
  end: number
}

export interface RuleReplacement {
  /** 替换表达式的正则文本。 */
  pattern: string
  /** 正则替换文本。 */
  replacement: string
  /** 是否只保留并替换第一个完整匹配片段。 */
  firstMatchOnly: boolean
}

export interface RulePut {
  /** 写入变量的名称。 */
  name: string
  /** 写入变量前编译的规则。 */
  rule: CompiledRule
}

export interface RuleAtom {
  kind: 'atom'
  /** 原始规则文本。 */
  source: string
  /** 当前节点在原始规则中的范围。 */
  span: RuleSpan
  /** 规则执行模式。 */
  mode: RuleMode
  /** 去除模式前缀后的规则正文。 */
  body: string
  /** 该节点声明的宿主能力。 */
  capabilities: RuleCapability[]
  /** 前置变量写入。 */
  puts: RulePut[]
  /** 规则结果上的替换。 */
  replacement?: RuleReplacement
}

export interface RuleSequence {
  kind: 'sequence'
  /** 组合操作。 */
  operator: '&&' | '||' | '%%'
  /** 组合节点原文。 */
  source: string
  /** 组合节点范围。 */
  span: RuleSpan
  /** 按源码顺序排列的子规则。 */
  children: CompiledRule[]
  /** 子规则所需能力的并集。 */
  capabilities: RuleCapability[]
}

export type CompiledRule = RuleAtom | RuleSequence

export interface RuleCompileOptions {
  /** 是否允许首字符 `:` 进入全规则 Regex 模式。 */
  allInOne?: boolean
  /** 没有显式模式前缀时的默认模式；内容为 JSON 时传 `Json` 对齐 Android isJSON。 */
  defaultMode?: 'Default' | 'Json'
}

export type RuleDiagnosticCode =
  | 'unbalanced-rule'
  | 'invalid-regex'
  | 'invalid-put'
  | 'capability-unavailable'
  | 'variable-missing'
  | 'evaluation-error'
  | 'budget-exceeded'
  | 'cancelled'

export interface RuleDiagnostic {
  /** 稳定规则诊断码。 */
  code: RuleDiagnosticCode
  /** 诊断消息。 */
  message: string
  /** 诊断在规则原文中的范围。 */
  span?: RuleSpan
  /** 该诊断是否允许继续执行后续组合分支。 */
  canContinue: boolean
}

export interface RuleCompileResult {
  /** 编译成功时的不可变规则 IR。 */
  rule?: CompiledRule
  /** 词法、语法和模式检查结果。 */
  diagnostics: RuleDiagnostic[]
}

export type VariableScope = 'local' | 'chapter' | 'book' | 'rule-data' | 'source'

export interface RuleVariableView {
  /** 按 local、chapter、book、rule-data、source 顺序读取变量。 */
  get(name: string): string | undefined
  /** 写入指定作用域；省略作用域时写入当前可用的最具体持久层。 */
  set(name: string, value: string | null, scope?: VariableScope): void
  /** 只删除指定作用域中的变量。 */
  delete(name: string, scope?: VariableScope): void
  /** 判断变量是否命中，local 以键存在判断，其他作用域跳过空字符串。 */
  has(name: string): boolean
  /** 返回一个作用域的脱敏快照；省略时返回所有作用域的合并视图。 */
  snapshot(scope?: VariableScope): Readonly<Record<string, string>>
}

export interface MemoryVariableOptions {
  /** 本次规则调用可写入的持久作用域，顺序由最具体到最通用。 */
  availableScopes?: readonly VariableScope[]
  /** 初始变量值；各对象只读复制到内部 map。 */
  initial?: Partial<Record<VariableScope, Record<string, string>>>
}

export interface RuleContext {
  /** 当前规则调用身份。 */
  requestId: string
  /** 当前规则输入。阶段 02 对非文本值只做安全文本化。 */
  content: unknown
  /** 空 URL 结果的回退基准。 */
  baseUrl?: string
  /** 非空相对 URL 结果的重定向基准。 */
  redirectUrl?: string
  /** 当前只读书源。 */
  readonly source: NormalizedSource
  /** 当前书籍，搜索阶段可以省略。 */
  readonly book?: JsonObject
  /** 当前章节，搜索和详情阶段可以省略。 */
  readonly chapter?: JsonObject
  /** 当前规则变量视图。 */
  variables: RuleVariableView
  /** 取消规则求值。 */
  signal?: AbortSignal
}

export interface RuleBudget {
  /** 单次求值允许的 evaluator 步数。 */
  maxSteps: number
  /** 规则组合和递归插值的最大深度。 */
  maxDepth: number
  /** 所有输出文本和列表项的最大 UTF-8 字节数。 */
  maxOutputBytes: number
}

export type RuleValue = JsonValue

export interface VariableChange {
  /** 变量作用域。 */
  scope: VariableScope
  /** 变量名。 */
  name: string
  /** 修改前的值；缺失时为 undefined。 */
  before?: string
  /** 修改后的值；删除时为 undefined。 */
  after?: string
}

export interface RuleEvaluationResult {
  /** 可判别的纯规则求值状态。 */
  status: 'success' | 'empty' | 'failed' | 'cancelled' | 'capability-missing' | 'budget-exceeded'
  /** 求值结果；empty/失败时为 null。 */
  value: RuleValue | null
  /** 按发生顺序返回的规则诊断。 */
  diagnostics: RuleDiagnostic[]
  /** 本次求值中变量的可观察变化。 */
  variableChanges: VariableChange[]
}
