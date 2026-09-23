import { splitReplacement, splitTopLevel } from './scanner.ts'
import type {
  CompiledRule,
  RuleAtom,
  RuleCapability,
  RuleCompileOptions,
  RuleCompileResult,
  RuleDiagnostic,
  RuleMode,
  RulePut,
  RuleReplacement,
  RuleSequence,
  RuleSpan,
} from './types.ts'

const capabilityByMode: Record<RuleMode, RuleCapability[]> = {
  Default: ['text', 'variables', 'parser:html'],
  XPath: ['parser:xpath'],
  Json: ['parser:json'],
  Js: ['javascript'],
  Regex: ['regex'],
  WebJs: ['webview'],
}

function uniqueCapabilities(nodes: readonly CompiledRule[]): RuleCapability[] {
  return [...new Set(nodes.flatMap((node) => node.capabilities))]
}

function capabilitiesFor(mode: RuleMode, body: string): RuleCapability[] {
  if (mode === 'Default' && (body === '' || body === 'text' || body === 'ownText' || body === 'html' || body.startsWith('literal:') || body.includes('@get:') || body.includes('{{'))) return ['text', 'variables']
  return capabilityByMode[mode]
}

function trimPart(text: string, start: number, end: number): { text: string; span: RuleSpan } {
  const left = text.length - text.trimStart().length
  const trimmed = text.trim()
  return { text: trimmed, span: { start: start + left, end: end - (text.length - text.trimEnd().length) } }
}

function findBalancedEnd(input: string, start: number): number | undefined {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  for (let index = start; index < input.length; index += 1) {
    const current = input[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === '{') depth += 1
    else if (current === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

function modeOf(body: string, allInOne: boolean, defaultMode: 'Default' | 'Json' = 'Default'): { mode: RuleMode; body: string } {
  if (body.startsWith('@@')) return { mode: 'Default', body: body.slice(2) }
  const prefix = /^@(css|xpath|json|js|webjs):/i.exec(body)
  if (prefix !== null) {
    const modeByPrefix: Record<string, RuleMode> = { css: 'Default', xpath: 'XPath', json: 'Json', js: 'Js', webjs: 'WebJs' }
    const mode = modeByPrefix[prefix[1]!.toLowerCase()]!
    return { mode, body: body.slice(prefix[0].length) }
  }
  if (allInOne && body.startsWith(':')) return { mode: 'Regex', body: body.slice(1) }
  if (body.startsWith('$.') || body.startsWith('$[')) return { mode: 'Json', body }
  if (body.startsWith('/')) return { mode: 'XPath', body }
  if (body.startsWith('<js>')) {
    const end = body.indexOf('</js>', '<js>'.length)
    return { mode: 'Js', body: end < 0 ? body.slice('<js>'.length) : body.slice('<js>'.length, end) }
  }
  return { mode: defaultMode, body }
}

function isOpaqueScriptRule(input: string): boolean {
  const trimmed = input.trim()
  return /^@(?:js|webjs):/i.test(trimmed) || trimmed.startsWith('<js>') || /<js>|@js:/i.test(trimmed)
}

function decodeSingleQuoted(input: string): string {
  let result = ''
  let escaped = false
  for (const current of input) {
    if (!escaped) {
      if (current === '\\') escaped = true
      else result += current
      continue
    }
    escaped = false
    if (current === 'n') result += '\n'
    else if (current === 'r') result += '\r'
    else if (current === 't') result += '\t'
    else result += current
  }
  return result
}

function readQuoted(input: string, start: number): { value: string; next: number } | undefined {
  const quote = input[start]
  if (quote !== '"' && quote !== "'") return undefined
  let escaped = false
  let value = ''
  for (let index = start + 1; index < input.length; index += 1) {
    const current = input[index]!
    if (escaped) {
      value += `\\${current}`
      escaped = false
    } else if (current === '\\') escaped = true
    else if (current === quote) {
      return { value: quote === '"' ? JSON.parse(`"${value}"`) as string : decodeSingleQuoted(value), next: index + 1 }
    } else value += current
  }
  return undefined
}

function readUnquoted(input: string, start: number): { value: string; next: number } | undefined {
  let square = 0
  let round = 0
  let curly = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  for (let index = start; index < input.length; index += 1) {
    const current = input[index]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'" || current === '`') quote = current
    else if (current === '[') square += 1
    else if (current === ']') square = Math.max(0, square - 1)
    else if (current === '(') round += 1
    else if (current === ')') round = Math.max(0, round - 1)
    else if (current === '{') curly += 1
    else if (current === '}') curly = Math.max(0, curly - 1)
    else if (current === ',' && square === 0 && round === 0 && curly === 0) {
      const value = input.slice(start, index).trim()
      return value.length === 0 ? undefined : { value, next: index }
    }
  }
  const value = input.slice(start).trim()
  return value.length === 0 ? undefined : { value, next: input.length }
}

/** Parse the relaxed object syntax used by Android's @put rules. */
function parsePutObject(input: string): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  let index = 0
  while (index < input.length) {
    while (/\s|,/.test(input[index] ?? '')) index += 1
    if (index >= input.length) return result
    const quotedKey = readQuoted(input, index)
    let key: string
    if (quotedKey !== undefined) {
      key = quotedKey.value
      index = quotedKey.next
    } else {
      const match = /^[A-Za-z_$][\w$-]*/.exec(input.slice(index))
      if (match === null) return undefined
      key = match[0]
      index += key.length
    }
    while (/\s/.test(input[index] ?? '')) index += 1
    if (input[index] !== ':') return undefined
    index += 1
    while (/\s/.test(input[index] ?? '')) index += 1
    const quotedValue = readQuoted(input, index)
    const value = quotedValue ?? readUnquoted(input, index)
    if (value === undefined) return undefined
    result[key] = value.value
    index = value.next
    while (/\s/.test(input[index] ?? '')) index += 1
    if (index < input.length && input[index] !== ',') return undefined
  }
  return result
}

function compileAtom(input: string, span: RuleSpan, options: RuleCompileOptions): RuleCompileResult {
  const diagnostics: RuleDiagnostic[] = []
  const trimmed = trimPart(input, span.start, span.end)
  let body = trimmed.text
  const puts: RulePut[] = []
  while (body.toLowerCase().startsWith('@put:')) {
    const objectStart = body.indexOf('{', 5)
    if (objectStart < 0) {
      diagnostics.push({ code: 'invalid-put', message: '@put 缺少 JSON 对象', span: trimmed.span, canContinue: false })
      return { diagnostics }
    }
    const objectEnd = findBalancedEnd(body, objectStart)
    if (objectEnd === undefined) {
      diagnostics.push({ code: 'invalid-put', message: '@put 对象不平衡', span: trimmed.span, canContinue: false })
      return { diagnostics }
    }
    const parsed = parsePutObject(body.slice(objectStart + 1, objectEnd - 1))
    if (parsed === undefined) {
      diagnostics.push({ code: 'invalid-put', message: '@put 必须是键到规则字符串的 JSON 对象', span: trimmed.span, canContinue: false })
      return { diagnostics }
    }
    for (const [name, value] of Object.entries(parsed)) {
      const nested = compileInternal(value, { start: 0, end: value.length }, options)
      diagnostics.push(...nested.diagnostics)
      if (nested.rule !== undefined) puts.push({ name, rule: nested.rule })
    }
    body = body.slice(objectEnd).trimStart()
  }

  const opaque = isOpaqueScriptRule(trimmed.text) || ((options.allInOne ?? true) && trimmed.text.startsWith(':'))
  const replacementParts = opaque ? { parts: [body] } : splitReplacement(body)
  if (replacementParts.diagnostic !== undefined) return { diagnostics: [...diagnostics, replacementParts.diagnostic] }
  if (replacementParts.parts.length > 4) {
    diagnostics.push({ code: 'unbalanced-rule', message: '替换表达式最多包含规则、匹配、替换和首项标记四段', span: trimmed.span, canContinue: false })
    return { diagnostics }
  }
  const mode = modeOf(replacementParts.parts[0] ?? '', options.allInOne ?? true, options.defaultMode)
  const replacement: RuleReplacement | undefined = replacementParts.parts.length >= 2
    ? { pattern: replacementParts.parts[1]!, replacement: replacementParts.parts[2] ?? '', firstMatchOnly: replacementParts.parts.length === 4 }
    : undefined
  if (mode.mode === 'Regex') {
    try {
      new RegExp(mode.body)
    } catch {
      diagnostics.push({ code: 'invalid-regex', message: 'Regex 规则无法编译', span: trimmed.span, canContinue: false })
    }
  }
  const atom: RuleAtom = { kind: 'atom', source: input, span: trimmed.span, mode: mode.mode, body: mode.body, capabilities: capabilitiesFor(mode.mode, mode.body), puts }
  if (replacement !== undefined) atom.replacement = replacement
  return diagnostics.length === 0 ? { rule: atom, diagnostics } : { diagnostics }
}

function compileInternal(input: string, span: RuleSpan, options: RuleCompileOptions): RuleCompileResult {
  const trimmed = trimPart(input, span.start, span.end)
  const leadingRegex = (options.allInOne ?? true) && trimmed.text.startsWith(':')
  if (isOpaqueScriptRule(trimmed.text) || (leadingRegex && !trimmed.text.includes('%%'))) return compileAtom(trimmed.text, trimmed.span, options)
  const precedence: Array<'||' | '%%' | '&&'> = leadingRegex ? ['%%'] : ['||', '%%', '&&']
  for (const operator of precedence) {
    const split = splitTopLevel(trimmed.text, operator)
    if (split.diagnostic !== undefined) return { diagnostics: [{ ...split.diagnostic, span: { start: trimmed.span.start + split.diagnostic.span!.start, end: trimmed.span.start + split.diagnostic.span!.end } }] }
    if (split.parts.length > 1) {
      const children: CompiledRule[] = []
      const diagnostics: RuleDiagnostic[] = []
      for (const part of split.parts) {
        const child = compileInternal(part.text, { start: trimmed.span.start + part.start, end: trimmed.span.start + part.end }, options)
        diagnostics.push(...child.diagnostics)
        if (child.rule !== undefined) children.push(child.rule)
      }
      if (diagnostics.length > 0) return { diagnostics }
      const sequence: RuleSequence = { kind: 'sequence', operator, source: trimmed.text, span: trimmed.span, children, capabilities: uniqueCapabilities(children) }
      return { rule: sequence, diagnostics }
    }
  }
  return compileAtom(trimmed.text, trimmed.span, options)
}

export function compileRule(input: string, options: RuleCompileOptions = {}): RuleCompileResult {
  return compileInternal(input, { start: 0, end: input.length }, options)
}

export function inspectRuleCapabilities(rule: CompiledRule): RuleCapability[] {
  return [...rule.capabilities]
}
