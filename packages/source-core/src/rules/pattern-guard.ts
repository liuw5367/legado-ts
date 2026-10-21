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
 * `\Q...\E` 和边界转义是等价转换，占有量词去掉 `+` 后只保留匹配集合，
 * 仍受上面的长度/回溯守卫约束；字符类交集与作用域 flags 暂时返回明确诊断。
 */
function translateJavaPattern(pattern: string, inputFlags: string): JavaPatternTranslation | { error: SourcePatternError } {
  let flags = inputFlags
  let source = pattern
  const inline = /^\(\?([imsUdx-]+)\)/u.exec(source)
  if (inline !== null) {
    source = source.slice(inline[0].length)
    for (const flag of inline[1]!) {
      if (flag === '-') continue
      if ('imsu'.includes(flag) && !flags.includes(flag)) flags += flag
      if (!'imsu'.includes(flag)) return { error: { code: 'unsupported-pattern', message: `Java 正则内联 flag ${flag} 暂不支持` } }
    }
  }
  if (/\(\?[imsUdx-]+:/u.test(source)) return { error: { code: 'unsupported-pattern', message: 'Java 正则作用域 flag 暂不支持' } }
  if (/\[[^\]]*&&/u.test(source)) return { error: { code: 'unsupported-pattern', message: 'Java 正则字符类交集暂不支持' } }
  source = source.replace(/\\R/gu, '(?:\\r\\n|[\\n\\r\\u2028\\u2029])').replace(/\\A/gu, '^').replace(/\\[zZ]/gu, '$')
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
  // ECMAScript 没有占有量词；去除占有标记保留 Java 的匹配集合，复杂度由守卫控制。
  output = output.replace(/(\*|\+|\?|\{\d+(?:,\d*)?\})\+/gu, '$1')
  return { pattern: output, flags }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}
