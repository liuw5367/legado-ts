export interface ParsedSourceRequestUrl {
  url: string
  options?: Readonly<Record<string, unknown>>
}

function optionsObject(input: string): Readonly<Record<string, unknown>> | undefined {
  let value: unknown
  try { value = JSON.parse(input) as unknown } catch {
    try { value = new GsonLenientJsonParser(input).parse() } catch { return undefined }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>
  return undefined
}

class GsonLenientJsonParser {
  private position = 0
  private readonly input: string

  public constructor(input: string) {
    this.input = input
  }

  public parse(): unknown {
    const value = this.readValue(0)
    this.skipIgnored()
    if (this.position !== this.input.length) throw new SyntaxError('URL 选项 JSON 后存在多余内容')
    return value
  }

  private readValue(depth: number): unknown {
    if (depth > 255) throw new SyntaxError('URL 选项 JSON 嵌套过深')
    this.skipIgnored()
    const character = this.input[this.position]
    if (character === '{') return this.readObject(depth + 1)
    if (character === '[') return this.readArray(depth + 1)
    if (character === '"' || character === "'") return this.readQuoted(character)
    if (character === undefined) throw new SyntaxError('URL 选项 JSON 缺少值')
    const literal = this.readLiteral()
    if (literal.length === 0) throw new SyntaxError('URL 选项 JSON 包含非法值')
    if (literal.toLowerCase() === 'true') return true
    if (literal.toLowerCase() === 'false') return false
    if (literal.toLowerCase() === 'null') return null
    // Gson 将符合 JSON 十进制语法的未加引号 token 作为数字读取，其他 token 保留为字符串。
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(literal)) return Number(literal)
    return literal
  }

  private readObject(depth: number): Record<string, unknown> {
    this.position += 1
    const value: Record<string, unknown> = {}
    this.skipIgnored()
    if (this.consume('}')) return value
    while (this.position < this.input.length) {
      this.skipIgnored()
      const character = this.input[this.position]
      const key = character === '"' || character === "'" ? this.readQuoted(character) : this.readLiteral()
      if (typeof key !== 'string' || key.length === 0) throw new SyntaxError('URL 选项 JSON 对象键无效')
      this.skipIgnored()
      if (!this.consume(':')) {
        if (!this.consume('=')) throw new SyntaxError('URL 选项 JSON 缺少键值分隔符')
        this.consume('>')
      }
      Object.defineProperty(value, key, {
        value: this.readValue(depth),
        configurable: true,
        enumerable: true,
        writable: true,
      })
      this.skipIgnored()
      if (this.consume('}')) return value
      if (!this.consume(',') && !this.consume(';')) throw new SyntaxError('URL 选项 JSON 对象缺少成员分隔符')
      this.skipIgnored()
      if (this.input[this.position] === '}') throw new SyntaxError('URL 选项 JSON 对象末尾不能有分隔符')
    }
    throw new SyntaxError('URL 选项 JSON 对象未闭合')
  }

  private readArray(depth: number): unknown[] {
    this.position += 1
    const values: unknown[] = []
    this.skipIgnored()
    if (this.consume(']')) return values
    while (this.position < this.input.length) {
      this.skipIgnored()
      if (this.input[this.position] === ',' || this.input[this.position] === ';') {
        values.push(null)
        this.position += 1
        continue
      }
      if (this.input[this.position] === ']') {
        values.push(null)
        this.position += 1
        return values
      }
      values.push(this.readValue(depth))
      this.skipIgnored()
      if (this.consume(']')) return values
      if (!this.consume(',') && !this.consume(';')) throw new SyntaxError('URL 选项 JSON 数组缺少元素分隔符')
    }
    throw new SyntaxError('URL 选项 JSON 数组未闭合')
  }

  private readQuoted(quote: string): string {
    this.position += 1
    let value = ''
    while (this.position < this.input.length) {
      const character = this.input[this.position++]!
      if (character === quote) return value
      if (character !== '\\') {
        value += character
        continue
      }
      const escaped = this.input[this.position++]
      if (escaped === undefined) break
      if (escaped === 'u') {
        const hex = this.input.slice(this.position, this.position + 4)
        // Gson 需要恰好四位十六进制数字表示一个 UTF-16 代码单元。
        if (!/^[\da-f]{4}$/iu.test(hex)) throw new SyntaxError('URL 选项 JSON Unicode 转义无效')
        value += String.fromCharCode(Number.parseInt(hex, 16))
        this.position += 4
      } else {
        value += ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escaped] ?? escaped
      }
    }
    throw new SyntaxError('URL 选项 JSON 字符串未闭合')
  }

  private readLiteral(): string {
    const start = this.position
    const delimiters = ",;:{}[]\\/\"'=#"
    while (this.position < this.input.length) {
      const character = this.input[this.position]!
      if (isGsonWhitespace(character) || delimiters.includes(character)) break
      this.position += 1
    }
    return this.input.slice(start, this.position)
  }

  private skipIgnored(): void {
    while (this.position < this.input.length) {
      const character = this.input[this.position]!
      if (isGsonWhitespace(character)) {
        this.position += 1
      } else if (character === '#') {
        this.skipLineComment()
      } else if (character === '/' && this.input[this.position + 1] === '/') {
        this.position += 2
        this.skipLineComment()
      } else if (character === '/' && this.input[this.position + 1] === '*') {
        this.position += 2
        const end = this.input.indexOf('*/', this.position)
        if (end < 0) throw new SyntaxError('URL 选项 JSON 注释未闭合')
        this.position = end + 2
      } else {
        return
      }
    }
  }

  private skipLineComment(): void {
    while (this.position < this.input.length && this.input[this.position] !== '\r' && this.input[this.position] !== '\n') this.position += 1
  }

  private consume(value: string): boolean {
    if (!this.input.startsWith(value, this.position)) return false
    this.position += value.length
    return true
  }
}

/**
 * Split Android's `url, JSON options` suffix before URL normalization.
 */
export function splitSourceRequestUrl(input: string): ParsedSourceRequestUrl {
  // 与 Android AnalyzeUrl.paramPattern 相同，取逗号后第一个左花括号作为选项起点。
  const separator = /\s*,\s*(?=\{)/u.exec(input)
  if (separator === null) return { url: input.trim() }
  const optionsStart = separator.index + separator[0].length
  const options = optionsObject(input.slice(optionsStart).trim())
  return { url: input.slice(0, separator.index).trim(), ...(options === undefined ? {} : { options }) }
}

function isGsonWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r'
}

const querySafeCharacters = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$&()*+,-./:;=?@[\\]^_`{|}~')

function isSafeQuery(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!
    if (current === '%' && /^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      index += 2
      continue
    }
    if (!querySafeCharacters.has(current)) return false
  }
  return true
}

function encodeQuery(value: string, charset: string | undefined, encodeCharset: ((value: string, charset: string) => Uint8Array) | undefined): string {
  if (isSafeQuery(value)) return value
  return [...value].map((character) => {
    if (querySafeCharacters.has(character)) return character
    if (charset === 'escape') {
      const codePoint = character.codePointAt(0)!
      if (codePoint <= 0xff) return `%${codePoint.toString(16).padStart(2, '0').toUpperCase()}`
      const units = character.length === 2 ? [character.charCodeAt(0), character.charCodeAt(1)] : [codePoint]
      return units.map((unit) => `%u${unit.toString(16).padStart(4, '0').toUpperCase()}`).join('')
    }
    const normalized = charset?.toLowerCase().replaceAll('-', '')
    if (encodeCharset === undefined && normalized !== undefined && normalized !== 'utf8') {
      throw new Error(`当前网络宿主不支持 ${charset} 查询参数编码`)
    }
    const bytes = encodeCharset?.(character, charset ?? 'utf-8') ?? new TextEncoder().encode(character)
    return [...bytes].map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('')
  }).join('')
}

/**
 * Resolve a source URL only after its query has been encoded with the source's
 * requested charset. URLSearchParams cannot be used here because its form
 * encoding rules differ from Android's query encoding rules.
 */
export function resolveSourceRequestUrl(
  input: string,
  baseUrl: string,
  charset: string | undefined,
  encodeCharset?: (value: string, charset: string) => Uint8Array,
): string {
  const fragmentStart = input.indexOf('#')
  const fragment = fragmentStart < 0 ? '' : input.slice(fragmentStart)
  const address = fragmentStart < 0 ? input : input.slice(0, fragmentStart)
  const queryStart = address.indexOf('?')
  if (queryStart < 0) return new URL(input, baseUrl).toString()
  const absolute = new URL(address.slice(0, queryStart), baseUrl)
  // URL.search 赋空字符串会删除问号；Android 保留显式空查询。
  absolute.search = '?' + encodeQuery(address.slice(queryStart + 1), charset, encodeCharset)
  if (fragment.length > 0) absolute.hash = fragment.slice(1)
  return absolute.toString()
}

/** Resolve a source-owned URL without encoding its query before request options are read. */
export function resolveSourceRequestReference(input: string, baseUrl: string): string {
  const parsed = splitSourceRequestUrl(input)
  const base = splitSourceRequestUrl(baseUrl).url
  const protectedSegments: string[] = []
  const protectedUrl = parsed.url.replace(/<js>[\s\S]*?<\/js>|<[^<>]*>/gi, (segment) => {
    const index = protectedSegments.push(segment) - 1
    return `legadoreservedurlsegment${index}x`
  })
  const fragmentStart = protectedUrl.indexOf('#')
  const fragment = fragmentStart < 0 ? '' : protectedUrl.slice(fragmentStart)
  const address = fragmentStart < 0 ? protectedUrl : protectedUrl.slice(0, fragmentStart)
  const queryStart = address.indexOf('?')
  let resolved: string
  if (queryStart < 0) {
    resolved = new URL(parsed.url, base).toString()
  } else {
    const absolute = new URL(address.slice(0, queryStart), base)
    absolute.search = ''
    absolute.hash = ''
    resolved = `${absolute.toString()}?${address.slice(queryStart + 1)}${fragment}`
  }
  resolved = resolved.replace(/legadoreservedurlsegment(\d+)x/g, (_match, index: string) => protectedSegments[Number(index)] ?? _match)
  return parsed.options === undefined ? resolved : `${resolved},${JSON.stringify(parsed.options)}`
}
