/**
 * 书源可控正则的守卫：长度上限 + 教科书式嵌套量词检测。
 *
 * Android 没有任何正则防护，这一层是仓内额外加的，取舍依据来自语料实测：
 * - 长度：3281 条源正则（`bookUrlPattern` 与 `##` 匹配串）最长 981 字符、p99.9 为 544，上限取 2048；
 * - 复杂度：`(a+)+` 这类形态在语料里有 4 条 `##` 匹配串合法使用（如 `(\n.*)+`），
 *   它们作用在正常大小的章节正文上并不会爆炸，所以默认按输入规模分档：
 *   `bookUrlPattern` 匹配的是可能很长的 URL，一律拒绝；`##` 替换只在输入超过 64 KiB 时拒绝。
 * 命中守卫时调用方必须给出明确诊断，不能静默忽略。
 */

export type SourcePatternErrorCode = 'pattern-too-long' | 'pattern-complexity' | 'invalid-pattern' | 'unsupported-pattern'

export interface SourcePatternError {
  /** 稳定分类，调用方据此给出诊断。 */
  code: SourcePatternErrorCode
  message: string
}

export interface SourcePatternOptions {
  /** 传给 RegExp 的标志；默认无标志，调用方按匹配语义显式传入。 */
  flags?: string
}

interface JavaPatternTranslation {
  pattern: string
  flags: string
}

/** 长度上限：语料最长 981，取 2048 留一倍余量。 */
const maxSourcePatternLength = 2048
/**
 * 教科书式灾难回溯形态：`(a+)+`、`([a-z]*)*`、`(.*)*`。
 * 组体只允许「简单原子序列 + 单个无界量词」；带 `|` 的分组、带分隔符的写法（`(?:[a-z]+\.)+`）都不在此列。
 */
const nestedQuantifierPattern = /\(((?:\\.|\[[^\]]*\]|[^\\[\]()|])+[*+?])\)\s*[*+{]/g
/** 分组修饰前缀（`(?:`、`(?=`、`(?!`、`(?<name>`）不是原子，判定前先剥掉。 */
const groupModifierPrefix = /^\?(?:[:=!]|<[A-Za-z_$][\w$]*>)?/
/**
 * 组体里是否含「没被量词修饰的原子」：`(\n.*)+`、`(ab+)+` 每轮重复都被该字面量锚定，
 * 回溯不会指数级放大，放行；全是量化原子的 `(a+)+` / `(.*)*` / `([a-z]+)+` 一律拒绝（与输入规模无关）。
 * 必须按原子逐个扫描，不能用正则去搜——搜索会落进字符类内部（`[a-z]` 里那个 `a`）。
 */
function hasAnchoredAtom(body: string): boolean {
  let index = 0
  while (index < body.length) {
    const current = body[index]!
    if ('*+?'.includes(current)) return true
    let end = index + 1
    if (current === '\\') end = index + 2
    else if (current === '[') {
      const close = body.indexOf(']', index + 1)
      end = close < 0 ? body.length : close + 1
    }
    const quantifier = body[end]
    if (quantifier === undefined || !'*+?{'.includes(quantifier)) return true
    end += body[end + 1] === '?' ? 2 : 1
    index = end
  }
  return false
}

function hasUnanchoredNesting(pattern: string): boolean {
  for (const match of pattern.matchAll(nestedQuantifierPattern)) {
    const body = match[1]!.replace(groupModifierPrefix, '')
    if (!hasAnchoredAtom(body)) return true
  }
  return false
}

export function compileSourcePattern(pattern: string, options: SourcePatternOptions = {}): { regex: RegExp } | { error: SourcePatternError } {
  const translated = translateJavaPattern(pattern, options.flags ?? '')
  if ('error' in translated) return { error: translated.error }
  if (translated.pattern.length > maxSourcePatternLength) return { error: { code: 'pattern-too-long', message: `书源正则超过长度上限（${maxSourcePatternLength} 字符）` } }
  if (hasUnanchoredNesting(translated.pattern)) return { error: { code: 'pattern-complexity', message: '书源正则存在未锚定的嵌套量词，可能造成灾难性回溯' } }
  try {
    return { regex: new RegExp(translated.pattern, translated.flags) }
  } catch {
    return { error: { code: 'invalid-pattern', message: '书源正则无法编译' } }
  }
}

/**
 * 转换 Java Pattern 中可安全表达的历史书源语法；不把未知语法降级成字面匹配。
 * `\Q...\E` 和边界转义是等价转换；占有量词和原子分组没有等价的
 * ECMAScript 表达，必须返回明确诊断，不能静默放宽匹配语义。
 */
function translateJavaPattern(pattern: string, inputFlags: string): JavaPatternTranslation | { error: SourcePatternError } {
  let flags = inputFlags
  for (const flag of flags) {
    if (!'dgimsuvy'.includes(flag)) return { error: { code: 'unsupported-pattern', message: `正则 flag ${flag} 暂不支持` } }
  }
  let source = pattern
  const inline = /^\(\?([imsUdx]*)(?:-([imsUdx]+))?\)/u.exec(source)
  if (inline !== null) {
    source = source.slice(inline[0].length)
    const enabled = inline[1] ?? ''
    const disabled = inline[2] ?? ''
    for (const flag of `${enabled}${disabled}`) {
      if (!'imsuU'.includes(flag)) return { error: { code: 'unsupported-pattern', message: `Java 正则内联 flag ${flag} 暂不支持` } }
    }
    flags = applyInlineFlags(flags, enabled, true)
    flags = applyInlineFlags(flags, disabled, false)
  }
  if (/\(\?[imsUdx-]+:/u.test(source)) return { error: { code: 'unsupported-pattern', message: 'Java 正则作用域 flag 暂不支持' } }
  source = source.replace(/\\R/gu, '(?:\\r\\n|[\\n\\r\\u2028\\u2029])').replace(/\\A/gu, '^').replace(/\\[zZ]/gu, '$')
  const intersections = translateJavaCharacterClassIntersections(source)
  if ('error' in intersections) return intersections
  source = intersections.pattern
  const properties = translateJavaUnicodeProperties(source)
  if ('error' in properties) return properties
  source = properties.pattern
  if (properties.unicode && !flags.includes('u')) flags += 'u'
  if (/\\(?:C|N\{)/u.test(source)) return { error: { code: 'unsupported-pattern', message: 'Java 正则字符转义暂不支持' } }
  let output = ''
  for (let index = 0; index < source.length;) {
    if (source.startsWith('\\Q', index)) {
      const end = source.indexOf('\\E', index + 2)
      if (end < 0) return { error: { code: 'invalid-pattern', message: 'Java 正则缺少 \\E 结束标记' } }
      output += escapeRegexLiteral(source.slice(index + 2, end))
      index = end + 2
      continue
    }
    output += source[index]!
    index += 1
  }
  if (/\(\?>/u.test(output)) return { error: { code: 'unsupported-pattern', message: 'Java 正则原子分组暂不支持' } }
  if (hasPossessiveQuantifier(output)) return { error: { code: 'unsupported-pattern', message: 'Java 正则占有量词暂不支持' } }
  return { pattern: output, flags }
}

/**
 * 将 Java Pattern 的常见字符类交集转换成 ECMAScript 的 lookahead 组合。
 *
 * Java 允许 `[a-z&&[^bc]]`、`[a-z&&[def]]` 等集合运算，ECMAScript
 * 没有对应的字符类运算符。把每个子类放进同一位置的 lookahead，再用
 * `\\s\\S` 消费一个字符，可以保持交集/差集的匹配结果；遇到不能明确
 * 分解的语法则保留能力诊断，避免静默扩大匹配范围。
 */
function translateJavaCharacterClassIntersections(source: string): { pattern: string } | { error: SourcePatternError } {
  let output = ''
  for (let index = 0; index < source.length;) {
    if (source[index] === '\\') {
      output += source.slice(index, index + 2)
      index += 2
      continue
    }
    if (source[index] !== '[') {
      output += source[index]!
      index += 1
      continue
    }
    const end = findCharacterClassEnd(source, index)
    if (end < 0) {
      output += source.slice(index)
      break
    }
    const raw = source.slice(index, end + 1)
    const converted = convertCharacterClassIntersection(raw)
    if ('error' in converted) return converted
    output += converted.pattern
    index = end + 1
  }
  return { pattern: output }
}

function findCharacterClassEnd(source: string, start: number): number {
  let depth = 0
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const current = source[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
      continue
    }
    if (current === '[') {
      depth += 1
      continue
    }
    if (current !== ']') continue
    depth -= 1
    if (depth === 0) return index
  }
  return -1
}

function convertCharacterClassIntersection(raw: string): { pattern: string } | { error: SourcePatternError } {
  const body = raw.slice(1, -1)
  const parts: string[] = []
  let start = 0
  let depth = 0
  let escaped = false
  for (let index = 0; index < body.length; index += 1) {
    const current = body[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
      continue
    }
    if (current === '[') {
      depth += 1
      continue
    }
    if (current === ']') {
      if (depth === 0) return { error: { code: 'invalid-pattern', message: 'Java 正则字符类括号不匹配' } }
      depth -= 1
      continue
    }
    if (depth !== 0 || current !== '&' || body[index + 1] !== '&') continue
    parts.push(body.slice(start, index))
    start = index + 2
    index += 1
  }
  if (depth !== 0) return { error: { code: 'invalid-pattern', message: 'Java 正则字符类括号不匹配' } }
  if (parts.length === 0) return { pattern: raw }
  parts.push(body.slice(start))
  if (parts.some((part) => part.length === 0)) return { error: { code: 'unsupported-pattern', message: 'Java 正则字符类交集缺少集合项' } }
  const classes: string[] = []
  for (const [partIndex, part] of parts.entries()) {
    if (partIndex === 0) {
      classes.push(part.startsWith('[') && part.endsWith(']') ? part : `[${part}]`)
      continue
    }
    if (!part.startsWith('[') || !part.endsWith(']') || findCharacterClassEnd(part, 0) !== part.length - 1) {
      return { error: { code: 'unsupported-pattern', message: 'Java 正则字符类交集只支持嵌套集合语法' } }
    }
    const nested = convertCharacterClassIntersection(part)
    if ('error' in nested) return nested
    classes.push(nested.pattern)
  }
  return { pattern: `(?:${classes.map((item) => `(?=${item})`).join('')}[\\s\\S])` }
}

function applyInlineFlags(current: string, flags: string, enable: boolean): string {
  let result = current
  for (const flag of flags) {
    if (flag === 'U') {
      if (enable && !result.includes('u')) result += 'u'
      if (!enable) result = result.replace('u', '')
      continue
    }
    if (enable && !result.includes(flag)) result += flag
    if (!enable) result = result.replace(flag, '')
  }
  return result
}

function hasPossessiveQuantifier(pattern: string): boolean {
  let escaped = false
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
      continue
    }
    if (current === '[') {
      inClass = true
      continue
    }
    if (current === ']' && inClass) {
      inClass = false
      continue
    }
    if (inClass) continue
    if ('*+?'.includes(current) && pattern[index + 1] === '+') return true
    if (current === '}') {
      const start = pattern.lastIndexOf('{', index)
      if (start >= 0 && pattern[index + 1] === '+' && /^\{\d+(?:,\d*)?\}$/u.test(pattern.slice(start, index + 1))) return true
    }
  }
  return false
}

/** Java Pattern 的 POSIX/历史 Unicode 属性与 ECMAScript 属性转义的有限等价映射。 */
function translateJavaUnicodeProperties(source: string): { pattern: string; unicode: boolean } | { error: SourcePatternError } {
  const aliases: Record<string, string> = {
    Lower: 'Lowercase_Letter',
    Upper: 'Uppercase_Letter',
    Alpha: 'Alphabetic',
    Digit: 'Decimal_Number',
    Alnum: '[\\p{Alphabetic}\\p{Decimal_Number}]',
    Punct: 'Punctuation',
    Space: 'White_Space',
    Blank: '[\\t\\p{Space_Separator}]',
    Cntrl: 'Control',
    XDigit: '[0-9A-Fa-f]',
    Graph: '[^\\p{White_Space}\\p{Control}\\p{Unassigned}]',
    Print: '[^\\p{Control}\\p{Unassigned}]',
    javaLowerCase: 'Lowercase_Letter',
    javaUpperCase: 'Uppercase_Letter',
    javaAlphabetic: 'Alphabetic',
    javaDigit: 'Decimal_Number',
    javaWhitespace: 'White_Space',
    javaMirrored: 'Bidi_Mirrored',
    IsAlphabetic: 'Alphabetic',
    IsLowercase: 'Lowercase_Letter',
    IsUppercase: 'Uppercase_Letter',
    IsDigit: 'Decimal_Number',
    IsWhite_Space: 'White_Space',
    IsHan: 'Script=Han',
  }
  let unicode = false
  let unsupported: string | undefined
  const pattern = source.replace(/\\([pP])\{([^{}]+)\}/gu, (_match, kind: string, property: string) => {
    let mapped = aliases[property] ?? (property.startsWith('In') ? `Script=${property.slice(2)}` : undefined)
    if (mapped === undefined) {
      try {
        new RegExp(`\\p{${property}}`, 'u')
        mapped = property
      } catch {
        unsupported = property
        return _match
      }
    }
    unicode = true
    if (mapped.startsWith('[')) return kind === 'p' ? mapped : `[^${mapped.slice(1)}`
    return `\\${kind}{${mapped}}`
  })
  if (unsupported !== undefined) return { error: { code: 'unsupported-pattern', message: `Java Unicode 属性 ${unsupported} 暂不支持` } }
  return { pattern, unicode }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}
