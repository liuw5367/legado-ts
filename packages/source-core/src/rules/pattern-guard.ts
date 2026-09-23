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

export type SourcePatternErrorCode = 'pattern-too-long' | 'pattern-complexity' | 'invalid-pattern'

export interface SourcePatternError {
  /** 稳定分类，调用方据此给出诊断。 */
  code: SourcePatternErrorCode
  message: string
}

export interface SourcePatternOptions {
  /** 传给 RegExp 的标志；默认无标志，调用方按匹配语义显式传入。 */
  flags?: string
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
  if (pattern.length > maxSourcePatternLength) return { error: { code: 'pattern-too-long', message: `书源正则超过长度上限（${maxSourcePatternLength} 字符）` } }
  if (hasUnanchoredNesting(pattern)) return { error: { code: 'pattern-complexity', message: '书源正则存在未锚定的嵌套量词，可能造成灾难性回溯' } }
  try {
    return { regex: new RegExp(pattern, options.flags ?? '') }
  } catch {
    return { error: { code: 'invalid-pattern', message: '书源正则无法编译' } }
  }
}
