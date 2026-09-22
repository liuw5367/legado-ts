import { extractStaticJavaScript } from './static-javascript.ts'
import { normalizeSource } from './normalize.ts'
import { diagnostic, primaryError, safeLocation } from '../diagnostics/diagnostics.ts'
import type {
  ImportCandidate,
  ImportInput,
  ImportInputText,
  ImportInputUri,
  ImportLimits,
  ImportOptions,
  ImportOrigin,
  JsonObject,
  JsonValue,
  RawSource,
  SourceSnapshot,
} from '../model/types.ts'

const defaultLimits: ImportLimits = { maxCandidates: 1000, maxBytes: 4 * 1024 * 1024, maxSourceUrls: 32 }

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function jsonText(value: JsonValue): string {
  return JSON.stringify(value)
}

function emptyRaw(rawText: string, kind: RawSource['kind'], location?: string): RawSource {
  const originKind: ImportOrigin['kind'] = kind === 'javascript' ? 'javascript' : kind === 'uri' || kind === 'file' ? 'uri' : 'text'
  const origin: ImportOrigin = location === undefined ? { kind: originKind } : { kind: originKind, location: safeLocation(location) ?? location }
  return { rawText, kind, origin, parsed: null, unknownFields: {}, fieldShapes: {} }
}

function candidateError(candidate: Omit<ImportCandidate, 'error'>): ImportCandidate {
  const first = primaryError(candidate.diagnostics)
  if (first === undefined) return candidate
  return { ...candidate, error: { code: first.code, message: first.message, canRetry: first.retryable } }
}

function invalidCandidate(raw: RawSource, diagnostics: ImportCandidate['diagnostics'], id: string, replacements: ImportCandidate['replacements'] = []): ImportCandidate {
  return candidateError({ id, origin: raw.origin, rawText: raw.rawText, raw, unknownFields: raw.unknownFields, replacements, diagnostics, writable: false, status: 'invalid' })
}

function makeRaw(rawText: string, kind: RawSource['kind'], value: JsonValue, location?: string): RawSource {
  const originKind = kind === 'javascript' ? 'javascript' : kind === 'uri' || kind === 'file' ? 'uri' : 'text'
  const origin: ImportOrigin = location === undefined ? { kind: originKind } : { kind: originKind, location: safeLocation(location) ?? location }
  return { rawText, kind, origin, parsed: value, unknownFields: {}, fieldShapes: {} }
}

function applyReplacements(rawText: string, rules: ImportOptions['replacements'], name: string, url: string): { text: string; results: ImportCandidate['replacements']; diagnostics: ImportCandidate['diagnostics'] } {
  let text = rawText
  const results: ImportCandidate['replacements'] = []
  const diagnostics: ImportCandidate['diagnostics'] = []
  for (const rule of rules ?? []) {
    let nameMatches = true
    let urlMatches = true
    try {
      if (rule.namePattern !== undefined) nameMatches = new RegExp(rule.namePattern).test(name)
      if (rule.urlPattern !== undefined) urlMatches = new RegExp(rule.urlPattern).test(url)
    } catch {
      results.push({ ruleId: rule.ruleId, applied: false, error: '替换规则的匹配表达式无效' })
      diagnostics.push(diagnostic('replacement-failed', 'replace', '替换规则的匹配表达式无效', { retryable: false }))
      continue
    }
    if (!nameMatches || !urlMatches) {
      results.push({ ruleId: rule.ruleId, applied: false })
      continue
    }
    try {
      const replacement = new RegExp(rule.search, rule.all === false ? '' : 'g')
      const next = text.replace(replacement, rule.replacement)
      results.push({ ruleId: rule.ruleId, applied: next !== text })
      text = next
    } catch {
      results.push({ ruleId: rule.ruleId, applied: false, error: '替换规则执行失败' })
      diagnostics.push(diagnostic('replacement-failed', 'replace', '替换规则执行失败', { retryable: false }))
    }
  }
  return { text, results, diagnostics }
}

function parseJson(text: string): { value?: JsonValue; error?: string } {
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')) as JsonValue }
  } catch {
    return { error: '输入不是有效 JSON' }
  }
}

function replacementValue(text: string, kind: RawSource['kind']): JsonValue | undefined {
  if (kind === 'javascript') return extractStaticJavaScript(text).config ?? undefined
  return parseJson(text).value
}

function sourceUrls(value: JsonValue): string[] | null {
  if (!isObject(value) || !('sourceUrls' in value)) return null
  const urls = value.sourceUrls
  if (!Array.isArray(urls) || urls.some((item) => typeof item !== 'string' || item.trim() === '')) return []
  return urls as string[]
}

function matchLocal(source: SourceSnapshot | undefined, candidate: ImportCandidate): ImportCandidate {
  if (source === undefined || candidate.source === undefined) return candidate
  const local = JSON.stringify(source.source)
  const remote = JSON.stringify(candidate.source)
  if (local === remote) return { ...candidate, localMatch: 'same' }
  return { ...candidate, localMatch: 'update' }
}

function parseValue(value: JsonValue, rawText: string, kind: RawSource['kind'], id: string, options: ImportOptions, requireName = false): ImportCandidate {
  const raw = makeRaw(rawText, kind, value)
  const original = normalizeSource(value, raw, requireName)
  const originalSource = original.source
  const replacements = applyReplacements(rawText, options.replacements, originalSource?.bookSourceName ?? '', originalSource?.bookSourceUrl ?? '')
  const replacementDiagnostics = [...replacements.diagnostics]
  let normalized = original
  if (replacements.text !== rawText) {
    const replacedValue = replacementValue(replacements.text, kind)
    if (replacedValue === undefined) {
      replacementDiagnostics.push(diagnostic('replacement-failed', 'replace', '替换后的文本无法重新解析，已保留原始候选并禁止写入', { retryable: false }))
    } else {
      normalized = normalizeSource(replacedValue, raw, requireName)
    }
  }
  const source = normalized.source
  const diagnostics = [...normalized.diagnostics, ...replacementDiagnostics]
  const withRaw = { ...normalized.raw, parsed: value }
  const candidate: ImportCandidate = source === undefined
    ? invalidCandidate(withRaw, diagnostics, id, replacements.results)
    : candidateError({ id, origin: withRaw.origin, rawText, raw: withRaw, source, unknownFields: normalized.unknownFields, replacements: replacements.results, diagnostics, writable: !diagnostics.some((item) => item.severity === 'error'), status: diagnostics.some((item) => item.severity === 'error') ? 'invalid' : 'ready' })
  return matchLocal(options.localSnapshots?.get(source?.bookSourceUrl ?? ''), candidate)
}

function parseJavaScript(text: string, id: string, options: ImportOptions, dynamicHint = true): ImportCandidate {
  const extracted = extractStaticJavaScript(text)
  const raw = emptyRaw(text, 'javascript')
  if (extracted.config === null || extracted.source === undefined) {
    const diagnostics = [diagnostic(dynamicHint ? 'requires-javascript' : 'input-invalid-json', 'parse', dynamicHint ? extracted.error ?? '动态 JavaScript 书源需要 JavaScript 宿主' : '输入不是有效 JSON 或可识别的静态 JavaScript 书源')]
    return invalidCandidate(raw, diagnostics, id)
  }
  const candidate = parseValue(extracted.config, text, 'javascript', id, options, true)
  if (candidate.source !== undefined) candidate.source.mainJs = text
  candidate.raw.parsed = extracted.config
  return candidate
}

function parseText(text: string, id: string, options: ImportOptions, kind: RawSource['kind'] = 'json'): ImportCandidate[] {
  const parsed = parseJson(text)
  if (parsed.value !== undefined) {
    if (Array.isArray(parsed.value)) return parsed.value.map((item, index) => parseValue(item, JSON.stringify(item), 'json-array', `${id}-${index}`, options))
    return [parseValue(parsed.value, text, kind, id, options)]
  }
  return [parseJavaScript(text, id, options, /\b(?:config|source)\s*=/.test(text))]
}

function isStructuredInput(input: ImportInput): input is ImportInputText | ImportInputUri {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const kind = (input as { kind?: unknown }).kind
  return kind === 'text' || kind === 'javascript' || kind === 'uri' || kind === 'file' || kind === 'url'
}

function originLocation(input: ImportInputText | ImportInputUri): string | undefined {
  return input.origin === undefined ? undefined : input.origin.location
}

function readRequest(uri: string, maxBytes: number, signal: AbortSignal | undefined): { uri: string; maxBytes: number; signal?: AbortSignal } {
  return signal === undefined ? { uri, maxBytes } : { uri, maxBytes, signal }
}

export async function importSources(input: ImportInput, options: ImportOptions = {}): Promise<ImportCandidate[]> {
  const limits = { ...defaultLimits, ...options.limits }
  const candidates: ImportCandidate[] = []
  const add = (candidate: ImportCandidate): void => {
    if (candidates.length < limits.maxCandidates) candidates.push(candidate)
  }
  if (isCancelled(options.signal)) return [invalidCandidate(emptyRaw('', 'json'), [diagnostic('cancelled', 'input', '导入已取消', { retryable: true })], 'cancelled')]

  let text: string | undefined
  let value: JsonValue | undefined
  let inputKind: RawSource['kind'] = 'json'
  let location: string | undefined
  if (typeof input === 'string') text = input
  else if (isStructuredInput(input)) {
    if ('text' in input && typeof input.text === 'string') {
      text = input.text
      inputKind = input.kind === 'javascript' ? 'javascript' : 'json'
      location = originLocation(input)
    } else if ('uri' in input && typeof input.uri === 'string') {
      inputKind = input.kind === 'file' ? 'file' : 'uri'
      location = originLocation(input) ?? input.uri
      if (options.reader === undefined) return [invalidCandidate(emptyRaw('', inputKind, location), [diagnostic('reader-missing', 'fetch', 'URI 输入缺少受控读取端口', { retryable: false })], 'reader-missing')]
      try {
        const response = await options.reader.read(readRequest(input.uri, limits.maxBytes, options.signal))
        text = response.text
        location = response.location ?? location
      } catch {
        return [invalidCandidate(emptyRaw('', inputKind, location), [diagnostic('reader-failed', 'fetch', '受控读取失败', { retryable: true })], 'reader-failed')]
      }
    }
  } else {
    value = input
  }

  if (text !== undefined) {
    if (byteLength(text) > limits.maxBytes) return [invalidCandidate(emptyRaw(text, inputKind, location), [diagnostic('response-too-large', 'input', '输入超过字节限制', { retryable: false })], 'too-large')]
    if (inputKind === 'javascript') add(parseJavaScript(text, 'source-0', options))
    else {
      const parsed = parseJson(text)
      if (parsed.value === undefined) add(parseJavaScript(text, 'source-0', options, /\b(?:config|source)\s*=/.test(text)))
      else value = parsed.value
    }
  }

  if (value !== undefined) {
    const urls = sourceUrls(value)
    if (urls !== null) {
      if (urls.length === 0 || urls.length > limits.maxSourceUrls) return [invalidCandidate(emptyRaw(jsonText(value), 'json'), [diagnostic(urls.length === 0 ? 'source-urls-invalid' : 'source-urls-limit', 'input', 'sourceUrls 必须是非空且不超过上限的字符串数组', { retryable: false })], 'source-urls')]
      if (options.reader === undefined) return [invalidCandidate(emptyRaw(jsonText(value), 'json'), [diagnostic('reader-missing', 'fetch', 'sourceUrls 输入缺少受控读取端口', { retryable: false })], 'source-urls-reader')]
      for (const [index, uri] of urls.entries()) {
        if (isCancelled(options.signal)) {
          add(invalidCandidate(emptyRaw('', 'uri', uri), [diagnostic('cancelled', 'fetch', '导入已取消', { retryable: true })], `source-${index}-cancelled`))
          break
        }
        try {
          const response = await options.reader.read(readRequest(uri, limits.maxBytes, options.signal))
          for (const candidate of parseText(response.text, `source-${index}`, options)) add(candidate)
        } catch {
          add(invalidCandidate(emptyRaw('', 'uri', uri), [diagnostic(isCancelled(options.signal) ? 'cancelled' : 'reader-failed', 'fetch', isCancelled(options.signal) ? '导入已取消' : 'sourceUrls 成员读取失败', { retryable: true })], `source-${index}-reader`))
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => add(parseValue(item, JSON.stringify(item), 'json-array', `source-${index}`, options)))
    } else {
      add(parseValue(value, text ?? jsonText(value), inputKind, 'source-0', options))
    }
  }

  if (candidates.length === 0) add(invalidCandidate(emptyRaw('', 'json'), [diagnostic('input-empty', 'input', '没有可导入的书源', { retryable: false })], 'empty'))
  return candidates
}
