import type { RuleDiagnostic, RuleSpan } from './types.ts'

export interface TopLevelOperator {
  /** 组合操作符。 */
  operator: '&&' | '||' | '%%'
  /** 操作符在当前字符串中的 UTF-16 偏移。 */
  index: number
}

export interface ScanResult {
  /** 顶层组合操作符，按源顺序排列。 */
  operators: TopLevelOperator[]
  /** 扫描错误；存在时不能继续编译。 */
  diagnostic?: RuleDiagnostic
}

function diagnostic(message: string, span: RuleSpan): RuleDiagnostic {
  return { code: 'unbalanced-rule', message, span, canContinue: false }
}

export function scanTopLevel(input: string): ScanResult {
  const operators: TopLevelOperator[] = []
  let square = 0
  let round = 0
  let curly = 0
  let interpolation = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    const next = input[index + 1]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      continue
    }
    if (current === '{' && next === '{') {
      interpolation += 1
      index += 1
      continue
    }
    if (current === '}' && next === '}' && interpolation > 0) {
      interpolation -= 1
      index += 1
      continue
    }
    if (current === '[') square += 1
    else if (current === ']') {
      square -= 1
      if (square < 0) return { operators, diagnostic: diagnostic('方括号不平衡', { start: index, end: index + 1 }) }
    } else if (current === '(') round += 1
    else if (current === ')') {
      round -= 1
      if (round < 0) return { operators, diagnostic: diagnostic('圆括号不平衡', { start: index, end: index + 1 }) }
    } else if (current === '{') curly += 1
    else if (current === '}') {
      curly -= 1
      if (curly < 0) return { operators, diagnostic: diagnostic('花括号不平衡', { start: index, end: index + 1 }) }
    }
    if (square === 0 && round === 0 && curly === 0 && interpolation === 0) {
      const pair = `${current}${next ?? ''}`
      if (pair === '&&' || pair === '||' || pair === '%%') {
        operators.push({ operator: pair, index })
        index += 1
      }
    }
  }
  if (quote !== null) return { operators, diagnostic: diagnostic('字符串引号不平衡', { start: Math.max(0, input.length - 1), end: input.length }) }
  if (square !== 0 || round !== 0 || curly !== 0 || interpolation !== 0) return { operators, diagnostic: diagnostic('规则分组或插值不平衡', { start: 0, end: input.length }) }
  return { operators }
}

export function splitTopLevel(input: string, operator: '&&' | '||' | '%%'): { parts: Array<{ text: string; start: number; end: number }>; diagnostic?: RuleDiagnostic } {
  const scanned = scanTopLevel(input)
  if (scanned.diagnostic !== undefined) return { parts: [], diagnostic: scanned.diagnostic }
  const selected = scanned.operators.filter((item) => item.operator === operator)
  if (selected.length === 0) return { parts: [{ text: input, start: 0, end: input.length }] }
  const parts: Array<{ text: string; start: number; end: number }> = []
  let start = 0
  for (const item of selected) {
    parts.push({ text: input.slice(start, item.index), start, end: item.index })
    start = item.index + operator.length
  }
  parts.push({ text: input.slice(start), start, end: input.length })
  return { parts }
}

export function splitReplacement(input: string): { parts: string[]; diagnostic?: RuleDiagnostic } {
  const scanned = scanTopLevel(input)
  if (scanned.diagnostic !== undefined) return { parts: [], diagnostic: scanned.diagnostic }
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  let square = 0
  let round = 0
  let curly = 0
  for (let index = 0; index < input.length - 1; index += 1) {
    const current = input[index]
    const next = input[index + 1]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      continue
    }
    if (current === '[') square += 1
    else if (current === ']') square -= 1
    else if (current === '(') round += 1
    else if (current === ')') round -= 1
    else if (current === '{') curly += 1
    else if (current === '}') curly -= 1
    if (current === '#' && next === '#' && square === 0 && round === 0 && curly === 0) {
      parts.push(input.slice(start, index))
      start = index + 2
      index += 1
    }
  }
  parts.push(input.slice(start))
  return { parts }
}
