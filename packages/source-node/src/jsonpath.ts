import { JSONPath } from 'jsonpath-plus'
import { parseRelaxedJson, ParserAdapterError, type JsonPathParser, type RuleValue } from '@legado/source-core'

export class JsonPathParserAdapter implements JsonPathParser {
  public evaluate(value: unknown, expression: string): RuleValue | null {
    try {
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
    } catch (error) {
      if (error instanceof ParserAdapterError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ParserAdapterError('unsupported-jsonpath', `JSONPath 规则不受支持：${message}`, { cause: error })
    }
  }
}

/** 将 Jayway 的正则匹配运算转换为 safe evaluator 支持的 RegExp.test 调用。 */
function normalizeJaywayExpression(expression: string): string {
  const output = normalizeJaywayFilterOperators(expression)
  let normalized = ''
  let index = 0
  while (index < output.length) {
    const match = /(@(?:\.[A-Za-z_$][\w$]*|\[['"][^'"\]]+['"]))(\s*=~\s*)\/((?:\\.|[^/\\])+)\/([dgimsuvy]*)/uy.exec(output.slice(index))
    if (match === null || match.index !== 0) { normalized += output[index]!; index += 1; continue }
    normalized += `/${match[3]!}/${match[4] ?? ''}.test(${match[1]!})`
    index += match[0].length
  }
  return normalized
}

/**
 * Jayway 的过滤运算符不是 JavaScript 运算符，jsonpath-plus 也不会直接解析它们。
 * 这里只转换可以保持 safe evaluator 语义的简单形式；无法安全展开的集合运算
 * 让 adapter 抛出稳定的 unsupported-jsonpath，而不是被误当成空列表。
 */
function normalizeJaywayFilterOperators(expression: string): string {
  let output = expression
  const path = String.raw`(?:@(?:\.[A-Za-z_$][\w$]*|\[['"][^'"\]]+['"])*)`
  const item = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|true|false|null)`
  const literal = String.raw`\[\s*(?:${item}(?:\s*,\s*${item})*)?\s*\]`
  const scalar = new RegExp(`(${path})\\s+(in|nin)\\s+(${literal})`, 'gu')
  output = output.replace(scalar, (_match, left: string, operator: string, right: string) => operator === 'in' ? `${right}.includes(${left})` : `!${right}.includes(${left})`)

  const size = new RegExp(`(${path})\\s+size\\s+(-?\\d+)`, 'gu')
  output = output.replace(size, '($1 != null && $1.length == $2)')
  const empty = new RegExp(`(${path})\\s+empty\\s+(true|false)`, 'gu')
  output = output.replace(empty, (_match, left: string, expected: string) => expected === 'true' ? `(${left} == null || ${left}.length == 0)` : `(${left} != null && ${left}.length != 0)`)

  const collection = new RegExp(`(${path})\\s+(anyof|noneof)\\s+(${literal})`, 'gu')
  output = output.replace(collection, (_match, left: string, operator: string, right: string) => {
    const items = parseJsonPathLiteralArray(right)
    if (items === undefined || items.length === 0) return operator === 'noneof' ? 'true' : 'false'
    const checks = items.map((item) => `${left}.includes(${item})`)
    return operator === 'noneof' ? `(${left} == null || !(${checks.join(' || ')}))` : `(${left} != null && (${checks.join(' || ')}))`
  })

  const subset = new RegExp(`(${path})\\s+subsetof\\s+(${literal})`, 'gu')
  output = output.replace(subset, (_match, left: string, right: string) => {
    const expression = subsetExpression(left, right)
    if (expression === undefined) throw new ParserAdapterError('unsupported-jsonpath', 'JSONPath subsetof 集合运算仅支持有限原始值集合')
    return expression
  })
  if (/\s+subsetof\s+/u.test(output)) throw new ParserAdapterError('unsupported-jsonpath', 'JSONPath subsetof 集合运算暂不支持')
  if (/\s+(?:in|nin|size|empty|anyof|noneof)\s+/u.test(output)) throw new ParserAdapterError('unsupported-jsonpath', 'JSONPath 过滤运算无法安全转换')
  return output
}

/** 对小型原始值集合展开所有子集，避免把任意回调函数暴露给 safe evaluator。 */
function subsetExpression(left: string, right: string): string | undefined {
  const items = parseJsonPathLiteralArray(right)
  if (items === undefined || items.length > 8) return undefined
  const values = items.map((item) => JSON.parse(item) as unknown)
  if (values.some((item) => item === null || typeof item === 'object' || typeof item === 'function')) return undefined
  const separator = '\u0000'
  if (values.some((item) => typeof item === 'string' && item.includes(separator))) return undefined
  const combinations: string[] = []
  for (let mask = 0; mask < 2 ** values.length; mask += 1) {
    const selected = values.filter((_item, index) => (mask & (1 << index)) !== 0).map(String).sort()
    const key = JSON.stringify(selected.join(separator))
    combinations.push(`(${left}.length == ${selected.length} && ${left}.slice().sort().join(${JSON.stringify(separator)}) == ${key})`)
  }
  return `(${left} != null && (${combinations.join(' || ')}))`
}

function parseJsonPathLiteralArray(value: string): string[] | undefined {
  try {
    const parsed = parseRelaxedJson(value)
    return Array.isArray(parsed) ? parsed.map((item) => JSON.stringify(item)) : undefined
  } catch {
    return undefined
  }
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
