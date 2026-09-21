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
import type { JsonObject, JsonValue } from '../model/types.ts'

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

function modeOf(body: string, allInOne: boolean): { mode: RuleMode; body: string } {
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
  if (body.startsWith('<js>') && body.endsWith('</js>')) return { mode: 'Js', body: body.slice(4, -5) }
  return { mode: 'Default', body }
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
    try {
      const parsed = JSON.parse(body.slice(objectStart, objectEnd)) as JsonValue
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object')
      for (const [name, value] of Object.entries(parsed as JsonObject)) {
        if (typeof value !== 'string') throw new Error('rule must be string')
        const nested = compileInternal(value, { start: 0, end: value.length }, options)
        diagnostics.push(...nested.diagnostics)
        if (nested.rule !== undefined) puts.push({ name, rule: nested.rule })
      }
    } catch {
      diagnostics.push({ code: 'invalid-put', message: '@put 必须是键到规则字符串的 JSON 对象', span: trimmed.span, canContinue: false })
      return { diagnostics }
    }
    body = body.slice(objectEnd).trimStart()
  }

  const replacementParts = splitReplacement(body)
  if (replacementParts.diagnostic !== undefined) return { diagnostics: [...diagnostics, replacementParts.diagnostic] }
  if (replacementParts.parts.length > 4) {
    diagnostics.push({ code: 'unbalanced-rule', message: '替换表达式最多包含规则、匹配、替换和首项标记四段', span: trimmed.span, canContinue: false })
    return { diagnostics }
  }
  const mode = modeOf(replacementParts.parts[0] ?? '', options.allInOne ?? true)
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
  const precedence: Array<'||' | '%%' | '&&'> = ['||', '%%', '&&']
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
