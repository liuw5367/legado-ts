export interface ParsedSourceRequestUrl {
  url: string
  options?: Readonly<Record<string, unknown>>
}

function relaxedJson(input: string): string {
  let result = ''
  let doubleQuoted = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    if (doubleQuoted) {
      result += current
      if (current === '\\' && input[index + 1] !== undefined) result += input[++index]!
      else if (current === '"') doubleQuoted = false
      continue
    }
    if (current === '"') { doubleQuoted = true; result += current; continue }
    if (current !== "'") { result += current; continue }
    let value = ''
    for (index += 1; index < input.length; index += 1) {
      const item = input[index]!
      if (item === '\\') {
        const next = input[index + 1]
        if (next === "'") { value += "'"; index += 1 } else { value += item; if (next !== undefined) { value += next; index += 1 } }
      } else if (item === "'") break
      else value += item
    }
    result += JSON.stringify(value)
  }
  return result
}

function optionsObject(input: string): Readonly<Record<string, unknown>> | undefined {
  for (const candidate of [input, relaxedJson(input)]) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>
    } catch {
      // The relaxed pass below handles Android book-source files using single quotes.
    }
  }
  return undefined
}

/**
 * Split Android's `url, JSON options` suffix before URL normalization. Only a
 * comma followed by a valid object counts, so ordinary commas in query values
 * stay part of the URL.
 */
export function splitSourceRequestUrl(input: string): ParsedSourceRequestUrl {
  let quote: string | undefined
  let depth = 0
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    if (quote !== undefined) {
      if (current === '\\') index += 1
      else if (current === quote) quote = undefined
      continue
    }
    if (current === '"' || current === "'") { quote = current; continue }
    if (current === '{' || current === '[') depth += 1
    else if (current === '}' || current === ']') depth = Math.max(0, depth - 1)
    else if (current === ',' && depth === 0) {
      let start = index + 1
      while (/\s/u.test(input[start] ?? '')) start += 1
      if (input[start] !== '{') continue
      const options = optionsObject(input.slice(start).trim())
      if (options !== undefined) return { url: input.slice(0, index).trim(), options }
    }
  }
  return { url: input.trim() }
}

const querySafeCharacters = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$&()*+,-./:;=?@[\\]^_`{|}~')

function isSafeQuery(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!
    if (current === '%' && /^[\\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
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
    if (charset?.toLowerCase() === 'escape') {
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
  absolute.search = encodeQuery(address.slice(queryStart + 1), charset, encodeCharset)
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
