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
  /** 复杂度守卫：`reject` 一律拒绝；`reject-large-input` 只在输入超过阈值时拒绝。 */
  complexity?: 'reject' | 'reject-large-input'
  /** 本次匹配的输入规模（字符数）；`reject-large-input` 需要它。 */
  inputLength?: number
}

/** 长度上限：语料最长 981，取 2048 留一倍余量。 */
const maxSourcePatternLength = 2048
/** 超过这个输入规模才把嵌套量词当成风险；真实章节正文远小于它。 */
const complexityGuardInputLength = 64 * 1024
/**
 * 教科书式灾难回溯形态：`(a+)+`、`([a-z]*)*`、`(ab+){2,}`。
 * 组体只允许「简单原子序列 + 单个无界量词」，所以 `(?:[a-zA-Z0-9-]+\.)+` 这类带分隔符的合法写法不受影响。
 */
const nestedQuantifier = /\(((?:\\.|\[[^\]]*\]|[^\\[\]()|])+[*+])\)\s*[*+{]/

export function compileSourcePattern(pattern: string, options: SourcePatternOptions = {}): { regex: RegExp } | { error: SourcePatternError } {
  if (pattern.length > maxSourcePatternLength) return { error: { code: 'pattern-too-long', message: `书源正则超过长度上限（${maxSourcePatternLength} 字符）` } }
  if (nestedQuantifier.test(pattern)) {
    if ((options.complexity ?? 'reject') === 'reject') return { error: { code: 'pattern-complexity', message: '书源正则存在嵌套量词，可能造成灾难性回溯' } }
    if ((options.inputLength ?? 0) > complexityGuardInputLength) return { error: { code: 'pattern-complexity', message: '书源正则存在嵌套量词，输入超过 64 KiB 时拒绝执行' } }
  }
  try {
    return { regex: new RegExp(pattern, options.flags ?? '') }
  } catch {
    return { error: { code: 'invalid-pattern', message: '书源正则无法编译' } }
  }
}
