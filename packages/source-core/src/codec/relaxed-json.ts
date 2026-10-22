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
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index += 1
      index += 1
      result += ' '
      continue
    }
    result += current
  }

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
