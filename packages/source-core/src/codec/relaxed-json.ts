/**
 * 解析 Android/GSON 历史书源里常见的宽松 JSON 形态。
 * 只处理数据语法：注释、单引号字符串、未加引号的对象键和尾逗号；
 * 不执行表达式、不解析函数，也不允许通过原型字段注入运行时对象。
 */
export function parseRelaxedJson(input: string): unknown {
  const trimmed = input.replace(/^\uFEFF/u, '').trim()
  try { return JSON.parse(trimmed) as unknown } catch { /* 继续宽松数据语法 */ }
  try { return JSON.parse(normalizeRelaxedJson(trimmed)) as unknown } catch { return undefined }
}

/** 解析 JSONPath 输入并保留 JSON 文本中的对象键顺序，包括整数样式的键。 */
export function parseRelaxedJsonPreservingKeyOrder(input: string): unknown {
  const trimmed = input.replace(/^\uFEFF/u, '').trim()
  let normalized = trimmed
  try {
    JSON.parse(normalized)
  } catch {
    try {
      normalized = normalizeRelaxedJson(trimmed)
      JSON.parse(normalized)
    } catch {
      return undefined
    }
  }
  const value = parseRelaxedJson(input)
  if (value === undefined) return undefined
  return restoreJsonKeyOrder(value, parseJsonOrderShape(normalized))
}

type JsonOrderShape =
  | { kind: 'object'; keys: string[]; children: Map<string, JsonOrderShape> }
  | { kind: 'array'; children: JsonOrderShape[] }
  | undefined

/** 记录每个 JSON 对象的文本键序，供 Proxy 枚举时覆盖 JS 的整数键排序。 */
function parseJsonOrderShape(input: string): JsonOrderShape {
  let offset = 0
  const skipWhitespace = (): void => {
    while (/\s/u.test(input[offset] ?? '')) offset += 1
  }
  const readString = (): string => {
    const start = offset
    offset += 1
    let escaped = false
    while (offset < input.length) {
      const current = input[offset++]!
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') return JSON.parse(input.slice(start, offset)) as string
    }
    throw new SyntaxError('JSON 对象键未闭合')
  }
  const readValue = (): JsonOrderShape => {
    skipWhitespace()
    const current = input[offset]
    if (current === '{') {
      offset += 1
      const keys: string[] = []
      const children = new Map<string, JsonOrderShape>()
      skipWhitespace()
      if (input[offset] === '}') { offset += 1; return { kind: 'object', keys, children } }
      while (offset < input.length) {
        skipWhitespace()
        const key = readString()
        skipWhitespace()
        if (input[offset] !== ':') throw new SyntaxError('JSON 对象键缺少冒号')
        offset += 1
        const child = readValue()
        if (!children.has(key)) keys.push(key)
        children.set(key, child)
        skipWhitespace()
        if (input[offset] === '}') { offset += 1; return { kind: 'object', keys, children } }
        if (input[offset] !== ',') throw new SyntaxError('JSON 对象成员缺少逗号')
        offset += 1
      }
      throw new SyntaxError('JSON 对象未闭合')
    }
    if (current === '[') {
      offset += 1
      const children: JsonOrderShape[] = []
      skipWhitespace()
      if (input[offset] === ']') { offset += 1; return { kind: 'array', children } }
      while (offset < input.length) {
        children.push(readValue())
        skipWhitespace()
        if (input[offset] === ']') { offset += 1; return { kind: 'array', children } }
        if (input[offset] !== ',') throw new SyntaxError('JSON 数组成员缺少逗号')
        offset += 1
      }
      throw new SyntaxError('JSON 数组未闭合')
    }
    if (current === '"') { readString(); return undefined }
    const start = offset
    // 字符串由前一分支处理；标量在空白或 JSON 结构分隔符处结束。
    while (offset < input.length && !/[\s,}\]]/u.test(input[offset]!)) offset += 1
    if (offset === start) throw new SyntaxError('JSON 值为空')
    return undefined
  }
  const shape = readValue()
  skipWhitespace()
  if (offset !== input.length) throw new SyntaxError('JSON 文本包含多余内容')
  return shape
}

function restoreJsonKeyOrder(value: unknown, shape: JsonOrderShape): unknown {
  if (shape?.kind === 'array' && Array.isArray(value)) {
    return value.map((item, index) => restoreJsonKeyOrder(item, shape.children[index]))
  }
  if (shape?.kind !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value)) return value

  const source = value as Record<string, unknown>
  const target = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      value: restoreJsonKeyOrder(source[key], shape.children.get(key)),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return new Proxy(target, {
    ownKeys(current) {
      const known = shape.keys.filter((key) => Object.hasOwn(current, key))
      return [...known, ...Reflect.ownKeys(current).filter((key) => typeof key !== 'string' || !known.includes(key))]
    },
  })
}

export function normalizeRelaxedJson(input: string): string {
  let result = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    const next = input[index + 1]
    if (quote === 'double') {
      result += current
      if (escaped) {
        if (!isJsonEscape(current)) result += `\\${current}`
        escaped = false
      }
      else if (current === '\\') escaped = true
      else if (current === '"') quote = null
      continue
    }
    if (quote === 'single') {
      if (escaped) {
        result += current === '"' ? '\\"' : current === '\\' || current === "'" ? current : isJsonEscape(current) ? `\\${current}` : `\\\\${current}`
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === "'") {
        result += '"'
        quote = null
      } else {
        if (current === '"') result += '\\"'
        else result += current
      }
      continue
    }
    if (current === '"') { quote = 'double'; result += current; continue }
    if (current === "'") { quote = 'single'; result += '"'; continue }
    if (current === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') index += 1
      result += '\n'
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      let closed = false
      while (index < input.length) {
        if (input[index] === '*' && input[index + 1] === '/') {
          index += 1
          closed = true
          break
        }
        index += 1
      }
      if (!closed) throw new SyntaxError('宽松 JSON 包含未闭合块注释')
      result += ' '
      continue
    }
    result += current
  }
  if (quote !== null) throw new SyntaxError('宽松 JSON 包含未闭合字符串')

  // 只在字符串外处理未加引号的键和尾逗号，避免修改字符串中的 `{x: 1}`、`,}` 等文本。
  let normalized = ''
  quote = null
  escaped = false
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index]!
    const next = result[index + 1]
    if (quote === 'double') {
      normalized += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') quote = null
      continue
    }
    if (current === '"') {
      quote = 'double'
      normalized += current
      continue
    }
    if (current === ',' && next !== undefined) {
      let lookahead = index + 1
      while (/\s/u.test(result[lookahead] ?? '')) lookahead += 1
      if (result[lookahead] === '}' || result[lookahead] === ']') {
        index = lookahead - 1
        continue
      }
    }
    if (isIdentifierStart(current)) {
      let end = index + 1
      while (isIdentifierPart(result[end] ?? '')) end += 1
      let lookahead = end
      while (/\s/u.test(result[lookahead] ?? '')) lookahead += 1
      if (result[lookahead] === ':') {
        normalized += JSON.stringify(result.slice(index, end))
        index = end - 1
        continue
      }
    }
    normalized += current
  }
  if (quote !== null) throw new SyntaxError('宽松 JSON 包含未闭合字符串')
  return normalized
}

function isJsonEscape(value: string | undefined): boolean {
  return value !== undefined && /["\\/bfnrtu]/u.test(value)
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[$_\p{L}]/u.test(value)
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[-_$\u200c\u200d\p{L}\p{N}]/u.test(value)
}
