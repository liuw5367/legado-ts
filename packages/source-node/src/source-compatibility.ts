import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { compileRule, importSources, inspectRuleCapabilities } from '@legado/source-core'
import type { ImportCandidate, NormalizedSource, RuleCapability } from '@legado/source-core'

export const sourceFixtureFiles = [
  'fixtures/source/collection/13655_c5880332228edeffa2ce977a525a6b21.json',
  'fixtures/source/collection/14328_c803e1b071690d18ce7acb5184727058.json',
  'fixtures/source/single/1790039793-起点.json',
  'fixtures/source/single/1790040141-豆瓣.json',
] as const

const ruleGroups = ['ruleExplore', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview'] as const

export interface SourceFixtureCandidate {
  readonly file: string
  readonly index: number
  readonly candidate: ImportCandidate
}

export interface StaticRuleRecord {
  readonly group: string
  readonly field: string
  readonly sourceHash: string
  readonly capabilities: RuleCapability[]
  readonly compiled: boolean
  readonly diagnostics: string[]
}

export interface StaticSourceRecord {
  readonly file: string
  readonly index: number
  readonly candidateId: string
  readonly sourceHash: string
  readonly sourceFingerprint?: string
  readonly name: string
  readonly host?: string
  readonly status: ImportCandidate['status']
  readonly importDiagnostics: string[]
  readonly ruleCount: number
  readonly compiledRuleCount: number
  readonly parseable: boolean
  readonly compileDiagnostics: Readonly<Record<string, number>>
  readonly capabilities: RuleCapability[]
  readonly flags: string[]
}

export interface StaticCompatibilityReport {
  readonly version: 1
  readonly keyword: string
  readonly generatedAt: string
  readonly summary: {
    candidates: number
    ready: number
    invalid: number
    rules: number
    compiledRules: number
    uncompiledRules: number
    parseableSources: number
    capabilityCounts: Readonly<Record<string, number>>
    diagnosticCounts: Readonly<Record<string, number>>
    flagCounts: Readonly<Record<string, number>>
  }
  readonly sources: StaticSourceRecord[]
  readonly rules: StaticRuleRecord[]
}

export function sourceFixtureCandidateId(item: Pick<SourceFixtureCandidate, 'file' | 'index'>): string {
  return `${item.file}#${item.index}`
}

function sourceHash(source: NormalizedSource | undefined, candidate: ImportCandidate): string {
  const value = source === undefined ? candidate.rawText : JSON.stringify(source)
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function hostOf(source: NormalizedSource | undefined): string | undefined {
  if (source === undefined) return undefined
  try {
    return new URL(source.bookSourceUrl).hostname
  } catch {
    return undefined
  }
}

function sourceText(source: NormalizedSource): string {
  return JSON.stringify(source)
}

function count(values: Iterable<string>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const value of values) result[value] = (result[value] ?? 0) + 1
  return result
}

function ruleEntries(source: NormalizedSource): Array<{ group: string; field: string; value: string }> {
  const result: Array<{ group: string; field: string; value: string }> = []
  for (const group of ruleGroups) {
    const value = source[group]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    for (const [field, rule] of Object.entries(value)) if (typeof rule === 'string' && rule.length > 0) result.push({ group, field, value: rule })
  }
  return result
}

function flagsOf(source: NormalizedSource): string[] {
  const text = sourceText(source)
  const flags: string[] = []
  if (text.includes('<js>') || /@js:/i.test(text)) flags.push('javascript')
  if (typeof source.searchUrl === 'string' && source.searchUrl.includes(',')) flags.push('request-options')
  if (typeof source.searchUrl === 'string' && (source.searchUrl.includes('<js>') || source.searchUrl.toLowerCase().includes('@js:'))) flags.push('dynamic-url')
  if (text.includes('webView') && /"webView"\s*:\s*true/i.test(text)) flags.push('webview')
  if (typeof source.loginUrl === 'string' && source.loginUrl.length > 0) flags.push('login')
  if (/authorization\s*[:=]|["']cookie["']\s*:/i.test(text)) flags.push('sensitive-header')
  if (/font|字体|replaceFont/i.test(text)) flags.push('font')
  if (/aes|des|md5|sha\d|base64|hexDecode|crypto/i.test(text)) flags.push('crypto')
  try {
    const url = new URL(source.bookSourceUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') flags.push('non-http-url')
  } catch {
    flags.push('invalid-url')
  }
  return flags
}

export async function loadSourceFixtureCandidates(root = new URL('../../../', import.meta.url)): Promise<SourceFixtureCandidate[]> {
  const result: SourceFixtureCandidate[] = []
  for (const file of sourceFixtureFiles) {
    const input = await readFile(new URL(file, root), 'utf8')
    const candidates = await importSources(input)
    for (const [index, candidate] of candidates.entries()) result.push({ file, index, candidate })
  }
  return result
}

export function buildStaticCompatibilityReport(items: readonly SourceFixtureCandidate[], keyword = '我本无意成仙'): StaticCompatibilityReport {
  const rules: StaticRuleRecord[] = []
  const sources: StaticSourceRecord[] = []
  for (const item of items) {
    const source = item.candidate.source
    const hash = sourceHash(source, item.candidate)
    const host = hostOf(source)
    const sourceRules = source === undefined ? [] : ruleEntries(source)
    const compileDiagnostics: Record<string, number> = {}
    const capabilities = new Set<RuleCapability>()
    let compiledRuleCount = 0
    for (const entry of sourceRules) {
      const result = compileRule(entry.value)
      if (result.rule !== undefined) {
        compiledRuleCount += 1
        for (const capability of inspectRuleCapabilities(result.rule)) capabilities.add(capability)
      }
      for (const diagnostic of result.diagnostics) compileDiagnostics[diagnostic.code] = (compileDiagnostics[diagnostic.code] ?? 0) + 1
      rules.push({ group: entry.group, field: entry.field, sourceHash: hash, capabilities: result.rule === undefined ? [] : inspectRuleCapabilities(result.rule), compiled: result.rule !== undefined, diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code) })
    }
    sources.push({
      file: item.file,
      index: item.index,
      candidateId: sourceFixtureCandidateId(item),
      sourceHash: hash,
      ...(item.candidate.sourceFingerprint === undefined ? {} : { sourceFingerprint: item.candidate.sourceFingerprint }),
      name: source?.bookSourceName ?? '',
      ...(host === undefined ? {} : { host }),
      status: item.candidate.status,
      importDiagnostics: item.candidate.diagnostics.map((diagnostic) => diagnostic.code),
      ruleCount: sourceRules.length,
      compiledRuleCount,
      parseable: item.candidate.status === 'ready' && compiledRuleCount === sourceRules.length,
      compileDiagnostics,
      capabilities: [...capabilities].sort(),
      flags: source === undefined ? ['invalid-source'] : flagsOf(source),
    })
  }
  return {
    version: 1,
    keyword,
    generatedAt: new Date().toISOString(),
    summary: {
      candidates: sources.length,
      ready: sources.filter((source) => source.status === 'ready').length,
      invalid: sources.filter((source) => source.status === 'invalid').length,
      rules: rules.length,
      compiledRules: rules.filter((rule) => rule.compiled).length,
      uncompiledRules: rules.filter((rule) => !rule.compiled).length,
      parseableSources: sources.filter((source) => source.parseable).length,
      capabilityCounts: count(rules.flatMap((rule) => rule.capabilities)),
      diagnosticCounts: count(rules.flatMap((rule) => rule.diagnostics)),
      flagCounts: count(sources.flatMap((source) => source.flags)),
    },
    sources,
    rules,
  }
}
