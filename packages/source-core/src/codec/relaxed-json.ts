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

export function normalizeRelaxedJson(input: string): string {
  let result = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!
    const next = input[index + 1]
    if (quote === 'double') {
      result += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') quote = null
      continue
    }
    if (quote === 'single') {
      if (escaped) {
        result += current === '"' ? '\\"' : current === '\\' || current === "'" ? current : `\\${current}`
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
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index += 1
      index += 1
      result += ' '
      continue
    }
    result += current
  }
  result = result.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/gu, '$1"$2":')
  result = result.replace(/,\s*([}\]])/gu, '$1')
  // 单引号字符串里的未知反斜杠不是 JSON 转义；补成字面反斜杠，避免 c\\d 变成非法 JSON。
  result = result.replace(/\\(?!["\\/bfnrtu])/gu, '\\\\')
  return result
}
