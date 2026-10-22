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

interface ScopedPatternMode {
  ignoreCase: boolean
  multiline: boolean
  dotAll: boolean
  extended: boolean
  unixLines: boolean
}

interface ScopedFlagGroup {
  start: number
  enabled: string
  disabled: string
  contentStart: number
  end: number
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
 * `\Q...\E` 和边界转义是等价转换；简单原子上的占有量词和单原子原子组可用
 * 同原子负向前瞻固定贪婪边界，复杂分组没有等价的 ECMAScript 表达，必须返回明确诊断。
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
      if (!'imsuxUd'.includes(flag)) return { error: { code: 'unsupported-pattern', message: `Java 正则内联 flag ${flag} 暂不支持` } }
    }
    flags = applyInlineFlags(flags, enabled, true)
    flags = applyInlineFlags(flags, disabled, false)
    const extended = applyInlineExtended(false, enabled, true)
    const finalExtended = applyInlineExtended(extended, disabled, false)
    const unixLines = applyInlineUnixLines(false, enabled, true)
    const finalUnixLines = applyInlineUnixLines(unixLines, disabled, false)
    const scoped = translateScopedFlags(source, flags, finalExtended, finalUnixLines)
    if ('error' in scoped) return scoped
    source = scoped.pattern
    flags = scoped.flags
  } else {
    const scoped = translateScopedFlags(source, flags, false, false)
    if ('error' in scoped) return scoped
    source = scoped.pattern
    flags = scoped.flags
  }
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
  const atomic = translateSimpleAtomicGroups(output)
  if ('error' in atomic) return atomic
  output = atomic.pattern
  if (/\(\?>/u.test(output)) return { error: { code: 'unsupported-pattern', message: 'Java 正则复杂原子分组暂不支持' } }
  const possessive = translateJavaPossessiveQuantifiers(output)
  if ('error' in possessive) return possessive
  output = possessive.pattern
  if (hasPossessiveQuantifier(output)) return { error: { code: 'unsupported-pattern', message: 'Java 正则复杂占有量词暂不支持' } }
  return { pattern: output, flags }
}

/**
 * Java 的 `(?im-s:...)` 是局部作用域，而 ECMAScript 只有整条正则的 flags。
 * 对常见的 i/m/s/x/d 做词法展开，保留 `(?-i:...)` 这类书源写法；不能安全展开的
 * u/U 作用域继续明确返回能力错误，避免把局部语义错误地扩大到整条正则。
 */
function translateScopedFlags(source: string, inputFlags: string, initialExtended: boolean, initialUnixLines: boolean): { pattern: string; flags: string } | { error: SourcePatternError } {
  const first = findScopedFlagGroup(source, 0)
  if (first === undefined && !initialExtended && !initialUnixLines) return { pattern: source, flags: inputFlags }
  const unsupported = first === undefined ? undefined : `${first.enabled}${first.disabled}`.split('').find((flag) => !'imsxd'.includes(flag))
  if (unsupported !== undefined) return { error: { code: 'unsupported-pattern', message: `Java 正则作用域 flag ${unsupported} 暂不支持` } }
  const mode: ScopedPatternMode = {
    ignoreCase: inputFlags.includes('i'),
    multiline: inputFlags.includes('m'),
    dotAll: inputFlags.includes('s'),
    extended: initialExtended,
    unixLines: initialUnixLines,
  }
  const translated = translateScopedSegment(source, 0, source.length, mode, false)
  if ('error' in translated) return translated
  return { pattern: translated.pattern, flags: inputFlags.replace(/[ims]/gu, '') }
}

function translateScopedSegment(source: string, start: number, end: number, mode: ScopedPatternMode, groupContent: boolean): { pattern: string } | { error: SourcePatternError } {
  let output = ''
  let index = start
  while (index < end) {
    if (source.startsWith('\\Q', index)) {
      const quoteEnd = source.indexOf('\\E', index + 2)
      if (quoteEnd < 0 || quoteEnd >= end) return { error: { code: 'invalid-pattern', message: 'Java 正则缺少 \\E 结束标记' } }
      const quoted = source.slice(index + 2, quoteEnd)
      output += mode.ignoreCase ? foldQuotedLiteral(quoted) : source.slice(index, quoteEnd + 2)
      index = quoteEnd + 2
      continue
    }
    const scoped = findScopedFlagGroup(source, index)
    if (scoped !== undefined && scoped.start === index && scoped.end < end) {
      const nestedMode = applyScopedFlagMode(mode, scoped.enabled, scoped.disabled)
      if ('error' in nestedMode) return nestedMode
      const inner = translateScopedSegment(source, scoped.contentStart, scoped.end, nestedMode.mode, true)
      if ('error' in inner) return inner
      output += `(?:${inner.pattern})`
      index = scoped.end + 1
      continue
    }
    const current = source[index]!
    if (current === '\\') {
      const escaped = foldEscapedLiteral(source, index, end, mode.ignoreCase)
      output += escaped.text
      index = escaped.next
      continue
    }
    if (current === '[') {
      const classEnd = findCharacterClassEnd(source, index)
      if (classEnd < 0 || classEnd >= end) return { error: { code: 'invalid-pattern', message: 'Java 正则字符类括号不匹配' } }
      const raw = source.slice(index, classEnd + 1)
      const normalizedClass = mode.extended ? stripJavaExtendedCharacterClass(raw) : { pattern: raw }
      if ('error' in normalizedClass) return normalizedClass
      const classPattern = normalizedClass.pattern
      output += mode.ignoreCase ? foldCharacterClass(classPattern) : classPattern
      index = classEnd + 1
      continue
    }
    if (mode.extended && isJavaPatternWhitespace(current)) {
      index += 1
      continue
    }
    if (mode.extended && current === '#') {
      while (index < end && source[index] !== '\n' && source[index] !== '\r') index += 1
      if (groupContent && index >= end) return { error: { code: 'invalid-pattern', message: 'Java 正则 COMMENTS 注释吞掉了分组结束符' } }
      continue
    }
    if (current === '^' && mode.multiline) {
      output += mode.unixLines ? '(?:^|(?<=\\n))' : '(?:^|(?<=[\\r\\n]))'
      index += 1
      continue
    }
    if (current === '$' && mode.unixLines) {
      // Java UNIX_LINES 只把 LF 当作行终止符；过滤 ECMAScript 对 CR/Unicode 行终止符的额外匹配。
      output += mode.multiline ? '(?:(?:$|(?=\\n))(?![\\r\\u2028\\u2029]))' : '$(?![\\r\\u2028\\u2029])'
      index += 1
      continue
    }
    if (current === '$' && mode.multiline) {
      output += '(?:$|(?=[\\r\\n]))'
      index += 1
      continue
    }
    if (current === '.' && mode.dotAll) {
      output += '[\\s\\S]'
      index += 1
      continue
    }
    if (current === '.' && mode.unixLines) {
      output += '[^\\n]'
      index += 1
      continue
    }
    output += mode.ignoreCase ? foldPatternAtom(current) : current
    index += 1
  }
  return { pattern: output }
}

function findScopedFlagGroup(source: string, start: number): ScopedFlagGroup | undefined {
  let index = start
  let quoted = false
  while (index < source.length) {
    if (source.startsWith('\\Q', index)) {
      quoted = true
      index += 2
      continue
    }
    if (quoted) {
      if (source.startsWith('\\E', index)) quoted = false
      index += 1
      continue
    }
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === '[') {
      const classEnd = findCharacterClassEnd(source, index)
      if (classEnd < 0) return undefined
      index = classEnd + 1
      continue
    }
    if (source[index] !== '(' || source[index + 1] !== '?') {
      index += 1
      continue
    }
    let cursor = index + 2
    const enabledStart = cursor
    while (cursor < source.length && /[A-Za-z]/u.test(source[cursor]!)) cursor += 1
    const enabled = source.slice(enabledStart, cursor)
    let disabled = ''
    if (source[cursor] === '-') {
      cursor += 1
      const disabledStart = cursor
      while (cursor < source.length && /[A-Za-z]/u.test(source[cursor]!)) cursor += 1
      disabled = source.slice(disabledStart, cursor)
    }
    if ((enabled.length === 0 && disabled.length === 0) || source[cursor] !== ':') {
      index += 2
      continue
    }
    const contentStart = cursor + 1
    const end = findGroupEnd(source, contentStart)
    return end < 0 ? undefined : { start: index, enabled, disabled, contentStart, end }
  }
  return undefined
}

function findGroupEnd(source: string, contentStart: number): number {
  let depth = 1
  let index = contentStart
  while (index < source.length) {
    if (source.startsWith('\\Q', index)) {
      const quoteEnd = source.indexOf('\\E', index + 2)
      if (quoteEnd < 0) return -1
      index = quoteEnd + 2
      continue
    }
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === '[') {
      const classEnd = findCharacterClassEnd(source, index)
      if (classEnd < 0) return -1
      index = classEnd + 1
      continue
    }
    if (source[index] === '(') depth += 1
    else if (source[index] === ')' && --depth === 0) return index
    index += 1
  }
  return -1
}

function applyScopedFlagMode(mode: ScopedPatternMode, enabled: string, disabled: string): { mode: ScopedPatternMode } | { error: SourcePatternError } {
  const unsupported = `${enabled}${disabled}`.split('').find((flag) => !'imsxd'.includes(flag))
  if (unsupported !== undefined) return { error: { code: 'unsupported-pattern', message: `Java 正则作用域 flag ${unsupported} 暂不支持` } }
  const next = { ...mode }
  for (const flag of enabled) {
    if (flag === 'i') next.ignoreCase = true
    if (flag === 'm') next.multiline = true
    if (flag === 's') next.dotAll = true
    if (flag === 'x') next.extended = true
    if (flag === 'd') next.unixLines = true
  }
  for (const flag of disabled) {
    if (flag === 'i') next.ignoreCase = false
    if (flag === 'm') next.multiline = false
    if (flag === 's') next.dotAll = false
    if (flag === 'x') next.extended = false
    if (flag === 'd') next.unixLines = false
  }
  return { mode: next }
}

function applyInlineExtended(current: boolean, flags: string, enable: boolean): boolean {
  let result = current
  for (const flag of flags) if (flag === 'x') result = enable
  return result
}

function applyInlineUnixLines(current: boolean, flags: string, enable: boolean): boolean {
  let result = current
  for (const flag of flags) if (flag === 'd') result = enable
  return result
}

function isJavaPatternWhitespace(value: string): boolean {
  return /[ \t\n\x0B\f\r]/u.test(value)
}

function stripJavaExtendedCharacterClass(raw: string): { pattern: string } | { error: SourcePatternError } {
  let output = '['
  for (let index = 1; index < raw.length - 1;) {
    const current = raw[index]!
    if (current === '\\') {
      output += raw.slice(index, Math.min(raw.length - 1, index + 2))
      index += 2
      continue
    }
    if (current === '[') {
      const end = findCharacterClassEnd(raw, index)
      if (end < 0 || end >= raw.length - 1) return { error: { code: 'invalid-pattern', message: 'Java 正则字符类括号不匹配' } }
      const nested = stripJavaExtendedCharacterClass(raw.slice(index, end + 1))
      if ('error' in nested) return nested
      output += nested.pattern
      index = end + 1
      continue
    }
    if (isJavaPatternWhitespace(current)) {
      index += 1
      continue
    }
    if (current === '#') {
      while (index < raw.length - 1 && raw[index] !== '\n' && raw[index] !== '\r') index += 1
      if (index >= raw.length - 1) return { error: { code: 'invalid-pattern', message: 'Java 正则 COMMENTS 注释吞掉了字符类结束符' } }
      continue
    }
    output += current
    index += 1
  }
  return { pattern: `${output}]` }
}

function translateSimpleAtomicGroups(pattern: string): { pattern: string } | { error: SourcePatternError } {
  let output = ''
  let index = 0
  while (index < pattern.length) {
    if (pattern.startsWith('(?>', index)) {
      const end = findGroupEnd(pattern, index + 3)
      if (end < 0) return { error: { code: 'invalid-pattern', message: 'Java 正则原子分组括号不匹配' } }
      const content = pattern.slice(index + 3, end)
      const replacement = translateSimpleAtomicContent(content)
      if (replacement !== undefined) {
        output += replacement
        index = end + 1
        continue
      }
    }
    if (pattern[index] === '\\') {
      const end = readPatternEscapeEnd(pattern, index)
      output += pattern.slice(index, end)
      index = end
      continue
    }
    if (pattern[index] === '[') {
      const end = findCharacterClassEnd(pattern, index)
      if (end < 0) return { error: { code: 'invalid-pattern', message: 'Java 正则字符类括号不匹配' } }
      output += pattern.slice(index, end + 1)
      index = end + 1
      continue
    }
    output += pattern[index]!
    index += 1
  }
  return { pattern: output }
}

function translateSimpleAtomicContent(content: string): string | undefined {
  const atom = readSimplePatternAtom(content, 0)
  if (atom === undefined) return undefined
  if (atom.end === content.length) return atom.text
  const quantifier = readGreedyQuantifier(content, atom.end)
  if (quantifier === undefined || quantifier.end !== content.length) return undefined
  return `${atom.text}${quantifier.quantifier}(?!${atom.text})`
}

function readGreedyQuantifier(pattern: string, index: number): { quantifier: string; end: number } | undefined {
  const current = pattern[index]
  if (current === '*' || current === '+' || current === '?') {
    return pattern[index + 1] === '?' ? undefined : { quantifier: current, end: index + 1 }
  }
  if (current !== '{') return undefined
  const close = pattern.indexOf('}', index + 1)
  if (close < 0 || pattern[close + 1] === '?') return undefined
  const quantifier = pattern.slice(index, close + 1)
  return /^\{\d+(?:,\d*)?\}$/u.test(quantifier) ? { quantifier, end: close + 1 } : undefined
}

interface SimplePatternAtom {
  text: string
  end: number
}

function translateJavaPossessiveQuantifiers(pattern: string): { pattern: string } | { error: SourcePatternError } {
  let output = ''
  let index = 0
  let lastAtom: SimplePatternAtom | undefined
  while (index < pattern.length) {
    if (pattern[index] === '\\' && isUnsafePossessiveEscape(pattern[index + 1])) {
      const end = readPatternEscapeEnd(pattern, index)
      output += pattern.slice(index, end)
      index = end
      lastAtom = undefined
      continue
    }
    const atom = readSimplePatternAtom(pattern, index)
    if (atom !== undefined) {
      output += atom.text
      lastAtom = atom
      index = atom.end
      continue
    }
    const quantifier = readPossessiveQuantifier(pattern, index)
    if (quantifier !== undefined) {
      if (lastAtom?.end === index) {
        if (pattern[quantifier.end] !== undefined && '*+?{'.includes(pattern[quantifier.end]!)) {
          return { error: { code: 'invalid-pattern', message: 'Java 正则占有量词后出现重复量词' } }
        }
        output += `${quantifier.quantifier}(?!${lastAtom.text})`
        index = quantifier.end
        lastAtom = undefined
        continue
      }
      return { error: { code: 'unsupported-pattern', message: 'Java 正则复杂占有量词暂不支持' } }
    }
    output += pattern[index]!
    index += 1
    lastAtom = undefined
  }
  return { pattern: output }
}

function readSimplePatternAtom(pattern: string, index: number): SimplePatternAtom | undefined {
  const current = pattern[index]
  if (current === undefined) return undefined
  if (current === '\\') {
    if (isUnsafePossessiveEscape(pattern[index + 1])) return undefined
    const end = readPatternEscapeEnd(pattern, index)
    return { text: pattern.slice(index, end), end }
  }
  if (current === '[') {
    const end = findCharacterClassEnd(pattern, index)
    return end < 0 ? undefined : { text: pattern.slice(index, end + 1), end: end + 1 }
  }
  if (current === '.' || !/[\\^$*+?()[\]{}|]/u.test(current)) return { text: current, end: index + 1 }
  return undefined
}

function isUnsafePossessiveEscape(marker: string | undefined): boolean {
  return marker !== undefined && ('bBAGZzk'.includes(marker) || /\d/u.test(marker))
}

function readPatternEscapeEnd(pattern: string, index: number): number {
  const marker = pattern[index + 1]
  if (marker === undefined) return index + 1
  if ((marker === 'p' || marker === 'P') && pattern[index + 2] === '{') {
    const close = pattern.indexOf('}', index + 3)
    return close >= 0 ? close + 1 : index + 2
  }
  if ((marker === 'x' || marker === 'u') && pattern[index + 2] === '{') {
    const close = pattern.indexOf('}', index + 3)
    return close >= 0 ? close + 1 : index + 2
  }
  if (marker === 'k' && pattern[index + 2] === '<') {
    const close = pattern.indexOf('>', index + 3)
    return close >= 0 ? close + 1 : index + 2
  }
  return index + 2
}

function readPossessiveQuantifier(pattern: string, index: number): { quantifier: string; end: number } | undefined {
  const current = pattern[index]
  if (current === '*' || current === '+' || current === '?') {
    return pattern[index + 1] === '+' ? { quantifier: current, end: index + 2 } : undefined
  }
  if (current !== '{') return undefined
  const close = pattern.indexOf('}', index + 1)
  if (close < 0 || pattern[close + 1] !== '+') return undefined
  const quantifier = pattern.slice(index, close + 1)
  return /^\{\d+(?:,\d*)?\}$/u.test(quantifier) ? { quantifier, end: close + 2 } : undefined
}

function foldEscapedLiteral(source: string, index: number, end: number, ignoreCase: boolean): { text: string; next: number } {
  if (!ignoreCase) return { text: source.slice(index, Math.min(end, index + 2)), next: Math.min(end, index + 2) }
  const hex = /^\\x([0-9A-Fa-f]{2})/u.exec(source.slice(index, end))
  const unicode = /^\\u([0-9A-Fa-f]{4})/u.exec(source.slice(index, end))
  const match = hex ?? unicode
  if (match === null) return { text: source.slice(index, Math.min(end, index + 2)), next: Math.min(end, index + 2) }
  const value = String.fromCodePoint(Number.parseInt(match[1]!, 16))
  return { text: foldPatternLiteral(value), next: index + match[0].length }
}

function foldQuotedLiteral(value: string): string {
  return [...value].map((character) => foldPatternLiteral(character)).join('')
}

function foldPatternLiteral(value: string): string {
  if (value.length !== 1) return escapeRegexLiteral(value)
  const lower = value.toLowerCase()
  const upper = value.toUpperCase()
  if (lower === upper || lower.length !== 1 || upper.length !== 1) return escapeRegexLiteral(value)
  if (lower === value && upper === value) return escapeRegexLiteral(value)
  return `[${escapeRegexLiteral(lower)}${escapeRegexLiteral(upper)}]`
}

function foldPatternAtom(value: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(value) ? value : foldPatternLiteral(value)
}

function foldCharacterClass(raw: string): string {
  const body = raw.slice(1, -1)
  const prefix = body.startsWith('^') ? '^' : ''
  const value = prefix.length > 0 ? body.slice(1) : body
  let output = prefix
  for (let index = 0; index < value.length;) {
    if (value[index] === '\\') {
      output += value.slice(index, Math.min(value.length, index + 2))
      index += 2
      continue
    }
    if (value[index] === '[') {
      const end = findCharacterClassEnd(value, index)
      if (end >= 0) {
        output += foldCharacterClass(value.slice(index, end + 1))
        index = end + 1
        continue
      }
    }
    const first = value[index]!
    const second = value[index + 1]
    const third = value[index + 2]
    if (isCaseLetter(first) && second === '-' && third !== undefined && isCaseLetter(third)) {
      output += `${first}-${third}`
      const firstLower = first.toLowerCase()
      const thirdLower = third.toLowerCase()
      const firstUpper = first.toUpperCase()
      const thirdUpper = third.toUpperCase()
      if (`${firstLower}-${thirdLower}` !== `${first}-${third}`) output += `${firstLower}-${thirdLower}`
      if (`${firstUpper}-${thirdUpper}` !== `${first}-${third}` && `${firstUpper}-${thirdUpper}` !== `${firstLower}-${thirdLower}`) output += `${firstUpper}-${thirdUpper}`
      index += 3
      continue
    }
    output += isCaseLetter(first) ? `${first}${first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase()}` : first
    index += 1
  }
  return `[${output}]`
}

function isCaseLetter(value: string): boolean {
  return value.toLowerCase() !== value.toUpperCase() && value.length === 1
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
    if (flag === 'x') continue
    if (flag === 'd') continue
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
