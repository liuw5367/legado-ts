import { snapshotVariables, variableChanges } from './variables.ts'
import type {
  CompiledRule,
  RuleAtom,
  RuleBudget,
  RuleContext,
  RuleDiagnostic,
  RuleEvaluationResult,
  RuleSequence,
  RuleValue,
} from './types.ts'

const defaultBudget: RuleBudget = { maxSteps: 1000, maxDepth: 32, maxOutputBytes: 256 * 1024 }

function textValue(value: RuleValue | unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => textValue(item)).filter(Boolean).join('\n')
  return JSON.stringify(value)
}

function listValue(value: RuleValue): RuleValue[] {
  return Array.isArray(value) ? value : [value]
}

function nonEmpty(value: RuleValue | null): boolean {
  if (value === null) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function diagnostic(code: RuleDiagnostic['code'], message: string, canContinue = false): RuleDiagnostic {
  return { code, message, canContinue }
}

class EvaluationStop extends Error {
  public readonly reason: RuleDiagnostic

  public constructor(reason: RuleDiagnostic) {
    super(reason.message)
    this.reason = reason
  }
}

interface EvaluationState {
  steps: number
  budget: RuleBudget
  diagnostics: RuleDiagnostic[]
  context: RuleContext
}

function checkBudget(state: EvaluationState, depth: number): void {
  if (state.context.signal?.aborted === true) throw new EvaluationStop(diagnostic('cancelled', '规则求值已取消'))
  state.steps += 1
  if (state.steps > state.budget.maxSteps) throw new EvaluationStop(diagnostic('budget-exceeded', '规则求值步数超过限制'))
  if (depth > state.budget.maxDepth) throw new EvaluationStop(diagnostic('budget-exceeded', '规则求值深度超过限制'))
}

function checkOutput(state: EvaluationState, value: RuleValue): void {
  const bytes = new TextEncoder().encode(textValue(value)).byteLength
  if (bytes > state.budget.maxOutputBytes) throw new EvaluationStop(diagnostic('budget-exceeded', '规则输出超过字节限制'))
}

function interpolate(input: string, state: EvaluationState): string {
  const getPattern = /@get:\{([^{}]+)\}/g
  let result = input.replace(getPattern, (_match, name: string) => state.context.variables.get(name) ?? '')
  const templatePattern = /\{\{([\s\S]*?)\}\}/g
  result = result.replace(templatePattern, (_match, expression: string) => {
    const trimmed = expression.trim()
    if (trimmed.startsWith('@') || trimmed.startsWith('$.') || trimmed.startsWith('$[') || trimmed.startsWith('//')) {
      throw new EvaluationStop(diagnostic('capability-unavailable', '模板中的递归规则需要 parser 或 JavaScript 宿主'))
    }
    return state.context.variables.get(trimmed) ?? ''
  })
  return result
}

function applyReplacement(value: RuleValue, atom: RuleAtom): RuleValue {
  if (atom.replacement === undefined) return value
  const text = textValue(value)
  let pattern: RegExp
  try {
    pattern = new RegExp(atom.replacement.pattern, 'g')
  } catch {
    throw new EvaluationStop(diagnostic('invalid-regex', '规则结果替换表达式无法编译'))
  }
  if (!atom.replacement.firstMatchOnly) return text.replace(pattern, atom.replacement.replacement)
  const first = pattern.exec(text)
  if (first === null) return ''
  return first[0].replace(new RegExp(atom.replacement.pattern, 'g'), atom.replacement.replacement)
}

function evaluateRegex(body: string, input: unknown): RuleValue {
  const regex = new RegExp(body, 'g')
  const text = textValue(input)
  const matches: string[][] = []
  for (const match of text.matchAll(regex)) matches.push([match[0] ?? '', ...match.slice(1).map((item) => item ?? '')])
  return matches
}

function evaluateAtom(atom: RuleAtom, state: EvaluationState, depth: number): RuleValue {
  checkBudget(state, depth)
  for (const put of atom.puts) {
    const value = evaluateNode(put.rule, state, depth + 1)
    state.context.variables.set(put.name, textValue(value))
  }
  let value: RuleValue
  if (atom.mode === 'Regex') {
    value = evaluateRegex(atom.body, state.context.content)
  } else if (atom.mode === 'Default') {
    const hasInterpolation = atom.body.includes('@get:') || atom.body.includes('{{')
    const body = interpolate(atom.body, state)
    if (body === '' || body === 'text' || body === 'ownText' || body === 'html') value = textValue(state.context.content)
    else if (body.startsWith('literal:')) value = body.slice('literal:'.length)
    else if (hasInterpolation) value = body
    else throw new EvaluationStop(diagnostic('capability-unavailable', 'Default 选择器需要 HTML parser adapter'))
  } else {
    throw new EvaluationStop(diagnostic('capability-unavailable', `${atom.mode} 规则需要对应宿主能力`))
  }
  const replaced = applyReplacement(value, atom)
  checkOutput(state, replaced)
  return replaced
}

function evaluateSequence(sequence: RuleSequence, state: EvaluationState, depth: number): RuleValue {
  checkBudget(state, depth)
  if (sequence.operator === '||') {
    for (const child of sequence.children) {
      try {
        const value = evaluateNode(child, state, depth + 1)
        if (nonEmpty(value)) return value
      } catch (error) {
        if (error instanceof EvaluationStop && error.reason.canContinue) state.diagnostics.push(error.reason)
        else throw error
      }
    }
    return null
  }
  if (sequence.operator === '%%') {
    const values = sequence.children.map((child) => listValue(evaluateNode(child, state, depth + 1)))
    const result: RuleValue[] = []
    const primaryLength = values[0]?.length ?? 0
    for (let index = 0; index < primaryLength; index += 1) {
      for (const value of values) if (index < value.length && nonEmpty(value[index] ?? null)) result.push(value[index]!)
    }
    return result
  }
  const values = sequence.children.map((child) => evaluateNode(child, state, depth + 1)).filter((value) => nonEmpty(value))
  if (values.length === 0) return null
  if (values.some((value) => Array.isArray(value))) return values.flatMap((value) => listValue(value))
  return values.map((value) => textValue(value)).join('\n')
}

function evaluateNode(rule: CompiledRule, state: EvaluationState, depth: number): RuleValue {
  return rule.kind === 'atom' ? evaluateAtom(rule, state, depth) : evaluateSequence(rule, state, depth)
}

export function evaluateRule(rule: CompiledRule, context: RuleContext, budget: Partial<RuleBudget> = {}): RuleEvaluationResult {
  const before = snapshotVariables(context.variables)
  const state: EvaluationState = { steps: 0, budget: { ...defaultBudget, ...budget }, diagnostics: [], context }
  try {
    const value = evaluateNode(rule, state, 0)
    const after = snapshotVariables(context.variables)
    return { status: nonEmpty(value) ? 'success' : 'empty', value: value ?? null, diagnostics: state.diagnostics, variableChanges: variableChanges(before, after) }
  } catch (error) {
    const reason = error instanceof EvaluationStop ? error.reason : diagnostic('evaluation-error', '规则求值失败')
    const after = snapshotVariables(context.variables)
    const status = reason.code === 'cancelled' ? 'cancelled' : reason.code === 'capability-unavailable' ? 'capability-missing' : reason.code === 'budget-exceeded' ? 'budget-exceeded' : 'failed'
    return { status, value: null, diagnostics: [...state.diagnostics, reason], variableChanges: variableChanges(before, after) }
  }
}
