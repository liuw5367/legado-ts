import { compileRule } from './compiler.ts'
import { compileSourcePattern } from './pattern-guard.ts'
import { MemoryVariableView } from './variables.ts'
import { sourceDefinitionFingerprint } from '../codec/identity.ts'
import { MemorySourceScriptCache } from '../runtime/source-session.ts'
import { replaceFont } from '../runtime/font.ts'
import type {
  CryptoHost,
  EncodingHost,
  FontHost,
  HtmlDocument,
  HtmlParser,
  JsonPathParser,
  ParserNode,
  SourceScriptCache,
  XPathParser,
} from '../runtime/contracts.ts'
import type { JavaScriptHost, JavaScriptVariableScope } from '../runtime/javascript.ts'
import type { NormalizedSource } from '../model/types.ts'
import type { CompiledRule, RuleAtom, RuleSequence } from './types.ts'
import type {
  WorkflowRulePort,
  WorkflowRuleRequest,
  WorkflowRuleOutput,
  WorkflowJavaScriptRequest,
  SourceFunctionName,
  SourceFunctionOutput,
  SourceFunctionRequest,
} from '../workflows/types.ts'

export interface SourceRuleBridgeRequest {
  kind: string
  url?: string
  method?: string
  body?: unknown
  options?: unknown
  headers?: Readonly<Record<string, string>>
  value?: unknown
  saveTime?: unknown
  text?: unknown
  errorBase64?: unknown
  correctBase64?: unknown
  filter?: unknown
  key?: unknown
  iv?: unknown
  transformation?: unknown
  time?: unknown
  format?: unknown
  offsetMs?: unknown
  capability?: string
  expression?: unknown
  name?: string
  scope?: string
}

export interface SourceRuleRuntimeOptions {
  /** bridge 处理器；第三个参数是本次求值的书源（宿主总是显式传入），URL 展开等求值发生在首次请求之前。 */
  request?: (input: SourceRuleBridgeRequest, signal: AbortSignal, source: NormalizedSource) => Promise<unknown>
  /** Android `source.putConcurrent` 的会话级限流配置写端。 */
  setConcurrentRate?: (value: string) => void
  /** 书源 JS 的 CacheManager 端口，默认是仅当前会话可见的内存缓存。 */
  cache?: SourceScriptCache
  /** 平台对齐 Android JavaScriptInterface 的时间格式。 */
  timeFormat?: (time: number) => string
  timeFormatUTC?: (time: number, format: string, offsetMs: number) => string | null
  /** 由宿主提供密码学随机 UUID。 */
  randomUUID?: () => string
  encoding: EncodingHost
  crypto: CryptoHost
  font: FontHost
  html: HtmlParser
  json: JsonPathParser
  xpath: XPathParser
  javascript: JavaScriptHost
  initialVariables?: Readonly<Record<string, string>>
  maxSteps?: number
}

interface EvaluationState {
  readonly request: WorkflowRuleRequest
  readonly source: NormalizedSource
  readonly content: unknown
  readonly bindings: Readonly<Record<string, unknown>>
  readonly budget: { steps: number; depth: number }
  readonly expect: WorkflowRuleRequest['expect']
}

interface NodeRef {
  readonly __legadoNode: string
  readonly id: string
}

interface StoredNode {
  readonly document: HtmlDocument
  readonly node: ParserNode
}

interface SelectedNode {
  readonly document: HtmlDocument
  readonly node: ParserNode
}

class SourceRuleError extends Error {
  public readonly status: Extract<WorkflowRuleOutput['status'], 'failed' | 'cancelled' | 'capability-missing'>

  public constructor(status: Extract<WorkflowRuleOutput['status'], 'failed' | 'cancelled' | 'capability-missing'>, message: string) {
    super(message)
    this.status = status
  }
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n')
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function isVariableScope(value: unknown): value is JavaScriptVariableScope {
  return value === 'chapter' || value === 'book' || value === 'rule-data' || value === 'source'
}

function jsonInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    // JSON 文本可能带 UTF-8 BOM；先移除 BOM 再解析。
    return JSON.parse(value.replace(/^\uFEFF/, '')) as unknown
  } catch {
    return value
  }
}

function isNodeRef(value: unknown): value is NodeRef {
  return typeof value === 'object' && value !== null && (value as { __legadoNode?: unknown }).__legadoNode === 'source-rule-node' && typeof (value as { id?: unknown }).id === 'string'
}

type DefaultOutput = 'text' | 'textNodes' | 'ownText' | 'html' | 'all'

interface DefaultPlan {
  /** `@` 之前的元素选择器链；没有选择器时为空串。 */
  selector: string
  /** 已知输出标记；与 `attribute` 互斥。 */
  output?: DefaultOutput
  /** 末段不是输出标记时，按 Android 语义作为属性名。 */
  attribute?: string
}

/**
 * 解析 Default 规则：Android 把 `@` 分割后的最后一段一律当作输出标记，只识别
 * text/textNodes/ownText/html/all，其余（含 href、value、data-original）都是属性名；
 * 整条规则没有 `@` 时整段就是属性名。字段规则据此取值，不能把节点本身当成结果。
 */
function lastOutput(body: string): DefaultPlan {
  const separator = body.lastIndexOf('@')
  if (separator < 0) return { selector: '', attribute: body.trim() }
  const token = body.slice(separator + 1).trim()
  if (token.length === 0) return { selector: body, output: 'text' }
  const lower = token.toLowerCase()
  const output: DefaultOutput | undefined = lower === 'text' ? 'text' : lower === 'textnodes' ? 'textNodes' : lower === 'owntext' ? 'ownText' : lower === 'html' ? 'html' : lower === 'all' ? 'all' : undefined
  return output === undefined ? { selector: body.slice(0, separator), attribute: token } : { selector: body.slice(0, separator), output }
}

/** Android AnalyzeRule.isJSON：对象/数组，或 trim 后由 `{}`、`[]` 包裹的字符串。 */
function jsonContent(value: unknown): boolean {
  if (value === null || value === undefined || isNodeRef(value)) return false
  if (typeof value !== 'string') return typeof value === 'object'
  const text = value.trim()
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))
}

/**
 * jsonpath-plus 只对「确定路径」额外包一层数组；含通配、递归、过滤、切片、联合或脚本的路径，
 * 返回值本身就是 Android `JsonPath.read` 的元素列表（如 `$.single[*]` 在 `[[1,2]]` 上返回 `[[1,2]]`）。
 */
function isDefiniteJsonPath(expression: string): boolean {
  const unquoted = expression.replace(/'[^']*'|"[^"]*"/gu, '')
  return !/[*?()]|\.\.|,|:/u.test(unquoted)
}

function normalizeSelector(selector: string): string {
  if (selector.startsWith('class.')) return `.${selector.slice('class.'.length)}`
  if (selector.startsWith('tag.')) return selector.slice('tag.'.length)
  if (selector.startsWith('id.')) return `#${selector.slice('id.'.length)}`
  return selector
}

function splitSelectorChain(selector: string): string[] {
  return selector.split('@').map((item) => item.trim()).filter(Boolean)
}

interface PositionSelection {
  base: string
  tokens: Array<number | { start?: number; end?: number; step: number }>
  excluded: boolean
}

function parseBracketSelection(selector: string): PositionSelection | undefined {
  const open = selector.lastIndexOf('[')
  if (open < 0 || !selector.endsWith(']')) return undefined
  let body = selector.slice(open + 1, -1).trim()
  const excluded = body.startsWith('!')
  if (excluded) body = body.slice(1).trim()
  if (body.length === 0) return undefined
  const tokens: PositionSelection['tokens'] = []
  for (const part of body.split(',')) {
    const item = part.trim()
    if (/^-?\d+$/u.test(item)) {
      tokens.push(Number(item))
      continue
    }
    const range = /^(-?\d+)?\s*:\s*(-?\d+)?\s*(?::\s*(-?\d+))?$/u.exec(item)
    if (range === null) return undefined
    tokens.push({
      ...(range[1] === undefined ? {} : { start: Number(range[1]) }),
      ...(range[2] === undefined ? {} : { end: Number(range[2]) }),
      step: range[3] === undefined ? 1 : Number(range[3]),
    })
  }
  return { base: selector.slice(0, open), tokens, excluded }
}

function parseLegacySelection(selector: string): PositionSelection | undefined {
  const match = /^(.*?)([.!])(-?\d+(?::-?\d+)*)$/u.exec(selector)
  if (match === null) return undefined
  return {
    base: match[1]!,
    tokens: match[3]!.split(':').map(Number),
    excluded: match[2] === '!',
  }
}

function positionedIndexes(selection: PositionSelection, length: number): number[] {
  const indexes: number[] = []
  const add = (index: number): void => {
    const normalized = index < 0 ? length + index : index
    if (normalized >= 0 && normalized < length && !indexes.includes(normalized)) indexes.push(normalized)
  }
  for (const token of selection.tokens) {
    if (typeof token === 'number') {
      add(token)
      continue
    }
    let start = token.start ?? 0
    let end = token.end ?? length - 1
    if (start < 0) start += length
    if (end < 0) end += length
    if (length === 0 || ((start < 0 && end < 0) || (start >= length && end >= length))) continue
    start = Math.max(0, Math.min(length - 1, start))
    end = Math.max(0, Math.min(length - 1, end))
    if (start === end || token.step >= length) {
      add(start)
      continue
    }
    const step = token.step > 0 ? token.step : -token.step < length ? token.step + length : 1
    const stride = Math.max(1, step)
    if (end >= start) for (let index = start; index <= end; index += stride) add(index)
    else for (let index = start; index >= end; index -= stride) add(index)
  }
  return indexes
}

function applyPositionSelection(nodes: ParserNode[], selection: PositionSelection | undefined): ParserNode[] {
  if (selection === undefined) return nodes
  const indexes = positionedIndexes(selection, nodes.length)
  if (selection.excluded) {
    const excluded = new Set(indexes)
    return nodes.filter((_node, index) => !excluded.has(index))
  }
  return indexes.map((index) => nodes[index]!)
}

function selectWithPosition(document: HtmlDocument, selector: string): ParserNode[] {
  // Android distinguishes legacy discrete indices (tag.a.0:3) from bracket ranges (tag.a[0:3]).
  const selection = parseBracketSelection(selector) ?? parseLegacySelection(selector)
  const base = selection?.base ?? selector
  const nodes = base.length === 0 || base === 'children' ? document.children() : document.select(base)
  return applyPositionSelection(nodes, selection)
}

interface SourceRuleSegment {
  kind: 'rule' | 'javascript'
  text: string
}

function splitSourceRuleSegments(rule: string): SourceRuleSegment[] | undefined {
  const matcher = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/ig
  const segments: SourceRuleSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(rule)) !== null) {
    const before = rule.slice(cursor, match.index).trim()
    if (before.length > 0) segments.push({ kind: 'rule', text: before })
    const code = (match[1] ?? match[2] ?? '').trim()
    segments.push({ kind: 'javascript', text: code })
    cursor = matcher.lastIndex
    if (match[2] !== undefined) return segments
  }
  if (segments.length === 0) return undefined
  const tail = rule.slice(cursor).trim()
  if (tail.length > 0) segments.push({ kind: 'rule', text: tail })
  return segments
}

type RuleEntity = Record<string, unknown>

function entityVariables(entity: unknown): Record<string, string> {
  if (typeof entity !== 'object' || entity === null) return {}
  const record = entity as RuleEntity
  const value = record.variable ?? (typeof record.rawFields === 'object' && record.rawFields !== null ? (record.rawFields as RuleEntity).variable : undefined)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      }
    } catch {
      return {}
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
  return {}
}

function entityValue(entity: unknown, name: string): string | undefined {
  return entityVariables(entity)[name]
}

function mergeCapturedEntityVariables(value: unknown, names: readonly string[] | undefined, bindings: Readonly<Record<string, unknown>>, initialVariables: Readonly<Record<string, string | undefined>>): unknown {
  if (names === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const wrapper = value as RuleEntity
  const captured = wrapper.__legadoWorkflowBindings
  if (typeof captured !== 'object' || captured === null || Array.isArray(captured)) return value
  const result: RuleEntity = { ...wrapper, __legadoWorkflowBindings: { ...(captured as RuleEntity) } }
  const capturedBindings = result.__legadoWorkflowBindings as RuleEntity
  for (const name of names) {
    const current = bindings[name]
    const returned = capturedBindings[name]
    if (typeof current !== 'object' || current === null || typeof returned !== 'object' || returned === null || Array.isArray(returned)) continue
    const currentVariable = (current as RuleEntity).variable
    if (typeof currentVariable === 'string' && currentVariable !== initialVariables[name]) {
      capturedBindings[name] = { ...(returned as RuleEntity), variable: currentVariable }
    }
  }
  return result
}

export class SourceRuleRuntime implements WorkflowRulePort {
  private readonly variables: MemoryVariableView
  private readonly html: HtmlParser
  private readonly json: JsonPathParser
  private readonly xpath: XPathParser
  private readonly javascript: JavaScriptHost
  private readonly encoding: EncodingHost
  private readonly crypto: CryptoHost
  private readonly font: FontHost
  private readonly requestBridge?: SourceRuleRuntimeOptions['request']
  private readonly setConcurrentRate?: SourceRuleRuntimeOptions['setConcurrentRate']
  private readonly cache: SourceScriptCache
  private readonly timeFormat?: SourceRuleRuntimeOptions['timeFormat']
  private readonly timeFormatUTC?: SourceRuleRuntimeOptions['timeFormatUTC']
  private readonly randomUUID?: SourceRuleRuntimeOptions['randomUUID']
  private readonly maxSteps: number
  private readonly nodes = new Map<string, StoredNode>()
  private readonly captureRows = new WeakMap<object, string>()
  private bindings: Readonly<Record<string, unknown>> = {}
  private nextNodeId = 0

  public constructor(options: SourceRuleRuntimeOptions) {
    this.variables = new MemoryVariableView({ availableScopes: ['source'], initial: { source: options.initialVariables ?? {} } })
    this.encoding = options.encoding
    this.crypto = options.crypto
    this.font = options.font
    this.html = options.html
    this.json = options.json
    this.xpath = options.xpath
    this.javascript = options.javascript
    this.requestBridge = options.request
    this.setConcurrentRate = options.setConcurrentRate
    this.cache = options.cache ?? new MemorySourceScriptCache()
    this.timeFormat = options.timeFormat
    this.timeFormatUTC = options.timeFormatUTC
    this.randomUUID = options.randomUUID
    this.maxSteps = options.maxSteps ?? 10000
  }

  public setBindings(bindings: Readonly<Record<string, unknown>>): void {
    this.bindings = { ...bindings }
  }

  public setVariable(name: string, value: string | null): void {
    this.variables.set(name, value, 'source')
  }

  public snapshotVariables(scope: 'source'): Readonly<Record<string, string>> {
    return this.variables.snapshot(scope)
  }

  private readVariable(name: string, bindings: Readonly<Record<string, unknown>>, scope?: JavaScriptVariableScope): string | undefined {
    if (scope === 'source') {
      const value = this.variables.get(name, 'source')
      return name === '__source__' ? value ?? '' : value
    }
    if (scope !== undefined) return entityValue(this.entityForScope(bindings, scope), name)
    if (name === 'bookName' && this.entityForScope(bindings, 'book') !== undefined) {
      const bookName = (this.entityForScope(bindings, 'book') as RuleEntity).name
      return bookName === null || bookName === undefined ? '' : textValue(bookName)
    }
    if (name === 'title' && this.entityForScope(bindings, 'chapter') !== undefined) {
      const title = (this.entityForScope(bindings, 'chapter') as RuleEntity).title
      return title === null || title === undefined ? '' : textValue(title)
    }
    for (const current of ['chapter', 'book', 'rule-data', 'source'] as const) {
      const value = this.readVariable(name, bindings, current)
      if (value !== undefined && value.length > 0) return value
    }
    return undefined
  }

  private writeVariable(name: string, value: unknown, bindings: Readonly<Record<string, unknown>>, scope?: JavaScriptVariableScope): void {
    const target = scope ?? (this.entityForScope(bindings, 'chapter') !== undefined ? 'chapter' : this.entityForScope(bindings, 'book') !== undefined ? 'book' : this.entityForScope(bindings, 'rule-data') !== undefined ? 'rule-data' : 'source')
    const next = value === null || value === undefined ? null : textValue(value)
    if (target === 'source') {
      this.variables.set(name, next, 'source')
      return
    }
    const entity = this.entityForScope(bindings, target)
    if (entity === undefined) return
    const values = entityVariables(entity)
    if (next === null) delete values[name]
    else Object.defineProperty(values, name, { value: next, enumerable: true, configurable: true, writable: true })
    entity.variable = JSON.stringify(values)
  }

  private entityForScope(bindings: Readonly<Record<string, unknown>>, scope: JavaScriptVariableScope): RuleEntity | undefined {
    const value = scope === 'rule-data' ? bindings.ruleData ?? bindings.rule_data : bindings[scope]
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RuleEntity : undefined
  }

  private async nestedRule(rule: string, state: EvaluationState, content: unknown, expect: WorkflowRuleRequest['expect'], signal: AbortSignal): Promise<unknown> {
    const nestedState: EvaluationState = {
      ...state,
      request: { ...state.request, signal },
      budget: state.budget,
    }
    this.check(nestedState)
    state.budget.depth += 1
    if (state.budget.depth > 64) {
      state.budget.depth -= 1
      throw new SourceRuleError('failed', '规则嵌套超过限制')
    }
    try {
      const nestedExpect = expect ?? 'text'
      const request: WorkflowRuleRequest = { ...nestedState.request, rule, content, expect: nestedExpect, bindings: state.bindings }
      return await this.evaluateText(rule, { ...nestedState, request, content, expect: nestedExpect }, content)
    } finally {
      state.budget.depth -= 1
    }
  }

  public async executeJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown = '', signal?: AbortSignal): Promise<WorkflowRuleOutput> {
    return this.runJavaScript(code, stage, source, content, signal)
  }

  public async executeWorkflowJavaScript(request: WorkflowJavaScriptRequest): Promise<WorkflowRuleOutput> {
    return this.runJavaScript(request.code, request.stage, request.source, request.content ?? '', request.signal, {
      mode: 'script',
      ...(request.captureMutations === undefined ? {} : { captureBindings: request.captureMutations }),
      ...(request.content === undefined ? {} : { content: request.content }),
      ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
      ...(request.redirectUrl === undefined ? {} : { redirectUrl: request.redirectUrl }),
      ...(request.bindings === undefined ? {} : { bindings: request.bindings }),
      ...(request.captureGlobals === true ? { captureGlobals: true } : {}),
      ...(request.globalState === undefined ? {} : { globalState: request.globalState }),
    })
  }

  public async executeSourceFunction(request: SourceFunctionRequest): Promise<SourceFunctionOutput> {
    const names: Record<SourceFunctionName, readonly string[]> = {
      search: ['key', 'page'],
      explore: ['url', 'page'],
      getBookInfo: ['book'],
      getChapters: ['book'],
      getContent: ['chapter', 'book', 'nextChapterUrl'],
    }
    const parameters = names[request.name]
    const bindings: Readonly<Record<string, unknown>> = {
      ...(request.bindings ?? {}),
      ...Object.fromEntries(parameters.map((name, index) => [name, request.args[index]])),
    }
    const call = `${request.name}(${parameters.join(', ')})`
    const code = [
      request.source.mainJs ?? '',
      `typeof ${request.name} === 'function' ? { __legadoSourceFunctionExists: true, value: ${call} } : { __legadoSourceFunctionExists: false }`,
    ].join('\n')
    const captureBindings = parameters.filter((name) => Object.hasOwn(bindings, name))
    const output = await this.runJavaScript(code, request.stage, request.source, '', request.signal, { bindings, mode: 'script', captureBindings })
    if (output.status !== 'success') return { ...output, exists: false }
    let value = output.value
    if (captureBindings.length > 0) {
      const captured = value as { __legadoWorkflowValue?: unknown; __legadoWorkflowBindings?: unknown } | null
      if (typeof captured !== 'object' || captured === null || !('__legadoWorkflowBindings' in captured) || typeof captured.__legadoWorkflowBindings !== 'object' || captured.__legadoWorkflowBindings === null) {
        return { status: 'failed', value: null, exists: false, message: 'JavaScript 源函数返回值无法识别' }
      }
      for (const name of captureBindings) {
        const target = bindings[name]
        const changed = (captured.__legadoWorkflowBindings as RuleEntity)[name]
        if (typeof target !== 'object' || target === null || Array.isArray(target) || typeof changed !== 'object' || changed === null || Array.isArray(changed)) continue
        for (const [key, value] of Object.entries(changed)) {
          Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
        }
      }
      value = captured.__legadoWorkflowValue
    }
    if (typeof value !== 'object' || value === null || !('__legadoSourceFunctionExists' in value)) {
      return { status: 'failed', value: null, exists: false, message: 'JavaScript 源函数返回值无法识别' }
    }
    const result = value as { __legadoSourceFunctionExists: unknown; value?: unknown }
    if (result.__legadoSourceFunctionExists !== true) return { status: 'empty', value: null, exists: false }
    return { status: result.value === null || result.value === undefined ? 'empty' : 'success', value: result.value ?? null, exists: true }
  }

  public async evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput> {
    if (request.signal?.aborted === true) return { status: 'cancelled', value: null, message: '规则求值已取消' }
    const bindings = { ...this.bindings, ...(request.bindings ?? {}) }
    const state: EvaluationState = { request: { ...request, bindings }, source: request.source, content: request.content, bindings, budget: { steps: 0, depth: 0 }, expect: request.expect }
    try {
      const value = await this.evaluateText(request.rule, state, request.content)
      return nonEmpty(value) ? { status: 'success', value } : { status: 'empty', value: null }
    } catch (error) {
      if (error instanceof SourceRuleError) return { status: error.status, value: null, message: error.message }
      return { status: 'failed', value: null, message: error instanceof Error ? error.message : '规则求值失败' }
    }
  }

  private async evaluateText(rule: string, state: EvaluationState, content: unknown): Promise<unknown> {
    this.check(state)
    const segments = splitSourceRuleSegments(rule)
    if (segments !== undefined) {
      let result = content
      for (const [index, segment] of segments.entries()) {
        if (index > 0) this.check(state)
        if (segment.kind === 'rule') {
          const captureExpansion = this.expandCaptureReferences(segment.text, result, state.source.bookSourceUrl)
          result = captureExpansion.changed
            ? await this.evaluateCaptureText(captureExpansion.text, state, result)
            : await this.evaluatePlainText(segment.text, state, result)
          continue
        }
        // `<js></js>` is also used as a separator; an empty body leaves the current result intact.
        if (segment.text.length === 0) continue
        // JS templates are expanded against the content that entered the full rule,
        // while `result` itself is the output of the preceding segment.
        const code = await this.expandTemplate(segment.text, state, content)
        const output = await this.runJavaScript(code, this.javascriptStage(state.request.stage), state.source, result, state.request.signal, { ...state.request, bindings: state.bindings, ruleState: state, mode: 'script' })
        if (output.status !== 'success') throw new SourceRuleError(output.status === 'capability-missing' ? 'capability-missing' : output.status === 'cancelled' ? 'cancelled' : 'failed', output.message ?? 'JavaScript 规则执行失败')
        result = output.value
      }
      return result
    }
    const captureExpansion = this.expandCaptureReferences(rule, content, state.source.bookSourceUrl)
    const ruleText = captureExpansion.changed ? captureExpansion.text : rule
    if (captureExpansion.changed) return this.evaluateCaptureText(ruleText, state, content)
    return this.evaluatePlainText(ruleText, state, content)
  }

  private expandCaptureReferences(rule: string, content: unknown, sourceId: string): { text: string; changed: boolean } {
    if (!Array.isArray(content) || this.captureRows.get(content) !== sourceId) return { text: rule, changed: false }
    let changed = false
    const text = rule.replace(/\$([1-9]\d?)/gu, (_match, captureIndex: string) => {
      changed = true
      return textValue(content[Number(captureIndex)])
    })
    return { text, changed }
  }

  private async evaluateCaptureText(rule: string, state: EvaluationState, content: unknown): Promise<unknown> {
    if (!rule.includes('##') && !/@put:/i.test(rule)) return this.interpolate(rule, state, content)
    const compiled = compileRule(rule, { defaultMode: 'Default', allInOne: false })
    if (compiled.rule === undefined) throw new SourceRuleError('failed', compiled.diagnostics[0]?.message ?? '规则编译失败')
    if (compiled.rule.kind !== 'atom') return this.interpolate(rule, state, content)
    for (const put of compiled.rule.puts) this.writeVariable(put.name, textValue(await this.evaluateNode(put.rule, state, content)), state.bindings)
    const text = await this.interpolate(compiled.rule.body, state, content)
    return this.applyReplacement(text, compiled.rule, state, content)
  }

  private async evaluatePlainText(rule: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const compiled = compileRule(rule, { defaultMode: jsonContent(content) ? 'Json' : 'Default' })
    if (compiled.rule === undefined) throw new SourceRuleError('failed', compiled.diagnostics[0]?.message ?? '规则编译失败')
    return this.evaluateNode(compiled.rule, state, content)
  }

  private async evaluateNode(rule: CompiledRule, state: EvaluationState, content: unknown): Promise<unknown> {
    this.check(state)
    state.budget.depth += 1
    if (state.budget.depth > 64) {
      state.budget.depth -= 1
      throw new SourceRuleError('failed', '规则嵌套超过限制')
    }
    try {
      if (rule.kind === 'atom') return this.evaluateAtom(rule, state, content)
      return this.evaluateSequence(rule, state, content)
    } finally {
      state.budget.depth -= 1
    }
  }

  private async evaluateSequence(rule: RuleSequence, state: EvaluationState, content: unknown): Promise<unknown> {
    if (rule.operator === '||') {
      let lastError: SourceRuleError | undefined
      for (const child of rule.children) {
        try {
          const value = await this.evaluateNode(child, state, content)
          if (nonEmpty(value)) return value
        } catch (error) {
          if (error instanceof SourceRuleError) lastError = error
          else throw error
        }
      }
      if (lastError !== undefined && lastError.status !== 'failed') throw lastError
      return null
    }
    if (rule.operator === '%%') {
      const values = await Promise.all(rule.children.map(async (child) => this.toList(await this.evaluateNode(child, state, content))))
      const nonEmptyValues = values.filter((value) => nonEmpty(value))
      const result: unknown[] = []
      const length = nonEmptyValues[0]?.length ?? 0
      for (let index = 0; index < length; index += 1) for (const value of nonEmptyValues) if (index < value.length && nonEmpty(value[index])) result.push(value[index])
      return result
    }
    const values = (await Promise.all(rule.children.map((child) => this.evaluateNode(child, state, content)))).filter(nonEmpty)
    if (values.length === 0) return null
    if (values.some(Array.isArray)) return values.flatMap((value) => this.toList(value))
    return values.map(textValue).join('\n')
  }

  private async evaluateAtom(rule: RuleAtom, state: EvaluationState, content: unknown): Promise<unknown> {
    for (const put of rule.puts) this.writeVariable(put.name, textValue(await this.evaluateNode(put.rule, state, content)), state.bindings)
    const template = rule.body.includes('{{') || rule.body.includes('@get:')
    const interpolated = template ? await this.interpolate(rule.body, state, content) : rule.body
    let value: unknown
    // Android AnalyzeRule：规则体含 `{{}}`/`@get:{}` 时切到 Regex 模式，结果是插值后的文本本身，
    // 不再按 Default/Json/XPath 解析（AnalyzeRule.kt:702-713）；Js 模式例外，它先插值再执行。
    // 插值后为空时 Android 的 `if (rule.isNotEmpty())` 不成立，result 保持分析前的整页内容。
    // 空规则串在 Android 里分三种：列表规则（getStringList）沿用上一份内容；字段规则（getString）
    // 只有「带 ## 替换」时才沿用内容并继续做替换（AnalyzeRule.kt:345 的 `rule.isNotBlank() || replaceRegex.isEmpty()`），
    // 其余情况字段值就是空串。
    if (interpolated.length === 0 && rule.mode !== 'Js') value = rule.replacement !== undefined || state.expect === 'nodes'
      ? this.contentValue(content)
      : await this.evaluateDefault('', state, content)
    else if (template && (rule.mode === 'Default' || rule.mode === 'Json' || rule.mode === 'XPath')) value = interpolated
    else if (rule.mode === 'Default') value = await this.evaluateDefault(rule.body, state, content)
    else if (rule.mode === 'Json') value = await this.evaluateJson(rule.body, state, content)
    else if (rule.mode === 'XPath') value = this.evaluateXPath(rule.body, content, state.expect)
    else if (rule.mode === 'Regex') value = this.evaluateRegex(rule.body, content, state.source.bookSourceUrl)
    else if (rule.mode === 'Js') {
      const result = await this.runJavaScript(interpolated, this.javascriptStage(state.request.stage), state.source, content, state.request.signal, { ...state.request, bindings: state.bindings, ruleState: state, mode: 'script' })
      if (result.status !== 'success') throw new SourceRuleError(result.status === 'capability-missing' ? 'capability-missing' : result.status === 'cancelled' ? 'cancelled' : 'failed', result.message ?? 'JavaScript 规则执行失败')
      value = result.value
    } else throw new SourceRuleError('capability-missing', 'WebView 规则需要浏览器宿主')
    return this.applyReplacement(value, rule, state, content)
  }

  private async evaluateDefault(body: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const expanded = await this.interpolate(body, state, content)
    const stored = isNodeRef(content) ? this.nodes.get(content.id) : undefined
    if (expanded === '') {
      // Android 两条路径对空规则的处理不同：列表规则走 getStringList，`if (rule.isNotEmpty())` 不成立时
      // 沿用上一份内容；字段规则走 getString，最终落到 AnalyzeByJSoup.getString("")，结果是空。
      if (state.expect !== 'nodes') return stored === undefined ? '' : stored.document.read(stored.node, 'text')
      return stored === undefined ? textValue(content) : this.remember(stored.document, stored.node)
    }
    if (expanded === 'text' || expanded === 'ownText' || expanded === 'html') {
      if (stored === undefined) return textValue(content)
      return stored.document.read(stored.node, expanded)
    }
    // Legado 的节点字段规则允许直接写属性名，不要求 @ 前缀。
    // 节点字段规则的直接属性写法只接受 HTML 属性名中的单词、冒号和连字符。
    if (stored !== undefined && /^[\w:-]+$/u.test(expanded)) {
      const attribute = stored.document.attr(stored.node, expanded)
      if (attribute !== undefined) return attribute
    }
    if (expanded.startsWith('literal:')) return expanded.slice('literal:'.length)
    // 列表规则整条是选择器链；字段规则的末段是输出标记或属性名。
    const plan: DefaultPlan = state.expect === 'nodes' ? { selector: expanded } : lastOutput(expanded)
    const selectorParts = splitSelectorChain(plan.selector).map(normalizeSelector)
    if (selectorParts.length === 0) {
      // 没有选择器时按当前内容取值；属性名查询不落到整页文本上（Android 查的是根元素属性）。
      if (stored === undefined) return plan.attribute === undefined ? textValue(content) : ''
      if (plan.attribute !== undefined) return stored.document.attr(stored.node, plan.attribute) ?? ''
      if (plan.output === undefined) return this.remember(stored.document, stored.node)
      return stored.document.read(stored.node, plan.output)
    }
    let current: Array<{ document: HtmlDocument; node?: ParserNode }> = stored === undefined
      ? [{ document: this.html.parse(textValue(content)) }]
      : [{ document: stored.document, node: stored.node }]
    for (const selector of selectorParts) {
      const next: SelectedNode[] = []
      for (const root of current) {
        const view = root.node === undefined ? root.document : root.document.child(root.node)
        const textSelection = parseBracketSelection(selector) ?? parseLegacySelection(selector)
        const textSelector = textSelection?.base ?? selector
        if (textSelector.startsWith('text.')) {
          const expected = textSelector.slice('text.'.length)
          const matching = view.select('*').filter((node) => view.read(node, 'text').includes(expected))
          for (const node of applyPositionSelection(matching, textSelection)) next.push({ document: view, node })
        } else for (const node of selectWithPosition(view, selector)) next.push({ document: view, node })
      }
      current = next
    }
    const selected = current.filter((item): item is SelectedNode => item.node !== undefined)
    if (plan.attribute !== undefined) {
      // Android 跳过空属性并去重，避免空值参与拼接。
      const values: string[] = []
      for (const item of selected) {
        const value = item.document.attr(item.node, plan.attribute) ?? ''
        if (value.length > 0 && !values.includes(value)) values.push(value)
      }
      return values
    }
    if (plan.output === undefined) return selected.map((item) => this.remember(item.document, item.node))
    return selected.map((item) => item.document.read(item.node, plan.output!)).filter((value) => value.length > 0)
  }

  private async evaluateJson(expression: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const inlineRules = [...expression.matchAll(/\{(\$\.[^{}]+)\}/gu)]
    if (inlineRules.length > 0) {
      let expanded = expression
      for (const match of inlineRules.reverse()) {
        const value = await this.evaluateText(match[1]!, state, content)
        const start = match.index!
        expanded = `${expanded.slice(0, start)}${textValue(value)}${expanded.slice(start + match[0].length)}`
      }
      return expanded
    }
    const value = this.json.evaluate(jsonInput(content), expression)
    // Android 的确定路径直接返回数组本身，jsonpath-plus 的 wrap 会再包一层；
    // 不拆开会让 `data.books` 这类列表规则只拿到一个「数组项」。
    // 通配/递归/过滤路径的结果本身就是「元素列表」，数组元素是条目而不是外层包装，不能拆。
    return isDefiniteJsonPath(expression) && Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value
  }

  private evaluateXPath(expression: string, content: unknown, expect: WorkflowRuleRequest['expect']): unknown {
    const stored = isNodeRef(content) ? this.nodes.get(content.id) : undefined
    const document = stored === undefined ? this.xpath.parse(textValue(content)) : stored.document
    const context = stored === undefined ? document : document.child(stored.node)
    const value = this.xpath.evaluate(context, expression)
    if (Array.isArray(value) && value.every((item) => this.isParserNode(item))) {
      return expect === 'nodes'
        ? value.map((item) => this.remember(context, item as ParserNode))
        : value.map((item) => context.read(item as ParserNode, 'text'))
    }
    return value
  }

  private evaluateRegex(expression: string, content: unknown, sourceId: string): unknown {
    const text = textValue(content)
    const compiled = compileSourcePattern(expression, { flags: 'g' })
    if ('error' in compiled) throw new SourceRuleError('failed', `${compiled.error.message}：${expression.slice(0, 40)}`)
    return [...text.matchAll(compiled.regex)].map((match) => {
      const row = [match[0] ?? '', ...match.slice(1).map((item) => item ?? '')]
      this.captureRows.set(row, sourceId)
      return row
    })
  }

  /** 只在文本真的含模板时才插值，普通规则不额外扫描。 */
  private async expandTemplate(input: string, state: EvaluationState, content: unknown): Promise<string> {
    return input.includes('{{') || input.includes('@get:') ? await this.interpolate(input, state, content) : input
  }

  /** Android「规则为空则不改写上一个 result」：拿到的是进入本条规则时的内容。 */
  private contentValue(content: unknown): unknown {
    const stored = isNodeRef(content) ? this.nodes.get(content.id) : undefined
    return stored === undefined ? textValue(content) : this.remember(stored.document, stored.node)
  }

  private async interpolate(input: string, state: EvaluationState, content: unknown): Promise<string> {
    // 变量占位和双花括号求值遵循 Legado 插值语法；按倒序替换避免偏移量变化。
    let result = input.replace(/@get:\{([^{}]+)\}/g, (_match, name: string) => this.readVariable(name, state.bindings) ?? '')
    const matches = [...result.matchAll(/\{\{([\s\S]*?)\}\}/g)]
    for (const match of matches.reverse()) {
      const expression = match[1]!.trim()
      const value = await this.interpolateValue(expression, state, content)
      result = `${result.slice(0, match.index!)}${textValue(value)}${result.slice(match.index! + match[0].length)}`
    }
    return result
  }

  /**
   * Android `AnalyzeRule.makeUpRule`：表达式是规则形态（`@`/`$.`/`$[`/`//`）时按规则求值，
   * 否则当内联 JS 求值；两者失败都展开为空串（Android 的 evalJS 返回 null 就不插入内容）。
   */
  private async interpolateValue(expression: string, state: EvaluationState, content: unknown): Promise<unknown> {
    if (expression.startsWith('@') || expression.startsWith('$.') || expression.startsWith('$[') || expression.startsWith('//')) {
      try {
        return await this.evaluateText(expression, state, content)
      } catch (error) {
        if (error instanceof SourceRuleError && error.status === 'cancelled') throw error
        return undefined
      }
    }
    const variable = this.readVariable(expression, state.bindings)
    if (variable !== undefined) return variable
    const output = await this.runJavaScript(expression, this.javascriptStage(state.request.stage), state.source, content, state.request.signal, { ...state.request, bindings: state.bindings, ruleState: state, mode: 'script' })
    if (output.status === 'cancelled') throw new SourceRuleError('cancelled', output.message ?? '模板表达式求值已取消')
    return output.status === 'success' ? output.value : undefined
  }

  private async applyReplacement(value: unknown, rule: RuleAtom, state: EvaluationState, content: unknown): Promise<unknown> {
    if (rule.replacement === undefined) return value
    // Android 先对整条规则插值再按 `##` 切分，所以匹配串和替换串里的 {{}} 同样生效。
    const patternText = await this.expandTemplate(rule.replacement.pattern, state, content)
    const replacement = await this.expandTemplate(rule.replacement.replacement, state, content)
    const text = textValue(value)
    // 源可控正则过长度上限或（对超长输入）命中嵌套量词时明确失败，不让病态配置拖垮求值。
    const compiled = compileSourcePattern(patternText, { flags: 'g' })
    if ('error' in compiled) {
      if (compiled.error.code === 'invalid-pattern') {
        return rule.replacement.firstMatchOnly ? replacement : text.split(patternText).join(replacement)
      }
      throw new SourceRuleError('failed', `${compiled.error.message}：${patternText.slice(0, 40)}`)
    }
    if (!rule.replacement.firstMatchOnly) return text.replace(compiled.regex, replacement)
    const first = compiled.regex.exec(text)
    if (first === null) return ''
    const firstPattern = new RegExp(compiled.regex.source, compiled.regex.flags.replace(/g/u, ''))
    return first[0].replace(firstPattern, replacement)
  }

  private async runJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown, signal?: AbortSignal, context?: { baseUrl?: string; redirectUrl?: string; content?: unknown; bindings?: Readonly<Record<string, unknown>>; ruleState?: EvaluationState; mode?: 'script' | 'function-body'; captureBindings?: readonly string[]; captureGlobals?: boolean; globalState?: Readonly<Record<string, unknown>> }): Promise<WorkflowRuleOutput> {
    const bindings: Readonly<Record<string, unknown>> = {
      ...this.bindings,
      ...(context?.bindings ?? {}),
      ...(context?.globalState === undefined ? {} : { __legadoWorkflowGlobalState: context.globalState }),
      result: content,
      src: context?.content ?? content,
      sourceKey: source.bookSourceUrl,
      sourceName: source.bookSourceName,
      sourceData: source,
      baseUrl: context?.baseUrl ?? source.bookSourceUrl,
      redirectUrl: context?.redirectUrl ?? context?.baseUrl ?? source.bookSourceUrl,
    }
    const prelude = [
      'globalThis.result = bindings.result;',
      'for (const [name, value] of Object.entries(bindings.__legadoWorkflowGlobalState ?? {})) { try { Object.defineProperty(globalThis, name, { value: __legadoDecode(JSON.parse(__legadoEncode(value))), writable: true, enumerable: true, configurable: true }); } catch {} }',
      'if (bindings.__strResponse != null) { const responseValue = bindings.__strResponse; globalThis.result = { ...responseValue, __body: responseValue.body, __code: responseValue.status ?? responseValue.code, __url: responseValue.url, __message: responseValue.message, __headers: responseValue.headers }; Object.defineProperties(globalThis.result, { body: { value: () => globalThis.result.__body }, code: { value: () => globalThis.result.__code }, url: { value: () => globalThis.result.__url }, message: { value: () => globalThis.result.__message }, headers: { value: () => globalThis.result.__headers }, isSuccessful: { value: () => globalThis.result.__code >= 200 && globalThis.result.__code < 300 } }); }',
      'globalThis.src = bindings.src;',
      'globalThis.key = bindings.key;',
      'globalThis.page = bindings.page;',
      'globalThis.url = bindings.url;',
      'globalThis.nextChapterUrl = bindings.nextChapterUrl;',
      'globalThis.chapters = bindings.chapters;',
      'globalThis.index = bindings.index;',
      'globalThis.title = bindings.title;',
      'globalThis.gInt = bindings.gInt;',
      'globalThis.fromBookInfo = bindings.fromBookInfo ?? bindings.isFromBookInfo;',
      'globalThis.isFromBookInfo = globalThis.fromBookInfo;',
      'const refreshTocUrl = () => { throw new Error("__LEGADO_CAPABILITY__runtime refreshTocUrl unavailable") };',
      'const reGetBook = () => { throw new Error("__LEGADO_CAPABILITY__runtime reGetBook unavailable") };',
      'globalThis.baseUrl = bindings.baseUrl;',
      'globalThis.redirectUrl = bindings.redirectUrl;',
      'const sourceValue = bindings.sourceData ?? {};',
      'globalThis.source = { ...sourceValue, key: bindings.sourceKey }; Object.defineProperties(globalThis.source, { getKey: { value: () => bindings.sourceKey }, get: { value: (name) => getVar(String(name), "source") ?? "" }, put: { value: (name, value) => { setVar(String(name), value, "source"); return value; } }, getVariable: { value: () => getVar("__source__", "source") ?? "" }, setVariable: { value: (value) => setVar("__source__", value, "source") }, putVariable: { value: (value) => setVar("__source__", value, "source") }, putConcurrent: { value: (value) => { if (typeof __legadoSetConcurrentRate !== "function") throw new Error("__LEGADO_CAPABILITY__runtime source.putConcurrent unavailable"); return __legadoSetConcurrentRate(String(value)); } } });',
      'globalThis.sourceApi = sourceValue;',
      'const bookValue = bindings.book ?? {};',
      'globalThis.book = { ...bookValue }; Object.defineProperties(globalThis.book, { getVariable: { value: (name) => getVar(String(name), "book") ?? "" }, putVariable: { value: (name, value) => { setVar(String(name), value, "book"); return true; } } });',
      'globalThis.chapter = { ...(bindings.chapter ?? {}) }; Object.defineProperties(globalThis.chapter, { getVariable: { value: (name) => getVar(String(name), "chapter") ?? "" }, putVariable: { value: (name, value) => { setVar(String(name), value, "chapter"); return true; } } });',
      'const getVariable = (name) => getVar(String(name));',
      'const putVariable = (name, value) => setVar(String(name), value);',
      // Android CookieStore 的 set/remove 返回 Unit，`{{cookie.removeCookie(...)}}` 必须展开为空串而不是 "true"。
      'const cookie = { getCookie: (url) => request({ kind: "cookie-get", url: String(url) }), setCookie: (url, value) => { request({ kind: "cookie-set", url: String(url), value: String(value) }); }, removeCookie: (url) => { request({ kind: "cookie-remove", url: String(url) }); } };',
      // 正文常常是 JSON 文本，`java.getString("$.x")` 必须能在这上面取路径（Android 会先解析内容）。
      'const legadoPathValue = (value, path) => { if (typeof value === "string") { try { value = JSON.parse(value); } catch (error) { value = undefined; } } const parts = String(path).replace(/^\\$\\.?\\.?/, "").match(/[A-Za-z_$][\\w$-]*|\\[\\d+\\]|\\[\\*\\]/g) ?? []; let current = value; for (const part of parts) { if (part === "[*]") current = Array.isArray(current) ? current : []; else if (Array.isArray(current)) current = current.map((item) => item == null ? undefined : item[part.startsWith("[") ? Number(part.slice(1, -1)) : part]); else current = current == null ? undefined : current[part]; } return current; };',
      'const legadoGetString = (name) => { const key = String(name); const value = key.startsWith("$") ? legadoPathValue(result, key) : result != null && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : getVar(key); return Array.isArray(value) ? value.map((item) => String(item ?? "")).join("\\n") : String(value ?? ""); };',
      'const java = { ajax: (value, method, body) => value != null && typeof value === "object" ? request(Object.assign({ kind: "network" }, value)) : method != null && typeof method === "object" ? request(Object.assign({ kind: "network", url: String(value) }, method)) : request({ kind: "network", url: String(value), method: method ?? "GET", body }), get: (value, options) => options !== undefined || /^(?:https?:)?\\/\\//.test(String(value)) ? request({ kind: "network", url: String(value), method: "GET", options }) : Object.prototype.hasOwnProperty.call(bindings, String(value)) ? bindings[String(value)] : getVar(String(value)), put: (name, value) => { setVar(String(name), value); return value; }, getString: (name) => { const key = String(name); return Object.prototype.hasOwnProperty.call(bindings, key) ? String(bindings[key] ?? "") : legadoGetString(name); }, getStringList: (name) => legadoGetString(name).split("\\n").filter(Boolean), getWebViewUA: () => request({ kind: "runtime-capability", capability: "getWebViewUA" }), base64Encode: (value) => request({ kind: "base64-encode", value }), base64Decode: (value) => request({ kind: "base64-decode-text", value }), base64DecodeToString: (value) => request({ kind: "base64-decode-text", value }), hexDecodeToString: (value) => request({ kind: "hex-decode-text", value }), md5Encode: (value) => request({ kind: "md5", value }), digestHex: (value, algorithm) => request({ kind: "digest", value, transformation: algorithm }), encodeURI: (value) => encodeURI(String(value)), decodeURI: (value) => decodeURI(String(value)), aesBase64DecodeToString: (value, key, transformation, iv) => request({ kind: "aes-decode-text", value, key, transformation, iv }), replaceFont: (text, errorBase64, correctBase64, filter) => request({ kind: "font-replace", text, errorBase64, correctBase64, filter }), toast: () => undefined, longToast: () => undefined, log: () => undefined, timeFormat: (value) => String(value), timeFormatUTC: (value) => String(value), randomUUID: () => "", getAppVariant: () => "", androidId: () => "", deviceID: () => "" };',
      'const legadoString = (value) => Array.isArray(value) ? value.map((item) => String(item ?? "")).join("\\n") : String(value ?? "");',
      'const legadoCookie = (url, key) => { const cookieText = String(request({ kind: "cookie-get", url: String(url) }) ?? ""); if (key === undefined || key === null) return cookieText; for (const part of cookieText.split(";")) { const index = part.indexOf("="); if (index >= 0 && part.slice(0, index).trim() === String(key)) return part.slice(index + 1).trim(); } return ""; };',
      'java.getString = (rule) => legadoString(evaluateRule(String(rule), { expect: "text", content: result }));',
      'java.getStringList = (rule) => { const value = evaluateRule(String(rule), { expect: "text", content: result }); return Array.isArray(value) ? value.map((item) => String(item ?? "")).filter(Boolean) : String(value ?? "").split("\\n").filter(Boolean); };',
      'java.getCookie = (url, key) => legadoCookie(url, key);',
      'java.timeFormat = (time) => request({ kind: "time-format", time: Number(time) });',
      'java.timeFormatUTC = (time, format, offsetMs) => request({ kind: "time-format-utc", time: Number(time), format: String(format), offsetMs: Number(offsetMs) });',
      'java.randomUUID = () => request({ kind: "random-uuid" });',
      'java.getAppVariant = () => request({ kind: "runtime-capability", capability: "getAppVariant" });',
      'java.androidId = () => request({ kind: "runtime-capability", capability: "androidId" });',
      'java.deviceID = () => request({ kind: "runtime-capability", capability: "deviceID" });',
      'globalThis.cache = { get: (key) => request({ kind: "cache-get", key: String(key) }), put: (key, value, saveTime) => request({ kind: "cache-put", key: String(key), value: String(value), saveTime: Number(saveTime ?? 0) }), delete: (key) => request({ kind: "cache-delete", key: String(key) }), getFromMemory: (key) => request({ kind: "cache-memory-get", key: String(key) }), putMemory: (key, value) => request({ kind: "cache-memory-put", key: String(key), value: String(value) }), deleteMemory: (key) => request({ kind: "cache-memory-delete", key: String(key) }), getFile: (key) => request({ kind: "cache-file-get", key: String(key) }), putFile: (key, value, saveTime) => request({ kind: "cache-file-put", key: String(key), value: String(value), saveTime: Number(saveTime ?? 0) }) };',
      'const getToken = () => request({ kind: "token" });',
      'globalThis.Packages = globalThis.Packages ?? {};',
      'globalThis.Packages.io = globalThis.Packages.io ?? {};',
      'globalThis.Packages.io.legado = globalThis.Packages.io.legado ?? {};',
      'globalThis.Packages.io.legado.app = globalThis.Packages.io.legado.app ?? {};',
      'globalThis.Packages.io.legado.app.help = globalThis.Packages.io.legado.app.help ?? {};',
      'globalThis.Packages.io.legado.app.help.http = globalThis.Packages.io.legado.app.help.http ?? {};',
      'globalThis.Packages.io.legado.app.help.http.StrResponse = (url, body) => ({ url: String(url), status: 200, code: 200, headers: {}, body: String(body ?? "") });',
      'const checkEnv = () => "default";',
      'const isVs = () => false;',
    ].join('\n')
    const ruleState = context?.ruleState ?? this.createJavaScriptRuleState(source, stage, content, bindings, signal)
    const runSignal = signal ?? new AbortController().signal
    try {
      const libraries = await this.loadSourceLibraries(source, runSignal)
      const executable = `${prelude}\n${libraries.join('\n')}\n${code}`
      const initialCaptureVariables: Record<string, string | undefined> = {}
      for (const name of context?.captureBindings ?? []) {
        const entity = bindings[name]
        initialCaptureVariables[name] = typeof entity === 'object' && entity !== null && typeof (entity as RuleEntity).variable === 'string'
          ? (entity as RuleEntity).variable as string
          : undefined
      }
      const output = await this.javascript.execute({
        code: executable,
        mode: context?.mode ?? 'script',
        stage,
        bindings,
        ...(context?.captureBindings === undefined ? {} : { captureBindings: context.captureBindings }),
        ...(context?.captureGlobals === true ? { captureGlobals: true } : {}),
        ...(signal === undefined ? {} : { signal }),
      }, {
        getVariable: async (name, _bridgeSignal, scope) => {
          if (scope !== undefined && !isVariableScope(scope)) throw new Error('书源变量作用域无效')
          return this.readVariable(name, bindings, scope)
        },
        setVariable: async (name, value, _bridgeSignal, scope) => {
          if (scope !== undefined && !isVariableScope(scope)) throw new Error('书源变量作用域无效')
          this.writeVariable(name, value, bindings, scope)
        },
        ...(this.setConcurrentRate === undefined ? {} : { setConcurrentRate: this.setConcurrentRate }),
        request: (payload, bridgeSignal) => this.handleBridge(payload, bridgeSignal, source),
        evaluateRule: (rule, bridgeSignal, options) => this.nestedRule(rule, ruleState, options?.content ?? content, options?.expect ?? 'text', bridgeSignal),
      })
      return {
        status: output.status === 'budget-exceeded' ? 'failed' : output.status,
        value: mergeCapturedEntityVariables(output.value, context?.captureBindings, bindings, initialCaptureVariables),
        ...(output.diagnostics[0] === undefined ? {} : { message: output.diagnostics[0].message }),
      }
    } catch (error) {
      if (error instanceof SourceRuleError) return { status: error.status, value: null, message: error.message }
      if (signal?.aborted === true) return { status: 'cancelled', value: null, message: 'JavaScript 宿主准备已取消' }
      return { status: 'failed', value: null, message: error instanceof Error ? error.message : 'JavaScript 宿主准备失败' }
    }
  }

  private createJavaScriptRuleState(source: NormalizedSource, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', content: unknown, bindings: Readonly<Record<string, unknown>>, signal?: AbortSignal): EvaluationState {
    const workflowStage: WorkflowRuleRequest['stage'] = stage === 'search' || stage === 'mainJs' ? 'search' : 'detail'
    const request: WorkflowRuleRequest = {
      source,
      stage: workflowStage,
      field: 'javascript',
      rule: '',
      content,
      expect: 'text',
      bindings,
      ...(signal === undefined ? {} : { signal }),
    }
    return { request, source, content, bindings, budget: { steps: 0, depth: 0 }, expect: 'text' }
  }

  private async loadSourceLibraries(source: NormalizedSource, signal: AbortSignal): Promise<string[]> {
    const value = source.jsLib
    if (typeof value !== 'string' || value.trim().length === 0) return []
    let remoteUrls: string[] | undefined
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        remoteUrls = Object.values(parsed).map((item) => {
          if (item === null || item === undefined) return ''
          return typeof item === 'object' ? JSON.stringify(item) ?? '' : String(item)
        })
      }
    } catch {
      return [value]
    }
    if (remoteUrls === undefined) return [value]
    const scripts: string[] = []
    const fingerprint = sourceDefinitionFingerprint(source)
    for (const remoteUrl of remoteUrls) {
      let url: URL
      try {
        url = new URL(remoteUrl)
      } catch {
        continue
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      const cacheKey = `jsLib:${fingerprint}:${url.toString()}`
      let script = await this.cache.get(cacheKey, signal)
      if (script === undefined) {
        if (this.requestBridge === undefined) throw new SourceRuleError('capability-missing', '加载 jsLib 需要网络宿主')
        const response = await this.requestBridge({ kind: 'network', url: url.toString() }, signal, source)
        if (typeof response !== 'string') throw new SourceRuleError('failed', 'jsLib 网络响应不是文本')
        script = response
        await this.cache.put(cacheKey, script, 0, signal)
      }
      scripts.push(script)
    }
    return scripts
  }

  private async handleBridge(input: unknown, signal: AbortSignal, source: NormalizedSource): Promise<unknown> {
    if (typeof input !== 'object' || input === null) throw new Error('书源 bridge 请求必须是对象')
    const request = input as SourceRuleBridgeRequest
    if (request.kind === 'base64-encode') return this.encoding.base64Encode(textValue(request.value))
    if (request.kind === 'base64-decode-text') return new TextDecoder().decode(this.encoding.base64Decode(textValue(request.value)))
    if (request.kind === 'hex-decode-text') return new TextDecoder().decode(this.encoding.hexDecode(textValue(request.value)))
    if (request.kind === 'md5') return this.crypto.digestHex(textValue(request.value), 'md5')
    if (request.kind === 'digest') return this.crypto.digestHex(textValue(request.value), (textValue(request.transformation) || 'sha256') as 'md5' | 'sha1' | 'sha256' | 'sha512')
    if (request.kind === 'aes-decode-text') {
      const key = this.encoding.encode(textValue(request.key), 'utf-8')
      const iv = this.encoding.encode(textValue(request.iv), 'utf-8')
      return this.crypto.createSymmetricCrypto(textValue(request.transformation), key, iv).decryptText(this.encoding.base64Decode(textValue(request.value)))
    }
    if (request.kind === 'font-replace') {
      const error = this.font.queryBase64TTF(textValue(request.errorBase64), { signal })
      const correct = this.font.queryBase64TTF(textValue(request.correctBase64), { signal })
      return replaceFont(textValue(request.text), error, correct, request.filter === true)
    }
    if (request.kind === 'cache-get') return this.cache.get(textValue(request.key), signal)
    if (request.kind === 'cache-put') return this.cache.put(textValue(request.key), textValue(request.value), Number(request.saveTime) || 0, signal)
    if (request.kind === 'cache-delete') return this.cache.delete(textValue(request.key), signal)
    if (request.kind === 'cache-memory-get') return this.cache.getFromMemory(textValue(request.key))
    if (request.kind === 'cache-memory-put') return this.cache.putMemory(textValue(request.key), textValue(request.value), signal)
    if (request.kind === 'cache-memory-delete') return this.cache.deleteMemory(textValue(request.key), signal)
    if (request.kind === 'cache-file-get') return this.cache.getFile(textValue(request.key))
    if (request.kind === 'cache-file-put') return this.cache.putFile(textValue(request.key), textValue(request.value), Number(request.saveTime) || 0, signal)
    if (request.kind === 'time-format') {
      if (this.timeFormat === undefined) throw new Error('__LEGADO_CAPABILITY__runtime timeFormat unavailable')
      return this.timeFormat(Number(request.time))
    }
    if (request.kind === 'time-format-utc') {
      if (this.timeFormatUTC === undefined) throw new Error('__LEGADO_CAPABILITY__runtime timeFormatUTC unavailable')
      return this.timeFormatUTC(Number(request.time), textValue(request.format), Number(request.offsetMs))
    }
    if (request.kind === 'random-uuid') {
      if (this.randomUUID === undefined) throw new Error('__LEGADO_CAPABILITY__runtime randomUUID unavailable')
      return this.randomUUID()
    }
    if (request.kind === 'runtime-capability') throw new Error(`__LEGADO_CAPABILITY__runtime ${textValue(request.capability)} unavailable`)
    if (this.requestBridge === undefined) throw new Error('__LEGADO_CAPABILITY__network 书源网络或宿主 bridge 不可用')
    return this.requestBridge(request, signal, source)
  }

  private remember(document: HtmlDocument, node: ParserNode): NodeRef {
    const id = `node-${this.nextNodeId++}`
    this.nodes.set(id, { document, node })
    return { __legadoNode: 'source-rule-node', id }
  }

  private toList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [value]
  }

  private isParserNode(value: unknown): value is ParserNode {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string' && typeof (value as { kind?: unknown }).kind === 'string'
  }

  private javascriptStage(stage: WorkflowRuleRequest['stage']): 'mainJs' | 'book' | 'chapter' | 'search' | 'content' {
    return stage === 'search' ? 'search' : stage === 'detail' ? 'book' : 'content'
  }

  private check(state: EvaluationState): void {
    if (state.request.signal?.aborted === true) throw new SourceRuleError('cancelled', '规则求值已取消')
    state.budget.steps += 1
    if (state.budget.steps > this.maxSteps) throw new SourceRuleError('failed', '规则求值步数超过限制')
  }
}
