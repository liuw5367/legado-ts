import { JSONPath } from 'jsonpath-plus'
import { parseRelaxedJson, ParserAdapterError, type JsonPathParser, type RuleValue } from '@legado/source-core'

export class JsonPathParserAdapter implements JsonPathParser {
  public evaluate(value: unknown, expression: string): RuleValue | null {
    try {
      const normalized = normalizeJaywayExpression(expression)
      const functionCall = /^(.*)\.([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/su.exec(normalized)
      if (functionCall !== null) {
        const name = functionCall[2]!
        if (jsonPathFunctionNames.has(name)) {
          const values = JSONPath({ path: functionCall[1]!, json: value as never, wrap: true, eval: 'safe', sandbox: jsonPathSandbox as never }) as unknown
          const args = parseJsonPathArguments(functionCall[3]!)
          const result = applyJsonPathFunction(name, functionCall[1]!, values, args)
          return result === undefined ? [] : [result] as RuleValue
        }
      }
      // Android's Jayway JsonPath evaluates filter predicates. jsonpath-plus' safe
      // evaluator provides the same expression subset without enabling native JS.
      const result = JSONPath({ path: normalized, json: value as never, wrap: true, eval: 'safe', sandbox: jsonPathSandbox as never }) as unknown
      return result === undefined ? [] : result as RuleValue
    } catch (error) {
      if (error instanceof ParserAdapterError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ParserAdapterError('unsupported-jsonpath', `JSONPath 规则不受支持：${message}`, { cause: error })
    }
  }
}

const jsonPathSandbox = {
  __legadoIn(left: unknown, right: unknown): boolean {
    return jsonPathIn(left, right)
  },
  __legadoNin(left: unknown, right: unknown): boolean {
    return !jsonPathIn(left, right)
  },
  __legadoAnyof(left: unknown, right: unknown): boolean {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return left.some((item) => right.some((candidate) => jsonPathEquals(item, candidate)))
  },
  __legadoNoneof(left: unknown, right: unknown): boolean {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return left.every((item) => right.every((candidate) => !jsonPathEquals(item, candidate)))
  },
  __legadoSubsetof(left: unknown, right: unknown): boolean {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return left.every((item) => right.some((candidate) => jsonPathEquals(item, candidate)))
  },
  __legadoEmpty(value: unknown): boolean {
    // Jayway 3.0 的 EmptyEvaluator 只把空字符串、空数组和空对象判为 true；缺失路径和标量均为 false。
    if (typeof value === 'string' || Array.isArray(value)) return value.length === 0
    if (value !== null && typeof value === 'object') return Object.keys(value).length === 0
    return false
  },
  __legadoNotEmpty(value: unknown): boolean {
    return value !== undefined && !jsonPathSandbox.__legadoEmpty(value)
  },
  __legadoSize(value: unknown, expected: number): boolean {
    if (typeof value === 'string' || Array.isArray(value)) return value.length === expected
    return value !== null && typeof value === 'object' && Object.keys(value).length === expected
  },
}

const jsonPathFunctionNames = new Set(['length', 'size', 'keys', 'min', 'max', 'avg', 'sum', 'stddev', 'first', 'last', 'index', 'concat', 'append'])

function jsonPathEquals(left: unknown, right: unknown): boolean {
  if (left === right) return left !== undefined
  if (left === undefined || right === undefined || left === null || right === null) return false
  if (typeof left === 'boolean' || typeof right === 'boolean') return false
  if (typeof left === 'number' && typeof right === 'string') return Number.isFinite(Number(right)) && left === Number(right)
  if (typeof left === 'string' && typeof right === 'number') return Number.isFinite(Number(left)) && Number(left) === right
  return false
}

function jsonPathIn(left: unknown, right: unknown): boolean {
  return Array.isArray(right) && left !== undefined && right.some((candidate) => jsonPathEquals(left, candidate))
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
  output = output.replace(scalar, (_match, left: string, operator: string, right: string) => `__legado${operator === 'in' ? 'In' : 'Nin'}(${left},${right})`)

  const size = new RegExp(`(${path})\\s+size\\s+(-?\\d+)`, 'gu')
  output = output.replace(size, '__legadoSize($1,$2)')
  const empty = new RegExp(`(${path})\\s+empty\\s+(true|false)`, 'gu')
  output = output.replace(empty, (_match, left: string, expected: string) => expected === 'true' ? `__legadoEmpty(${left})` : `__legadoNotEmpty(${left})`)

  const collection = new RegExp(`(${path})\\s+(anyof|noneof)\\s+(${literal})`, 'gu')
  output = output.replace(collection, (_match, left: string, operator: string, right: string) => `__legado${operator === 'anyof' ? 'Anyof' : 'Noneof'}(${left},${right})`)

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

/** 将有限原始值集合交给受控 sandbox，保留 Jayway 的集合/类型语义。 */
function subsetExpression(left: string, right: string): string | undefined {
  const items = parseJsonPathLiteralArray(right)
  if (items === undefined) return undefined
  const values = items.map((item) => JSON.parse(item) as unknown)
  if (values.some((item) => item === null || typeof item === 'object' || typeof item === 'function')) return undefined
  return `__legadoSubsetof(${left},${right})`
}

function parseJsonPathLiteralArray(value: string): string[] | undefined {
  try {
    const parsed = parseRelaxedJson(value)
    return Array.isArray(parsed) ? parsed.map((item) => JSON.stringify(item)) : undefined
  } catch {
    return undefined
  }
}

function parseJsonPathArguments(value: string): unknown[] {
  if (value.trim().length === 0) return []
  const parts: string[] = []
  let start = 0
  let quote: string | undefined
  let escaped = false
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'") { quote = current; continue }
    if (current === '[' || current === '{') depth += 1
    else if (current === ']' || current === '}') depth -= 1
    else if (current === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.map((part) => {
    const parsed = parseRelaxedJson(part)
    if (parsed === undefined) throw new ParserAdapterError('unsupported-jsonpath', `JSONPath 函数参数无法解析：${part}`)
    return parsed
  })
}

function isCollectionPath(path: string): boolean {
  return /\.\.|\[\s*(?:\*|\?|[^\]]*,)/u.test(path)
}

function functionInput(path: string, value: unknown): unknown {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0) throw new Error('JSONPath 函数输入路径没有匹配结果')
  if (values.length === 1 && Array.isArray(values[0])) return values[0]
  if (isCollectionPath(path) || values.length > 1) return values
  return values[0]
}

function applyJsonPathFunction(name: string, path: string, value: unknown, args: unknown[]): unknown {
  const input = functionInput(path, value)
  if ((name === 'length' || name === 'size') && args.length > 0) throw new Error(`${name} 不接受参数`)
  if (name === 'length' || name === 'size') {
    if (typeof input === 'string') return null
    if (Array.isArray(input)) return input.length
    if (input !== null && typeof input === 'object') return Object.keys(input).length
    return null
  }
  if (name === 'keys') {
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : null
  }
  if (name === 'concat') {
    const values = Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
    return [...values, ...stringArguments(args)].join('')
  }
  if (name === 'append') {
    if (!Array.isArray(input)) return input
    return [...input, ...args]
  }
  if (!Array.isArray(input)) throw new Error(`${name} 只能用于数组`)
  if (name === 'first') {
    if (input.length === 0) throw new Error('first 不能用于空数组')
    return input[0]
  }
  if (name === 'last') {
    const index = input.length - 1
    // Jayway 3.0's Last implementation treats a one-item array as an invalid
    // negative target after adding -1; preserve that observable edge case.
    if (index <= 0) throw new Error(`last 目标索引超出范围：${input.length}`)
    return input[index]
  }
  if (name === 'index') {
    if (args.length !== 1 || typeof args[0] !== 'number' || !Number.isInteger(args[0])) throw new Error('index 需要一个整数参数')
    const index = args[0] < 0 ? input.length + args[0] : args[0]
    if (index < 0 || index >= input.length) throw new Error(`index 目标索引超出范围：${args[0]}`)
    return input[index]
  }
  const numbers = input.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  if (numbers.length === 0) throw new Error(`${name} 没有可聚合的数字`)
  if (name === 'sum') return numbers.reduce((total, item) => total + item, 0)
  if (name === 'avg') return numbers.reduce((total, item) => total + item, 0) / numbers.length
  if (name === 'min') return Math.min(...numbers)
  if (name === 'max') return Math.max(...numbers)
  const average = numbers.reduce((total, item) => total + item, 0) / numbers.length
  return Math.sqrt(numbers.reduce((total, item) => total + item * item, 0) / numbers.length - average * average)
}

function stringArguments(args: unknown[]): string[] {
  const values: string[] = []
  const append = (value: unknown): void => {
    if (value === null || value === undefined) return
    values.push(typeof value === 'object' ? javaJsonPathString(value) : String(value))
  }
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of arg) append(item)
    } else {
      append(arg)
    }
  }
  return values
}

function javaJsonPathString(value: object): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === null ? 'null' : javaJsonPathStringValue(item)).join(', ')}]`
  return `{${Object.entries(value).map(([key, item]) => `${key}=${javaJsonPathStringValue(item)}`).join(', ')}}`
}

function javaJsonPathStringValue(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') return javaJsonPathString(value)
  return String(value)
}
