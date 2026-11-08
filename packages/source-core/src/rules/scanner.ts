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
  let replacement = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    const next = input[index + 1]
    // Replacement patterns are regular-expression text, not rule syntax.
    // Once the first `##` separator is reached, parentheses, brackets, braces
    // and rule operators must not affect the structural scan.
    if (replacement) continue
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
    if (current === '\\') {
      // RuleAnalyzer 在分组外仍识别反斜杠后的组合符；分组/引号中的转义继续保护字面内容。
      const pair = input.slice(index + 1, index + 3)
      if (square !== 0 || round !== 0 || curly !== 0 || interpolation !== 0 || !['&&', '||', '%%'].includes(pair)) index += 1
      continue
    }
    if (current === '#' && next === '#' && interpolation === 0 && square === 0 && round === 0 && curly === 0) {
      replacement = true
      index += 1
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

/**
 * 按 Android `RuleAnalyzer(code=true).splitRule(...)` 的代码平衡规则切分。
 * 只在遇到方括号/圆括号时进入代码平衡组；组内由引号与反斜线保护内容，
 * 花括号不作为外层组合符的平衡组。Android 先选择最早出现的组合符，
 * 再按该组合符切分当前层，剩余组合符由递归调用处理。
 */
export function splitCodeBalancedAny(
  input: string,
  operators: readonly ('&&' | '||' | '%%')[],
): { operator?: '&&' | '||' | '%%'; parts: Array<{ text: string; start: number; end: number }>; diagnostic?: RuleDiagnostic } {
  const findNext = (from: number, selected: readonly ('&&' | '||' | '%%')[]) => {
    let cursor = from
    while (cursor < input.length) {
      let groupStart = -1
      for (let index = cursor; index < input.length; index += 1) {
        if (input[index] === '[' || input[index] === '(') {
          groupStart = index
          break
        }
      }
      let delimiter = -1
      let delimiterOperator: '&&' | '||' | '%%' | undefined
      for (let index = cursor; index < input.length; index += 1) {
        const found = selected.find((operator) => input.startsWith(operator, index))
        if (found !== undefined) {
          delimiter = index
          delimiterOperator = found
          break
        }
      }
      if (delimiter < 0) return { delimiter, delimiterOperator }
      if (groupStart < 0 || delimiter < groupStart) return { delimiter, delimiterOperator }
      const end = chompCodeBalancedEnd(input, groupStart, input[groupStart] as '[' | '(')
      if (end === undefined) return { delimiter: -1, diagnostic: diagnostic('代码规则分组不平衡', { start: groupStart, end: input.length }) }
      cursor = end
    }
    return { delimiter: -1, delimiterOperator: undefined }
  }

  const first = findNext(0, operators)
  if (first.diagnostic !== undefined) return { parts: [], diagnostic: first.diagnostic }
  if (first.delimiter < 0 || first.delimiterOperator === undefined) {
    return { parts: [{ text: input, start: 0, end: input.length }] }
  }

  const operator = first.delimiterOperator
  const parts: Array<{ text: string; start: number; end: number }> = []
  let start = 0
  let next = first.delimiter
  while (next >= 0) {
    parts.push({ text: input.slice(start, next), start, end: next })
    start = next + operator.length
    const found = findNext(start, [operator])
    if (found.diagnostic !== undefined) return { parts: [], diagnostic: found.diagnostic }
    next = found.delimiter
  }
  parts.push({ text: input.slice(start), start, end: input.length })
  return { operator, parts }
}

/** 按指定组合符直接观察 Android `RuleAnalyzer(code=true).splitRule(operator)`。 */
export function splitCodeBalanced(input: string, operator: '&&' | '||' | '%%'): { parts: Array<{ text: string; start: number; end: number }>; diagnostic?: RuleDiagnostic } {
  const result = splitCodeBalancedAny(input, [operator])
  return { parts: result.parts, ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }) }
}

/** 与 RuleAnalyzer.chompCodeBalanced 一致，返回平衡分组的 UTF-16 结束偏移。 */
function chompCodeBalancedEnd(input: string, start: number, open: '[' | '(' | '{', close = open === '[' ? ']' : open === '(' ? ')' : '}'): number | undefined {
  let index = start
  let squareDepth = 0
  let groupDepth = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  do {
    if (index >= input.length) break
    const current = input[index++]!
    if (current !== '\\') {
      if (current === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote
      else if (current === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote
      if (inSingleQuote || inDoubleQuote) continue
      if (current === '[') squareDepth += 1
      else if (current === ']') squareDepth -= 1
      else if (squareDepth === 0) {
        if (current === open) groupDepth += 1
        else if (current === close) groupDepth -= 1
      }
    } else index += 1
  } while (squareDepth > 0 || groupDepth > 0)
  return squareDepth > 0 || groupDepth > 0 ? undefined : index
}

/**
 * 使用 Android JSONPath `innerRule("{$.")` 的代码平衡边界替换内嵌路径。
 * 空回调结果不计为替换，并按 Android 继续前移起始标记长度；若之后仍找到成功项，
 * 未命中项原样保留；若全未命中，调用方收到 `replaced: false` 并回退为整条 JSONPath 查询。
 */
export async function replaceBalancedInnerRules(
  input: string,
  inner: string,
  resolve: (expression: string) => string | null | undefined | Promise<string | null | undefined>,
  startStep = 1,
  endStep = 1,
): Promise<{ text: string; replaced: boolean }> {
  let output = ''
  let outputStart = 0
  let searchFrom = 0
  let replaced = false
  while (searchFrom < input.length) {
    const start = input.indexOf(inner, searchFrom)
    if (start < 0) break
    const end = chompCodeBalancedEnd(input, start, '{')
    if (end === undefined) {
      searchFrom = start + inner.length
      continue
    }
    const expression = input.slice(start + startStep, end - endStep)
    const value = await resolve(expression)
    if (value !== null && value !== undefined && value.length > 0) {
      output += input.slice(outputStart, start) + value
      outputStart = end
      replaced = true
      searchFrom = end
    } else {
      // Android 在空回调后仍从当前位置额外前移 inner.length；紧邻的标记可能因此被跳过。
      searchFrom = end + inner.length
    }
  }
  return replaced ? { text: output + input.slice(outputStart), replaced: true } : { text: '', replaced: false }
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
  let replacement = false
  for (let index = 0; index < input.length - 1; index += 1) {
    const current = input[index]
    const next = input[index + 1]
    if (replacement) {
      if (quote !== null) {
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === quote) quote = null
      } else if (current === '"' || current === "'" || current === '`') {
        quote = current
      } else if (current === '#' && next === '#') {
        parts.push(input.slice(start, index))
        start = index + 2
        index += 1
      }
      continue
    }
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
      replacement = true
      index += 1
    }
  }
  parts.push(input.slice(start))
  return { parts }
}
