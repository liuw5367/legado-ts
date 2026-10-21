import { JSONPath } from 'jsonpath-plus'
import type { JsonPathParser, RuleValue } from '@legado/source-core'

export class JsonPathParserAdapter implements JsonPathParser {
  public evaluate(value: unknown, expression: string): RuleValue | null {
    const normalized = normalizeJaywayExpression(expression)
    const functionCall = /^(.*)\.(length|size|keys|min|max|avg|sum)\(\)$/su.exec(normalized)
    if (functionCall !== null) {
      const values = JSONPath({ path: functionCall[1]!, json: value as never, wrap: true, eval: 'safe' }) as unknown
      return [applyJsonPathFunction(functionCall[2]!, values)] as RuleValue
    }
    // Android's Jayway JsonPath evaluates filter predicates. jsonpath-plus' safe
    // evaluator provides the same expression subset without enabling native JS.
    const result = JSONPath({ path: normalized, json: value as never, wrap: true, eval: 'safe' }) as unknown
    return result === undefined ? [] : result as RuleValue
  }
}

/** 将 Jayway 的正则匹配运算转换为 safe evaluator 支持的 RegExp.test 调用。 */
function normalizeJaywayExpression(expression: string): string {
  let output = ''
  let index = 0
  while (index < expression.length) {
    const match = /(@(?:\.[A-Za-z_$][\w$]*|\[['"][^'"\]]+['"]))(\s*=~\s*)\/((?:\\.|[^/\\])+)\/([dgimsuvy]*)/uy.exec(expression.slice(index))
    if (match === null || match.index !== 0) { output += expression[index]!; index += 1; continue }
    output += `/${match[3]!}/${match[4] ?? ''}.test(${match[1]!})`
    index += match[0].length
  }
  return output
}

function applyJsonPathFunction(name: string, value: unknown): number | string[] {
  const values = Array.isArray(value) ? value : [value]
  const first = values.length === 1 ? values[0] : values
  if (name === 'length' || name === 'size') {
    if (typeof first === 'string' || Array.isArray(first)) return first.length
    if (first !== null && typeof first === 'object') return Object.keys(first).length
    return 0
  }
  if (name === 'keys') return first !== null && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : []
  const numbers = (Array.isArray(first) ? first : values).map(Number).filter(Number.isFinite)
  if (numbers.length === 0) return 0
  if (name === 'sum') return numbers.reduce((total, item) => total + item, 0)
  if (name === 'avg') return numbers.reduce((total, item) => total + item, 0) / numbers.length
  if (name === 'min') return Math.min(...numbers)
  return Math.max(...numbers)
}
