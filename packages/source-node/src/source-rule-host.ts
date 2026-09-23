import {
  compileRule,
  compileSourcePattern,
  MemoryVariableView,
} from '@legado/source-core'
import type {
  CompiledRule,
  HtmlDocument,
  NormalizedSource,
  ParserNode,
  RuleAtom,
  RuleSequence,
  WorkflowRulePort,
  WorkflowRuleRequest,
  WorkflowRuleOutput,
} from '@legado/source-core'
import { NodeCryptoHost } from './crypto.ts'
import { NodeEncodingHost } from './encoding.ts'
import { NodeFontHost } from './font.ts'
import { HtmlParserAdapter } from './html.ts'
import { QuickJSJavaScriptHost } from './javascript.ts'
import { JsonPathParserAdapter } from './jsonpath.ts'
import { XPathParserAdapter } from './xpath.ts'

export interface SourceRuleBridgeRequest {
  kind: string
  url?: string
  method?: string
  body?: unknown
  options?: unknown
  headers?: Readonly<Record<string, string>>
  value?: unknown
  text?: unknown
  errorBase64?: unknown
  correctBase64?: unknown
  filter?: unknown
  key?: unknown
  iv?: unknown
  transformation?: unknown
  expression?: unknown
  name?: string
  scope?: string
}

export interface SourceRuleHostOptions {
  /** bridge 处理器；第三个参数是本次求值的书源，URL 展开等求值发生在首次请求之前。 */
  request?: (input: SourceRuleBridgeRequest, signal: AbortSignal, source?: NormalizedSource) => Promise<unknown>
  encoding?: NodeEncodingHost
  crypto?: NodeCryptoHost
  font?: NodeFontHost
  initialVariables?: Readonly<Record<string, string>>
  maxSteps?: number
}

interface EvaluationState {
  readonly request: WorkflowRuleRequest
  readonly source: NormalizedSource
  readonly content: unknown
  steps: number
  depth: number
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

function jsonInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
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

function selectWithPosition(document: HtmlDocument, selector: string): ParserNode[] {
  const slice = /^(.*)\.(-?\d+):(-?\d+)(?::(-?\d+))?$/.exec(selector)
  const index = /^(.*)\.(-?\d+)$/.exec(selector)
  const base = slice?.[1] ?? index?.[1] ?? selector
  const nodes = document.select(base.length === 0 ? '*' : base)
  if (slice !== null) {
    const start = Number(slice[2])
    const end = Number(slice[3])
    const step = slice[4] === undefined ? 1 : Number(slice[4])
    if (step === 0) return []
    const from = start < 0 ? Math.max(0, nodes.length + start) : Math.min(nodes.length, start)
    const to = end < 0 ? Math.max(0, nodes.length + end) : Math.min(nodes.length, end)
    const result: ParserNode[] = []
    if (step > 0) for (let position = from; position < to; position += step) result.push(nodes[position]!)
    else for (let position = Math.min(nodes.length - 1, from); position > to; position += step) result.push(nodes[position]!)
    return result
  }
  if (index !== null) {
    const position = Number(index[2])
    const normalized = position < 0 ? nodes.length + position : position
    return normalized >= 0 && normalized < nodes.length ? [nodes[normalized]!] : []
  }
  return nodes
}

function sourceScript(rule: string): { code: string; tail?: string } | undefined {
  const trimmed = rule.trim()
  if (trimmed.startsWith('<js>')) {
    const end = trimmed.indexOf('</js>')
    if (end < 0) return { code: trimmed.slice('<js>'.length) }
    const tail = trimmed.slice(end + '</js>'.length).trim()
    return { code: trimmed.slice('<js>'.length, end), ...(tail.length > 0 ? { tail } : {}) }
  }
  if (trimmed.toLowerCase().startsWith('@js:')) return { code: trimmed.slice(4).trim() }
  return undefined
}

function trailingExpression(code: string): { body: string; expression?: string } {
  const input = code.trim().replace(/;$/, '').trim()
  let start = 0
  let quote: string | undefined
  let escaped = false
  let depth = 0
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === '(' || current === '[' || current === '{') depth += 1
    else if (current === ')' || current === ']' || current === '}') depth = Math.max(0, depth - 1)
    else if (current === ';' && depth === 0) start = index + 1
  }
  const last = input.slice(start).trim()
  if (last.length === 0 || last === '}' || last.startsWith('//')) return { body: input }
  if (/^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[[^\n]+\]))*(?:\([^;\n]*\))?$/.test(last) || last.startsWith('`') || last.startsWith('"') || last.startsWith("'")) {
    return { body: input.slice(0, start).trim(), expression: last }
  }
  return { body: input }
}

export class SourceRuleHost implements WorkflowRulePort {
  private readonly variables: MemoryVariableView
  private readonly html = new HtmlParserAdapter()
  private readonly json = new JsonPathParserAdapter()
  private readonly xpath = new XPathParserAdapter()
  private readonly javascript: QuickJSJavaScriptHost
  private readonly encoding: NodeEncodingHost
  private readonly crypto: NodeCryptoHost
  private readonly font: NodeFontHost
  private readonly requestBridge?: SourceRuleHostOptions['request']
  private readonly maxSteps: number
  private readonly nodes = new Map<string, StoredNode>()
  private bindings: Readonly<Record<string, unknown>> = {}
  private nextNodeId = 0

  public constructor(options: SourceRuleHostOptions = {}) {
    this.variables = new MemoryVariableView({ availableScopes: ['chapter', 'book', 'rule-data', 'source'], initial: { source: options.initialVariables ?? {} } })
    this.encoding = options.encoding ?? new NodeEncodingHost()
    this.crypto = options.crypto ?? new NodeCryptoHost(this.encoding)
    this.font = options.font ?? new NodeFontHost({ encoding: this.encoding })
    this.requestBridge = options.request
    this.maxSteps = options.maxSteps ?? 10000
    this.javascript = new QuickJSJavaScriptHost({
      getVariable: async (name) => this.variables.get(name),
      setVariable: async (name, value) => this.variables.set(name, value === null ? null : textValue(value)),
    })
  }

  public setBindings(bindings: Readonly<Record<string, unknown>>): void {
    this.bindings = { ...bindings }
  }

  public setVariable(name: string, value: string | null): void {
    this.variables.set(name, value)
  }

  public async executeJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown = '', signal?: AbortSignal): Promise<WorkflowRuleOutput> {
    return this.runJavaScript(code, stage, source, content, signal)
  }

  public async evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput> {
    if (request.signal?.aborted === true) return { status: 'cancelled', value: null, message: '规则求值已取消' }
    const state: EvaluationState = { request, source: request.source, content: request.content, steps: 0, depth: 0 }
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
    const script = sourceScript(rule)
    if (script !== undefined) {
      const output = await this.runJavaScript(await this.expandTemplate(script.code, state, content), this.javascriptStage(state.request.stage), state.source, content, state.request.signal, state.request)
      if (output.status !== 'success') throw new SourceRuleError(output.status === 'capability-missing' ? 'capability-missing' : output.status === 'cancelled' ? 'cancelled' : 'failed', output.message ?? 'JavaScript 规则执行失败')
      return script.tail === undefined ? output.value : this.evaluateText(script.tail, state, output.value)
    }
    // A common Legado form is a selector followed by a JavaScript transform,
    // for example `$.path@js:...` or `tag.a@href@js:...`.  The core compiler
    // deliberately keeps this syntax opaque, so the host must split it before
    // compiling the selector part.
    const jsIndex = rule.indexOf('@js:')
    if (jsIndex > 0) {
      const selectorRule = rule.slice(0, jsIndex).trim()
      const code = rule.slice(jsIndex + '@js:'.length).trim()
      if (selectorRule.length > 0 && code.length > 0) {
        const selected = await this.evaluateText(selectorRule, state, content)
        const output = await this.runJavaScript(code, this.javascriptStage(state.request.stage), state.source, selected, state.request.signal, state.request)
        if (output.status !== 'success') throw new SourceRuleError(output.status === 'capability-missing' ? 'capability-missing' : output.status === 'cancelled' ? 'cancelled' : 'failed', output.message ?? 'JavaScript 规则执行失败')
        return output.value
      }
    }
    const compiled = compileRule(rule, { defaultMode: jsonContent(content) ? 'Json' : 'Default' })
    if (compiled.rule === undefined) throw new SourceRuleError('failed', compiled.diagnostics[0]?.message ?? '规则编译失败')
    return this.evaluateNode(compiled.rule, state, content)
  }

  private async evaluateNode(rule: CompiledRule, state: EvaluationState, content: unknown): Promise<unknown> {
    this.check(state)
    state.depth += 1
    if (state.depth > 64) throw new SourceRuleError('failed', '规则嵌套超过限制')
    try {
      if (rule.kind === 'atom') return this.evaluateAtom(rule, state, content)
      return this.evaluateSequence(rule, state, content)
    } finally {
      state.depth -= 1
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
      const result: unknown[] = []
      const length = values[0]?.length ?? 0
      for (let index = 0; index < length; index += 1) for (const value of values) if (index < value.length && nonEmpty(value[index])) result.push(value[index])
      return result
    }
    const values = (await Promise.all(rule.children.map((child) => this.evaluateNode(child, state, content)))).filter(nonEmpty)
    if (values.length === 0) return null
    if (values.some(Array.isArray)) return values.flatMap((value) => this.toList(value))
    return values.map(textValue).join('\n')
  }

  private async evaluateAtom(rule: RuleAtom, state: EvaluationState, content: unknown): Promise<unknown> {
    for (const put of rule.puts) this.variables.set(put.name, textValue(await this.evaluateNode(put.rule, state, content)))
    const template = rule.body.includes('{{') || rule.body.includes('@get:')
    const interpolated = template ? await this.interpolate(rule.body, state, content) : rule.body
    let value: unknown
    // Android AnalyzeRule：规则体含 `{{}}`/`@get:{}` 时切到 Regex 模式，结果是插值后的文本本身，
    // 不再按 Default/Json/XPath 解析（AnalyzeRule.kt:702-713）；Js 模式例外，它先插值再执行。
    // 插值后为空时 Android 的 `if (rule.isNotEmpty())` 不成立，result 保持分析前的整页内容。
    // 空规则串（例如只剩 `@put:{...}`）在 Android 里连模式分支都不进，直接沿用上一份内容。
    if (interpolated.length === 0 && rule.mode !== 'Js') value = await this.evaluateDefault('', state, content)
    else if (template && (rule.mode === 'Default' || rule.mode === 'Json' || rule.mode === 'XPath')) value = interpolated
    else if (rule.mode === 'Default') value = await this.evaluateDefault(rule.body, state, content)
    else if (rule.mode === 'Json') value = this.evaluateJson(rule.body, content)
    else if (rule.mode === 'XPath') value = this.evaluateXPath(rule.body, content)
    else if (rule.mode === 'Regex') value = this.evaluateRegex(rule.body, content)
    else if (rule.mode === 'Js') {
      const result = await this.runJavaScript(interpolated, this.javascriptStage(state.request.stage), state.source, content, state.request.signal, state.request)
      if (result.status !== 'success') throw new SourceRuleError(result.status === 'capability-missing' ? 'capability-missing' : result.status === 'cancelled' ? 'cancelled' : 'failed', result.message ?? 'JavaScript 规则执行失败')
      value = result.value
    } else throw new SourceRuleError('capability-missing', 'WebView 规则需要浏览器宿主')
    return this.applyReplacement(value, rule, state, content)
  }

  private async evaluateDefault(body: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const expanded = await this.interpolate(body, state, content)
    const stored = isNodeRef(content) ? this.nodes.get(content.id) : undefined
    if (expanded === '' || expanded === 'text' || expanded === 'ownText' || expanded === 'html') {
      if (stored === undefined) return textValue(content)
      return stored.document.read(stored.node, expanded === '' ? 'text' : expanded as 'text' | 'ownText' | 'html')
    }
    // Legado 的节点字段规则允许直接写属性名，不要求 @ 前缀。
    if (stored !== undefined && /^[\w:-]+$/u.test(expanded)) {
      const attribute = stored.document.attr(stored.node, expanded)
      if (attribute !== undefined) return attribute
    }
    if (expanded.startsWith('literal:')) return expanded.slice('literal:'.length)
    // 列表规则整条是选择器链；字段规则的末段是输出标记或属性名。
    const plan: DefaultPlan = state.request.expect === 'nodes' ? { selector: expanded } : lastOutput(expanded)
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
        if (selector.startsWith('text.')) {
          const expected = selector.slice('text.'.length)
          for (const node of view.select('*')) if (view.read(node, 'text').includes(expected)) next.push({ document: view, node })
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

  private evaluateJson(expression: string, content: unknown): unknown {
    const value = this.json.evaluate(jsonInput(content), expression)
    // Android 的确定路径直接返回数组本身，jsonpath-plus 的 wrap 会再包一层；
    // 不拆开会让 `data.books` 这类列表规则只拿到一个「数组项」。
    // 通配/递归/过滤路径的结果本身就是「元素列表」，数组元素是条目而不是外层包装，不能拆。
    return isDefiniteJsonPath(expression) && Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value
  }

  private evaluateXPath(expression: string, content: unknown): unknown {
    const document = this.xpath.parse(textValue(content))
    const value = this.xpath.evaluate(document, expression)
    if (Array.isArray(value) && value.every((item) => this.isParserNode(item))) return value.map((item) => document.read(item as ParserNode, 'text'))
    return value
  }

  private evaluateRegex(expression: string, content: unknown): unknown {
    const text = textValue(content)
    const compiled = compileSourcePattern(expression, { flags: 'g', complexity: 'reject-large-input', inputLength: text.length })
    if ('error' in compiled) throw new SourceRuleError('failed', `${compiled.error.message}：${expression.slice(0, 40)}`)
    return [...text.matchAll(compiled.regex)].map((match) => [match[0] ?? '', ...match.slice(1).map((item) => item ?? '')])
  }

  /** 只在文本真的含模板时才插值，普通规则不额外扫描。 */
  private async expandTemplate(input: string, state: EvaluationState, content: unknown): Promise<string> {
    return input.includes('{{') || input.includes('@get:') ? await this.interpolate(input, state, content) : input
  }

  private async interpolate(input: string, state: EvaluationState, content: unknown): Promise<string> {
    let result = input.replace(/@get:\{([^{}]+)\}/g, (_match, name: string) => this.variables.get(name) ?? '')
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
    const variable = this.variables.get(expression)
    if (variable !== undefined) return variable
    const output = await this.runJavaScript(expression, this.javascriptStage(state.request.stage), state.source, content, state.request.signal, state.request)
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
    const compiled = compileSourcePattern(patternText, { flags: 'g', complexity: 'reject-large-input', inputLength: text.length })
    if ('error' in compiled) throw new SourceRuleError('failed', `${compiled.error.message}：${patternText.slice(0, 40)}`)
    if (!rule.replacement.firstMatchOnly) return text.replace(compiled.regex, replacement)
    const first = compiled.regex.exec(text)
    return first === null ? '' : first[0].replace(compiled.regex, replacement)
  }

  private async runJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown, signal?: AbortSignal, context?: Pick<WorkflowRuleRequest, 'baseUrl' | 'redirectUrl' | 'content' | 'bindings'>): Promise<WorkflowRuleOutput> {
    const bindings = {
      ...this.bindings,
      ...(context?.bindings ?? {}),
      result: content,
      src: context?.content ?? content,
      sourceKey: source.bookSourceUrl,
      sourceName: source.bookSourceName,
      baseUrl: context?.baseUrl ?? source.bookSourceUrl,
      redirectUrl: context?.redirectUrl ?? context?.baseUrl ?? source.bookSourceUrl,
    }
    const prelude = [
      'globalThis.result = bindings.result;',
      'globalThis.src = bindings.src;',
      'globalThis.key = bindings.key;',
      'globalThis.page = bindings.page;',
      'globalThis.baseUrl = bindings.baseUrl;',
      'globalThis.redirectUrl = bindings.redirectUrl;',
      'globalThis.source = { getKey: () => bindings.sourceKey, key: bindings.sourceKey, getVariable: (name) => name === undefined ? getVar("__source__") : getVar(String(name)), setVariable: (name, value) => value === undefined ? setVar("__source__", name) : setVar(String(name), value) };',
      'const bookValue = bindings.book ?? {};',
      'globalThis.book = { ...bookValue, getVariable: (name) => name === undefined ? getVar("__book__") : getVar(String(name)), setVariable: (name, value) => value === undefined ? setVar("__book__", name) : setVar(String(name), value), putVariable: (name, value) => setVar(String(name), value) };',
      'globalThis.chapter = bindings.chapter ?? {};',
      'const getVariable = (name) => getVar(String(name));',
      'const putVariable = (name, value) => setVar(String(name), value);',
      // Android CookieStore 的 set/remove 返回 Unit，`{{cookie.removeCookie(...)}}` 必须展开为空串而不是 "true"。
      'const cookie = { getCookie: (url) => request({ kind: "cookie-get", url: String(url) }), setCookie: (url, value) => { request({ kind: "cookie-set", url: String(url), value: String(value) }); }, removeCookie: (url) => { request({ kind: "cookie-remove", url: String(url) }); } };',
      // 正文常常是 JSON 文本，`java.getString("$.x")` 必须能在这上面取路径（Android 会先解析内容）。
      'const legadoPathValue = (value, path) => { if (typeof value === "string") { try { value = JSON.parse(value); } catch (error) { value = undefined; } } const parts = String(path).replace(/^\\$\\.?\\.?/, "").match(/[A-Za-z_$][\\w$-]*|\\[\\d+\\]|\\[\\*\\]/g) ?? []; let current = value; for (const part of parts) { if (part === "[*]") current = Array.isArray(current) ? current : []; else if (Array.isArray(current)) current = current.map((item) => item == null ? undefined : item[part.startsWith("[") ? Number(part.slice(1, -1)) : part]); else current = current == null ? undefined : current[part]; } return current; };',
      'const legadoGetString = (name) => { const key = String(name); const value = key.startsWith("$") ? legadoPathValue(result, key) : result != null && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : getVar(key); return Array.isArray(value) ? value.map((item) => String(item ?? "")).join("\\n") : String(value ?? ""); };',
      'const java = { ajax: (value, method, body) => value != null && typeof value === "object" ? request(Object.assign({ kind: "network" }, value)) : method != null && typeof method === "object" ? request(Object.assign({ kind: "network", url: String(value) }, method)) : request({ kind: "network", url: String(value), method: method ?? "GET", body }), get: (value, options) => options !== undefined || /^(?:https?:)?\\/\\//.test(String(value)) ? request({ kind: "network", url: String(value), method: "GET", options }) : getVar(String(value)), put: (name, value) => { setVar(String(name), value); return value; }, getString: (name) => legadoGetString(name), getStringList: (name) => legadoGetString(name).split("\\n").filter(Boolean), getWebViewUA: () => "Mozilla/5.0", base64Encode: (value) => request({ kind: "base64-encode", value }), base64Decode: (value) => request({ kind: "base64-decode-text", value }), base64DecodeToString: (value) => request({ kind: "base64-decode-text", value }), hexDecodeToString: (value) => request({ kind: "hex-decode-text", value }), md5Encode: (value) => request({ kind: "md5", value }), digestHex: (value, algorithm) => request({ kind: "digest", value, transformation: algorithm }), encodeURI: (value) => encodeURI(String(value)), decodeURI: (value) => decodeURI(String(value)), aesBase64DecodeToString: (value, key, transformation, iv) => request({ kind: "aes-decode-text", value, key, transformation, iv }), replaceFont: (text, errorBase64, correctBase64, filter) => request({ kind: "font-replace", text, errorBase64, correctBase64, filter }), toast: () => undefined, longToast: () => undefined, log: () => undefined, timeFormat: (value) => String(value), timeFormatUTC: (value) => String(value), randomUUID: () => "", getAppVariant: () => "", androidId: () => "", deviceID: () => "" };',
      'const getToken = () => request({ kind: "token" });',
      'const checkEnv = () => "default";',
      'const isVs = () => false;',
    ].join('\n')
    // `result` is an input binding in Legado, but real sources sometimes use
    // `var result = ...` to replace it.  Keep the binding global so `let/const
    // page` declarations in other sources do not collide with our prelude,
    // and normalize the legacy var declaration to an assignment.
    const sourceCode = code.replace(/\bvar\s+result\b/g, 'result')
    const trailing = trailingExpression(sourceCode)
    const executable = `${prelude}\n${trailing.body}\n${trailing.expression === undefined ? '' : `return (${trailing.expression});`}`
    const input = { code: executable, stage, bindings, variables: this.variables.snapshot(), ...(signal === undefined ? {} : { signal }) }
    // 书源随这趟求值传入 bridge：共享宿主不再有「当前书源」字段，跨源并发不会串源。
    const output = await this.javascript.execute(input, { request: (payload, runSignal) => this.handleBridge(payload, runSignal, source) })
    return {
      status: output.status === 'budget-exceeded' ? 'failed' : output.status,
      value: output.value,
      ...(output.diagnostics[0] === undefined ? {} : { message: output.diagnostics[0].message }),
    }
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
      return this.font.replaceFont(textValue(request.text), error, correct, request.filter === true)
    }
    if (this.requestBridge === undefined) throw new Error('书源网络或宿主 bridge 不可用')
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
    state.steps += 1
    if (state.steps > this.maxSteps) throw new SourceRuleError('failed', '规则求值步数超过限制')
  }
}
