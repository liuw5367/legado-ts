import { diagnostic } from '../diagnostics/diagnostics.ts'
import type { ImportDiagnostic, JsonObject, JsonValue, NormalizedSource, RawSource } from '../model/types.ts'

const ruleFields = ['ruleExplore', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview'] as const

const knownFields = new Set([
  'bookSourceUrl',
  'bookSourceName',
  'bookSourceGroup',
  'bookSourceType',
  'bookUrlPattern',
  'customOrder',
  'enabled',
  'enabledExplore',
  'jsLib',
  'enabledCookieJar',
  'concurrentRate',
  'header',
  'loginUrl',
  'loginUi',
  'loginCheckJs',
  'coverDecodeJs',
  'bookSourceComment',
  'variableComment',
  'lastUpdateTime',
  'respondTime',
  'weight',
  'exploreUrl',
  'exploreScreen',
  'searchUrl',
  'mainJs',
  'eventListener',
  'customButton',
  'sourceUrls',
  ...ruleFields,
])

const defaults: Record<string, JsonValue> = {
  bookSourceName: '',
  bookSourceType: 0,
  customOrder: 0,
  enabled: true,
  enabledExplore: true,
  lastUpdateTime: 0,
  respondTime: 180000,
  weight: 0,
  eventListener: false,
  customButton: false,
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(clone)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

function parseRule(value: JsonValue, path: string, diagnostics: ImportDiagnostic[]): JsonValue {
  if (value === null || value === '') return null
  // Android exports an empty rule group as `[]` (most commonly an unused
  // explore group).  It is a valid, intentionally incomplete configuration,
  // not a malformed source.  Keep the shape so the runtime can treat the
  // missing individual rules as unsupported/empty at the workflow boundary.
  if (isObject(value) || Array.isArray(value)) return clone(value)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as JsonValue
      if (isObject(parsed)) return parsed
    } catch {
      // 规则文本的求值属于阶段 02；此处只接受序列化规则对象。
    }
  }
  diagnostics.push(diagnostic('rule-invalid', 'normalize', '规则字段不是对象或有效的 JSON 对象字符串', { path }))
  return null
}

export interface NormalizationResult {
  raw: RawSource
  source?: NormalizedSource
  unknownFields: JsonObject
  diagnostics: ImportDiagnostic[]
}

export function normalizeSource(value: JsonValue, raw: RawSource, requireName = false): NormalizationResult {
  const diagnostics: ImportDiagnostic[] = []
  if (!isObject(value)) {
    diagnostics.push(diagnostic('input-not-object', 'parse', '书源必须是 JSON 对象'))
    return { raw, unknownFields: {}, diagnostics }
  }

  const url = value.bookSourceUrl
  if (typeof url !== 'string' || url.trim() === '') {
    diagnostics.push(diagnostic('source-url-missing', 'normalize', '缺少非空 bookSourceUrl', { path: 'bookSourceUrl' }))
  }
  const name = value.bookSourceName
  if (typeof name !== 'string') {
    diagnostics.push(diagnostic('source-name-missing', 'normalize', 'JSON 书源缺少 bookSourceName，规范化为空字符串', { severity: requireName ? 'error' : 'info', path: 'bookSourceName' }))
  } else if (requireName && name.trim() === '') {
    diagnostics.push(diagnostic('source-name-missing', 'normalize', 'JavaScript 书源要求非空 bookSourceName', { path: 'bookSourceName' }))
  }

  const unknownFields: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (!knownFields.has(key)) unknownFields[key] = clone(item)
  }

  const normalized: JsonObject = {}
  for (const [key, defaultValue] of Object.entries(defaults)) normalized[key] = defaultValue
  for (const [key, item] of Object.entries(value)) normalized[key] = clone(item)
  normalized.bookSourceUrl = typeof url === 'string' ? url : ''
  normalized.bookSourceName = typeof name === 'string' ? name : ''

  const type = normalized.bookSourceType
  if (typeof type !== 'number' || !Number.isInteger(type)) {
    diagnostics.push(diagnostic('source-type-invalid', 'normalize', 'bookSourceType 必须是整数；保留原值并使用文本能力前需要检查', { path: 'bookSourceType' }))
  }

  const fieldShapes: Record<string, JsonValue | undefined> = {}
  for (const field of ruleFields) {
    fieldShapes[field] = value[field]
    if (field in value) normalized[field] = parseRule(value[field] ?? null, field, diagnostics)
  }

  const source = normalized as NormalizedSource
  const result: NormalizationResult = { raw: { ...raw, unknownFields, fieldShapes }, source, unknownFields, diagnostics }
  if (diagnostics.some((item) => item.severity === 'error')) return { raw: result.raw, unknownFields, diagnostics }
  return result
}

export function knownSourceFields(): ReadonlySet<string> {
  return knownFields
}
