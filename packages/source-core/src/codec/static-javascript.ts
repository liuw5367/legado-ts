import type { JsonObject, JsonValue, NormalizedSource } from '../model/types.ts'

export interface StaticJavaScriptResult {
  source?: NormalizedSource
  config: JsonObject | null
  error?: string
}

function stripComments(input: string): string {
  let result = ''
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    const next = input[index + 1]
    if (quote !== null) {
      result += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      result += current
    } else if (current === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') index += 1
      result += '\n'
    } else if (current === '/' && next === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index += 1
      index += 1
      result += ' '
    } else {
      result += current
    }
  }
  return result
}

function findObjectEnd(input: string, start: number): number | undefined {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  for (let index = start; index < input.length; index += 1) {
    const current = input[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
    } else if (current === '{') {
      depth += 1
    } else if (current === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

function convertSingleQuotedStrings(input: string): string {
  let result = ''
  let quote: '"' | "'" | '`' | null = null
  let buffer = ''
  let escaped = false
  for (const current of input) {
    if (quote === null) {
      if (current === "'") {
        quote = "'"
        buffer = ''
      } else {
        result += current
      }
      continue
    }
    if (current === '\n' || current === '\r') return input
    if (escaped) {
      buffer += current === "'" ? "'" : `\\${current}`
      escaped = false
    } else if (current === '\\') {
      escaped = true
    } else if (current === quote) {
      result += JSON.stringify(buffer)
      quote = null
    } else {
      buffer += current
    }
  }
  return quote === null ? result : input
}

function normalizeObjectLiteral(input: string): string {
  let result = convertSingleQuotedStrings(stripComments(input))
  result = result.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
  result = result.replace(/,\s*([}\]])/g, '$1')
  result = result.replace(/\bundefined\b/g, 'null')
  return result
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceFromConfig(value: JsonObject): NormalizedSource | undefined {
  const url = value.bookSourceUrl
  const name = value.bookSourceName
  if (typeof url !== 'string' || url.trim() === '' || typeof name !== 'string' || name.trim() === '') return undefined
  return value as NormalizedSource
}

function findConfigLiteral(text: string, binding: string): JsonObject | null {
  const match = new RegExp(`(?:const|let|var)\\s+${binding}\\s*=|(?:^|[;\\n])\\s*${binding}\\s*=`).exec(text)
  if (match === null) return null
  const start = text.indexOf('{', match.index + match[0].length)
  if (start < 0) return null
  const end = findObjectEnd(text, start)
  if (end === undefined) return null
  try {
    const parsed = JSON.parse(normalizeObjectLiteral(text.slice(start, end))) as JsonValue
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function extractStaticJavaScript(text: string): StaticJavaScriptResult {
  const config = findConfigLiteral(text, 'config')
  const legacy = config === null ? findConfigLiteral(text, 'source') : null
  const selected = config ?? legacy
  if (selected === null) return { config: null, error: '未找到可安全读取的静态 config/source 对象' }
  const source = sourceFromConfig(selected)
  if (source === undefined) return { config: selected, error: '静态配置缺少非空 bookSourceUrl 或 bookSourceName' }
  return { config: selected, source }
}
