import { compileRule } from './compiler.ts'
import { compileSourcePattern } from './pattern-guard.ts'
import { MemoryVariableView } from './variables.ts'
import { sourceDefinitionFingerprint } from '../codec/identity.ts'
import { MemorySourceScriptCache } from '../runtime/source-session.ts'
import { replaceFont } from '../runtime/font.ts'
import type {
  CryptoHost,
  EncodingHost,
  FontHost,
  FontMapping,
  HtmlDocument,
  HtmlParser,
  JsonPathParser,
  ParserNode,
  SourceScriptCache,
  RequestBudget,
  XPathParser,
} from '../runtime/contracts.ts'
import type { JavaScriptHost, JavaScriptVariableScope } from '../runtime/javascript.ts'
import type { NormalizedSource } from '../model/types.ts'
import type { CompiledRule, RuleAtom, RuleSequence } from './types.ts'
import type {
  WorkflowRulePort,
  WorkflowRuleRequest,
  WorkflowRuleOutput,
  WorkflowJavaScriptRequest,
  WorkflowImageDecodeRequest,
  SourceFunctionName,
  SourceFunctionOutput,
  SourceFunctionRequest,
  WorkflowStage,
  RequestObserver,
} from '../workflows/types.ts'
import { internalChapterScopeBinding } from '../workflows/types.ts'
import { formatChapterBody, unescapeHtml4 } from '../workflows/html-format.ts'

export interface SourceRuleBridgeRequest {
  kind: string
  /** Core workflow stage of the script that issued this bridge request. */
  stage?: WorkflowStage
  action?: unknown
  input?: unknown
  url?: string
  urls?: readonly string[]
  method?: string
  body?: unknown
  options?: unknown
  /** 当前脚本请求链共享的 HTTP 预算；由请求宿主注入到 bridge 子请求。 */
  budget?: Partial<RequestBudget>
  skipRateLimit?: boolean
  /** Android ajaxTestAll 的逐项失败回退；普通 ajaxAll 失败应中止整个批次。 */
  isTest?: boolean
  headers?: Readonly<Record<string, string>>
  value?: unknown
  charset?: unknown
  flags?: unknown
  saveTime?: unknown
  onlyDisk?: unknown
  text?: unknown
  errorBase64?: unknown
  correctBase64?: unknown
  errorFontId?: unknown
  correctFontId?: unknown
  filter?: unknown
  key?: unknown
  iv?: unknown
  algorithm?: unknown
  transformation?: unknown
  operation?: unknown
  inputEncoding?: unknown
  outputEncoding?: unknown
  data?: unknown
  signatureEncoding?: unknown
  time?: unknown
  format?: unknown
  offsetMs?: unknown
  capability?: string
  expression?: unknown
  name?: string
  scope?: string
  privateKey?: unknown
  publicKey?: unknown
  signature?: unknown
  usePublicKey?: unknown
  useCache?: unknown
  timeoutMs?: unknown
  single?: unknown
  token?: unknown
  pattern?: unknown
}

/** Android BaseSource 登录状态和请求头的最小持久化端口。未提供时使用当前运行时会话内存。 */
export interface SourceRuntimeState {
  getHeaderMap?: (source: NormalizedSource, includeLoginHeader: boolean, signal: AbortSignal) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>
  /** BaseSource.getVariable/setVariable 对应的源级字符串。 */
  getVariable?: (source: NormalizedSource, signal: AbortSignal) => string | null | undefined | Promise<string | null | undefined>
  setVariable?: (source: NormalizedSource, value: string | null, signal: AbortSignal) => void | Promise<void>
  /** BaseSource.get/put 对应的源级键值缓存。 */
  getValue?: (source: NormalizedSource, key: string, signal: AbortSignal) => string | null | undefined | Promise<string | null | undefined>
  putValue?: (source: NormalizedSource, key: string, value: string, signal: AbortSignal) => string | Promise<string>
  getLoginHeader?: (source: NormalizedSource, signal: AbortSignal) => string | null | undefined | Promise<string | null | undefined>
  putLoginHeader?: (source: NormalizedSource, value: string, signal: AbortSignal) => void | Promise<void>
  removeLoginHeader?: (source: NormalizedSource, signal: AbortSignal) => void | Promise<void>
  getLoginInfo?: (source: NormalizedSource, signal: AbortSignal) => string | null | undefined | Promise<string | null | undefined>
  getLoginInfoMap?: (source: NormalizedSource, signal: AbortSignal) => Readonly<Record<string, string>> | undefined | Promise<Readonly<Record<string, string>> | undefined>
  putLoginInfo?: (source: NormalizedSource, value: string, signal: AbortSignal) => boolean | Promise<boolean>
  removeLoginInfo?: (source: NormalizedSource, signal: AbortSignal) => void | Promise<void>
}

export interface SourceRuntimePlatformContext {
  readonly source: NormalizedSource
  readonly workflowStage: WorkflowStage
  readonly signal: AbortSignal
  readonly bindings: Readonly<Record<string, unknown>>
}

/** Android-facing bridge for capabilities owned by the application/platform. */
export interface SourceRuntimePlatform {
  invoke: (capability: string, input: unknown, context: SourceRuntimePlatformContext) => unknown | Promise<unknown>
}

export interface SourceRuntimeConcurrencyLease {
  token: string
  /** `singleFlight` skips the action when a previous flight completed first. */
  skip?: boolean
}

/** Android SourceLock semantics shared by all operations for one source. */
export interface SourceRuntimeConcurrency {
  acquire: (kind: 'singleFlight' | 'lock', name: string, timeoutMs: number, signal: AbortSignal) => SourceRuntimeConcurrencyLease | Promise<SourceRuntimeConcurrencyLease>
  release: (token: string) => void | Promise<void>
  tick: (name: string) => number
  close?: () => void
}

export type SourceFileOperation =
  | 'getFile'
  | 'listFiles'
  | 'importScript'
  | 'cacheFile'
  | 'downloadFile'
  | 'readFile'
  | 'readTxtFile'
  | 'deleteFile'
  | 'unzipFile'
  | 'un7zFile'
  | 'unrarFile'
  | 'unArchiveFile'
  | 'getTxtInFolder'
  | 'getZipStringContent'
  | 'getRarStringContent'
  | 'get7zStringContent'
  | 'getZipByteArrayContent'
  | 'getRarByteArrayContent'
  | 'get7zByteArrayContent'

/** Android 相对缓存目录文件 API 的受控宿主端口。路径解析和归档预算由宿主负责。 */
export interface SourceFileHost {
  execute: (operation: SourceFileOperation, input: Readonly<Record<string, unknown>>, signal: AbortSignal, source: NormalizedSource) => unknown | Promise<unknown>
  /** Optional CacheManager.delete hook for Android cacheFile mappings. */
  invalidateCacheFile?: (key: string, signal: AbortSignal, source: NormalizedSource) => void | Promise<void>
}

export interface SourceRuleRuntimeOptions {
  /** bridge 处理器；第三个参数是本次求值的书源，第四个参数是当前调用链的请求观察器。 */
  request?: (input: SourceRuleBridgeRequest, signal: AbortSignal, source: NormalizedSource, requestObserver?: RequestObserver) => Promise<unknown>
  /** Android `source.putConcurrent` 的会话级限流配置写端。 */
  setConcurrentRate?: (value: string) => void
  /** 书源 JS 的 CacheManager 端口，默认是仅当前会话可见的内存缓存。 */
  cache?: SourceScriptCache
  /** 平台对齐 Android JavaScriptInterface 的时间格式。 */
  timeFormat?: (time: number) => string
  timeFormatUTC?: (time: number, format: string, offsetMs: number) => string | null
  /** 由宿主提供密码学随机 UUID。 */
  randomUUID?: () => string
  /** Android BaseSource 登录信息、请求头和状态持久化端口。 */
  sourceState?: SourceRuntimeState
  /** Android 阅读缓存目录和归档 API 的受控宿主端口。 */
  file?: SourceFileHost
  /** 平台 User-Agent；未提供时 java.getWebViewUA 报能力错误。 */
  webViewUA?: () => string
  /** JavaScript 日志端口；不提供时 log 仍返回原值但不写宿主日志。 */
  logger?: (level: 'toast' | 'longToast' | 'log' | 'logType', value: unknown) => void
  /** WebView/browser/device/config and other platform-facing JsExtensions. */
  platform?: SourceRuntimePlatform
  /** Cross-execution SourceLock implementation, scoped by the host to a source. */
  concurrency?: SourceRuntimeConcurrency
  encoding: EncodingHost
  crypto: CryptoHost
  font: FontHost
  html: HtmlParser
  json: JsonPathParser
  xpath: XPathParser
  javascript: JavaScriptHost
  initialVariables?: Readonly<Record<string, string>>
  maxSteps?: number
}

interface EvaluationState {
  readonly request: WorkflowRuleRequest
  readonly source: NormalizedSource
  readonly content: unknown
  readonly bindings: Readonly<Record<string, unknown>>
  readonly budget: { steps: number; depth: number }
  readonly expect: WorkflowRuleRequest['expect']
}

interface NodeRef {
  readonly __legadoNode: string
  readonly id: string
}

const inputStreamResultPrelude = String.raw`if (bindings.__legadoResultInputKind === "input-stream" && globalThis.result instanceof Uint8Array) {
  const __bytes = globalThis.result
  let __cursor = 0
  let __mark = 0
  globalThis.result = {
    read: function(target, offset, length) {
      if (arguments.length === 0) return __cursor < __bytes.length ? __bytes[__cursor++] : -1
      const __start = offset === undefined ? 0 : Number(offset)
      const __count = length === undefined ? target.length - __start : Number(length)
      if ((!ArrayBuffer.isView(target) && !Array.isArray(target)) || !Number.isInteger(__start) || !Number.isInteger(__count) || __start < 0 || __count < 0 || __start + __count > target.length) throw new RangeError("invalid InputStream read range")
      if (__count === 0) return 0
      const __available = Math.min(__count, __bytes.length - __cursor)
      if (__available <= 0) return -1
      for (let __index = 0; __index < __available; __index++) target[__start + __index] = __bytes[__cursor + __index]
      __cursor += __available
      return __available
    },
    readAllBytes: function() {
      const __remaining = __bytes.slice(__cursor)
      __cursor = __bytes.length
      return __remaining
    },
    available: function() { return __bytes.length - __cursor },
    skip: function(count) {
      const __count = Math.max(0, Math.min(__bytes.length - __cursor, Math.trunc(Number(count) || 0)))
      __cursor += __count
      return __count
    },
    mark: function() { __mark = __cursor },
    reset: function() { __cursor = __mark },
    markSupported: function() { return true },
  }
}`

interface StoredNode {
  readonly document: HtmlDocument
  readonly node: ParserNode
}

const javaCompatibilityPrelude = String.raw`
const legadoMap = (input) => {
  const target = Object.create(null)
  const assign = (key, value) => Object.defineProperty(target, String(key), { value, writable: true, enumerable: true, configurable: true })
  if (input !== null && typeof input === "object" && !Array.isArray(input)) for (const [key, value] of Object.entries(input)) assign(key, value)
  const keyOf = (key) => String(key)
  Object.defineProperties(target, {
    get: { value: (key) => target[keyOf(key)] },
    getOrDefault: { value: (key, fallback) => target[keyOf(key)] === undefined ? fallback : target[keyOf(key)] },
    put: { value: (key, value) => { const name = keyOf(key); const previous = target[name]; assign(name, value); return previous } },
    putAll: { value: (value) => { if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) assign(key, item); return target } },
    remove: { value: (key) => { const name = keyOf(key); const previous = target[name]; delete target[name]; return previous } },
    clear: { value: () => { for (const key of Object.keys(target)) delete target[key] } },
    containsKey: { value: (key) => Object.prototype.hasOwnProperty.call(target, keyOf(key)) },
    containsValue: { value: (value) => Object.values(target).some((item) => Object.is(item, value)) },
    keySet: { value: () => legadoList(Object.keys(target)) },
    values: { value: () => legadoList(Object.values(target)) },
    entrySet: { value: () => legadoList(Object.entries(target).map(([key, value]) => ({ getKey: () => key, getValue: () => target[key], setValue: (next) => { const previous = target[key]; assign(key, next); return previous } }))) },
    size: { value: () => Object.keys(target).length },
    isEmpty: { value: () => Object.keys(target).length === 0 },
    forEach: { value: (callback) => { if (typeof callback === "function") for (const [key, value] of Object.entries(target)) callback(value, key, target) } },
  })
  return target
}
const legadoList = (input) => {
  const target = Array.isArray(input) ? input.slice() : []
  const isIndex = (value) => (typeof value === "number" || value instanceof Number) && Number.isInteger(Number(value))
  Object.defineProperties(target, {
    get: { value: (index) => target[Number(index)] },
    set: { value: (index, value) => { const position = Number(index); const previous = target[position]; target[position] = value; return previous } },
    size: { value: () => target.length },
    isEmpty: { value: () => target.length === 0 },
    contains: { value: (value) => target.includes(value) },
    indexOf: { value: (value) => target.indexOf(value) },
    toArray: { value: () => target.slice() },
    add: { value: function(indexOrValue, value) { if (arguments.length > 1) { const index = Number(indexOrValue); if (!Number.isInteger(index) || index < 0 || index > target.length) throw new RangeError("List index out of bounds"); target.splice(index, 0, value); return true } target.push(indexOrValue); return true } },
    addAll: { value: (indexOrValues, values) => { const items = Array.isArray(values) ? values : Array.isArray(indexOrValues) ? indexOrValues : []; if (Array.isArray(values)) { const index = Number(indexOrValues); if (!Number.isInteger(index) || index < 0 || index > target.length) throw new RangeError("List index out of bounds"); target.splice(index, 0, ...items) } else target.push(...items); return items.length > 0 } },
    remove: { value: (value) => { if (isIndex(value)) { const index = Number(value); if (index < 0 || index >= target.length) return null; return target.splice(index, 1)[0] } const index = target.indexOf(value); return index < 0 ? false : (target.splice(index, 1), true) } },
    removeAt: { value: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= target.length) return null; return target.splice(position, 1)[0] } },
    containsAll: { value: (values) => Array.isArray(values) && values.every((value) => target.includes(value)) },
    lastIndexOf: { value: (value) => target.lastIndexOf(value) },
    subList: { value: (from, to) => legadoList(target.slice(Number(from), Number(to))) },
    clear: { value: () => { target.length = 0 } },
    iterator: { value: () => { let index = 0; return { hasNext: () => index < target.length, next: () => index < target.length ? target[index++] : null, remove: () => { if (index > 0) target.splice(--index, 1) } } } },
    forEach: { value: (callback) => { if (typeof callback === "function") target.forEach(callback); return undefined } },
    removeIf: { value: (predicate) => { if (typeof predicate !== "function") return false; const before = target.length; for (let index = target.length - 1; index >= 0; index -= 1) if (predicate(target[index], index, target)) target.splice(index, 1); return target.length !== before } },
    sort: { value: (comparator) => { target.sort(typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : undefined); return target } },
  })
  return target
}
const legadoBytesFromHex = (value) => {
  const text = String(value ?? "")
  const bytes = new Uint8Array(Math.floor(text.length / 2))
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  return bytes
}
const legadoJavaRegex = (pattern, flags) => { const compiled = request({ kind: "pattern-compile", pattern: String(pattern), flags: String(flags ?? "") }); return new RegExp(String(compiled.source), String(compiled.flags ?? "")) }
const legadoJavaSplit = (text, separator, limit) => {
  const max = limit === undefined ? 0 : Number(limit)
  if (max === 1) return [text]
  const regex = legadoJavaRegex(separator)
  let values = text.split(regex)
  if (max > 0 && values.length > max) values = values.slice(0, max - 1).concat(values.slice(max - 1).join(String(separator)))
  if (max === 0) while (values.length > 0 && values[values.length - 1] === "") values.pop()
  return values
}
const legadoJavaSubstring = (text, start, end) => {
  const from = Number(start)
  const to = end === undefined ? text.length : Number(end)
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || from > to) throw new RangeError("String index out of bounds")
  return legadoJavaString(text.slice(from, to))
}
const legadoJavaString = (input) => {
  const text = String(input ?? "")
  const value = {}
  Object.defineProperties(value, {
    getBytes: { value: (charset) => request({ kind: "encode-bytes", value: text, charset: charset === undefined ? "UTF-8" : String(charset) }) },
    length: { value: () => text.length },
    isEmpty: { value: () => text.length === 0 },
    equals: { value: (other) => text === String(other ?? "") },
    equalsIgnoreCase: { value: (other) => text.toLowerCase() === String(other ?? "").toLowerCase() },
    contains: { value: (part) => text.includes(String(part ?? "")) },
    startsWith: { value: (part) => text.startsWith(String(part ?? "")) },
    endsWith: { value: (part) => text.endsWith(String(part ?? "")) },
    substring: { value: (start, end) => legadoJavaSubstring(text, start, end) },
    subSequence: { value: (start, end) => legadoJavaSubstring(text, start, end) },
    charAt: { value: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= text.length) throw new RangeError("String index out of bounds"); return text.charAt(position) } },
    indexOf: { value: (part, start) => text.indexOf(String(part ?? ""), start === undefined ? 0 : Number(start)) },
    trim: { value: () => legadoJavaString(text.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, "")) },
    toLowerCase: { value: () => legadoJavaString(text.toLowerCase()) },
    toUpperCase: { value: () => legadoJavaString(text.toUpperCase()) },
    split: { value: (separator, limit) => legadoList(legadoJavaSplit(text, String(separator ?? ""), limit)) },
    replace: { value: (from, to) => legadoJavaString(text.split(String(from ?? "")).join(String(to ?? ""))) },
    replaceAll: { value: (pattern, replacement) => legadoJavaString(text.replace(legadoJavaRegex(pattern, "g"), String(replacement ?? ""))) },
    replaceFirst: { value: (pattern, replacement) => legadoJavaString(text.replace(legadoJavaRegex(pattern), String(replacement ?? ""))) },
    matches: { value: (pattern) => { const regex = legadoJavaRegex(pattern); const match = regex.exec(text); return match !== null && match[0] === text } },
    compareTo: { value: (other) => { const value = String(other ?? ""); const length = Math.min(text.length, value.length); for (let index = 0; index < length; index++) { const difference = text.charCodeAt(index) - value.charCodeAt(index); if (difference !== 0) return difference } return text.length - value.length } },
    compareToIgnoreCase: { value: (other) => legadoJavaString(text.toLowerCase()).compareTo(String(other ?? "").toLowerCase()) },
    concat: { value: (other) => legadoJavaString(text + String(other ?? "")) },
    // Java String.toCharArray 按 UTF-16 code unit 返回，不能使用按 Unicode code point 展开的 Array.from。
    toCharArray: { value: () => Array.from({ length: text.length }, (_, index) => text.charAt(index)) },
    regionMatches: { value: function(ignoreCase, thisOffset, other, otherOffset, length) { let insensitive = ignoreCase; let from = thisOffset; let value = other; let offset = otherOffset; let count = length; if (arguments.length < 5) { insensitive = false; from = ignoreCase; value = thisOffset; offset = other; count = otherOffset } const left = text.slice(Number(from), Number(from) + Number(count)); const right = String(value ?? "").slice(Number(offset), Number(offset) + Number(count)); return insensitive === true ? left.toLowerCase() === right.toLowerCase() : left === right } },
    hashCode: { value: () => { let hash = 0; for (const char of text) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return hash } },
    toString: { value: () => text },
    valueOf: { value: () => text },
    [Symbol.toPrimitive]: { value: () => text },
  })
  return value
}
const legadoJavaLangString = function(value, charsetOrOffset, length) {
  if (value instanceof Uint8Array || Array.isArray(value)) {
    const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value)
    if (typeof charsetOrOffset === "number") {
      const offset = Number(charsetOrOffset)
      const count = length === undefined ? bytes.length - offset : Number(length)
      if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0 || offset + count > bytes.length) throw new RangeError("String byte range out of bounds")
      return legadoJavaString(request({ kind: "decode-bytes", value: bytes.slice(offset, offset + count), charset: "UTF-8" }))
    }
    return legadoJavaString(request({ kind: "decode-bytes", value: bytes, charset: charsetOrOffset === undefined ? "UTF-8" : String(charsetOrOffset) }))
  }
  return legadoJavaString(value)
}
// 书源常见 String.format 只覆盖顺序的 %s 占位符；其他格式由受控能力错误表示，不猜测 Locale 规则。
Object.assign(legadoJavaLangString, {
  valueOf: (value) => legadoJavaString(value),
  copyValueOf: (value) => legadoJavaString(value),
  format: (format, ...args) => legadoJavaString(String(format ?? "").replace(/%s/gu, () => String(args.shift() ?? "null"))),
})
const legadoStringBuilder = function(initial) {
  let value = initial === undefined ? "" : String(initial)
  let capacity = Math.max(16, value.length)
  const target = {
    append: (item) => { value += String(item ?? "null"); capacity = Math.max(capacity, value.length); return target },
    insert: (index, item) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position > value.length) throw new RangeError("StringBuilder index out of bounds"); value = value.slice(0, position) + String(item ?? "null") + value.slice(position); capacity = Math.max(capacity, value.length); return target },
    delete: (start, end) => { const from = Number(start); const to = Number(end); if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > value.length) throw new RangeError("StringBuilder index out of bounds"); value = value.slice(0, from) + value.slice(to); return target },
    deleteCharAt: (index) => target.delete(index, Number(index) + 1),
    charAt: (index) => value.charAt(Number(index)),
    indexOf: (part, start) => value.indexOf(String(part ?? "null"), start === undefined ? 0 : Number(start)),
    lastIndexOf: (part, start) => value.lastIndexOf(String(part ?? "null"), start === undefined ? value.length : Number(start)),
    reverse: () => { value = Array.from(value).reverse().join(""); return target },
    length: () => value.length,
    capacity: () => capacity,
    ensureCapacity: (minimum) => { capacity = Math.max(capacity, Number(minimum) || 0); return undefined },
    setLength: (length) => { const next = Number(length); if (!Number.isInteger(next) || next < 0) throw new RangeError("StringBuilder length out of bounds"); value = next <= value.length ? value.slice(0, next) : value + "\u0000".repeat(next - value.length); capacity = Math.max(capacity, next); return undefined },
    toString: () => value,
  }
  return target
}
const legadoInteger = { toHexString: (value) => (Number(value) >>> 0).toString(16), toString: (value, radix) => Math.trunc(Number(value)).toString(radix === undefined ? 10 : Number(radix)), parseInt: (value, radix) => Number.parseInt(String(value), radix === undefined ? 10 : Number(radix)), valueOf: (value) => Number(value), compare: (left, right) => Number(left) < Number(right) ? -1 : Number(left) > Number(right) ? 1 : 0, max: (left, right) => Math.max(Number(left), Number(right)), min: (left, right) => Math.min(Number(left), Number(right)) }
const legadoNumber = { toHexString: (value) => Math.trunc(Number(value)).toString(16), toString: legadoInteger.toString, parseInt: legadoInteger.parseInt, valueOf: legadoInteger.valueOf, compare: legadoInteger.compare, max: legadoInteger.max, min: legadoInteger.min }
const legadoLong = { MIN_VALUE: -(2n ** 63n), MAX_VALUE: (2n ** 63n) - 1n, parseLong: (value, radix) => BigInt(String(value).trim()), toString: (value, radix) => BigInt(value).toString(radix === undefined ? 10 : Number(radix)), valueOf: (value) => BigInt(value), compare: (left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0, max: (left, right) => BigInt(left) > BigInt(right) ? BigInt(left) : BigInt(right), min: (left, right) => BigInt(left) < BigInt(right) ? BigInt(left) : BigInt(right) }
const legadoBigInteger = function(value, radix) {
  let number
  if (value && typeof value === "object" && typeof value.__legadoBigInteger === "bigint") number = value.__legadoBigInteger
  else if (value instanceof Uint8Array || Array.isArray(value)) { let hex = Array.from(value instanceof Uint8Array ? value : Uint8Array.from(value)).map((item) => Number(item).toString(16).padStart(2, "0")).join(""); number = hex.length === 0 ? 0n : BigInt("0x" + hex); if (Number((value instanceof Uint8Array ? value : Uint8Array.from(value))[0] ?? 0) >= 128) number -= 1n << BigInt((value instanceof Uint8Array ? value : Uint8Array.from(value)).length * 8) }
  else number = BigInt(String(value ?? "0").trim().replace(/^[+]/u, ""))
  const api = { __legadoBigInteger: number, add: (other) => legadoBigInteger(number + BigInt(other?.__legadoBigInteger ?? other)), subtract: (other) => legadoBigInteger(number - BigInt(other?.__legadoBigInteger ?? other)), multiply: (other) => legadoBigInteger(number * BigInt(other?.__legadoBigInteger ?? other)), divide: (other) => legadoBigInteger(number / BigInt(other?.__legadoBigInteger ?? other)), remainder: (other) => legadoBigInteger(number % BigInt(other?.__legadoBigInteger ?? other)), mod: (other) => { const divisor = BigInt(other?.__legadoBigInteger ?? other); if (divisor <= 0n) throw new RangeError("BigInteger modulus must be positive"); return legadoBigInteger(number % divisor) }, compareTo: (other) => number < BigInt(other?.__legadoBigInteger ?? other) ? -1 : number > BigInt(other?.__legadoBigInteger ?? other) ? 1 : 0, negate: () => legadoBigInteger(-number), abs: () => legadoBigInteger(number < 0n ? -number : number), bitLength: () => (number < 0n ? (-number - 1n) : number).toString(2).length, intValue: () => Number(number), longValue: () => number, toString: (radix) => number.toString(radix === undefined ? 10 : Number(radix)), equals: (other) => other?.__legadoBigInteger === number, valueOf: () => number }
  return api
}
const legadoBigDecimal = function(value, scale) {
  const parse = String(value?.__legadoBigDecimal ?? value ?? "0").trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u)
  if (parse === null) throw new RangeError("invalid BigDecimal")
  let coefficient = BigInt((parse[1] === "-" ? "-" : "") + parse[2] + (parse[3] ?? ""))
  let decimalScale = (parse[3]?.length ?? 0) - Number(parse[4] ?? 0)
  if (scale !== undefined) decimalScale = Number(scale)
  if (!Number.isInteger(decimalScale)) throw new RangeError("invalid BigDecimal scale")
  const api = {
    __legadoBigDecimal: String(value?.__legadoBigDecimal ?? value ?? "0"),
    add: (other) => decimalOperation(coefficient, decimalScale, other, 1), subtract: (other) => decimalOperation(coefficient, decimalScale, other, -1), multiply: (other) => { const right = decimalParts(other); return decimalFromParts(coefficient * right.coefficient, decimalScale + right.scale) },
    divide: (other, roundingMode) => decimalDivide(coefficient, decimalScale, other, roundingMode), setScale: (nextScale, roundingMode) => decimalSetScale(coefficient, decimalScale, Number(nextScale), roundingMode), compareTo: (other) => { const right = decimalParts(other); const aligned = decimalAlign(coefficient, decimalScale, right.coefficient, right.scale); return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0 }, scale: () => decimalScale, unscaledValue: () => legadoBigInteger(coefficient), toPlainString: () => decimalToString(coefficient, decimalScale), toString: () => decimalToString(coefficient, decimalScale), valueOf: () => Number(coefficient) / 10 ** decimalScale,
  }
  return api
}
const decimalParts = (value) => { if (value && typeof value === "object" && typeof value.toPlainString === "function") { const text = value.toPlainString(); const parsed = String(text).match(/^(-?)(\d+)(?:\.(\d+))?$/u); if (parsed !== null) return { coefficient: BigInt((parsed[1] ?? "") + parsed[2] + (parsed[3] ?? "")), scale: parsed[3]?.length ?? 0 } } const text = String(value ?? "0"); const parsed = text.match(/^(-?)(\d+)(?:\.(\d+))?$/u); return parsed === null ? { coefficient: 0n, scale: 0 } : { coefficient: BigInt((parsed[1] ?? "") + parsed[2] + (parsed[3] ?? "")), scale: parsed[3]?.length ?? 0 } }
const decimalToString = (coefficient, scale) => { const negative = coefficient < 0n; const digits = (negative ? -coefficient : coefficient).toString(); if (scale <= 0) return (negative ? "-" : "") + digits + "0".repeat(-scale); const padded = digits.padStart(scale + 1, "0"); const point = padded.length - scale; return (negative ? "-" : "") + padded.slice(0, point) + "." + padded.slice(point) }
const decimalFromParts = (coefficient, scale) => legadoBigDecimal(decimalToString(coefficient, scale))
const decimalAlign = (left, leftScale, right, rightScale) => leftScale === rightScale ? { left, right } : leftScale > rightScale ? { left, right: right * 10n ** BigInt(leftScale - rightScale) } : { left: left * 10n ** BigInt(rightScale - leftScale), right }
const decimalOperation = (left, scale, other, sign) => { const right = decimalParts(other); const aligned = decimalAlign(left, scale, right.coefficient, right.scale); return decimalFromParts(aligned.left + BigInt(sign) * aligned.right, Math.max(scale, right.scale)) }
const decimalSetScale = (coefficient, scale, nextScale, roundingMode) => { if (nextScale >= scale) return decimalFromParts(coefficient * 10n ** BigInt(nextScale - scale), nextScale); const divisor = 10n ** BigInt(scale - nextScale); let quotient = coefficient / divisor; const remainder = coefficient % divisor; const mode = Number(roundingMode ?? 4); if (remainder !== 0n && mode === 4 && (remainder < 0n ? -remainder : remainder) * 2n >= divisor) quotient += coefficient < 0n ? -1n : 1n; return decimalFromParts(quotient, nextScale) }
const decimalDivide = (coefficient, scale, other, roundingMode) => { const right = decimalParts(other); if (right.coefficient === 0n) throw new RangeError("BigDecimal division by zero"); const targetScale = Math.max(0, scale + right.scale + 16); const numerator = coefficient * 10n ** BigInt(targetScale); const quotient = numerator / right.coefficient; return decimalSetScale(quotient, targetScale + scale - right.scale, Math.max(scale, right.scale), roundingMode) }
const legadoSet = function(input) { const values = []; const add = (value) => { if (!values.some((item) => Object.is(item, value))) values.push(value); return true }; for (const value of Array.isArray(input) ? input : []) add(value); return { add, addAll: (items) => { let changed = false; for (const value of items ?? []) changed = add(value) || changed; return changed }, contains: (value) => values.some((item) => Object.is(item, value)), remove: (value) => { const index = values.findIndex((item) => Object.is(item, value)); if (index < 0) return false; values.splice(index, 1); return true }, size: () => values.length, isEmpty: () => values.length === 0, toArray: () => values.slice(), iterator: () => { let index = 0; return { hasNext: () => index < values.length, next: () => index < values.length ? values[index++] : null, remove: () => { if (index > 0) values.splice(--index, 1) } } }, forEach: (callback) => values.forEach(callback), toString: () => "[" + values.join(", ") + "]" } }
const legadoJavaMath = { abs: (value) => Math.abs(Number(value)), max: (left, right) => Math.max(Number(left), Number(right)), min: (left, right) => Math.min(Number(left), Number(right)), round: (value) => Math.round(Number(value)), floor: (value) => Math.floor(Number(value)), ceil: (value) => Math.ceil(Number(value)), pow: (left, right) => Math.pow(Number(left), Number(right)), signum: (value) => Math.sign(Number(value)), toRadians: (value) => Number(value) * Math.PI / 180, toDegrees: (value) => Number(value) * 180 / Math.PI }
const legadoBytesValue = (value) => value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" })
const legadoConcatBytes = (parts) => { const total = parts.reduce((sum, item) => sum + item.length, 0); const result = new Uint8Array(total); let offset = 0; for (const item of parts) { result.set(item, offset); offset += item.length } return result }
const legadoDigest = (algorithm) => {
  let chunks = []
  const api = {
    update: (value, offset, length) => { const bytes = legadoBytesValue(value); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("MessageDigest update range out of bounds"); chunks.push(bytes.slice(start, start + count)); return api },
    digest: (value) => { if (value !== undefined) api.update(value); const result = legadoBytesFromHex(request({ kind: "digest", value: legadoConcatBytes(chunks), algorithm: String(algorithm) })); chunks = []; return result },
    reset: () => { chunks = []; return api },
    getAlgorithm: () => String(algorithm),
    getDigestLength: () => legadoBytesFromHex(request({ kind: "digest", value: new Uint8Array(), algorithm: String(algorithm) })).length,
  }
  return api
}
const legadoMessageDigest = { getInstance: (algorithm) => legadoDigest(algorithm) }
const legadoPattern = {
  CASE_INSENSITIVE: 2,
  MULTILINE: 8,
  DOTALL: 32,
  UNICODE_CASE: 64,
  COMMENTS: 4,
  LITERAL: 16,
  UNICODE_CHARACTER_CLASS: 256,
  quote: (pattern) => "\\Q" + String(pattern ?? "") + "\\E",
  compile: (pattern, flags) => {
    const numericFlags = Number(flags ?? 0)
    let javaFlags = ""
    if ((numericFlags & 2) !== 0) javaFlags += "i"
    if ((numericFlags & 8) !== 0) javaFlags += "m"
    if ((numericFlags & 32) !== 0) javaFlags += "s"
    if ((numericFlags & 64) !== 0 || (numericFlags & 256) !== 0) javaFlags += "u"
    if ((numericFlags & 16) !== 0) pattern = legadoPattern.quote(pattern)
    const compiled = request({ kind: "pattern-compile", pattern: String(pattern), flags: javaFlags })
    const regex = new RegExp(String(compiled.source), String(compiled.flags ?? "") + "g")
    return { matcher: (value) => {
      const input = String(value ?? "")
      let last = null
      const groupBounds = (index) => {
        if (last === null) return [-1, -1]
        const groupIndex = Number(index ?? 0)
        const group = last[groupIndex]
        if (group === undefined) return [-1, -1]
        if (Array.isArray(last.indices) && Array.isArray(last.indices[groupIndex])) return last.indices[groupIndex]
        if (groupIndex === 0) return [last.index, last.index + group.length]
        const local = String(last[0]).indexOf(String(group))
        return local < 0 ? [-1, -1] : [last.index + local, last.index + local + String(group).length]
      }
      return {
        find: () => { const match = regex.exec(input); if (match === null) return false; last = match; return true },
        matches: () => { const match = new RegExp(regex.source, regex.flags.replace("g", "")).exec(input); return match !== null && match[0] === input },
        lookingAt: () => { const match = new RegExp("^(?:" + regex.source + ")", regex.flags.replace("g", "")).exec(input); if (match === null) return false; last = match; return true },
        group: (index) => last === null ? null : last[Number(index ?? 0)] ?? null,
        groupCount: () => last === null ? 0 : Math.max(0, last.length - 1),
        replaceAll: (replacement) => input.replace(new RegExp(regex.source, regex.flags.replace("g", "") + "g"), String(replacement ?? "")),
        start: (index) => groupBounds(index)[0],
        end: (index) => groupBounds(index)[1],
        reset: () => { regex.lastIndex = 0; last = null; return undefined },
      }
    } }
  }
}
const legadoBase64 = {
  getEncoder: () => { const flags = 2; const encoder = { encodeToString: (value) => request({ kind: "base64-encode", value, flags }), encode: (value) => legadoJavaString(request({ kind: "base64-encode", value, flags })).getBytes("UTF-8"), withoutPadding: () => { const noPadding = 3; return { encodeToString: (value) => request({ kind: "base64-encode", value, flags: noPadding }), encode: (value) => legadoJavaString(request({ kind: "base64-encode", value, flags: noPadding })).getBytes("UTF-8") } } }; return encoder },
  getDecoder: () => ({ decode: (value) => request({ kind: "base64-decode-bytes", value: String(value) }) }),
}
const legadoByteArrayInputStream = function(input) {
  const bytes = input instanceof Uint8Array ? input : Array.isArray(input) ? Uint8Array.from(input) : request({ kind: "encode-bytes", value: String(input ?? ""), charset: "UTF-8" })
  let cursor = 0
  let mark = 0
  return { read: function(target, offset, length) { if (arguments.length === 0) return cursor < bytes.length ? bytes[cursor++] : -1; const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? target.length - start : Number(length); if ((!ArrayBuffer.isView(target) && !Array.isArray(target)) || !Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > target.length) throw new RangeError("invalid InputStream read range"); const available = Math.min(count, bytes.length - cursor); if (available <= 0) return -1; for (let index = 0; index < available; index++) target[start + index] = bytes[cursor + index]; cursor += available; return available }, readAllBytes: () => { const result = bytes.slice(cursor); cursor = bytes.length; return result }, available: () => bytes.length - cursor, skip: (count) => { const amount = Math.max(0, Math.min(bytes.length - cursor, Math.trunc(Number(count) || 0))); cursor += amount; return amount }, mark: () => { mark = cursor }, reset: () => { cursor = mark }, markSupported: () => true, close: () => undefined }
}
const legadoByteArrayOutputStream = function(initial) {
  let chunks = []
  const api = {
    write: (value, offset, length) => { const bytes = legadoBytesValue(value); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("OutputStream write range out of bounds"); chunks.push(bytes.slice(start, start + count)); return undefined },
    toByteArray: () => legadoConcatBytes(chunks),
    size: () => chunks.reduce((sum, item) => sum + item.length, 0),
    reset: () => { chunks = [] },
    close: () => undefined,
    flush: () => undefined,
    toString: (charset) => request({ kind: "decode-bytes", value: api.toByteArray(), charset: charset === undefined ? "UTF-8" : String(charset) }),
  }
  if (initial !== undefined) api.write(initial)
  return api
}
const legadoInputStreamReader = function(input, charset) {
  const bytes = legadoBytesValue(input?.readAllBytes?.() ?? input)
  const text = request({ kind: "decode-bytes", value: bytes, charset: charset === undefined ? "UTF-8" : String(charset) })
  let cursor = 0
  return { read: function(target, offset, length) { if (arguments.length === 0) return cursor < text.length ? text.charCodeAt(cursor++) : -1; const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? target.length - start : Number(length); if (!Array.isArray(target) && !ArrayBuffer.isView(target)) throw new TypeError("Reader target must be an array"); if (count === 0) return 0; const available = Math.min(count, text.length - cursor); if (available <= 0) return -1; for (let index = 0; index < available; index++) target[start + index] = text.charCodeAt(cursor + index); cursor += available; return available }, readAll: () => { const result = text.slice(cursor); cursor = text.length; return result }, close: () => undefined }
}
const legadoBufferedReader = function(reader) { return { readLine: () => { const chars = []; while (true) { const code = reader.read(); if (code < 0) return chars.length === 0 ? null : String.fromCharCode(...chars); if (code === 10) return String.fromCharCode(...chars); if (code !== 13) chars.push(code); if (chars.length >= 1048576) return String.fromCharCode(...chars) } }, read: (...args) => reader.read(...args), close: () => reader.close?.() } }
const legadoSecretKeySpec = function(value, algorithm) { const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" }); return { getEncoded: () => bytes, getAlgorithm: () => String(algorithm ?? ""), getFormat: () => "RAW", encoded: bytes } }
const legadoMac = { getInstance: (algorithm) => { let key; let chunks = []; const api = { init: (secret) => { key = secret?.getEncoded?.() ?? secret?.encoded ?? secret; chunks = []; return api }, update: (value, offset, length) => { const bytes = legadoBytesValue(value); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("Mac update range out of bounds"); chunks.push(bytes.slice(start, start + count)); return api }, doFinal: (value) => { if (value !== undefined) api.update(value); const hex = request({ kind: "hmac-hex", value: legadoConcatBytes(chunks), key, algorithm: String(algorithm) }); chunks = []; return request({ kind: "hex-decode-bytes", value: hex }) }, reset: () => { chunks = []; return api }, getAlgorithm: () => String(algorithm) }; return api } }
const legadoDatatypeConverter = { printHexBinary: (value) => String(request({ kind: "hex-encode", value }) ?? "").toUpperCase(), parseHexBinary: (value) => request({ kind: "hex-decode-bytes", value: String(value ?? "") }) }
const legadoUrlEncoder = { encode: (value, charset) => request({ kind: "encode-uri", value: String(value ?? ""), charset: charset === undefined ? "UTF-8" : String(charset) }) }
const legadoAndroidBase64 = { DEFAULT: 0, NO_PADDING: 1, NO_WRAP: 2, CRLF: 4, URL_SAFE: 8, NO_CLOSE: 16, encodeToString: (value, flags) => request({ kind: "base64-encode", value, flags: Number(flags ?? 0) }), encode: (value, flags) => legadoJavaString(request({ kind: "base64-encode", value, flags: Number(flags ?? 0) })).getBytes("UTF-8"), decode: (value, flags) => request({ kind: "base64-decode-bytes", value, flags: Number(flags ?? 0) }) }
const legadoJavaLang = { String: legadoJavaLangString, StringBuilder: legadoStringBuilder, Integer: legadoInteger, Long: legadoLong, Double: legadoNumber, Float: legadoNumber, Boolean: { parseBoolean: (value) => String(value).toLowerCase() === "true" }, Character: { isDigit: (value) => /\d/u.test(String(value)), isLetter: (value) => /\p{L}/u.test(String(value)), toLowerCase: (value) => String(value).toLowerCase(), toUpperCase: (value) => String(value).toUpperCase() }, Math: legadoJavaMath, CharSequence: legadoJavaLangString }
const legadoJavaArrays = { asList: (value) => legadoList(value), toString: (value) => "[" + Array.from(value ?? []).join(", ") + "]", copyOf: (value, length) => Array.from(value ?? []).slice(0, Number(length)).concat(Array(Math.max(0, Number(length) - (value?.length ?? 0))).fill(null)), copyOfRange: (value, from, to) => Array.from(value ?? []).slice(Number(from), Number(to)), fill: (value, item) => { if (Array.isArray(value)) value.fill(item); return undefined }, sort: (value) => { if (Array.isArray(value)) value.sort(); return undefined } }
const legadoJavaCollections = { sort: (list, comparator) => { if (Array.isArray(list)) list.sort(typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : undefined); return undefined }, reverse: (list) => { if (Array.isArray(list)) list.reverse(); return undefined }, shuffle: (list) => { if (Array.isArray(list)) for (let index = list.length - 1; index > 0; index -= 1) { const swap = Math.floor(Math.random() * (index + 1)); [list[index], list[swap]] = [list[swap], list[index]] }; return undefined }, singletonList: (value) => legadoList([value]), emptyList: () => legadoList([]) }
const legadoJavaUtil = { HashMap: function(initial) { return legadoMap(initial) }, LinkedHashMap: function(initial) { return legadoMap(initial) }, ArrayList: function(initial) { return legadoList(initial) }, HashSet: function(initial) { return legadoSet(initial) }, LinkedHashSet: function(initial) { return legadoSet(initial) }, Arrays: legadoJavaArrays, Collections: legadoJavaCollections, regex: { Pattern: legadoPattern }, Base64: legadoBase64 }
legadoJavaUtil.regex.Pattern = legadoPattern
const legadoJavaIo = { ByteArrayInputStream: legadoByteArrayInputStream, ByteArrayOutputStream: legadoByteArrayOutputStream, InputStreamReader: legadoInputStreamReader, BufferedReader: legadoBufferedReader }
const legadoJavaSecurity = { MessageDigest: legadoMessageDigest }
const legadoStandardCharsets = { UTF_8: "UTF-8", UTF_16: "UTF-16", ISO_8859_1: "ISO-8859-1" }
const legadoName = (value, name) => { try { Object.defineProperty(value, "__legadoName", { value: name, configurable: false, enumerable: false }); } catch {} return value }
for (const [name, value] of Object.entries(legadoJavaLang)) legadoName(value, name)
for (const [name, value] of Object.entries(legadoJavaUtil)) legadoName(value, name)
for (const [name, value] of Object.entries(legadoJavaIo)) legadoName(value, name)
legadoName(legadoJavaUtil.regex.Pattern, "Pattern")
legadoName(legadoJavaSecurity.MessageDigest, "MessageDigest")
legadoName(legadoBase64, "Base64")
legadoName(legadoByteArrayInputStream, "ByteArrayInputStream")
legadoName(legadoByteArrayOutputStream, "ByteArrayOutputStream")
legadoName(legadoInputStreamReader, "InputStreamReader")
legadoName(legadoBufferedReader, "BufferedReader")
legadoName(legadoBigInteger, "BigInteger")
legadoName(legadoBigDecimal, "BigDecimal")
legadoName(legadoSecretKeySpec, "SecretKeySpec")
legadoName(legadoMac, "Mac")
legadoName(legadoDatatypeConverter, "DatatypeConverter")
legadoName(legadoUrlEncoder, "URLEncoder")
legadoName(legadoAndroidBase64, "Base64")
const legadoExistingPackages = globalThis.Packages
const legadoPackages = { java: { lang: legadoJavaLang, math: { BigInteger: legadoBigInteger, BigDecimal: legadoBigDecimal, MathContext: function(precision) { return { precision: Number(precision) } } }, util: legadoJavaUtil, security: legadoJavaSecurity, nio: { charset: { StandardCharsets: legadoStandardCharsets } }, net: { URLEncoder: legadoUrlEncoder, URL: function(value, base) { return java.toURL(value, base) } }, io: legadoJavaIo }, javax: { crypto: { Mac: legadoMac, spec: { SecretKeySpec: legadoSecretKeySpec } }, xml: { bind: { DatatypeConverter: legadoDatatypeConverter } }, }, android: { util: { Base64: legadoAndroidBase64 } } }
legadoName(legadoPackages.java.nio.charset.StandardCharsets, "StandardCharsets")
legadoName(legadoPackages.java.net.URL, "URL")
if (legadoExistingPackages && legadoExistingPackages.io) legadoPackages.io = legadoExistingPackages.io
globalThis.Packages = legadoPackages
globalThis.JavaImporter = function(...packages) {
  const scope = {}
  const importItem = (item) => { if (item === null || (typeof item !== "object" && typeof item !== "function")) return; const name = item.__legadoName; if (name !== undefined) scope[name] = item; else Object.assign(scope, item) }
  scope.importPackage = (...items) => { for (const item of items) importItem(item); return scope }
  scope.importClass = (...items) => { for (const item of items) importItem(item); return scope }
  scope.importPackage(...packages)
  return scope
}
globalThis.JavaAdapter = function(base, overrides) { return Object.assign({}, overrides ?? {}) }
const __legadoSourceObject = globalThis.source
const __legadoSourceCopy = {}
for (const name of Reflect.ownKeys(__legadoSourceObject)) __legadoSourceCopy[name] = __legadoSourceObject[name]
const __legadoSourceLoginInfoMap = __legadoSourceCopy.getLoginInfoMap
const __legadoSourceHeaderMap = __legadoSourceCopy.getHeaderMap
__legadoSourceCopy.getLoginInfoMap = (...args) => legadoMap(typeof __legadoSourceLoginInfoMap === "function" ? __legadoSourceLoginInfoMap(...args) : __legadoSourceLoginInfoMap)
__legadoSourceCopy.getHeaderMap = (...args) => legadoMap(typeof __legadoSourceHeaderMap === "function" ? __legadoSourceHeaderMap(...args) : __legadoSourceHeaderMap)
const __legadoSourceRuleKeys = { getSearchRule: "ruleSearch", getExploreRule: "ruleExplore", getBookInfoRule: "ruleBookInfo", getTocRule: "ruleToc", getContentRule: "ruleContent", getRuleSearch: "ruleSearch", getRuleExplore: "ruleExplore", getRuleBookInfo: "ruleBookInfo", getRuleToc: "ruleToc", getRuleContent: "ruleContent" }
for (const name of Object.keys(__legadoSourceRuleKeys)) {
  const key = __legadoSourceRuleKeys[name]
  __legadoSourceCopy[name] = () => legadoMap(__legadoSourceObject[key] ?? {})
}
globalThis.source = __legadoSourceCopy
globalThis.sourceApi = globalThis.source
Object.defineProperties(globalThis.infoMap, { remove: { value: (key) => { const name = String(key); const previous = globalThis.infoMap[name]; delete globalThis.infoMap[name]; return previous } }, clear: { value: () => { for (const key of Object.keys(globalThis.infoMap)) delete globalThis.infoMap[key] } }, containsKey: { value: (key) => Object.prototype.hasOwnProperty.call(globalThis.infoMap, String(key)) }, size: { value: () => Object.keys(globalThis.infoMap).length }, isEmpty: { value: () => Object.keys(globalThis.infoMap).length === 0 } })
java.setBaseUrl = (value) => { if (value !== null && value !== undefined) globalThis.baseUrl = String(value); return java }
java.setRedirectUrl = (value) => { globalThis.redirectUrl = value == null ? "" : String(value); return java }
const __legadoLocal = {}
java.setLocal = (key, value) => { __legadoLocal[String(key)] = value; return value }
java.getLocal = (key) => __legadoLocal[String(key)]
java.evalJS = (code, extra) => request({ kind: "source-eval-js", value: String(code ?? ""), input: extra })
java.reGetBook = () => request({ kind: "workflow-action", action: "reGetBook", input: globalThis.book })
java.refreshTocUrl = () => request({ kind: "workflow-action", action: "refreshTocUrl", input: globalThis.book })
const __legadoGetString = java.getString
java.getString = (rule, content, isUrl) => typeof content === "boolean" && isUrl === undefined ? __legadoGetString(rule, content, undefined) : __legadoGetString(rule, content, isUrl)
const __legadoGetStringList = java.getStringList
java.getStringList = (rule, content, isUrl) => legadoList(__legadoGetStringList(rule, content, isUrl))
const __legadoGetElements = java.getElements
java.getElements = (rule) => legadoList(__legadoGetElements(rule))
const __legadoGetFile = java.getFile
java.getFile = (path) => {
  const value = __legadoGetFile(path)
  const target = value !== null && typeof value === "object" ? value : { path: String(path ?? ""), absolutePath: String(path ?? ""), name: String(path ?? "").split("/").at(-1) ?? "" }
  const refresh = () => legadoFileRequest("getFile", { path: String(path ?? "") }) ?? target
  Object.defineProperties(target, { exists: { configurable: true, value: () => Boolean(refresh().exists) }, isFile: { configurable: true, value: () => Boolean(refresh().isFile) }, isDirectory: { configurable: true, value: () => Boolean(refresh().isDirectory) }, getName: { configurable: true, value: () => String(refresh().name ?? target.name ?? "") }, getPath: { configurable: true, value: () => String(refresh().path ?? target.path ?? "") }, getAbsolutePath: { configurable: true, value: () => String(refresh().absolutePath ?? target.absolutePath ?? target.path ?? "") }, length: { configurable: true, value: () => Number(refresh().length ?? 0) }, lastModified: { configurable: true, value: () => Number(refresh().lastModified ?? 0) }, canRead: { configurable: true, value: () => Boolean(refresh().exists) }, canWrite: { configurable: true, value: () => Boolean(refresh().exists) }, listFiles: { configurable: true, value: () => legadoList(legadoFileRequest("listFiles", { path: String(path ?? "") }) ?? []) } })
  return target
}
const __legadoToURLCompat = java.toURL
java.toURL = (value, base) => {
  const result = __legadoToURLCompat(value, base)
  if (result === null || typeof result !== "object") return result
  const __legadoAuthorityMatch = new RegExp("^(?:([A-Za-z0-9_]+):)?//([^/?#]*)(?:[/?#]|$)", "u").exec(String(result.url ?? ""))
  if (__legadoAuthorityMatch !== null) {
    const __legadoProtocol = __legadoAuthorityMatch[1] == null ? "" : String(__legadoAuthorityMatch[1]) + ":"
    const __legadoAuthority = __legadoAuthorityMatch[2] ?? ""
    if (__legadoAuthority.startsWith("[")) {
      const __legadoEnd = __legadoAuthority.indexOf("]")
      result.hostname = __legadoEnd < 0 ? __legadoAuthority : __legadoAuthority.slice(0, __legadoEnd + 1)
      result.host = __legadoAuthority
      result.port = __legadoEnd >= 0 && __legadoAuthority[__legadoEnd + 1] === ":" ? __legadoAuthority.slice(__legadoEnd + 2) : ""
      result.protocol = __legadoProtocol
      result.origin = __legadoProtocol.length === 0 ? "" : __legadoProtocol + "//" + __legadoAuthority
    }
  }
  const query = String(result.query ?? "")
  const entries = []
  const decode = (item) => { try { return decodeURIComponent(String(item).replaceAll("+", " ")) } catch { return String(item) } }
  const encode = (item) => encodeURIComponent(String(item)).replaceAll("%20", "+")
  for (const part of query.split("&")) {
    if (part.length === 0) continue
    const index = part.indexOf("=")
    entries.push([index < 0 ? part : part.slice(0, index), decode(index < 0 ? "" : part.slice(index + 1))])
  }
  const params = result.searchParams && typeof result.searchParams === "object" ? result.searchParams : {}
  params.get = (key) => { const name = String(key); for (const entry of entries) if (entry[0] === name) return entry[1]; return null }
  params.getAll = (key) => entries.filter((entry) => entry[0] === String(key)).map((entry) => entry[1])
  params.has = (key) => entries.some((entry) => entry[0] === String(key))
  const sync = () => { for (const key of Object.keys(params)) if (!["get", "getAll", "has", "set", "append", "delete", "toString"].includes(key)) delete params[key]; for (const entry of entries) params[entry[0]] = entry[1]; result.query = entries.map((entry) => entry[0] + "=" + encode(entry[1])).join("&"); result.search = result.query.length === 0 ? "" : "?" + result.query }
  params.set = (key, item) => { const name = String(key); for (let index = entries.length - 1; index >= 0; index--) if (entries[index][0] === name) entries.splice(index, 1); entries.push([name, String(item)]); sync() }
  params.append = (key, item) => { entries.push([String(key), String(item)]); sync() }
  params.delete = (key) => { const name = String(key); for (let index = entries.length - 1; index >= 0; index--) if (entries[index][0] === name) entries.splice(index, 1); sync() }
  params.toString = () => entries.map((entry) => entry[0] + "=" + encode(entry[1])).join("&")
  sync()
  return result
}
const __legadoUrlContext = bindings.__legadoUrlContext
if (__legadoUrlContext !== null && typeof __legadoUrlContext === "object" && !Array.isArray(__legadoUrlContext)) {
  const __legadoUrlMap = {}
  const __legadoMapKey = (key) => String(key)
  const __legadoSyncUrlMap = () => { for (const key of Object.keys(__legadoUrlMap)) delete __legadoUrlMap[key]; for (const [key, value] of Object.entries(__legadoUrlContext.headerMap ?? {})) __legadoUrlMap[key] = String(value ?? "") }
  const __legadoUrlMapPut = (key, value) => { const name = __legadoMapKey(key); const previous = __legadoUrlContext.headerMap?.[name]; if (__legadoUrlContext.headerMap == null) __legadoUrlContext.headerMap = {}; __legadoUrlContext.headerMap[name] = String(value ?? ""); __legadoSyncUrlMap(); return previous }
  const __legadoUrlMapRemove = (key) => { const name = __legadoMapKey(key); const previous = __legadoUrlContext.headerMap?.[name]; if (__legadoUrlContext.headerMap != null) delete __legadoUrlContext.headerMap[name]; __legadoSyncUrlMap(); return previous }
  Object.defineProperties(__legadoUrlMap, { get: { value: (key) => __legadoUrlContext.headerMap?.[__legadoMapKey(key)] }, put: { value: __legadoUrlMapPut }, remove: { value: __legadoUrlMapRemove }, clear: { value: () => { __legadoUrlContext.headerMap = {}; __legadoSyncUrlMap() } }, containsKey: { value: (key) => Object.prototype.hasOwnProperty.call(__legadoUrlContext.headerMap ?? {}, __legadoMapKey(key)) }, size: { value: () => Object.keys(__legadoUrlContext.headerMap ?? {}).length }, isEmpty: { value: () => Object.keys(__legadoUrlContext.headerMap ?? {}).length === 0 }, keySet: { value: () => legadoList(Object.keys(__legadoUrlContext.headerMap ?? {})) } })
  __legadoSyncUrlMap()
  Object.defineProperties(java, { url: { configurable: true, get: () => String(__legadoUrlContext.url ?? ""), set: (value) => { __legadoUrlContext.url = String(value ?? ""); __legadoUrlContext.urlDirty = true } }, headerMap: { configurable: true, get: () => __legadoUrlMap } })
  java.getHeaderMap = () => __legadoUrlMap
  java.initUrl = () => { const value = request({ kind: "resolve-url", url: String(__legadoUrlContext.baseUrl ?? baseUrl ?? ""), value: String(__legadoUrlContext.url ?? "") }); __legadoUrlContext.url = String(value ?? __legadoUrlContext.url ?? ""); __legadoUrlContext.urlDirty = true; return __legadoUrlContext.url }
  const __legadoResponseHeaders = (headers) => { const source = headers !== null && typeof headers === "object" && !Array.isArray(headers) ? headers : {}; const get = (name) => { const wanted = String(name).toLowerCase(); for (const [key, value] of Object.entries(source)) if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? ""); return "" }; const result = { ...source }; Object.defineProperties(result, { get: { value: get }, names: { value: () => Object.keys(source) }, toMultimap: { value: () => ({ ...source }) }, toString: { value: () => Object.entries(source).map(([key, value]) => String(key) + ": " + (Array.isArray(value) ? value.join(", ") : String(value)) + "\n").join("") } }); return result }
  const __legadoStrResponse = (raw) => { const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; const target = String(record.url ?? __legadoUrlContext.url ?? ""); const body = String(record.body ?? raw ?? ""); const status = Number(record.status ?? record.code ?? 200); const headers = record.headers ?? {}; const message = String(record.message ?? record.statusMessage ?? ""); const response = { body, status, code: status, url: target, headers, redirected: Boolean(record.redirected), bytes: record.bytes }; const rawResponse = { request: () => ({ url: () => String(record.requestUrl ?? target), method: () => String(record.requestMethod ?? "GET"), headers: () => record.requestHeaders ?? {} }), url: () => target, code: () => status, statusCode: () => status, message: () => message, headers: () => __legadoResponseHeaders(headers), header: (name) => __legadoResponseHeaders(headers).get(name), isSuccessful: () => status >= 200 && status < 300 }; Object.defineProperties(rawResponse, { request: { value: rawResponse.request, configurable: true }, url: { value: rawResponse.url, configurable: true }, code: { value: rawResponse.code, configurable: true }, statusCode: { value: rawResponse.statusCode, configurable: true }, message: { value: rawResponse.message, configurable: true }, headers: { value: rawResponse.headers, configurable: true }, header: { value: rawResponse.header, configurable: true }, isSuccessful: { value: rawResponse.isSuccessful, configurable: true } }); Object.defineProperties(response, { statusCode: { value: () => status, configurable: true }, message: { value: () => message, configurable: true }, header: { value: (name) => __legadoResponseHeaders(headers).get(name), configurable: true }, isSuccessful: { value: () => status >= 200 && status < 300, configurable: true }, bodyAsBytes: { value: () => record.bytes instanceof Uint8Array ? record.bytes : record.bodyBytes instanceof Uint8Array ? record.bodyBytes : request({ kind: "encode-bytes", value: body, charset: "UTF-8" }), configurable: true }, errorBody: { value: () => record.errorBody ?? null, configurable: true }, callTime: { value: () => Number(record.callTime ?? 0), configurable: true }, raw: { value: () => rawResponse, configurable: true }, toString: { value: () => String(status) + " " + message, configurable: true } }); return response }
  const __legadoUrlRequest = (kind, jsStr, sourceRegex, useWebView) => request({ kind: "url-context-response", input: { url: String(__legadoUrlContext.url ?? ""), headers: { ...(__legadoUrlContext.headerMap ?? {}) }, body: __legadoUrlContext.body, method: __legadoUrlContext.method, options: __legadoUrlContext.options, baseUrl: __legadoUrlContext.baseUrl, redirectUrl: __legadoUrlContext.redirectUrl, responseKind: kind, jsStr, sourceRegex, useWebView: useWebView !== false } })
  java.getStrResponse = (jsStr, sourceRegex, useWebView) => __legadoStrResponse(__legadoUrlRequest("string", jsStr, sourceRegex, useWebView))
  java.getResponse = () => legadoResponseCompat(String(__legadoUrlContext.url ?? ""), __legadoUrlRequest("response"))
  java.getHeaderMap = () => __legadoUrlMap
}
globalThis.__legadoJavaPackages = { JavaImporter, Packages, JavaAdapter, MessageDigest: legadoMessageDigest, StringBuilder: legadoStringBuilder, Integer: legadoInteger, HashMap: legadoJavaUtil.HashMap, ArrayList: legadoJavaUtil.ArrayList, Pattern: legadoPattern, Base64: legadoBase64 }
`

/**
 * Element/Elements 的受控对象图。节点关系通过 parser adapter 的 DTO 端口取得，
 * 这样 JavaScript 只能看到稳定引用和允许的修改，不能持有 htmlparser2/xmldom 实例。
 */
const javaObjectGraphPrelude = String.raw`
const __legadoNodeGraphInfo = (node) => request({ kind: "node-info", value: String(node?.id ?? "") }) ?? {}
const __legadoNodeGraphMatch = (node, selector) => request({ kind: "node-match", value: { id: String(node?.id ?? ""), selector: String(selector ?? "") } }) === true
const __legadoNodeGraph = (node) => {
  if (node == null || typeof node !== "object" || node.__legadoNode !== "source-rule-node") return node
  const read = (rule) => legadoValueText(evaluateRule(String(rule), { expect: "text", content: node }))
  const value = { __legadoNode: node.__legadoNode, id: node.id }
  const info = () => __legadoNodeGraphInfo(node)
  const relation = (key) => { const item = info()[key]; return item == null ? null : __legadoNodeGraph(item) }
  const relationList = (key) => (Array.isArray(info()[key]) ? info()[key] : []).map(__legadoNodeGraph)
  Object.defineProperties(value, {
    attr: { value: function(name, next) { if (arguments.length > 1) { request({ kind: "node-mutate", value: { id: node.id, mutation: { operation: "attr", name: String(name), value: next == null ? null : String(next) } } }); return value } return String(info().attributes?.[String(name)] ?? "") } },
    hasAttr: { value: (name) => Object.prototype.hasOwnProperty.call(info().attributes ?? {}, String(name)) },
    text: { value: () => read("@text") },
    ownText: { value: () => read("@ownText") },
    html: { value: () => read("@html") },
    textNodes: { value: () => read("@textNodes") },
    select: { value: (rule) => __legadoElementsGraph(evaluateRule(String(rule), { expect: "nodes", content: node })) },
    parent: { value: () => relation("parent") },
    parents: { value: () => __legadoElementsGraph(relationList("parents")) },
    children: { value: () => __legadoElementsGraph(relationList("children")) },
    nextElementSibling: { value: () => relation("nextSibling") },
    previousElementSibling: { value: () => relation("previousSibling") },
    tagName: { value: () => String(info().tagName ?? "") },
    idName: { value: () => String(info().id ?? "") },
    className: { value: () => String(info().className ?? "") },
    is: { value: (selector) => __legadoNodeGraphMatch(node, selector) },
    clone: { value: () => __legadoNodeGraph(request({ kind: "node-mutate", value: { id: node.id, mutation: { operation: "clone" } } })) },
    remove: { value: () => { request({ kind: "node-mutate", value: { id: node.id, mutation: { operation: "remove" } } }); return value } },
    toString: { value: () => read("@text") },
  })
  return value
}
const __legadoElementsGraph = (values) => {
  const list = (Array.isArray(values) ? values : values == null ? [] : [values]).map(__legadoNodeGraph)
  Object.defineProperties(list, {
    toArray: { value: () => list.slice() },
    get: { value: (index) => list[Number(index)] ?? null },
    first: { value: () => list.length === 0 ? null : list[0] },
    last: { value: () => list.length === 0 ? null : list[list.length - 1] },
    size: { value: () => list.length },
    isEmpty: { value: () => list.length === 0 },
    attr: { value: function(name, next) { if (arguments.length > 1) { for (const item of list) if (item && typeof item.attr === "function") item.attr(name, next); return list } const first = list[0]; return first && typeof first.attr === "function" ? first.attr(name) : "" } },
    text: { value: () => list.map((item) => item && typeof item.text === "function" ? item.text() : "").filter(Boolean).join(" ") },
    ownText: { value: () => list.map((item) => item && typeof item.ownText === "function" ? item.ownText() : "").filter(Boolean).join(" ") },
    html: { value: () => list.map((item) => item && typeof item.html === "function" ? item.html() : "").join("\\n") },
    select: { value: (rule) => __legadoElementsGraph(list.flatMap((item) => item && typeof item.select === "function" ? item.select(rule) : [])) },
    remove: { value: () => { for (const item of list) if (item && typeof item.remove === "function") item.remove(); return list } },
    clone: { value: () => __legadoElementsGraph(list.map((item) => item && typeof item.clone === "function" ? item.clone() : item)) },
  })
  return list
}
java.getElement = (rule) => { const result = evaluateRule(String(rule), { expect: "nodes", content: legadoContent }); return Array.isArray(result) ? __legadoElementsGraph(result) : __legadoNodeGraph(result) }
java.getElements = (rule) => __legadoElementsGraph(evaluateRule(String(rule), { expect: "nodes", content: legadoContent }))
`

interface SelectedNode {
  readonly document: HtmlDocument
  readonly node: ParserNode
}

class SourceRuleError extends Error {
  public readonly status: Extract<WorkflowRuleOutput['status'], 'failed' | 'cancelled' | 'capability-missing'>

  public constructor(status: Extract<WorkflowRuleOutput['status'], 'failed' | 'cancelled' | 'capability-missing'>, message: string) {
    super(message)
    this.status = status
  }
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n')
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

const sourceCacheJsonPrefix = '__legado_cache_json_v1__:'
const sourceCacheBytesPrefix = '__legado_cache_bytes_v1__:'

function encodeSourceCacheValue(encoding: EncodingHost, value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return `${sourceCacheBytesPrefix}${encoding.base64Encode(value)}`
  if (value instanceof ArrayBuffer) return `${sourceCacheBytesPrefix}${encoding.base64Encode(new Uint8Array(value))}`
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? textValue(value) : `${sourceCacheJsonPrefix}${serialized}`
  } catch {
    throw new Error('__LEGADO_CACHE__cache-failed: value is not serializable')
  }
}

function decodeSourceCacheValue(encoding: EncodingHost, value: string | undefined): unknown {
  if (value === undefined) return undefined
  if (value.startsWith(sourceCacheBytesPrefix)) return encoding.base64Decode(value.slice(sourceCacheBytesPrefix.length))
  if (value.startsWith(sourceCacheJsonPrefix)) {
    try { return JSON.parse(value.slice(sourceCacheJsonPrefix.length)) } catch { return value }
  }
  return value
}

function inlineJavaScript(value: unknown): string | undefined {
  const text = textValue(value).trim()
  if (text.length === 0) return undefined
  const match = /^<js>([\s\S]*?)<\/js>$|^@js:([\s\S]*)$/iu.exec(text)
  return match === null ? undefined : (match[1] ?? match[2] ?? '').trim()
}

/**
 * QuickJS treats a top-level array/object literal as a block-like statement in
 * a few source-rule execution modes. Android evaluates these rules as an
 * expression, so parenthesize an expression-only literal before handing it to
 * the host. Statements and function bodies keep their original form.
 */
function normalizeJavaScriptExpression(code: string): string {
  const value = code.trim()
  if (value.length < 2 || (value[0] !== '[' && value[0] !== '{') || value.includes(';')) return code
  if (value[0] === '[' || value[0] === '{') return `var __legadoExpression = (${code}); __legadoExpression`
  return code
}

function sourceHeaderObject(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, textValue(item)]))
    throw new Error('source header must be an object')
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, textValue(item)]))
  throw new Error('source header must be an object')
}

function loginInfoDefaults(value: unknown): Record<string, string> | undefined {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return undefined }
  }
  if (!Array.isArray(parsed)) return undefined
  return Object.fromEntries(parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item) && textValue(item.type) !== 'button' && textValue(item.name).length > 0)
    .map((item) => [textValue(item.name), textValue(item.default)]))
}

/** Android NetworkUtils.getAbsoluteURL 的最小跨平台等价实现。 */
function resolveSourceUrl(baseValue: unknown, relativeValue: unknown): string {
  const relative = textValue(relativeValue).trim()
  if (relative.startsWith('javascript')) return ''
  const base = textValue(baseValue).split(',')[0]?.trim() ?? ''
  if (base.length === 0) return relative
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

function resolveSourceUrls(baseValue: unknown, relativeValues: unknown): string[] {
  return Array.isArray(relativeValues) ? relativeValues.map((value) => resolveSourceUrl(baseValue, value)) : []
}

function byteValue(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return Uint8Array.from(value)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => Number(left) - Number(right))
    if (entries.length > 0 && entries.every(([key, item], index) => key === String(index) && typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return Uint8Array.from(entries.map(([, item]) => item as number))
  }
  throw new Error('书源 bytes bridge 需要 ByteArray')
}

function isByteValue(value: unknown): boolean {
  try {
    byteValue(value)
    return true
  } catch {
    return false
  }
}

function cryptoInputValue(value: unknown): string | Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return Uint8Array.from(value)
  return textValue(value)
}

/** Android Base64 flags 的可移植子集：URL_SAFE、NO_PADDING、NO_WRAP、CRLF。 */
function base64Flags(value: unknown): number {
  const flags = Number(value ?? 0)
  if (!Number.isInteger(flags) || flags < 0 || flags > 0x3f) throw new Error('invalid Base64 flags')
  return flags
}

function base64EncodeWithFlags(encoding: EncodingHost, value: string | Uint8Array, flagsValue: unknown): string {
  const flags = base64Flags(flagsValue)
  let result = encoding.base64Encode(value)
  if ((flags & 8) !== 0) result = result.replaceAll('+', '-').replaceAll('/', '_')
  if ((flags & 1) !== 0) result = result.replace(/=+$/u, '')
  if ((flags & 4) !== 0) {
    const width = 76
    result = result.replace(new RegExp(`.{1,${width}}`, 'gu'), (line) => `${line}\r\n`).replace(/\r\n$/u, '')
  }
  return result
}

function base64DecodeWithFlags(encoding: EncodingHost, value: unknown, flagsValue: unknown): Uint8Array {
  const flags = base64Flags(flagsValue)
  let input = textValue(value).replace(/[\r\n\t\s]/gu, '')
  if ((flags & 8) !== 0) input = input.replaceAll('-', '+').replaceAll('_', '/')
  if (input.length % 4 === 2) input += '=='
  else if (input.length % 4 === 3) input += '='
  return encoding.base64Decode(input)
}

function encodeFormUri(encoding: EncodingHost, value: unknown, charset: unknown): string {
  const bytes = encoding.encode(textValue(value), textValue(charset) || 'UTF-8')
  let result = ''
  for (const byte of bytes) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2a || byte === 0x2d || byte === 0x2e || byte === 0x5f) result += String.fromCharCode(byte)
    else if (byte === 0x20) result += '+'
    else result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return result
}

type DigestAlgorithmName = 'md5' | 'sha1' | 'sha256' | 'sha512'

function digestAlgorithm(value: unknown): DigestAlgorithmName {
  const normalized = textValue(value).toLowerCase().replace(/[^a-z0-9]/gu, '')
  if (normalized === 'md5' || normalized === 'hmacmd5') return 'md5'
  if (normalized === 'sha1' || normalized === 'hmacsha1') return 'sha1'
  if (normalized === 'sha256' || normalized === 'hmacsha256') return 'sha256'
  if (normalized === 'sha512' || normalized === 'hmacsha512') return 'sha512'
  throw new Error(`unsupported digest algorithm: ${textValue(value)}`)
}

const chineseDigitValues: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
  十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 亿: 100000000,
}

function fullToHalf(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x3000) return ' '
    return code >= 0xff01 && code <= 0xff3e ? String.fromCodePoint(code - 0xfee0) : character
  }).join('')
}

/** Android JsExtensions.toNumChapter：把“第十一章”中的中文序号转换为阿拉伯数字。 */
function toNumChapter(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  const match = /第(.+?)章/u.exec(text)
  if (match === null) return text
  const numberText = fullToHalf(match[1] ?? '').replace(/\s+/gu, '')
  let number = -1
  if (/^[+-]?\d+$/u.test(numberText)) {
    const parsed = Number(numberText)
    if (Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647) number = parsed
  } else {
    let result = 0
    let temporary = 0
    let billion = 0
    try {
      for (let index = 0; index < numberText.length; index++) {
        const current = numberText[index]
        if (current === undefined) throw new Error('unknown Chinese number')
        const digit = chineseDigitValues[current]
        if (digit === undefined) throw new Error('unknown Chinese number')
        if (digit === 100000000) {
          result += temporary
          result *= digit
          billion = billion * 100000000 + result
          result = 0
          temporary = 0
        } else if (digit === 10000) {
          result += temporary
          result *= digit
          temporary = 0
        } else if (digit >= 10) {
          if (temporary === 0) temporary = 1
          result += digit * temporary
          temporary = 0
        } else {
          const previousCharacter = index > 0 ? numberText[index - 1] : undefined
          const previous = previousCharacter === undefined ? undefined : chineseDigitValues[previousCharacter]
          temporary = index >= 2 && index === numberText.length - 1 && previous !== undefined && previous > 10
            ? digit * previous / 10
            : temporary * 10 + digit
        }
      }
      number = result + temporary + billion
    } catch {
      number = -1
    }
  }
  return text.slice(0, match.index + 1) + String(number) + text.slice(match.index + match[0].length - 1)
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function isVariableScope(value: unknown): value is JavaScriptVariableScope {
  return value === 'chapter' || value === 'book' || value === 'rule-data' || value === 'source'
}

function jsonInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    // JSON 文本可能带 UTF-8 BOM；先移除 BOM 再解析。
    return JSON.parse(value.replace(/^\uFEFF/, '')) as unknown
  } catch {
    return value
  }
}

function isNodeRef(value: unknown): value is NodeRef {
  return typeof value === 'object' && value !== null && (value as { __legadoNode?: unknown }).__legadoNode === 'source-rule-node' && typeof (value as { id?: unknown }).id === 'string'
}

type DefaultOutput = 'text' | 'textNodes' | 'ownText' | 'html' | 'all'

interface DefaultPlan {
  /** `@` 之前的元素选择器链；没有选择器时为空串。 */
  selector: string
  /** 已知输出标记；与 `attribute` 互斥。 */
  output?: DefaultOutput
  /** 末段不是输出标记时，按 Android 语义作为属性名。 */
  attribute?: string
}

/**
 * 解析 Default 规则：Android 把 `@` 分割后的最后一段一律当作输出标记，只识别
 * text/textNodes/ownText/html/all，其余（含 href、value、data-original）都是属性名；
 * 整条规则没有 `@` 时整段就是属性名。字段规则据此取值，不能把节点本身当成结果。
 */
function lastOutput(body: string): DefaultPlan {
  const separator = body.lastIndexOf('@')
  if (separator < 0) return { selector: '', attribute: body.trim() }
  const token = body.slice(separator + 1).trim()
  if (token.length === 0) return { selector: body, output: 'text' }
  const lower = token.toLowerCase()
  const output: DefaultOutput | undefined = lower === 'text' ? 'text' : lower === 'textnodes' ? 'textNodes' : lower === 'owntext' ? 'ownText' : lower === 'html' ? 'html' : lower === 'all' ? 'all' : undefined
  return output === undefined ? { selector: body.slice(0, separator), attribute: token } : { selector: body.slice(0, separator), output }
}

/** Android AnalyzeRule.isJSON：对象/数组，或 trim 后由 `{}`、`[]` 包裹的字符串。 */
function jsonContent(value: unknown): boolean {
  if (value === null || value === undefined || isNodeRef(value)) return false
  if (Array.isArray(value)) return !value.some(isNodeRef)
  if (typeof value !== 'string') return typeof value === 'object'
  const text = value.trim()
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))
}

/**
 * jsonpath-plus 只对「确定路径」额外包一层数组；含通配、递归、过滤、切片、联合或脚本的路径，
 * 返回值本身就是 Android `JsonPath.read` 的元素列表（如 `$.single[*]` 在 `[[1,2]]` 上返回 `[[1,2]]`）。
 */
function isDefiniteJsonPath(expression: string): boolean {
  const unquoted = expression.replace(/'[^']*'|"[^"]*"/gu, '')
  return !/[*?()]|\.\.|,|:/u.test(unquoted)
}

function normalizeSelector(selector: string): string {
  if (selector.startsWith('class.')) return `.${selector.slice('class.'.length)}`
  if (selector.startsWith('tag.')) return selector.slice('tag.'.length)
  if (selector.startsWith('id.')) return `#${selector.slice('id.'.length)}`
  return selector
}

function splitSelectorChain(selector: string): string[] {
  return selector.split('@').map((item) => item.trim()).filter(Boolean)
}

interface PositionSelection {
  base: string
  tokens: Array<number | { start?: number; end?: number; step: number }>
  excluded: boolean
}

function parseBracketSelection(selector: string): PositionSelection | undefined {
  const open = selector.lastIndexOf('[')
  if (open < 0 || !selector.endsWith(']')) return undefined
  let body = selector.slice(open + 1, -1).trim()
  const excluded = body.startsWith('!')
  if (excluded) body = body.slice(1).trim()
  if (body.length === 0) return undefined
  const tokens: PositionSelection['tokens'] = []
  for (const part of body.split(',')) {
    const item = part.trim()
    if (/^-?\d+$/u.test(item)) {
      tokens.push(Number(item))
      continue
    }
    const range = /^(-?\d+)?\s*:\s*(-?\d+)?\s*(?::\s*(-?\d+))?$/u.exec(item)
    if (range === null) return undefined
    tokens.push({
      ...(range[1] === undefined ? {} : { start: Number(range[1]) }),
      ...(range[2] === undefined ? {} : { end: Number(range[2]) }),
      step: range[3] === undefined ? 1 : Number(range[3]),
    })
  }
  return { base: selector.slice(0, open), tokens, excluded }
}

function parseLegacySelection(selector: string): PositionSelection | undefined {
  const match = /^(.*?)([.!])(-?\d+(?::-?\d+)*)$/u.exec(selector)
  if (match === null) return undefined
  return {
    base: match[1]!,
    tokens: match[3]!.split(':').map(Number),
    excluded: match[2] === '!',
  }
}

function positionedIndexes(selection: PositionSelection, length: number): number[] {
  const indexes: number[] = []
  const add = (index: number): void => {
    const normalized = index < 0 ? length + index : index
    if (normalized >= 0 && normalized < length && !indexes.includes(normalized)) indexes.push(normalized)
  }
  for (const token of selection.tokens) {
    if (typeof token === 'number') {
      add(token)
      continue
    }
    let start = token.start ?? 0
    let end = token.end ?? length - 1
    if (start < 0) start += length
    if (end < 0) end += length
    if (length === 0 || ((start < 0 && end < 0) || (start >= length && end >= length))) continue
    start = Math.max(0, Math.min(length - 1, start))
    end = Math.max(0, Math.min(length - 1, end))
    if (start === end || token.step >= length) {
      add(start)
      continue
    }
    const step = token.step > 0 ? token.step : -token.step < length ? token.step + length : 1
    const stride = Math.max(1, step)
    if (end >= start) for (let index = start; index <= end; index += stride) add(index)
    else for (let index = start; index >= end; index -= stride) add(index)
  }
  return indexes
}

function applyPositionSelection(nodes: ParserNode[], selection: PositionSelection | undefined): ParserNode[] {
  if (selection === undefined) return nodes
  const indexes = positionedIndexes(selection, nodes.length)
  if (selection.excluded) {
    const excluded = new Set(indexes)
    return nodes.filter((_node, index) => !excluded.has(index))
  }
  return indexes.map((index) => nodes[index]!)
}

function selectWithPosition(document: HtmlDocument, selector: string): ParserNode[] {
  // Android distinguishes legacy discrete indices (tag.a.0:3) from bracket ranges (tag.a[0:3]).
  const selection = parseBracketSelection(selector) ?? parseLegacySelection(selector)
  const base = selection?.base ?? selector
  const nodes = base.length === 0 || base === 'children' ? document.children() : document.select(base)
  return applyPositionSelection(nodes, selection)
}

interface SourceRuleSegment {
  kind: 'rule' | 'javascript'
  text: string
}

function splitSourceRuleSegments(rule: string): SourceRuleSegment[] | undefined {
  const matcher = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/ig
  const segments: SourceRuleSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(rule)) !== null) {
    const before = rule.slice(cursor, match.index).trim()
    if (before.length > 0) segments.push({ kind: 'rule', text: before })
    const code = (match[1] ?? match[2] ?? '').trim()
    segments.push({ kind: 'javascript', text: code })
    cursor = matcher.lastIndex
    if (match[2] !== undefined) return segments
  }
  if (segments.length === 0) return undefined
  const tail = rule.slice(cursor).trim()
  if (tail.length > 0) segments.push({ kind: 'rule', text: tail })
  return segments
}

type RuleEntity = Record<string, unknown>

function entityVariables(entity: unknown): Record<string, string> {
  if (typeof entity !== 'object' || entity === null) return {}
  const record = entity as RuleEntity
  const value = record.variable ?? (typeof record.rawFields === 'object' && record.rawFields !== null ? (record.rawFields as RuleEntity).variable : undefined)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      }
    } catch {
      return {}
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
  return {}
}

function entityValue(entity: unknown, name: string): string | undefined {
  return entityVariables(entity)[name]
}

function mergeCapturedEntityVariables(value: unknown, names: readonly string[] | undefined, bindings: Readonly<Record<string, unknown>>, initialVariables: Readonly<Record<string, string | undefined>>): unknown {
  if (names === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const wrapper = value as RuleEntity
  const captured = wrapper.__legadoWorkflowBindings
  if (typeof captured !== 'object' || captured === null || Array.isArray(captured)) return value
  const result: RuleEntity = { ...wrapper, __legadoWorkflowBindings: { ...(captured as RuleEntity) } }
  const capturedBindings = result.__legadoWorkflowBindings as RuleEntity
  for (const name of names) {
    const current = bindings[name]
    const returned = capturedBindings[name]
    if (typeof current !== 'object' || current === null || typeof returned !== 'object' || returned === null || Array.isArray(returned)) continue
    const currentVariable = (current as RuleEntity).variable
    if (typeof currentVariable === 'string' && currentVariable !== initialVariables[name]) {
      capturedBindings[name] = { ...(returned as RuleEntity), variable: currentVariable }
    }
  }
  return result
}

export class SourceRuleRuntime implements WorkflowRulePort {
  private readonly variables: MemoryVariableView
  private readonly html: HtmlParser
  private readonly json: JsonPathParser
  private readonly xpath: XPathParser
  private readonly javascript: JavaScriptHost
  private readonly encoding: EncodingHost
  private readonly crypto: CryptoHost
  private readonly font: FontHost
  private readonly requestBridge?: SourceRuleRuntimeOptions['request']
  private readonly setConcurrentRate?: SourceRuleRuntimeOptions['setConcurrentRate']
  private readonly cache: SourceScriptCache
  private readonly timeFormat?: SourceRuleRuntimeOptions['timeFormat']
  private readonly timeFormatUTC?: SourceRuleRuntimeOptions['timeFormatUTC']
  private readonly randomUUID?: SourceRuleRuntimeOptions['randomUUID']
  private readonly sourceState?: SourceRuleRuntimeOptions['sourceState']
  private readonly file?: SourceRuleRuntimeOptions['file']
  private readonly webViewUA?: SourceRuleRuntimeOptions['webViewUA']
  private readonly logger?: SourceRuleRuntimeOptions['logger']
  private readonly platform?: SourceRuleRuntimeOptions['platform']
  private readonly concurrency?: SourceRuleRuntimeOptions['concurrency']
  private readonly sessionLoginHeaders = new Map<string, string>()
  private readonly sessionLoginInfo = new Map<string, string>()
  private readonly sessionSourceVariables = new Map<string, string>()
  private readonly sessionSourceValues = new Map<string, Map<string, string>>()
  private readonly clearedJsLibStates = new Set<string>()
  private readonly fontMappings = new Map<string, FontMapping>()
  private nextFontId = 0
  private readonly maxSteps: number
  private readonly nodes = new Map<string, StoredNode>()
  private readonly captureRows = new WeakMap<object, string>()
  private bindings: Readonly<Record<string, unknown>> = {}
  private nextNodeId = 0

  public constructor(options: SourceRuleRuntimeOptions) {
    this.variables = new MemoryVariableView({ availableScopes: ['source'], initial: { source: options.initialVariables ?? {} } })
    this.encoding = options.encoding
    this.crypto = options.crypto
    this.font = options.font
    this.html = options.html
    this.json = options.json
    this.xpath = options.xpath
    this.javascript = options.javascript
    this.requestBridge = options.request
    this.setConcurrentRate = options.setConcurrentRate
    this.cache = options.cache ?? new MemorySourceScriptCache()
    this.timeFormat = options.timeFormat
    this.timeFormatUTC = options.timeFormatUTC
    this.randomUUID = options.randomUUID
    this.sourceState = options.sourceState
    this.file = options.file
    this.webViewUA = options.webViewUA
    this.logger = options.logger
    this.platform = options.platform
    this.concurrency = options.concurrency
    this.maxSteps = options.maxSteps ?? 10000
  }

  public setBindings(bindings: Readonly<Record<string, unknown>>): void {
    this.bindings = { ...bindings }
  }

  public setVariable(name: string, value: string | null): void {
    this.variables.set(name, value, 'source')
  }

  public snapshotVariables(scope: 'source'): Readonly<Record<string, string>> {
    return this.variables.snapshot(scope)
  }

  private readVariable(name: string, bindings: Readonly<Record<string, unknown>>, scope?: JavaScriptVariableScope): string | undefined {
    if (scope === 'source') {
      const value = this.variables.get(name, 'source')
      return name === '__source__' ? value ?? '' : value
    }
    if (scope !== undefined) return entityValue(this.entityForScope(bindings, scope), name)
    if (name === 'bookName' && this.entityForScope(bindings, 'book') !== undefined) {
      const bookName = (this.entityForScope(bindings, 'book') as RuleEntity).name
      return bookName === null || bookName === undefined ? '' : textValue(bookName)
    }
    if (name === 'title' && this.entityForScope(bindings, 'chapter') !== undefined) {
      const title = (this.entityForScope(bindings, 'chapter') as RuleEntity).title
      return title === null || title === undefined ? '' : textValue(title)
    }
    for (const current of ['chapter', 'book', 'rule-data', 'source'] as const) {
      const value = this.readVariable(name, bindings, current)
      if (value !== undefined && value.length > 0) return value
    }
    return undefined
  }

  private writeVariable(name: string, value: unknown, bindings: Readonly<Record<string, unknown>>, scope?: JavaScriptVariableScope): void {
    const target = scope ?? (this.entityForScope(bindings, 'chapter') !== undefined ? 'chapter' : this.entityForScope(bindings, 'book') !== undefined ? 'book' : this.entityForScope(bindings, 'rule-data') !== undefined ? 'rule-data' : 'source')
    const next = value === null || value === undefined ? null : textValue(value)
    if (target === 'source') {
      this.variables.set(name, next, 'source')
      return
    }
    const entity = this.entityForScope(bindings, target)
    if (entity === undefined) return
    const values = entityVariables(entity)
    if (next === null) delete values[name]
    else Object.defineProperty(values, name, { value: next, enumerable: true, configurable: true, writable: true })
    entity.variable = JSON.stringify(values)
  }

  private entityForScope(bindings: Readonly<Record<string, unknown>>, scope: JavaScriptVariableScope): RuleEntity | undefined {
    const value = scope === 'rule-data'
      ? bindings.ruleData ?? bindings.rule_data
      : scope === 'chapter'
        ? bindings.chapter ?? bindings[internalChapterScopeBinding]
        : bindings[scope]
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RuleEntity : undefined
  }

  private async nestedRule(rule: string, state: EvaluationState, content: unknown, expect: WorkflowRuleRequest['expect'], signal: AbortSignal): Promise<unknown> {
    const nestedState: EvaluationState = {
      ...state,
      request: { ...state.request, signal },
      budget: state.budget,
    }
    this.check(nestedState)
    state.budget.depth += 1
    if (state.budget.depth > 64) {
      state.budget.depth -= 1
      throw new SourceRuleError('failed', '规则嵌套超过限制')
    }
    try {
      const nestedExpect = expect ?? 'text'
      const request: WorkflowRuleRequest = { ...nestedState.request, rule, content, expect: nestedExpect, bindings: state.bindings }
      return await this.evaluateText(rule, { ...nestedState, request, content, expect: nestedExpect }, content)
    } finally {
      state.budget.depth -= 1
    }
  }

  public async executeJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown = '', signal?: AbortSignal): Promise<WorkflowRuleOutput> {
    return this.runJavaScript(code, stage, source, content, signal)
  }

  public async executeWorkflowJavaScript(request: WorkflowJavaScriptRequest): Promise<WorkflowRuleOutput> {
    return this.runJavaScript(request.code, request.stage, request.source, request.content ?? '', request.signal, {
      mode: 'script',
      ...(request.workflowStage === undefined ? {} : { workflowStage: request.workflowStage }),
      ...(request.captureMutations === undefined ? {} : { captureBindings: request.captureMutations }),
      ...(request.mutableBindings === undefined ? {} : { mutableBindings: request.mutableBindings }),
      ...(request.content === undefined ? {} : { content: request.content }),
      ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
      ...(request.redirectUrl === undefined ? {} : { redirectUrl: request.redirectUrl }),
      ...(request.bindings === undefined ? {} : { bindings: request.bindings }),
      ...(request.captureGlobals === true ? { captureGlobals: true } : {}),
      ...(request.globalState === undefined ? {} : { globalState: request.globalState }),
      ...(request.workflowActions === undefined ? {} : { workflowActions: request.workflowActions }),
      ...(request.javascriptBudget === undefined ? {} : { javascriptBudget: request.javascriptBudget }),
      ...(request.requestBudget === undefined ? {} : { requestBudget: request.requestBudget }),
      ...(request.requestObserver === undefined ? {} : { requestObserver: request.requestObserver }),
    })
  }

  public async executeImageDecodeScript(request: WorkflowImageDecodeRequest): Promise<WorkflowRuleOutput> {
    return this.runJavaScript(request.code, 'content', request.source, request.bytes, request.signal, {
      mode: 'script',
      content: request.src,
      bindings: { book: request.book },
      resultInputKind: request.resultInputKind,
      ...(request.javascriptBudget === undefined ? {} : { javascriptBudget: request.javascriptBudget }),
    })
  }

  public async executeSourceFunction(request: SourceFunctionRequest): Promise<SourceFunctionOutput> {
    const names: Record<SourceFunctionName, readonly string[]> = {
      search: ['key', 'page'],
      explore: ['url', 'page'],
      getBookInfo: ['book'],
      getChapters: ['book'],
      getContent: ['chapter', 'book', 'nextChapterUrl'],
      getContentBatch: ['chapters', 'book'],
      getReviewSummary: ['chapter', 'book'],
      getReviewDetail: ['chapter', 'book', 'paraIndex', 'paraData', 'page'],
      getReviewReplies: ['chapter', 'book', 'paraIndex', 'paraData', 'reviewId', 'page'],
    }
    const parameters = names[request.name]
    const bindings: Readonly<Record<string, unknown>> = {
      ...(request.bindings ?? {}),
      ...Object.fromEntries(parameters.map((name, index) => [name, request.args[index]])),
    }
    const call = `${request.name}(${parameters.join(', ')})`
    const code = [
      request.source.mainJs ?? '',
      `typeof ${request.name} === 'function' ? { __legadoSourceFunctionExists: true, value: ${call} } : { __legadoSourceFunctionExists: false }`,
    ].join('\n')
    const captureBindings = parameters.filter((name) => Object.hasOwn(bindings, name))
    const output = await this.runJavaScript(code, request.stage, request.source, '', request.signal, { bindings, mode: 'script', captureBindings, ...(request.workflowStage === undefined ? {} : { workflowStage: request.workflowStage }), ...(request.workflowActions === undefined ? {} : { workflowActions: request.workflowActions }), ...(request.requestBudget === undefined ? {} : { requestBudget: request.requestBudget }), ...(request.requestObserver === undefined ? {} : { requestObserver: request.requestObserver }) })
    if (output.status !== 'success') return { ...output, exists: false }
    let value = output.value
    if (captureBindings.length > 0) {
      const captured = value as { __legadoWorkflowValue?: unknown; __legadoWorkflowBindings?: unknown } | null
      if (typeof captured !== 'object' || captured === null || !('__legadoWorkflowBindings' in captured) || typeof captured.__legadoWorkflowBindings !== 'object' || captured.__legadoWorkflowBindings === null) {
        return { status: 'failed', value: null, exists: false, message: 'JavaScript 源函数返回值无法识别' }
      }
      for (const name of captureBindings) {
        const target = bindings[name]
        const changed = (captured.__legadoWorkflowBindings as RuleEntity)[name]
        if (typeof target !== 'object' || target === null || Array.isArray(target) || typeof changed !== 'object' || changed === null || Array.isArray(changed)) continue
        for (const [key, value] of Object.entries(changed)) {
          Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
        }
      }
      value = captured.__legadoWorkflowValue
    }
    if (typeof value !== 'object' || value === null || !('__legadoSourceFunctionExists' in value)) {
      return { status: 'failed', value: null, exists: false, message: 'JavaScript 源函数返回值无法识别' }
    }
    const result = value as { __legadoSourceFunctionExists: unknown; value?: unknown }
    if (result.__legadoSourceFunctionExists !== true) return { status: 'empty', value: null, exists: false }
    return { status: result.value === null || result.value === undefined ? 'empty' : 'success', value: result.value ?? null, exists: true }
  }

  public async evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput> {
    if (request.signal?.aborted === true) return { status: 'cancelled', value: null, message: '规则求值已取消' }
    const bindings = { ...this.bindings, ...(request.bindings ?? {}) }
    const state: EvaluationState = { request: { ...request, bindings }, source: request.source, content: request.content, bindings, budget: { steps: 0, depth: 0 }, expect: request.expect }
    try {
      const value = await this.evaluateText(request.rule, state, request.content)
      return nonEmpty(value) ? { status: 'success', value } : { status: 'empty', value: null }
    } catch (error) {
      if (error instanceof SourceRuleError) return { status: error.status, value: null, message: error.message }
      return { status: 'failed', value: null, message: error instanceof Error ? error.message : '规则求值失败' }
    }
  }

  private async evaluateText(rule: string, state: EvaluationState, content: unknown): Promise<unknown> {
    this.check(state)
    const segments = splitSourceRuleSegments(rule)
    if (segments !== undefined) {
      let result = content
      for (const [index, segment] of segments.entries()) {
        if (index > 0) this.check(state)
        if (segment.kind === 'rule') {
          const captureExpansion = this.expandCaptureReferences(segment.text, result, state.source.bookSourceUrl)
          result = captureExpansion.changed
            ? await this.evaluateCaptureText(captureExpansion.text, state, result)
            : await this.evaluatePlainText(segment.text, state, result)
          continue
        }
        // `<js></js>` is also used as a separator; an empty body leaves the current result intact.
        if (segment.text.length === 0) continue
        // JS templates are expanded against the content that entered the full rule,
        // while `result` itself is the output of the preceding segment.
        const code = await this.expandTemplate(segment.text, state, content)
        const output = await this.runJavaScript(code, this.javascriptStage(state.request.stage), state.source, result, state.request.signal, { ...state.request, bindings: state.bindings, ruleState: state, mode: 'script' })
        if (output.status !== 'success') throw new SourceRuleError(output.status === 'capability-missing' ? 'capability-missing' : output.status === 'cancelled' ? 'cancelled' : 'failed', output.message ?? 'JavaScript 规则执行失败')
        result = this.unwrapCapturedRuleValue(output.value, state)
      }
      return result
    }
    const captureExpansion = this.expandCaptureReferences(rule, content, state.source.bookSourceUrl)
    const ruleText = captureExpansion.changed ? captureExpansion.text : rule
    if (captureExpansion.changed) return this.evaluateCaptureText(ruleText, state, content)
    return this.evaluatePlainText(ruleText, state, content)
  }

  private expandCaptureReferences(rule: string, content: unknown, sourceId: string): { text: string; changed: boolean } {
    if (!Array.isArray(content) || this.captureRows.get(content) !== sourceId) return { text: rule, changed: false }
    let changed = false
    const text = rule.replace(/\$([1-9]\d?)/gu, (_match, captureIndex: string) => {
      changed = true
      return textValue(content[Number(captureIndex)])
    })
    return { text, changed }
  }

  private async evaluateCaptureText(rule: string, state: EvaluationState, content: unknown): Promise<unknown> {
    if (!rule.includes('##') && !/@put:/i.test(rule)) return this.interpolate(rule, state, content)
    const compiled = compileRule(rule, { defaultMode: 'Default', allInOne: false })
    if (compiled.rule === undefined) throw new SourceRuleError('failed', compiled.diagnostics[0]?.message ?? '规则编译失败')
    if (compiled.rule.kind !== 'atom') return this.interpolate(rule, state, content)
    for (const put of compiled.rule.puts) this.writeVariable(put.name, textValue(await this.evaluateNode(put.rule, state, content)), state.bindings)
    const text = await this.interpolate(compiled.rule.body, state, content)
    return this.applyReplacement(text, compiled.rule, state, content)
  }

  private async evaluatePlainText(rule: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const compiled = compileRule(rule, { defaultMode: jsonContent(content) ? 'Json' : 'Default' })
    if (compiled.rule === undefined) throw new SourceRuleError('failed', compiled.diagnostics[0]?.message ?? '规则编译失败')
    return this.evaluateNode(compiled.rule, state, content)
  }

  private async evaluateNode(rule: CompiledRule, state: EvaluationState, content: unknown): Promise<unknown> {
    this.check(state)
    state.budget.depth += 1
    if (state.budget.depth > 64) {
      state.budget.depth -= 1
      throw new SourceRuleError('failed', '规则嵌套超过限制')
    }
    try {
      if (rule.kind === 'atom') return this.evaluateAtom(rule, state, content)
      return this.evaluateSequence(rule, state, content)
    } finally {
      state.budget.depth -= 1
    }
  }

  private async evaluateSequence(rule: RuleSequence, state: EvaluationState, content: unknown): Promise<unknown> {
    if (rule.operator === '||') {
      let lastError: SourceRuleError | undefined
      for (const child of rule.children) {
        try {
          const value = await this.evaluateNode(child, state, content)
          if (nonEmpty(value)) return value
        } catch (error) {
          if (error instanceof SourceRuleError) lastError = error
          else throw error
        }
      }
      if (lastError !== undefined && lastError.status !== 'failed') throw lastError
      return null
    }
    if (rule.operator === '%%') {
      const values: unknown[][] = []
      for (const child of rule.children) values.push(this.toList(await this.evaluateNode(child, state, content)))
      const nonEmptyValues = values.filter((value) => nonEmpty(value))
      const result: unknown[] = []
      const length = nonEmptyValues[0]?.length ?? 0
      for (let index = 0; index < length; index += 1) for (const value of nonEmptyValues) if (index < value.length && nonEmpty(value[index])) result.push(value[index])
      return result
    }
    const values: unknown[] = []
    for (const child of rule.children) {
      const value = await this.evaluateNode(child, state, content)
      if (nonEmpty(value)) values.push(value)
    }
    if (values.length === 0) return null
    if (values.some(Array.isArray)) return values.flatMap((value) => this.toList(value))
    return values.map(textValue).join('\n')
  }

  private async evaluateAtom(rule: RuleAtom, state: EvaluationState, content: unknown): Promise<unknown> {
    for (const put of rule.puts) this.writeVariable(put.name, textValue(await this.evaluateNode(put.rule, state, content)), state.bindings)
    const template = rule.body.includes('{{') || rule.body.includes('@get:')
    const interpolated = template ? await this.interpolate(rule.body, state, content) : rule.body
    let value: unknown
    // Android AnalyzeRule：规则体含 `{{}}`/`@get:{}` 时切到 Regex 模式，结果是插值后的文本本身，
    // 不再按 Default/Json/XPath 解析（AnalyzeRule.kt:702-713）；Js 模式例外，它先插值再执行。
    // 插值后为空时 Android 的 `if (rule.isNotEmpty())` 不成立，result 保持分析前的整页内容。
    // 空规则串在 Android 里分三种：列表规则（getStringList）沿用上一份内容；字段规则（getString）
    // 只有「带 ## 替换」时才沿用内容并继续做替换（AnalyzeRule.kt:345 的 `rule.isNotBlank() || replaceRegex.isEmpty()`），
    // 其余情况字段值就是空串。
    if (interpolated.length === 0 && rule.mode !== 'Js') value = rule.replacement !== undefined || state.expect === 'nodes'
      ? this.contentValue(content)
      : await this.evaluateDefault('', state, content)
    else if (template && (rule.mode === 'Default' || rule.mode === 'Json' || rule.mode === 'XPath')) value = interpolated
    else if (rule.mode === 'Default') value = await this.evaluateDefault(rule.body, state, content)
    else if (rule.mode === 'Json') value = await this.evaluateJson(rule.body, state, content)
    else if (rule.mode === 'XPath') value = this.evaluateXPath(rule.body, content, state.expect)
    else if (rule.mode === 'Regex') value = this.evaluateRegex(rule.body, content, state.source.bookSourceUrl)
    else if (rule.mode === 'Js') {
      const result = await this.runJavaScript(interpolated, this.javascriptStage(state.request.stage), state.source, content, state.request.signal, { ...state.request, bindings: state.bindings, ruleState: state, mode: 'script' })
      if (result.status !== 'success') throw new SourceRuleError(result.status === 'capability-missing' ? 'capability-missing' : result.status === 'cancelled' ? 'cancelled' : 'failed', result.message ?? 'JavaScript 规则执行失败')
      value = this.unwrapCapturedRuleValue(result.value, state)
    } else throw new SourceRuleError('capability-missing', 'WebView 规则需要浏览器宿主')
    return this.applyReplacement(value, rule, state, content)
  }

  private unwrapCapturedRuleValue(value: unknown, state: EvaluationState): unknown {
    const names = state.request.captureBindings
    if (names === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const wrapper = value as RuleEntity
    const captured = wrapper.__legadoWorkflowBindings
    if (typeof captured !== 'object' || captured === null || Array.isArray(captured)) return value
    for (const name of names) {
      const target = state.bindings[name]
      const returned = (captured as RuleEntity)[name]
      if (typeof target !== 'object' || target === null || Array.isArray(target) || typeof returned !== 'object' || returned === null || Array.isArray(returned)) continue
      for (const key of Object.keys(target as RuleEntity)) if (!Object.hasOwn(returned as RuleEntity, key)) delete (target as RuleEntity)[key]
      Object.assign(target as RuleEntity, returned as RuleEntity)
    }
    return wrapper.__legadoWorkflowValue
  }

  private async evaluateDefault(body: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const expanded = await this.interpolate(body, state, content)
    const storedNodes = this.storedNodes(content)
    if (expanded === '') {
      // Android 两条路径对空规则的处理不同：列表规则走 getStringList，`if (rule.isNotEmpty())` 不成立时
      // 沿用上一份内容；字段规则走 getString，最终落到 AnalyzeByJSoup.getString("")，结果是空。
      if (state.expect !== 'nodes') {
        if (storedNodes.length === 0) return ''
        const values = storedNodes.map((stored) => stored.document.read(stored.node, 'text'))
        return values.length === 1 ? values[0] : values
      }
      if (storedNodes.length === 0) return textValue(content)
      const refs = storedNodes.map((stored) => this.remember(stored.document, stored.node))
      return refs.length === 1 ? refs[0] : refs
    }
    if (expanded === 'text' || expanded === 'ownText' || expanded === 'html') {
      if (storedNodes.length === 0) return textValue(content)
      const values = storedNodes.map((stored) => stored.document.read(stored.node, expanded))
      return values.length === 1 ? values[0] : values
    }
    // Legado 的节点字段规则允许直接写属性名，不要求 @ 前缀。
    // 节点字段规则的直接属性写法只接受 HTML 属性名中的单词、冒号和连字符。
    if (storedNodes.length > 0 && /^[\w:-]+$/u.test(expanded)) {
      const values = storedNodes.map((stored) => stored.document.attr(stored.node, expanded)).filter((value): value is string => value !== undefined)
      if (values.length > 0) return values.length === 1 ? values[0] : values
    }
    if (expanded.startsWith('literal:')) return expanded.slice('literal:'.length)
    // 列表规则整条是选择器链；字段规则的末段是输出标记或属性名。
    const plan: DefaultPlan = state.expect === 'nodes' ? { selector: expanded } : lastOutput(expanded)
    const selectorParts = splitSelectorChain(plan.selector).map(normalizeSelector)
    let current: Array<{ document: HtmlDocument; node?: ParserNode }> = storedNodes.length === 0
      ? [{ document: this.html.parse(textValue(content)) }]
      : storedNodes
    if (selectorParts.length === 0) {
      // 没有选择器时按当前内容取值；属性名查询不落到整页文本上（Android 查的是根元素属性）。
      if (plan.attribute !== undefined) {
        const values = current.filter((item): item is SelectedNode => item.node !== undefined).map((item) => item.document.attr(item.node, plan.attribute!)).filter((value): value is string => value !== undefined)
        return values.length === 1 ? values[0] ?? '' : values
      }
      if (plan.output === undefined) {
        const refs = current.filter((item): item is SelectedNode => item.node !== undefined).map((item) => this.remember(item.document, item.node))
        return refs.length === 1 ? refs[0] : refs
      }
      const values = current.filter((item): item is SelectedNode => item.node !== undefined).map((item) => item.document.read(item.node, plan.output!))
      return values.length === 1 ? values[0] : values
    }
    for (const selector of selectorParts) {
      const next: SelectedNode[] = []
      for (const root of current) {
        const view = root.node === undefined ? root.document : root.document.child(root.node)
        const textSelection = parseBracketSelection(selector) ?? parseLegacySelection(selector)
        const textSelector = textSelection?.base ?? selector
        if (textSelector.startsWith('text.')) {
          const expected = textSelector.slice('text.'.length)
          // Jsoup's getElementsContainingOwnText only inspects each element's
          // direct text nodes; descendant text must not make an ancestor match.
          const matching = view.select('*').filter((node) => view.read(node, 'ownText').includes(expected))
          for (const node of applyPositionSelection(matching, textSelection)) next.push({ document: view, node })
        } else for (const node of selectWithPosition(view, selector)) next.push({ document: view, node })
      }
      current = next
    }
    const selected = current.filter((item): item is SelectedNode => item.node !== undefined)
    if (plan.attribute !== undefined) {
      // Android 跳过空属性并去重，避免空值参与拼接。
      const values: string[] = []
      for (const item of selected) {
        const value = item.document.attr(item.node, plan.attribute) ?? ''
        if (value.length > 0 && !values.includes(value)) values.push(value)
      }
      return values
    }
    if (plan.output === undefined) return selected.map((item) => this.remember(item.document, item.node))
    return selected.map((item) => item.document.read(item.node, plan.output!)).filter((value) => value.length > 0)
  }

  private async evaluateJson(expression: string, state: EvaluationState, content: unknown): Promise<unknown> {
    const inlineRules = [...expression.matchAll(/\{(\$\.[^{}]+)\}/gu)]
    if (inlineRules.length > 0) {
      let expanded = expression
      for (const match of inlineRules.reverse()) {
        const value = await this.evaluateText(match[1]!, state, content)
        const start = match.index!
        expanded = `${expanded.slice(0, start)}${textValue(value)}${expanded.slice(start + match[0].length)}`
      }
      return expanded
    }
    const value = this.json.evaluate(jsonInput(content), expression)
    // Android 的确定路径直接返回数组本身，jsonpath-plus 的 wrap 会再包一层；
    // 不拆开会让 `data.books` 这类列表规则只拿到一个「数组项」。
    // 通配/递归/过滤路径的结果本身就是「元素列表」，数组元素是条目而不是外层包装，不能拆。
    return isDefiniteJsonPath(expression) && Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value
  }

  private evaluateXPath(expression: string, content: unknown, expect: WorkflowRuleRequest['expect']): unknown {
    const storedNodes = this.storedNodes(content)
    if (storedNodes.length === 0) {
      const document = this.xpath.parse(textValue(content))
      return this.evaluateXPathContext(document, expression, expect)
    }
    const values: unknown[] = []
    for (const stored of storedNodes) {
      const context = this.xpath.context?.(stored.document, stored.node) ?? this.xpath.parse(stored.document.read(stored.node, 'all'))
      const scopedContext = this.xpath.context !== undefined
        ? context
        : context.children()[0] === undefined ? context : context.child(context.children()[0]!)
      const value = this.evaluateXPathContext(scopedContext, expression, expect)
      if (Array.isArray(value)) values.push(...value)
      else if (nonEmpty(value)) values.push(value)
    }
    return values
  }

  private evaluateXPathContext(context: HtmlDocument, expression: string, expect: WorkflowRuleRequest['expect']): unknown {
    const value = this.xpath.evaluate(context, expression)
    if (Array.isArray(value) && value.every((item) => this.isParserNode(item))) {
      return expect === 'nodes'
        ? value.map((item) => this.remember(context, item as ParserNode))
        : value.map((item) => context.read(item as ParserNode, 'text'))
    }
    return value
  }

  private evaluateRegex(expression: string, content: unknown, sourceId: string): unknown {
    const text = textValue(content)
    const compiled = compileSourcePattern(expression, { flags: 'g' })
    if ('error' in compiled) throw new SourceRuleError('failed', `${compiled.error.message}：${expression.slice(0, 40)}`)
    return [...text.matchAll(compiled.regex)].map((match) => {
      const row = [match[0] ?? '', ...match.slice(1).map((item) => item ?? '')]
      this.captureRows.set(row, sourceId)
      return row
    })
  }

  /** 只在文本真的含模板时才插值，普通规则不额外扫描。 */
  private async expandTemplate(input: string, state: EvaluationState, content: unknown): Promise<string> {
    return input.includes('{{') || input.includes('@get:') ? await this.interpolate(input, state, content) : input
  }

  /** Android「规则为空则不改写上一个 result」：拿到的是进入本条规则时的内容。 */
  private contentValue(content: unknown): unknown {
    const storedNodes = this.storedNodes(content)
    if (storedNodes.length === 0) return textValue(content)
    const refs = storedNodes.map((stored) => this.remember(stored.document, stored.node))
    return refs.length === 1 ? refs[0] : refs
  }

  private storedNodes(content: unknown): StoredNode[] {
    const refs = isNodeRef(content) ? [content] : Array.isArray(content) ? content.filter(isNodeRef) : []
    return refs.map((ref) => this.nodes.get(ref.id)).filter((stored): stored is StoredNode => stored !== undefined)
  }

  private async interpolate(input: string, state: EvaluationState, content: unknown): Promise<string> {
    // 变量占位和双花括号求值遵循 Legado 插值语法；按倒序替换避免偏移量变化。
    let result = input.replace(/@get:\{([^{}]+)\}/g, (_match, name: string) => this.readVariable(name, state.bindings) ?? '')
    const matches = [...result.matchAll(/\{\{([\s\S]*?)\}\}/g)]
    for (const match of matches.reverse()) {
      const expression = match[1]!.trim()
      const value = await this.interpolateValue(expression, state, content)
      result = `${result.slice(0, match.index!)}${textValue(value)}${result.slice(match.index! + match[0].length)}`
    }
    return result
  }

  /**
   * Android `AnalyzeRule.makeUpRule`：表达式是规则形态（`@`/`$.`/`$[`/`//`）时按规则求值，
   * 否则当内联 JS 求值；两者失败都展开为空串（Android 的 evalJS 返回 null 就不插入内容）。
   */
  private async interpolateValue(expression: string, state: EvaluationState, content: unknown): Promise<unknown> {
    if (expression.startsWith('@') || expression.startsWith('$.') || expression.startsWith('$[') || expression.startsWith('//')) {
      try {
        return await this.evaluateText(expression, state, content)
      } catch (error) {
        if (error instanceof SourceRuleError && error.status === 'cancelled') throw error
        return undefined
      }
    }
    const variable = this.readVariable(expression, state.bindings)
    if (variable !== undefined) return variable
    const output = await this.runJavaScript(expression, this.javascriptStage(state.request.stage), state.source, content, state.request.signal, { ...state.request, bindings: state.bindings, ruleState: state, mode: 'script' })
    if (output.status === 'cancelled') throw new SourceRuleError('cancelled', output.message ?? '模板表达式求值已取消')
    return output.status === 'success' ? output.value : undefined
  }

  private async applyReplacement(value: unknown, rule: RuleAtom, state: EvaluationState, content: unknown): Promise<unknown> {
    if (rule.replacement === undefined) return value
    // Android 先对整条规则插值再按 `##` 切分，所以匹配串和替换串里的 {{}} 同样生效。
    const patternText = await this.expandTemplate(rule.replacement.pattern, state, content)
    const replacement = await this.expandTemplate(rule.replacement.replacement, state, content)
    const text = textValue(value)
    // 源可控正则过长度上限或（对超长输入）命中嵌套量词时明确失败，不让病态配置拖垮求值。
    const compiled = compileSourcePattern(patternText, { flags: 'g' })
    if ('error' in compiled) {
      if (compiled.error.code === 'invalid-pattern') return rule.replacement.firstMatchOnly ? replacement : text.split(patternText).join(replacement)
      throw new SourceRuleError('failed', `${compiled.error.message}：${patternText.slice(0, 40)}`)
    }
    if (!rule.replacement.firstMatchOnly) return text.replace(compiled.regex, replacement)
    const first = compiled.regex.exec(text)
    if (first === null) return ''
    const firstPattern = new RegExp(compiled.regex.source, compiled.regex.flags.replace(/g/u, ''))
    return first[0].replace(firstPattern, replacement)
  }

  private async runJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown, signal?: AbortSignal, context?: { baseUrl?: string; redirectUrl?: string; content?: unknown; bindings?: Readonly<Record<string, unknown>>; mutableBindings?: readonly string[]; workflowStage?: WorkflowStage; ruleState?: EvaluationState; mode?: 'script' | 'function-body'; captureBindings?: readonly string[]; captureGlobals?: boolean; globalState?: Readonly<Record<string, unknown>>; workflowActions?: WorkflowJavaScriptRequest['workflowActions']; javascriptBudget?: WorkflowJavaScriptRequest['javascriptBudget']; requestBudget?: Partial<RequestBudget>; resultInputKind?: WorkflowImageDecodeRequest['resultInputKind']; requestObserver?: RequestObserver }): Promise<WorkflowRuleOutput> {
    const explicitBindings = context?.bindings ?? {}
    let bindings: Readonly<Record<string, unknown>> = {
      ...this.bindings,
      ...explicitBindings,
      ...(context?.globalState === undefined ? {} : { __legadoWorkflowGlobalState: context.globalState }),
      ...(context?.resultInputKind === undefined ? {} : { __legadoResultInputKind: context.resultInputKind }),
      // Android action callbacks expose their input as `result`, while rule
      // scripts use the current pipeline value when no explicit binding was
      // supplied. Preserve an explicit binding for both cases.
      result: Object.prototype.hasOwnProperty.call(explicitBindings, 'result') ? explicitBindings.result : content,
      src: context?.content ?? content,
      sourceKey: source.bookSourceUrl,
      sourceName: source.bookSourceName,
      sourceData: source,
      baseUrl: context?.baseUrl ?? source.bookSourceUrl,
      redirectUrl: context?.redirectUrl ?? context?.baseUrl ?? source.bookSourceUrl,
      __legadoRuntimeConcurrency: this.concurrency !== undefined,
    }
    const prelude = [
      'globalThis.result = bindings.result;',
      inputStreamResultPrelude,
      'for (const [name, value] of Object.entries(bindings.__legadoWorkflowGlobalState ?? {})) { try { Object.defineProperty(globalThis, name, { value: __legadoDecode(JSON.parse(__legadoEncode(value))), writable: true, enumerable: true, configurable: true }); } catch {} }',
      'if (bindings.__strResponse != null) { const responseValue = bindings.__strResponse; globalThis.result = { ...responseValue, __body: responseValue.body, __code: responseValue.status ?? responseValue.code, __url: responseValue.url, __message: responseValue.message, __headers: responseValue.headers }; Object.defineProperties(globalThis.result, { body: { value: () => globalThis.result.__body }, code: { value: () => globalThis.result.__code }, url: { value: () => globalThis.result.__url }, message: { value: () => globalThis.result.__message }, headers: { value: () => globalThis.result.__headers }, isSuccessful: { value: () => globalThis.result.__code >= 200 && globalThis.result.__code < 300 } }); }',
      'globalThis.src = bindings.src;',
      'globalThis.key = bindings.key;',
      'globalThis.page = bindings.page;',
      'globalThis.url = bindings.url;',
      'globalThis.nextChapterUrl = bindings.nextChapterUrl;',
      'globalThis.chapters = bindings.chapters;',
      'globalThis.index = bindings.index;',
      'globalThis.title = bindings.title;',
      'globalThis.gInt = bindings.gInt;',
      'globalThis.fromBookInfo = bindings.fromBookInfo ?? bindings.isFromBookInfo;',
      'globalThis.isFromBookInfo = globalThis.fromBookInfo;',
      'const runPreUpdateAction = (action) => { const updated = request({ kind: "workflow-action", action, input: globalThis.book }); if (updated && typeof updated === "object") Object.assign(globalThis.book, updated); };',
      'const refreshTocUrl = () => runPreUpdateAction("refreshTocUrl");',
      'const reGetBook = () => runPreUpdateAction("reGetBook");',
      'globalThis.baseUrl = bindings.baseUrl;',
      'globalThis.redirectUrl = bindings.redirectUrl;',
      'globalThis.__legadoUrlContext = bindings.__legadoUrlContext;',
      'for (const [name, value] of Object.entries(bindings)) { if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name.startsWith("__legado") || Object.prototype.hasOwnProperty.call(bindings.__legadoWorkflowGlobalState ?? {}, name) || ["bindings", "sourceData", "sourceKey", "sourceName", "baseUrl", "redirectUrl", "src", "key", "page", "url", "nextChapterUrl", "chapters", "index", "title", "gInt", "fromBookInfo", "isFromBookInfo", "infoMap", "book", "chapter", "source", "sourceApi", "java", "cookie", "cache", "result"].includes(name)) continue; try { Object.defineProperty(globalThis, name, { value, writable: true, enumerable: true, configurable: true }); } catch {} }',
      // Android ExploreKind 脚本通过 infoMap 保存控件状态；方法保持 Map 语义，保存动作交给宿主决定持久化范围。
      'const __legadoInfoMapValue = bindings.infoMap && typeof bindings.infoMap === "object" && !Array.isArray(bindings.infoMap) ? { ...bindings.infoMap } : {}; globalThis.infoMap = __legadoInfoMapValue; Object.defineProperties(globalThis.infoMap, { get: { value: function(name) { return arguments.length === 0 ? globalThis.infoMap : globalThis.infoMap[String(name)]; } }, put: { value: (name, value) => { const key = String(name); const previous = globalThis.infoMap[key]; globalThis.infoMap[key] = String(value ?? ""); return previous; } }, putAll: { value: (value) => { if (value && typeof value === "object" && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) globalThis.infoMap[String(key)] = String(item ?? ""); } }, set: { value: (value) => { if (value && typeof value === "object" && !Array.isArray(value)) { for (const key of Object.keys(globalThis.infoMap)) delete globalThis.infoMap[key]; for (const [key, item] of Object.entries(value)) globalThis.infoMap[key] = String(item ?? ""); } return globalThis.infoMap; } }, keys: { get: () => legadoList(Object.keys(globalThis.infoMap)) }, values: { get: () => legadoList(Object.values(globalThis.infoMap)) }, entries: { get: () => legadoList(Object.entries(globalThis.infoMap).map(([key, value]) => [key, value])) }, keySet: { value: () => legadoList(Object.keys(globalThis.infoMap)) }, containsValue: { value: (value) => Object.values(globalThis.infoMap).some((item) => item === String(value ?? "")) }, save: { value: (time, need) => request({ kind: "workflow-action", action: "saveInfoMap", input: { infoMap: { ...globalThis.infoMap }, time: time == null ? 0 : Number(time), need: need !== false } }) }, saveNow: { value: () => request({ kind: "workflow-action", action: "saveInfoMap", input: { infoMap: { ...globalThis.infoMap }, now: true, need: true } }) } });',
      'const sourceValue = bindings.sourceData ?? {};',
      'globalThis.source = { ...sourceValue, key: bindings.sourceKey }; Object.defineProperties(globalThis.source, { getKey: { value: () => bindings.sourceKey }, get: { value: (name) => request({ kind: "source-state", operation: "getValue", name: String(name) }) }, put: { value: (name, value) => request({ kind: "source-state", operation: "putValue", name: String(name), value: String(value ?? "") }) }, getVariable: { value: () => request({ kind: "source-state", operation: "getVariable" }) ?? "" }, setVariable: { value: (value) => request({ kind: "source-state", operation: "setVariable", value: value == null ? null : String(value) }) }, putVariable: { value: (value) => request({ kind: "source-state", operation: "setVariable", value: value == null ? null : String(value) }) }, getHeaderMap: { value: (hasLoginHeader) => request({ kind: "source-state", operation: "getHeaderMap", value: hasLoginHeader === true }) }, getLoginHeader: { value: () => request({ kind: "source-state", operation: "getLoginHeader" }) }, getLoginHeaderMap: { value: () => { const value = request({ kind: "source-state", operation: "getLoginHeader" }); if (value == null || String(value).trim().length === 0) return null; try { return JSON.parse(String(value)); } catch { return null; } } }, putLoginHeader: { value: (value) => request({ kind: "source-state", operation: "putLoginHeader", value: String(value ?? "") }) }, removeLoginHeader: { value: () => request({ kind: "source-state", operation: "removeLoginHeader" }) }, getLoginInfo: { value: () => request({ kind: "source-state", operation: "getLoginInfo" }) }, getLoginInfoMap: { value: () => request({ kind: "source-state", operation: "getLoginInfoMap" }) }, putLoginInfo: { value: (value) => request({ kind: "source-state", operation: "putLoginInfo", value: String(value ?? "") }) }, putLoginInfoMap: { value: (value) => request({ kind: "source-state", operation: "putLoginInfo", value: JSON.stringify(value ?? {}) }) }, removeLoginInfo: { value: () => request({ kind: "source-state", operation: "removeLoginInfo" }) }, putConcurrent: { value: (value) => { if (typeof __legadoSetConcurrentRate !== "function") throw new Error("__LEGADO_CAPABILITY__runtime source.putConcurrent unavailable"); return __legadoSetConcurrentRate(String(value)); } } });',
      'globalThis.sourceApi = sourceValue;',
      'const bookValue = bindings.book ?? {};',
      'globalThis.book = { ...bookValue }; Object.defineProperties(globalThis.book, { getVariable: { value: (name) => getVar(String(name), "book") ?? "" }, putVariable: { value: (name, value) => { setVar(String(name), value, "book"); return true; } } });',
      'if (bindings.chapter !== undefined) { globalThis.chapter = { ...(bindings.chapter ?? {}) }; Object.defineProperties(globalThis.chapter, { getVariable: { value: (name) => getVar(String(name), "chapter") ?? "" }, putVariable: { value: (name, value) => { setVar(String(name), value, "chapter"); return true; } } }); } else { globalThis.chapter = undefined; }',
      'const getVariable = (name) => getVar(String(name));',
      'const putVariable = (name, value) => setVar(String(name), value);',
      // Android CookieStore 的 set/remove 返回 Unit，`{{cookie.removeCookie(...)}}` 必须展开为空串而不是 "true"。
      'const legadoCookieToMap = (value) => { const result = {}; for (const part of String(value ?? "").split(";")) { const index = part.indexOf("="); if (index < 0) continue; const key = part.slice(0, index).trim(); const item = part.slice(index + 1).trim(); if (key.length > 0 && (item.length > 0 || item === "null")) result[key] = item; } return result; }; const legadoMapToCookie = (value) => { if (value == null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) return null; return Object.entries(value).map(([key, item]) => `${key}=${String(item)}`).join("; "); }; const cookie = { getCookie: (url) => request({ kind: "cookie-get", url: String(url) }), setCookie: (url, value) => { request({ kind: "cookie-set", url: String(url), value: String(value) }); }, removeCookie: (url) => { request({ kind: "cookie-remove", url: String(url) }); }, getKey: (url, key) => legadoCookieToMap(request({ kind: "cookie-get", url: String(url) }))[String(key)] ?? "", cookieToMap: (value) => legadoCookieToMap(value), mapToCookie: (value) => legadoMapToCookie(value), replaceCookie: (url, value) => { const merged = { ...legadoCookieToMap(request({ kind: "cookie-get", url: String(url) })), ...legadoCookieToMap(value) }; request({ kind: "cookie-set", url: String(url), value: legadoMapToCookie(merged) ?? "" }); }, clear: () => { request({ kind: "cookie-clear" }); } };',
      'let legadoContent = result; const legadoValueText = (value) => Array.isArray(value) ? value.map((item) => String(item ?? "")).join("\\n") : String(value ?? ""); const legadoNodeRead = (node, rule) => legadoValueText(evaluateRule(String(rule), { expect: "text", content: node })); const legadoNode = (node) => { if (node == null || typeof node !== "object" || node.__legadoNode !== "source-rule-node") return node; const value = { ...node }; Object.defineProperties(value, { attr: { value: (name) => legadoNodeRead(node, String(name)) }, text: { value: () => legadoNodeRead(node, "@text") }, ownText: { value: () => legadoNodeRead(node, "@ownText") }, html: { value: () => legadoNodeRead(node, "@html") }, select: { value: (rule) => legadoElements(evaluateRule(String(rule), { expect: "nodes", content: node })) }, toString: { value: () => legadoNodeRead(node, "@text") } }); return value; }; const legadoElements = (values) => { const list = (Array.isArray(values) ? values : values == null ? [] : [values]).map(legadoNode); Object.defineProperties(list, { toArray: { value: () => list.slice() }, attr: { value: (name) => list.length === 0 || typeof list[0].attr !== "function" ? "" : list[0].attr(name) }, text: { value: () => list.map((item) => typeof item.text === "function" ? item.text() : String(item ?? "")).filter(Boolean).join(" ") }, ownText: { value: () => list.map((item) => typeof item.ownText === "function" ? item.ownText() : String(item ?? "")).filter(Boolean).join(" ") }, html: { value: () => list.map((item) => typeof item.html === "function" ? item.html() : String(item ?? "")).join("\\n") }, select: { value: (rule) => { const selected = []; for (const item of list) { if (item != null && typeof item.select === "function") { const nested = item.select(rule); if (Array.isArray(nested)) selected.push(...nested); } } return legadoElements(selected); } } }); return list; }; const legadoResponse = (url, raw) => { const record = raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; const body = typeof raw === "string" ? raw : String(record.body ?? raw ?? ""); const status = Number(record.status ?? record.code ?? 200); const target = String(record.url ?? url); const headers = record.headers ?? {}; const header = (name) => { const wanted = String(name).toLowerCase(); for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? ""); return ""; }; const request = { url: () => target }; const rawResponse = {}; Object.defineProperties(rawResponse, { request: { value: () => request, configurable: true }, url: { value: () => target, configurable: true }, code: { value: () => status, configurable: true }, message: { value: () => String(record.message ?? ""), configurable: true } }); const response = {}; Object.defineProperties(response, { body: { value: () => body, configurable: true }, code: { value: () => status, configurable: true }, statusCode: { value: () => status, configurable: true }, message: { value: () => String(record.message ?? ""), configurable: true }, headers: { value: () => headers, configurable: true }, header: { value: header, configurable: true }, url: { value: () => target, configurable: true }, isSuccessful: { value: () => status >= 200 && status < 300, configurable: true }, raw: { value: () => rawResponse, configurable: true }, toString: { value: () => body, configurable: true } }); return response; };',
      'const java = { ajax: (value, method, body) => value != null && typeof value === "object" ? request(Object.assign({ kind: "network" }, value)) : method != null && typeof method === "object" ? request(Object.assign({ kind: "network", url: String(value) }, method)) : request({ kind: "network", url: String(value), method: method ?? "GET", body }), get: (value, options) => options !== undefined || /^(?:https?:)?\\/\\//.test(String(value)) ? legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "GET", options })) : Object.prototype.hasOwnProperty.call(bindings, String(value)) ? bindings[String(value)] : getVar(String(value)), connect: (value, options) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "GET", options })), put: (name, value) => { setVar(name, value); return value; }, cacheContent: (chapter, content) => request({ kind: "workflow-action", action: "cacheContent", input: { chapter, content } }), setContent: (content, baseUrl) => { if (content === null || content === undefined) throw new Error("内容不可空（Content cannot be null）"); legadoContent = content; if (baseUrl !== undefined && baseUrl !== null) { globalThis.baseUrl = String(baseUrl); globalThis.redirectUrl = String(baseUrl); } return java; }, getElement: (rule) => { const value = evaluateRule(String(rule), { expect: "nodes", content: legadoContent }); return Array.isArray(value) ? legadoElements(value) : legadoNode(value); }, getElements: (rule) => legadoElements(evaluateRule(String(rule), { expect: "nodes", content: legadoContent })), getString: (rule, content, isUrl) => legadoValueText(evaluateRule(String(rule), { expect: "text", content: content === undefined ? legadoContent : content })), getStringList: (rule, content, isUrl) => { const value = evaluateRule(String(rule), { expect: "text", content: content === undefined ? legadoContent : content }); return Array.isArray(value) ? value.map((item) => String(item ?? "")).filter(Boolean) : String(value ?? "").split("\\n").filter(Boolean); }, getWebViewUA: () => request({ kind: "runtime-capability", capability: "getWebViewUA" }), base64Encode: (value) => request({ kind: "base64-encode", value }), base64Decode: (value) => request({ kind: "base64-decode-text", value }), base64DecodeToString: (value) => request({ kind: "base64-decode-text", value }), base64DecodeToByteArray: (value, flags) => value == null || String(value).trim().length === 0 ? null : request({ kind: "base64-decode-bytes", value, flags }), strToBytes: (value, charset) => request({ kind: "encode-bytes", value: String(value), charset: charset === undefined ? "UTF-8" : String(charset) }), bytesToStr: (value, charset) => request({ kind: "decode-bytes", value, charset: charset === undefined ? "UTF-8" : String(charset) }), toNumChapter: (value) => value == null ? null : request({ kind: "to-num-chapter", value }), hexDecodeToByteArray: (value) => request({ kind: "hex-decode-bytes", value }), hexDecodeToString: (value) => request({ kind: "hex-decode-text", value }), hexEncodeToString: (value) => request({ kind: "hex-encode", value }), md5Encode: (value) => request({ kind: "md5", value }), digestHex: (value, algorithm) => request({ kind: "digest", value, algorithm }), digestBase64Str: (value, algorithm) => request({ kind: "digest-base64", value, algorithm }), HMacHex: (value, algorithm, key) => request({ kind: "hmac-hex", value, algorithm, key }), HMacBase64: (value, algorithm, key) => request({ kind: "hmac-base64", value, algorithm, key }), encodeURI: (value) => encodeURI(String(value)), decodeURI: (value) => decodeURI(String(value)), aesBase64DecodeToString: (value, key, transformation, iv) => request({ kind: "aes-decode-text", value, key, transformation, iv }), replaceFont: (text, errorBase64, correctBase64, filter) => request({ kind: "font-replace", text, errorBase64, correctBase64, filter }), toast: () => undefined, longToast: () => undefined, log: () => undefined, timeFormat: (value) => String(value), timeFormatUTC: (time, format, offsetMs) => request({ kind: "time-format-utc", time: Number(time), format: String(format), offsetMs: Number(offsetMs) }), randomUUID: () => request({ kind: "random-uuid" }), getAppVariant: () => request({ kind: "runtime-capability", capability: "getAppVariant" }), androidId: () => request({ kind: "runtime-capability", capability: "androidId" }), deviceID: () => request({ kind: "runtime-capability", capability: "deviceID" }) };',
      'Object.assign(java, { post: (value, body, headers, timeout) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "POST", body, headers, options: timeout === undefined ? undefined : { timeout: Number(timeout) } })), head: (value, headers, timeout) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "HEAD", headers, options: timeout === undefined ? undefined : { timeout: Number(timeout) } })), ajaxTestAll: (values, timeout, skipRateLimit) => { const urls = (Array.isArray(values) ? values : [values]).map((value) => String(value)); const batch = request({ kind: "network-all", urls, isTest: true, skipRateLimit: skipRateLimit === true, options: timeout === undefined ? undefined : { timeout: Number(timeout) } }); return (Array.isArray(batch) ? batch : []).map((raw, index) => legadoResponse(urls[index] ?? "", raw)); } });',
      'java.ajaxAll = (values, skipRateLimit) => { const urls = (Array.isArray(values) ? values : [values]).map((value) => String(value)); const batch = request({ kind: "network-all", urls, skipRateLimit: skipRateLimit === true }); return (Array.isArray(batch) ? batch : []).map((raw, index) => legadoResponse(urls[index] ?? "", raw)); };',
      'Object.assign(java, { t2s: (value) => request({ kind: "runtime-capability", capability: "java.t2s", input: value }), s2t: (value) => request({ kind: "runtime-capability", capability: "java.s2t", input: value }), webView: (...args) => request({ kind: "runtime-capability", capability: "java.webView", input: args }), webview: (...args) => request({ kind: "runtime-capability", capability: "java.webview", input: args }), webViewGetSource: (...args) => request({ kind: "runtime-capability", capability: "java.webViewGetSource", input: args }), webViewGetOverrideUrl: (...args) => request({ kind: "runtime-capability", capability: "java.webViewGetOverrideUrl", input: args }), startBrowser: (...args) => request({ kind: "runtime-capability", capability: "java.startBrowser", input: args }), startBrowserAwait: (...args) => request({ kind: "runtime-capability", capability: "java.startBrowserAwait", input: args }), showBrowser: (...args) => request({ kind: "runtime-capability", capability: "java.showBrowser", input: args }), getVerificationCode: (...args) => request({ kind: "runtime-capability", capability: "java.getVerificationCode", input: args }), openVideoPlayer: (...args) => request({ kind: "runtime-capability", capability: "java.openVideoPlayer", input: args }), openUrl: (...args) => request({ kind: "runtime-capability", capability: "java.openUrl", input: args }), refreshExplore: () => { request({ kind: "workflow-action", action: "refreshExplore" }); }, reUiView: (deltaUp) => { request({ kind: "workflow-action", action: "reUiView", input: deltaUp === true }); }, upUiData: (data) => { request({ kind: "workflow-action", action: "upUiData", input: data }); }, upLoginData: (data) => { request({ kind: "workflow-action", action: "upUiData", input: data }); }, reLoginView: (deltaUp) => { request({ kind: "workflow-action", action: "reUiView", input: deltaUp === true }); } });',
      'const legadoCookie = (url, key) => { const cookieText = String(request({ kind: "cookie-get", url: String(url) }) ?? ""); if (key === undefined || key === null) return cookieText; for (const part of cookieText.split(";")) { const index = part.indexOf("="); if (index >= 0 && part.slice(0, index).trim() === String(key)) return part.slice(index + 1).trim(); } return ""; };',
      'java.getCookie = (url, key) => legadoCookie(url, key);',
      'java.timeFormat = (time) => request({ kind: "time-format", time: Number(time) });',
      'java.timeFormatUTC = (time, format, offsetMs) => request({ kind: "time-format-utc", time: Number(time), format: String(format), offsetMs: Number(offsetMs) });',
      'java.randomUUID = () => request({ kind: "random-uuid" });',
      'java.getAppVariant = () => request({ kind: "runtime-capability", capability: "getAppVariant" });',
      'java.androidId = () => request({ kind: "runtime-capability", capability: "androidId" });',
      'java.deviceID = () => request({ kind: "runtime-capability", capability: "deviceID" });',
      'globalThis.cache = { get: (key, onlyDisk) => request({ kind: "cache-get", key: String(key), onlyDisk: onlyDisk === true }), put: (key, value, saveTime) => request({ kind: "cache-put", key: String(key), value, saveTime: Number(saveTime ?? 0) }), delete: (key) => request({ kind: "cache-delete", key: String(key) }), getFromMemory: (key) => request({ kind: "cache-memory-get", key: String(key) }), putMemory: (key, value) => request({ kind: "cache-memory-put", key: String(key), value }), deleteMemory: (key) => request({ kind: "cache-memory-delete", key: String(key) }), getFile: (key) => request({ kind: "cache-file-get", key: String(key) }), putFile: (key, value, saveTime) => request({ kind: "cache-file-put", key: String(key), value, saveTime: Number(saveTime ?? 0) }) }; Object.assign(globalThis.cache, { getInt: (key, fallback) => { const value = globalThis.cache.get(key); const number = value == null || typeof value === "string" && value.trim().length === 0 ? Number.NaN : Number(value); return Number.isFinite(number) ? Math.trunc(number) : fallback === undefined ? null : Number(fallback ?? 0) }, getLong: (key, fallback) => { const value = globalThis.cache.get(key); const number = value == null || typeof value === "string" && value.trim().length === 0 ? Number.NaN : Number(value); return Number.isFinite(number) ? Math.trunc(number) : fallback === undefined ? null : Number(fallback ?? 0) }, getDouble: (key, fallback) => { const value = globalThis.cache.get(key); const number = value == null || typeof value === "string" && value.trim().length === 0 ? Number.NaN : Number(value); return Number.isFinite(number) ? number : fallback === undefined ? null : Number(fallback ?? 0) }, getFloat: (key, fallback) => { const value = globalThis.cache.get(key); const number = value == null || typeof value === "string" && value.trim().length === 0 ? Number.NaN : Number(value); return Number.isFinite(number) ? number : fallback === undefined ? null : Number(fallback ?? 0) }, getByteArray: (key) => request({ kind: "cache-bytes-get", key: String(key) }) });',
      'const getToken = () => request({ kind: "token" });',
      'globalThis.Packages = globalThis.Packages ?? {};',
      'globalThis.Packages.io = globalThis.Packages.io ?? {};',
      'globalThis.Packages.io.legado = globalThis.Packages.io.legado ?? {};',
      'globalThis.Packages.io.legado.app = globalThis.Packages.io.legado.app ?? {};',
      'globalThis.Packages.io.legado.app.help = globalThis.Packages.io.legado.app.help ?? {};',
      'globalThis.Packages.io.legado.app.help.http = globalThis.Packages.io.legado.app.help.http ?? {};',
      'globalThis.Packages.io.legado.app.help.http.StrResponse = function(url, body) { if (!(this instanceof globalThis.Packages.io.legado.app.help.http.StrResponse)) return new globalThis.Packages.io.legado.app.help.http.StrResponse(url, body); this.url = String(url); this.status = 200; this.code = 200; this.headers = {}; this.body = String(body ?? ""); };',
      'const checkEnv = () => "default";',
      'const isVs = () => false;',
      'const legadoResolveJavaUrl = (value) => request({ kind: "resolve-url", url: String(redirectUrl ?? baseUrl ?? bindings.sourceKey ?? ""), value: String(value ?? "") });',
      'const legadoResolveJavaUrls = (values) => request({ kind: "resolve-urls", url: String(redirectUrl ?? baseUrl ?? bindings.sourceKey ?? ""), urls: values.map((value) => String(value ?? "")) });',
      'const legadoJavaErrorText = (error) => { if (error && typeof error === "object") { const stack = error.stack == null ? "" : String(error.stack); const message = error.message == null ? "" : String(error.message); return stack.length > 0 && message.length > 0 && !stack.includes(message) ? `${message}\\n${stack}` : stack || message; } return String(error ?? ""); };',
      'const legadoJavaErrorMustPropagate = (error) => { const text = legadoJavaErrorText(error); return /__LEGADO_(?:CAPABILITY|CANCELLED|BUDGET|SERIALIZATION)__/.test(text) || text.includes("书源请求嵌套过深"); };',
      'const legadoJavaHeaders = (value) => { if (value == null) return {}; const raw = typeof value === "string" ? JSON.parse(value) : value; if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Request headers must be a map or JSON string"); const result = {}; for (const [name, item] of Object.entries(raw)) { if (item == null) throw new Error("Request header names and values cannot be null"); result[String(name)] = String(item); } return result; };',
      'const legadoJavaConnectHeaders = (value) => { if (value == null) return undefined; try { return legadoJavaHeaders(value); } catch { return undefined; } };',
      'const legadoJavaUrl = (value) => Array.isArray(value) ? String(value[0] ?? "") : String(value);',
      'const legadoJavaRequestOptions = (timeout) => ({ timeout: timeout == null ? 30000 : Number(timeout), followRedirects: false });',
      'const legadoGetString = (rule, content, isUrl) => { let sourceContent = content; let shouldUnescape = true; let resolveUrl = isUrl === true; if (typeof content === "boolean" && isUrl === undefined) { shouldUnescape = content; sourceContent = undefined; resolveUrl = false; } const value = legadoValueText(evaluateRule(String(rule), { expect: "text", content: sourceContent == null ? legadoContent : sourceContent })); const decoded = shouldUnescape ? request({ kind: "html-unescape", value }) : value; if (!resolveUrl) return decoded; return decoded.trim().length === 0 ? String(baseUrl ?? "") : legadoResolveJavaUrl(decoded); }; const legadoGetStringList = (rule, content, isUrl) => { const value = evaluateRule(String(rule), { expect: "text", content: content == null ? legadoContent : content }); const values = Array.isArray(value) ? value.map((item) => String(item ?? "")) : String(value ?? "").split("\\n"); if (isUrl !== true) return values.filter(Boolean); const result = []; for (const absolute of legadoResolveJavaUrls(values)) if (absolute && !result.includes(absolute)) result.push(absolute); return result; }; Object.assign(java, { ajax: (value, callTimeout) => { try { if (value != null && typeof value === "object" && !Array.isArray(value)) return request(Object.assign({ kind: "network" }, value)); const urlValue = legadoJavaUrl(value); if (callTimeout != null && typeof callTimeout === "object" && !Array.isArray(callTimeout)) return request(Object.assign({ kind: "network", url: urlValue }, callTimeout)); const input = { kind: "network", url: urlValue, method: "GET" }; if (callTimeout != null) input.options = { timeout: Number(callTimeout) }; return request(input); } catch (error) { if (legadoJavaErrorMustPropagate(error)) throw error; return legadoJavaErrorText(error); } }, get: (value, headers, timeout) => { const urlValue = String(value); if (headers === undefined && timeout === undefined && !/^(?:https?:)?\\/\\//.test(urlValue)) return Object.prototype.hasOwnProperty.call(bindings, urlValue) ? bindings[urlValue] : getVar(urlValue); const headerMap = legadoJavaHeaders(headers); return legadoResponse(urlValue, request({ kind: "network-response", url: urlValue, method: "GET", headers: headerMap, options: legadoJavaRequestOptions(timeout) })); }, connect: (value, header, timeout) => { const urlValue = String(value); try { const headerMap = legadoJavaConnectHeaders(header); const input = { kind: "network-response", url: urlValue, method: "GET" }; if (headerMap !== undefined) input.headers = headerMap; if (timeout != null) input.options = { timeout: Number(timeout) }; return legadoResponse(urlValue, request(input)); } catch (error) { if (legadoJavaErrorMustPropagate(error)) throw error; return legadoResponse(urlValue, { url: urlValue, status: 200, code: 200, body: legadoJavaErrorText(error) }); } }, getString: legadoGetString, getStringList: legadoGetStringList, post: (value, body, headers, timeout) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "POST", body, headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) })), head: (value, headers, timeout) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "HEAD", headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) })) });',
      // Jsoup Connection.Response/StrResponse 的可观察方法：网络 bridge 只传 DTO，
      // 在 QuickJS 侧重新挂载方法，避免把 Node/Undici 对象泄露给书源。
      'const legadoUtf8Bytes = (value) => { const encoded = encodeURIComponent(String(value)); const result = []; for (let index = 0; index < encoded.length;) { if (encoded[index] === "%") { result.push(parseInt(encoded.slice(index + 1, index + 3), 16)); index += 3; } else { result.push(encoded.charCodeAt(index)); index += 1; } } return Uint8Array.from(result); };',
      'const legadoResponseCompat = (url, raw) => { const response = legadoResponse(url, raw); const record = raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; const body = typeof raw === "string" ? raw : String(record.body ?? raw ?? ""); const status = Number(record.status ?? record.code ?? 200); const target = String(record.url ?? url); const headers = record.headers != null && typeof record.headers === "object" && !Array.isArray(record.headers) ? record.headers : {}; const bytes = record.bytes instanceof Uint8Array ? record.bytes : record.bodyBytes instanceof Uint8Array ? record.bodyBytes : legadoUtf8Bytes(body); const header = (name) => { const wanted = String(name).toLowerCase(); for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? ""); return ""; }; const contentType = header("content-type"); const charset = record.charset == null ? (/charset\\s*=\\s*[\\x22\\x27]?([^;\\x22\\x27\\s]+)/i.exec(contentType)?.[1] ?? null) : String(record.charset); const message = String(record.message ?? record.statusMessage ?? ""); const requestObject = {}; Object.defineProperties(requestObject, { url: { value: () => String(record.requestUrl ?? target), configurable: true }, method: { value: () => String(record.requestMethod ?? "GET"), configurable: true }, headers: { value: () => record.requestHeaders ?? {}, configurable: true } }); const rawResponse = {}; Object.defineProperties(rawResponse, { request: { value: () => requestObject, configurable: true }, url: { value: () => target, configurable: true }, code: { value: () => status, configurable: true }, statusCode: { value: () => status, configurable: true }, message: { value: () => message, configurable: true }, headers: { value: () => headers, configurable: true }, header: { value: header, configurable: true }, isSuccessful: { value: () => status >= 200 && status < 300, configurable: true } }); const responseHeaders = () => { const result = { ...headers }; Object.defineProperties(result, { get: { value: (name) => header(name) }, names: { value: () => Object.keys(headers) }, toMultimap: { value: () => ({ ...headers }) }, toString: { value: () => Object.entries(headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}\\n`).join("") } }); return result; }; Object.defineProperties(response, { headers: { value: responseHeaders, configurable: true }, header: { value: header, configurable: true }, bodyAsBytes: { value: () => bytes, configurable: true }, bytes: { value: bytes, configurable: true }, charset: { value: () => charset, configurable: true }, contentType: { value: () => contentType, configurable: true }, statusMessage: { value: () => message, configurable: true }, statusCode: { value: () => status, configurable: true }, message: { value: () => message, configurable: true }, redirected: { value: Boolean(record.redirected), configurable: true }, errorBody: { value: () => record.errorBody ?? null, configurable: true }, callTime: { value: () => Number(record.callTime ?? 0), configurable: true }, raw: { value: () => rawResponse, configurable: true }, toString: { value: () => `${status} ${message}`.trim(), configurable: true } }); return response; };',
      'java.get = (value, headers, timeout) => { const urlValue = String(value); if (headers === undefined && timeout === undefined && !/^(?:https?:)?\\/\\//.test(urlValue)) return Object.prototype.hasOwnProperty.call(bindings, urlValue) ? bindings[urlValue] : getVar(urlValue); const headerMap = legadoJavaHeaders(headers); return legadoResponseCompat(urlValue, request({ kind: "network-response", url: urlValue, method: "GET", headers: headerMap, options: legadoJavaRequestOptions(timeout) })); };',
      'java.connect = (value, header, timeout) => { const urlValue = String(value); try { const headerMap = legadoJavaConnectHeaders(header); const input = { kind: "network-response", url: urlValue, method: "GET" }; if (headerMap !== undefined) input.headers = headerMap; if (timeout != null) input.options = { timeout: Number(timeout) }; return legadoResponseCompat(urlValue, request(input)); } catch (error) { if (legadoJavaErrorMustPropagate(error)) throw error; return legadoResponseCompat(urlValue, { url: urlValue, status: 200, code: 200, body: legadoJavaErrorText(error), message: "OK" }); } };',
      'java.post = (value, body, headers, timeout) => legadoResponseCompat(String(value), request({ kind: "network-response", url: String(value), method: "POST", body, headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) })); java.head = (value, headers, timeout) => legadoResponseCompat(String(value), request({ kind: "network-response", url: String(value), method: "HEAD", headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) }));',
      'java.ajaxAll = (values, skipRateLimit) => { const urls = (Array.isArray(values) ? values : [values]).map((value) => String(value)); const batch = request({ kind: "network-all", urls, skipRateLimit: skipRateLimit === true }); return (Array.isArray(batch) ? batch : []).map((raw, index) => legadoResponseCompat(urls[index] ?? "", raw)); };',
      'java.ajaxTestAll = (values, timeout, skipRateLimit) => { const urls = (Array.isArray(values) ? values : [values]).map((value) => String(value)); const batch = request({ kind: "network-all", urls, isTest: true, skipRateLimit: skipRateLimit === true, options: timeout === undefined ? undefined : { timeout: Number(timeout) } }); return (Array.isArray(batch) ? batch : []).map((raw, index) => legadoResponseCompat(urls[index] ?? "", raw)); };',
      'const legadoCryptoConfig = (transformation, key, iv) => ({ transformation: String(transformation), key, ...(iv === undefined || iv === null ? {} : { iv }) }); const legadoCryptoBase64 = (value) => ({ __legadoBase64: String(value) }); const legadoCryptoInput = (value) => typeof value === "string" ? (/^(?:[0-9a-f]{2})+$/iu.test(value) ? "hex" : "base64") : "bytes"; const legadoSecretKey = (value) => ({ getEncoded: () => value, encoded: value, toString: () => java.base64Encode(value) }); const legadoCrypto = (transformation, key, iv) => { let currentKey = key; let currentIv = iv; if (currentKey === undefined || currentKey === null) currentKey = request({ kind: "crypto-key", transformation: String(transformation) }); const call = (operation, value, outputEncoding, charset) => request({ kind: "crypto-symmetric", operation, ...legadoCryptoConfig(transformation, currentKey, currentIv), value, inputEncoding: operation === "decrypt" ? legadoCryptoInput(value) : undefined, outputEncoding, ...(charset === undefined ? {} : { charset: String(charset) }) }); const api = { decrypt: (value) => call("decrypt", value, "bytes"), decryptStr: (value, charset) => call("decrypt", value, "text", charset === undefined ? "UTF-8" : charset), encrypt: (value) => call("encrypt", value, "bytes"), encryptBase64: (value) => call("encrypt", value, "base64"), encryptHex: (value) => call("encrypt", value, "hex"), setIv: (nextIv) => { currentIv = nextIv; return api; }, getIv: () => currentIv, getSecretKey: () => legadoSecretKey(currentKey) }; return api; };',
      'java.md5Encode = (value) => request({ kind: "md5", value: String(value) }); java.md5Encode16 = (value) => request({ kind: "md5-16", value: String(value) });',
      'java.base64Encode = (value, flags) => request({ kind: "base64-encode", value: String(value), flags: flags === undefined ? 2 : Number(flags) }); java.base64Decode = (value, charsetOrFlags) => typeof charsetOrFlags === "number" ? request({ kind: "base64-decode-text", value, flags: Number(charsetOrFlags) }) : request({ kind: "base64-decode-text", value, charset: charsetOrFlags === undefined ? "UTF-8" : String(charsetOrFlags) }); java.base64DecodeToString = (value, charset) => request({ kind: "base64-decode-text", value, charset: charset === undefined ? "UTF-8" : String(charset) }); java.base64DecodeToByteArray = (value, flags) => value == null || String(value).trim().length === 0 ? null : request({ kind: "base64-decode-bytes", value, flags: flags === undefined ? 0 : Number(flags) });',
      'java.encodeURI = (value, charset) => request({ kind: "encode-uri", value: String(value), charset: charset === undefined ? "UTF-8" : String(charset) });',
      'java.createSymmetricCrypto = (transformation, key, iv) => legadoCrypto(transformation, key, iv);',
      'const legadoAsymmetric = (transformation) => { let privateKey; let publicKey; const call = (operation, value, usePublicKey, outputEncoding, inputEncoding, charset) => request({ kind: "crypto-asymmetric", operation, transformation: String(transformation), value, privateKey, publicKey, usePublicKey: usePublicKey !== false, outputEncoding, inputEncoding, charset }); const api = { setPrivateKey: (value) => { privateKey = value; return api; }, setPublicKey: (value) => { publicKey = value; return api; }, decrypt: (value, usePublicKey) => call("decrypt", value, usePublicKey, "bytes", typeof value === "string" ? "base64" : "bytes"), decryptStr: (value, usePublicKey, charset) => call("decrypt", value, usePublicKey, "text", typeof value === "string" ? "base64" : "bytes", charset === undefined ? "UTF-8" : String(charset)), encrypt: (value, usePublicKey) => call("encrypt", value, usePublicKey, "bytes", "text"), encryptHex: (value, usePublicKey) => call("encrypt", value, usePublicKey, "hex", "text"), encryptBase64: (value, usePublicKey) => call("encrypt", value, usePublicKey, "base64", "text") }; return api; }; java.createAsymmetricCrypto = (transformation) => legadoAsymmetric(transformation);',
      'const legadoSign = (algorithm) => { let privateKey; let publicKey; const call = (operation, value, outputEncoding, signature, signatureEncoding) => request({ kind: "crypto-sign", algorithm: String(algorithm), operation, value, privateKey, publicKey, outputEncoding, signature, signatureEncoding }); const api = { setPrivateKey: (value) => { privateKey = value; return api; }, setPublicKey: (value) => { publicKey = value; return api; }, sign: (value) => call("sign", value, "bytes"), signHex: (value) => call("sign", value, "hex"), signBase64: (value) => call("sign", value, "base64"), verify: (value, signature) => call("verify", value, undefined, signature, typeof signature === "string" ? "base64" : "bytes") }; return api; }; java.createSign = (algorithm) => legadoSign(algorithm);',
      'const legadoCryptoDecrypt = (value, key, transformation, iv, outputEncoding) => request({ kind: "crypto-symmetric", operation: "decrypt", value, key, transformation, iv, inputEncoding: legadoCryptoInput(value), outputEncoding }); const legadoCryptoEncrypt = (value, key, transformation, iv, outputEncoding) => request({ kind: "crypto-symmetric", operation: "encrypt", value, key, transformation, iv, outputEncoding });',
      'java.aesDecodeToByteArray = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "bytes"); java.aesDecodeToString = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "text"); java.aesBase64DecodeToByteArray = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "bytes"); java.aesBase64DecodeToString = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "text");',
      'java.aesEncodeToByteArray = (value, key, transformation, iv) => legadoCryptoEncrypt(value, key, transformation, iv, "bytes"); java.aesEncodeToString = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "text"); java.aesEncodeToBase64ByteArray = (value, key, transformation, iv) => request({ kind: "encode-bytes", value: legadoCryptoEncrypt(value, key, transformation, iv, "base64"), charset: "UTF-8" }); java.aesEncodeToBase64String = (value, key, transformation, iv) => legadoCryptoEncrypt(value, key, transformation, iv, "base64");',
      'java.aesDecodeArgsBase64Str = (value, key, mode, padding, iv) => legadoCryptoDecrypt(value, legadoCryptoBase64(key), `AES/${mode}/${padding}`, legadoCryptoBase64(iv), "text"); java.aesEncodeArgsBase64Str = (value, key, mode, padding, iv) => legadoCryptoEncrypt(value, key, `AES/${mode}/${padding}`, iv, "base64");',
      'java.desDecodeToString = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "text"); java.desBase64DecodeToString = (value, key, transformation, iv) => legadoCryptoDecrypt(value, key, transformation, iv, "text"); java.desEncodeToString = (value, key, transformation, iv) => legadoCryptoEncrypt(value, key, transformation, iv, "text"); java.desEncodeToBase64String = (value, key, transformation, iv) => legadoCryptoEncrypt(value, key, transformation, iv, "base64");',
      'java.tripleDESDecodeStr = (value, key, mode, padding, iv) => legadoCryptoDecrypt(value, key, `DESede/${mode}/${padding}`, iv, "text"); java.tripleDESDecodeArgsBase64Str = (value, key, mode, padding, iv) => legadoCryptoDecrypt(value, legadoCryptoBase64(key), `DESede/${mode}/${padding}`, iv, "text"); java.tripleDESEncodeBase64Str = (value, key, mode, padding, iv) => legadoCryptoEncrypt(value, key, `DESede/${mode}/${padding}`, iv, "base64"); java.tripleDESEncodeArgsBase64Str = (value, key, mode, padding, iv) => legadoCryptoEncrypt(value, legadoCryptoBase64(key), `DESede/${mode}/${padding}`, iv, "base64");',
      'const legadoFont = (value, useCache, inputEncoding) => { const id = request({ kind: "font-query", value, useCache, inputEncoding }); if (id == null) return null; const call = (operation, item) => request({ kind: "font-query-method", name: String(id), operation, value: item }); return { __legadoFontId: String(id), getGlyfIdByUnicode: (unicode) => call("glyphId", Number(unicode)), getGlyfByUnicode: (unicode) => call("glyph", Number(unicode)), getGlyfById: (glyphId) => call("glyphById", Number(glyphId)), unicodeToGlyph: (unicode) => call("glyph", Number(unicode)), glyphToUnicode: (glyph) => call("unicode", glyph), unicodeToGlyphId: (unicode) => call("glyphId", Number(unicode)), getUnicodeByGlyf: (glyph) => call("unicode", glyph), isBlankUnicode: (unicode) => call("blank", Number(unicode)) }; }; java.queryBase64TTF = (value) => legadoFont(value, true, "base64"); java.queryTTF = (value, useCache) => legadoFont(value, useCache === undefined ? true : useCache, typeof value === "string" ? "auto" : "bytes"); java.replaceFont = (text, error, correct, filter) => request({ kind: "font-replace", text: String(text ?? ""), errorFontId: error && typeof error === "object" ? error.__legadoFontId : undefined, correctFontId: correct && typeof correct === "object" ? correct.__legadoFontId : undefined, errorBase64: typeof error === "string" ? error : undefined, correctBase64: typeof correct === "string" ? correct : undefined, filter: filter === true });',
      'const __legadoSourceState = (operation, value) => request({ kind: "source-state", operation, value });',
      'const __legadoInlineJs = (value) => { const text = String(value ?? "").trim(); const match = /^(?:<js>([\\s\\S]*?)<\\/js>|@js:([\\s\\S]*))$/iu.exec(text); return match == null ? null : String(match[1] ?? match[2] ?? "").trim(); }; const __legadoLoginUiV2 = (value) => { try { const parsed = JSON.parse(String(value ?? "")); return parsed != null && typeof parsed === "object" && Number(parsed.version) === 2; } catch { return false; } }; Object.defineProperties(source, { getSource: { value: () => source }, getTag: { value: () => String(sourceValue.bookSourceName ?? "") }, getLoginUiJs: { value: () => __legadoInlineJs(sourceValue.loginUi) }, isLoginUiV2: { value: () => __legadoLoginUiV2(sourceValue.loginUi) }, getLoginJs: { value: () => sourceValue.loginUrl == null ? null : __legadoInlineJs(sourceValue.loginUrl) ?? String(sourceValue.loginUrl) }, hasLoginForm: { value: () => sourceValue.loginUi != null && String(sourceValue.loginUi).trim().length > 0 && String(sourceValue.loginUi).replace(/\\s/gu, "") !== "[]" }, hasLogin: { value: () => Boolean((sourceValue.loginUrl != null && String(sourceValue.loginUrl).trim().length > 0) || (sourceValue.loginUi != null && String(sourceValue.loginUi).trim().length > 0 && String(sourceValue.loginUi).replace(/\\s/gu, "") !== "[]")) }, login: { value: () => { request({ kind: "source-login" }); } }, evalJS: { value: (code, extraBindings) => request({ kind: "source-eval-js", value: String(code ?? ""), input: extraBindings }) }, evalLoginUiV2: { value: (stateJson, book, chapter) => request({ kind: "source-login-ui", value: String(stateJson ?? ""), input: { book, chapter } }) }, evalLoginActionV2: { value: (action, stateJson, formJson, book, chapter) => request({ kind: "source-login-action", value: String(action ?? ""), data: String(stateJson ?? ""), input: { formJson: String(formJson ?? ""), book, chapter } }) }, refreshExplore: { value: () => { request({ kind: "workflow-action", action: "refreshExplore" }); } }, refreshJSLib: { value: () => { request({ kind: "cache-clear", scope: "jsLib" }); } } });',
      'java.getSource = () => source; java.getTag = () => String(sourceValue.bookSourceName ?? ""); java.getSourceNavigationContext = () => request({ kind: "runtime-capability", capability: "getSourceNavigationContext", input: { sourceKey: bindings.sourceKey, sourceName: sourceValue.bookSourceName } }); java.getBatchContext = () => Array.isArray(bindings.chapters) ? { book: globalThis.book, chapters: globalThis.chapters, saveContent: (chapter, content) => request({ kind: "workflow-action", action: "cacheContent", input: { chapter, content } }) } : null; java.getWebViewUA = () => request({ kind: "webview-ua" });',
      'java.refreshBookInfo = () => request({ kind: "workflow-action", action: "refreshBookInfo" }); java.refreshBookToc = () => request({ kind: "workflow-action", action: "refreshBookToc" }); java.refreshContent = () => request({ kind: "workflow-action", action: "refreshContent" });',
      'java.toast = (value) => request({ kind: "runtime-log", operation: "toast", value }); java.longToast = (value) => request({ kind: "runtime-log", operation: "longToast", value }); java.log = (value) => request({ kind: "runtime-log", operation: "log", value }); java.logType = (value) => request({ kind: "runtime-log", operation: "logType", value });',
      'const legadoToURL = (value, base) => { const raw = String(value ?? ""); const resolved = request({ kind: "resolve-url", url: String(base ?? redirectUrl ?? baseUrl ?? bindings.sourceKey ?? ""), value: raw }); const text = String(resolved ?? raw); const match = /^(?:(\\w+):)?\\/\\/([^/?#]*)([^?#]*)?(?:\\?([^#]*))?(?:#(.*))?$/u.exec(text); const protocol = match?.[1] == null ? "" : `${match[1]}:`; const authority = match?.[2] ?? ""; const pathname = match?.[3] ?? ""; const query = match?.[4] ?? ""; const hash = match?.[5] == null ? "" : `#${match[5]}`; const hostParts = authority.split(":"); const hostname = hostParts[0] ?? ""; const port = hostParts.length > 1 ? hostParts.slice(1).join(":") : ""; const params = {}; for (const part of query.split("&")) { if (part.length === 0) continue; const index = part.indexOf("="); if (index < 0) continue; const name = part.slice(0, index); const item = part.slice(index + 1); const decodedName = decodeURIComponent(name.replaceAll("+", " ")); const decodedValue = decodeURIComponent(item.replaceAll("+", " ")); params[decodedName] = decodedValue; } const search = query.length === 0 ? "" : `?${query}`; const origin = protocol.length === 0 ? "" : `${protocol}//${hostname}${port.length > 0 ? `:${port}` : ""}`; return { url: text, href: text, protocol, host: hostname, hostname, port, pathname, search, query, hash, origin, searchParams: params, toString: () => text }; }; java.toURL = (value, base) => legadoToURL(value, base);',
      'const legadoFileRequest = (operation, input) => request({ kind: "file", operation, ...(input ?? {}) }); const legadoFileObject = (path) => { const info = legadoFileRequest("getFile", { path: String(path ?? "") }); if (info == null || typeof info !== "object") return { path: String(path ?? ""), absolutePath: String(path ?? ""), exists: () => false, isFile: () => false, isDirectory: () => false, toString: () => String(path ?? "") }; const value = { ...info, path: info.path ?? String(path ?? ""), absolutePath: info.absolutePath ?? info.path ?? String(path ?? "") }; Object.defineProperties(value, { exists: { configurable: true, value: () => Boolean(info.exists) }, isFile: { configurable: true, value: () => Boolean(info.isFile) }, isDirectory: { configurable: true, value: () => Boolean(info.isDirectory) }, toString: { configurable: true, value: () => String(value.path) } }); return value; }; java.getFile = (path) => legadoFileObject(path); java.importScript = (path) => legadoFileRequest("importScript", { path: String(path ?? "") }); java.cacheFile = (url, saveTime) => legadoFileRequest("cacheFile", { url: String(url ?? ""), saveTime: Number(saveTime ?? 0) }); java.downloadFile = (value, url) => url === undefined ? legadoFileRequest("downloadFile", { url: String(value ?? "") }) : legadoFileRequest("downloadFile", { content: String(value ?? ""), url: String(url) }); java.readFile = (path) => legadoFileRequest("readFile", { path: String(path ?? "") }); java.readTxtFile = (path, charset) => legadoFileRequest("readTxtFile", { path: String(path ?? ""), charset: charset === undefined ? undefined : String(charset) }); java.deleteFile = (path) => legadoFileRequest("deleteFile", { path: String(path ?? "") }); java.unzipFile = (path) => legadoFileRequest("unzipFile", { path: String(path ?? "") }); java.un7zFile = (path) => legadoFileRequest("un7zFile", { path: String(path ?? "") }); java.unrarFile = (path) => legadoFileRequest("unrarFile", { path: String(path ?? "") }); java.unArchiveFile = (path) => legadoFileRequest("unArchiveFile", { path: String(path ?? "") }); java.getTxtInFolder = (path) => legadoFileRequest("getTxtInFolder", { path: String(path ?? "") });',
      'java.getZipStringContent = (url, path, charset) => legadoFileRequest("getZipStringContent", { url: String(url ?? ""), path: String(path ?? ""), charset: charset === undefined ? undefined : String(charset) }); java.getRarStringContent = (url, path, charset) => legadoFileRequest("getRarStringContent", { url: String(url ?? ""), path: String(path ?? ""), charset: charset === undefined ? undefined : String(charset) }); java.get7zStringContent = (url, path, charset) => legadoFileRequest("get7zStringContent", { url: String(url ?? ""), path: String(path ?? ""), charset: charset === undefined ? undefined : String(charset) }); java.getZipByteArrayContent = (url, path) => legadoFileRequest("getZipByteArrayContent", { url: String(url ?? ""), path: String(path ?? "") }); java.getRarByteArrayContent = (url, path) => legadoFileRequest("getRarByteArrayContent", { url: String(url ?? ""), path: String(path ?? "") }); java.get7zByteArrayContent = (url, path) => legadoFileRequest("get7zByteArrayContent", { url: String(url ?? ""), path: String(path ?? "") });',
      'java.htmlFormat = (value, redirect) => request({ kind: "html-format", value: String(value ?? ""), url: redirect === undefined || redirect === null ? "" : String(redirect) }); java.t2s = (value) => request({ kind: "runtime-capability", capability: "java.t2s", input: value }); java.s2t = (value) => request({ kind: "runtime-capability", capability: "java.s2t", input: value });',
      'const __legadoLocks = new Map(); const __legadoFlights = new Map(); const __legadoTicks = new Map(); const legadoCheckLockName = (name) => { const key = String(name ?? ""); if (key.length === 0 || key.length > 256) throw new Error("name 不能为空且长度不能超过 256"); return key; }; const legadoCheckTimeout = (timeoutMs) => { const value = timeoutMs === undefined ? 15000 : Number(timeoutMs); if (!Number.isFinite(value) || value < 0 || value > 300000) throw new Error("timeoutMs 必须在 0..300000 之间"); return value; }; const legadoRunLock = (name, action, timeoutMs, single) => { const key = legadoCheckLockName(name); const wait = legadoCheckTimeout(timeoutMs); if (typeof action !== "function") throw new Error("lock action must be a function"); const locks = single ? __legadoFlights : __legadoLocks; if (locks.has(key)) { if (single) return undefined; throw new Error("lock 等待超时: " + key); } if (bindings.__legadoRuntimeConcurrency === true) { const lease = request({ kind: "runtime-concurrency", operation: "acquire", name: key, timeoutMs: wait, single }); if (lease && typeof lease === "object" && lease.skip === true) return undefined; const token = lease && typeof lease === "object" ? String(lease.token ?? "") : ""; try { action(); return undefined; } finally { if (token.length > 0) request({ kind: "runtime-concurrency", operation: "release", token }); } } locks.set(key, true); try { action(); return undefined; } finally { locks.delete(key); } }; java.singleFlight = (name, action, timeoutMs) => legadoRunLock(name, action, timeoutMs, true); java.lock = (name, action, timeoutMs) => legadoRunLock(name, action, timeoutMs, false); java.tick = (name) => { const key = legadoCheckLockName(name); if (bindings.__legadoRuntimeConcurrency === true) return request({ kind: "runtime-concurrency", operation: "tick", name: key }); const value = Number(__legadoTicks.get(key) ?? 0); __legadoTicks.set(key, value === 2147483647 ? 0 : value + 1); return value; };',
      'java.getReadBookConfig = () => request({ kind: "runtime-capability", capability: "getReadBookConfig" }); java.getReadBookConfigMap = () => request({ kind: "runtime-capability", capability: "getReadBookConfigMap" }); java.getThemeMode = () => request({ kind: "runtime-capability", capability: "getThemeMode" }); java.getThemeConfig = () => request({ kind: "runtime-capability", capability: "getThemeConfig" }); java.getThemeConfigMap = () => request({ kind: "runtime-capability", capability: "getThemeConfigMap" });',
      // SourceLoginJsExtensions/RssJsExtensions 的纯入口优先生成结构化动作；
      // 没有动作宿主时仍通过统一 bridge 返回 capability-missing，而不是静默成功。
      'Object.assign(java, { copyText: (value) => request({ kind: "workflow-action", action: "copyText", input: String(value ?? "") }), clearTtsCache: () => request({ kind: "workflow-action", action: "clearTtsCache" }), searchBook: (...args) => request({ kind: "workflow-action", action: "searchBook", input: args }), addBook: (url) => request({ kind: "workflow-action", action: "addBook", input: String(url ?? "") }), showPhoto: (url) => request({ kind: "workflow-action", action: "showPhoto", input: String(url ?? "") }), open: (...args) => request({ kind: "workflow-action", action: "open", input: args }) });',
      'if (globalThis.book && typeof globalThis.book === "object") Object.defineProperties(globalThis.book, { putCustomVariable: { value: (value) => { setVar("custom", value, "book"); return true; } }, getCustomVariable: { value: () => getVar("custom", "book") ?? "" }, putBigVariable: { value: (name, value) => { setVar(String(name), value, "book"); return true; } }, getBigVariable: { value: (name) => getVar(String(name), "book") ?? "" } });',
      'if (globalThis.chapter && typeof globalThis.chapter === "object") Object.defineProperties(globalThis.chapter, { putImgUrl: { value: (value) => { globalThis.chapter.imgUrl = value == null ? null : String(value); return request({ kind: "workflow-action", action: "refreshContent", input: globalThis.chapter }); } }, putLyric: { value: (value) => { setVar("lyric", value, "chapter"); return request({ kind: "workflow-action", action: "refreshContent", input: globalThis.chapter }); } }, putDanmaku: { value: (value) => { setVar("danmaku", value, "chapter"); return request({ kind: "workflow-action", action: "refreshContent", input: globalThis.chapter }); } }, putBigVariable: { value: (name, value) => { setVar(String(name), value, "chapter"); return true; } }, getBigVariable: { value: (name) => getVar(String(name), "chapter") ?? "" }, update: { value: () => request({ kind: "workflow-action", action: "refreshContent", input: globalThis.chapter }) } });',
      javaCompatibilityPrelude,
      javaObjectGraphPrelude,
    ].join('\n')
    const ruleState = context?.ruleState ?? this.createJavaScriptRuleState(source, stage, content, bindings, signal)
    const runSignal = signal ?? new AbortController().signal
    try {
      const libraries = await this.loadSourceLibraries(source, runSignal, context?.workflowStage ?? this.workflowStageForJavaScript(stage), context?.requestObserver)
      const jsLibStateKey = libraries.length > 0 ? `jsLibState:${sourceDefinitionFingerprint(source)}` : undefined
      if (jsLibStateKey !== undefined) {
        const cachedState = decodeSourceCacheValue(this.encoding, await this.cache.get(jsLibStateKey, runSignal))
        const persisted = typeof cachedState === 'object' && cachedState !== null && !Array.isArray(cachedState) ? cachedState as Record<string, unknown> : {}
        const explicit = context?.globalState ?? {}
        bindings = { ...bindings, __legadoWorkflowGlobalState: { ...persisted, ...explicit } }
      }
      const executable = `${prelude}\n${libraries.join('\n')}\n${normalizeJavaScriptExpression(code)}`
      const initialCaptureVariables: Record<string, string | undefined> = {}
      for (const name of context?.captureBindings ?? []) {
        const entity = bindings[name]
        initialCaptureVariables[name] = typeof entity === 'object' && entity !== null && typeof (entity as RuleEntity).variable === 'string'
          ? (entity as RuleEntity).variable as string
          : undefined
      }
      const output = await this.javascript.execute({
        code: executable,
        mode: context?.mode ?? 'script',
        stage,
        bindings,
        ...(context?.javascriptBudget === undefined ? {} : { budget: context.javascriptBudget }),
        ...(context?.captureBindings === undefined ? {} : { captureBindings: context.captureBindings }),
        ...(context?.mutableBindings === undefined ? {} : { mutableBindings: context.mutableBindings }),
        ...(context?.captureGlobals === true || jsLibStateKey !== undefined ? { captureGlobals: true } : {}),
        ...(signal === undefined ? {} : { signal }),
      }, {
        getVariable: async (name, _bridgeSignal, scope) => {
          if (scope !== undefined && !isVariableScope(scope)) throw new Error('书源变量作用域无效')
          return this.readVariable(name, bindings, scope)
        },
        setVariable: async (name, value, _bridgeSignal, scope) => {
          if (scope !== undefined && !isVariableScope(scope)) throw new Error('书源变量作用域无效')
          this.writeVariable(name, value, bindings, scope)
        },
        ...(this.setConcurrentRate === undefined ? {} : { setConcurrentRate: this.setConcurrentRate }),
        request: (payload, bridgeSignal) => {
          if (typeof payload === 'object' && payload !== null && (payload as SourceRuleBridgeRequest).kind === 'workflow-action') {
            const actionRequest = payload as SourceRuleBridgeRequest
            const name = textValue(actionRequest.action)
            const action = context?.workflowActions?.[name]
            if (action === undefined) throw new Error(`__LEGADO_CAPABILITY__runtime ${name} unavailable`)
            return action(bridgeSignal, actionRequest.input)
          }
          const bridged = typeof payload === 'object' && payload !== null && context?.requestBudget !== undefined
            && ['network', 'network-all', 'network-response', 'url-context-response'].includes(String((payload as SourceRuleBridgeRequest).kind))
            ? { ...(payload as SourceRuleBridgeRequest), budget: { ...context.requestBudget, ...((payload as SourceRuleBridgeRequest).budget ?? {}) } }
            : payload
          return this.handleBridge(bridged, bridgeSignal, source, context?.ruleState?.request.stage ?? context?.workflowStage ?? this.workflowStageForJavaScript(stage), bindings, context?.workflowActions, context?.requestObserver)
        },
        evaluateRule: (rule, bridgeSignal, options) => this.nestedRule(rule, ruleState, options?.content ?? content, options?.expect ?? 'text', bridgeSignal),
      })
      let value = output.value
      if (jsLibStateKey !== undefined && typeof output.value === 'object' && output.value !== null && !Array.isArray(output.value)) {
        const wrapper = output.value as Record<string, unknown>
        const capturedGlobals = wrapper.__legadoWorkflowGlobals
        if (typeof capturedGlobals === 'object' && capturedGlobals !== null && !Array.isArray(capturedGlobals)) {
          const forbidden = new Set(['bindings', 'sourceData', 'sourceKey', 'sourceName', 'baseUrl', 'redirectUrl', 'src', 'key', 'page', 'url', 'nextChapterUrl', 'chapters', 'index', 'title', 'gInt', 'fromBookInfo', 'isFromBookInfo', 'infoMap', 'book', 'chapter', 'source', 'sourceApi', 'java', 'cookie', 'cache', 'result', 'Packages', 'JavaImporter', 'JavaAdapter'])
          const state: Record<string, unknown> = {}
          for (const [name, item] of Object.entries(capturedGlobals)) {
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) || name.startsWith('__legado') || forbidden.has(name) || Object.keys(state).length >= 128) continue
            try {
              const encoded = JSON.stringify(item)
              if (encoded !== undefined && encoded.length <= 262_144) state[name] = item
            } catch {
              // Functions and host objects are intentionally excluded from jsLib state.
            }
          }
          if (!this.clearedJsLibStates.delete(jsLibStateKey)) await this.cache.put(jsLibStateKey, `${sourceCacheJsonPrefix}${JSON.stringify(state)}`, 0, runSignal)
        }
        if (context?.captureGlobals !== true && context?.captureBindings === undefined) {
          value = wrapper.__legadoWorkflowValue
        } else if (context?.captureGlobals !== true && Object.hasOwn(wrapper, '__legadoWorkflowGlobals')) {
          const withoutState = { ...wrapper }
          delete withoutState.__legadoWorkflowGlobals
          value = withoutState
        }
      }
      return {
        status: output.status === 'budget-exceeded' ? 'failed' : output.status,
        value: mergeCapturedEntityVariables(value, context?.captureBindings, bindings, initialCaptureVariables),
        ...(output.diagnostics[0] === undefined ? {} : { message: output.diagnostics[0].message }),
      }
    } catch (error) {
      if (error instanceof SourceRuleError) return { status: error.status, value: null, message: error.message }
      if (signal?.aborted === true) return { status: 'cancelled', value: null, message: 'JavaScript 宿主准备已取消' }
      return { status: 'failed', value: null, message: error instanceof Error ? error.message : 'JavaScript 宿主准备失败' }
    }
  }

  private createJavaScriptRuleState(source: NormalizedSource, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', content: unknown, bindings: Readonly<Record<string, unknown>>, signal?: AbortSignal): EvaluationState {
    const workflowStage: WorkflowRuleRequest['stage'] = stage === 'search' || stage === 'mainJs' ? 'search' : 'detail'
    const request: WorkflowRuleRequest = {
      source,
      stage: workflowStage,
      field: 'javascript',
      rule: '',
      content,
      expect: 'text',
      bindings,
      ...(signal === undefined ? {} : { signal }),
    }
    return { request, source, content, bindings, budget: { steps: 0, depth: 0 }, expect: 'text' }
  }

  private async loadSourceLibraries(source: NormalizedSource, signal: AbortSignal, workflowStage: WorkflowStage, requestObserver?: RequestObserver): Promise<string[]> {
    const value = source.jsLib
    if (typeof value !== 'string' || value.trim().length === 0) return []
    let remoteUrls: string[] | undefined
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        remoteUrls = Object.values(parsed).map((item) => {
          if (item === null || item === undefined) return ''
          return typeof item === 'object' ? JSON.stringify(item) ?? '' : String(item)
        })
      }
    } catch {
      return [value]
    }
    if (remoteUrls === undefined) return [value]
    const scripts: string[] = []
    const fingerprint = sourceDefinitionFingerprint(source)
    for (const remoteUrl of remoteUrls) {
      let url: URL
      try {
        url = new URL(remoteUrl)
      } catch {
        continue
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      const cacheKey = `jsLib:${fingerprint}:${url.toString()}`
      let script = await this.cache.get(cacheKey, signal)
      if (script === undefined) {
        if (this.requestBridge === undefined) throw new SourceRuleError('capability-missing', '加载 jsLib 需要网络宿主')
        const response = await this.requestBridge({ kind: 'network', url: url.toString(), stage: workflowStage }, signal, source, requestObserver)
        if (typeof response !== 'string') throw new SourceRuleError('failed', 'jsLib 网络响应不是文本')
        script = response
        await this.cache.put(cacheKey, script, 0, signal)
      }
      scripts.push(script)
    }
    return scripts
  }

  private async clearSourceLibraries(source: NormalizedSource, signal: AbortSignal): Promise<void> {
    const value = source.jsLib
    if (typeof value !== 'string' || value.trim().length === 0) return
    const fingerprint = sourceDefinitionFingerprint(source)
    const stateKey = `jsLibState:${fingerprint}`
    this.clearedJsLibStates.add(stateKey)
    await this.cache.delete(stateKey, signal)
    let remoteUrls: string[] | undefined
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        remoteUrls = Object.values(parsed).map((item) => item === null || item === undefined ? '' : typeof item === 'object' ? JSON.stringify(item) ?? '' : String(item))
      }
    } catch {
      return
    }
    if (remoteUrls === undefined) return
    for (const remoteUrl of remoteUrls) {
      let url: URL
      try {
        url = new URL(remoteUrl)
      } catch {
        continue
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      await this.cache.delete(`jsLib:${fingerprint}:${url.toString()}`, signal)
    }
  }

  private async handleBridge(input: unknown, signal: AbortSignal, source: NormalizedSource, workflowStage: WorkflowStage, currentBindings: Readonly<Record<string, unknown>> = this.bindings, workflowActions?: WorkflowJavaScriptRequest['workflowActions'], requestObserver?: RequestObserver): Promise<unknown> {
    if (typeof input !== 'object' || input === null) throw new Error('书源 bridge 请求必须是对象')
    const request = input as SourceRuleBridgeRequest
    if (request.kind === 'node-info' || request.kind === 'node-mutate' || request.kind === 'node-match') {
      const value = request.value
      const nodeId = typeof value === 'string'
        ? value
        : typeof value === 'object' && value !== null && 'id' in value
          ? textValue((value as Record<string, unknown>).id)
          : textValue(request.name)
      const stored = this.nodes.get(nodeId)
      if (stored === undefined) throw new Error('__LEGADO_CAPABILITY__runtime parser node expired')
      if (request.kind === 'node-match') {
        const selector = typeof value === 'object' && value !== null ? textValue((value as Record<string, unknown>).selector) : ''
        return stored.document.select(selector).some((candidate) => candidate.id === stored.node.id)
      }
      if (request.kind === 'node-info') {
        const info = stored.document.describe?.(stored.node)
        if (info === undefined) throw new Error('__LEGADO_CAPABILITY__runtime parser node relations unavailable')
        const ref = (node: ParserNode | null | undefined): NodeRef | null | undefined => node === undefined || node === null ? node : this.remember(stored.document, node)
        return {
          ...info,
          parent: ref(info.parent),
          parents: info.parents?.map((node) => this.remember(stored.document, node)),
          children: info.children?.map((node) => this.remember(stored.document, node)),
          previousSibling: ref(info.previousSibling),
          nextSibling: ref(info.nextSibling),
        }
      }
      const mutation = typeof value === 'object' && value !== null && 'mutation' in value
        ? (value as Record<string, unknown>).mutation
        : request.input
      if (typeof mutation !== 'object' || mutation === null) throw new Error('parser node mutation must be an object')
      const result = stored.document.mutate?.(stored.node, mutation as Parameters<NonNullable<HtmlDocument['mutate']>>[1])
      return result === undefined ? undefined : this.remember(stored.document, result)
    }
    if (request.kind === 'resolve-url') return resolveSourceUrl(request.url, request.value)
    if (request.kind === 'resolve-urls') return resolveSourceUrls(request.url, request.urls)
    if (request.kind === 'pattern-compile') {
      const compiled = compileSourcePattern(textValue(request.pattern), { flags: textValue(request.flags) })
      if ('error' in compiled) throw new Error(`__LEGADO_PATTERN__${compiled.error.code}: ${compiled.error.message}`)
      return { source: compiled.regex.source, flags: compiled.regex.flags }
    }
    if (request.kind === 'base64-encode') return base64EncodeWithFlags(this.encoding, request.value instanceof Uint8Array || request.value instanceof ArrayBuffer ? byteValue(request.value) : textValue(request.value), request.flags)
    if (request.kind === 'base64-decode-bytes') {
      return base64DecodeWithFlags(this.encoding, request.value, request.flags)
    }
    if (request.kind === 'encode-bytes') return this.encoding.encode(textValue(request.value), textValue(request.charset) || 'UTF-8')
    if (request.kind === 'decode-bytes') return this.encoding.decode(byteValue(request.value), textValue(request.charset) || 'UTF-8')
    if (request.kind === 'to-num-chapter') return toNumChapter(request.value)
    if (request.kind === 'base64-decode-text') return this.encoding.decode(base64DecodeWithFlags(this.encoding, request.value, request.flags), textValue(request.charset) || 'UTF-8')
    if (request.kind === 'hex-decode-bytes') return this.encoding.hexDecode(textValue(request.value))
    if (request.kind === 'hex-decode-text') return new TextDecoder().decode(this.encoding.hexDecode(textValue(request.value)))
    if (request.kind === 'hex-encode') return this.encoding.hexEncode(request.value instanceof Uint8Array || request.value instanceof ArrayBuffer ? byteValue(request.value) : this.encoding.encode(textValue(request.value), 'UTF-8'))
    if (request.kind === 'md5') return this.crypto.digestHex(textValue(request.value), 'md5')
    if (request.kind === 'md5-16') return this.crypto.digestHex(textValue(request.value), 'md5').slice(8, 24)
    if (request.kind === 'digest') return this.crypto.digestHex(cryptoInputValue(request.value), digestAlgorithm(request.algorithm ?? request.transformation ?? 'sha256'))
    if (request.kind === 'digest-base64') return this.crypto.digestBase64(cryptoInputValue(request.value), digestAlgorithm(request.algorithm ?? request.transformation ?? 'sha256'))
    if (request.kind === 'hmac-hex') return this.crypto.hmacHex(cryptoInputValue(request.value), cryptoInputValue(request.key), digestAlgorithm(request.algorithm ?? request.transformation ?? 'sha256'))
    if (request.kind === 'hmac-base64') return this.encoding.base64Encode(this.encoding.hexDecode(this.crypto.hmacHex(cryptoInputValue(request.value), cryptoInputValue(request.key), digestAlgorithm(request.algorithm ?? request.transformation ?? 'sha256'))))
    if (request.kind === 'aes-decode-text') {
      const key = this.encoding.encode(textValue(request.key), 'utf-8')
      const iv = this.encoding.encode(textValue(request.iv), 'utf-8')
      return this.crypto.createSymmetricCrypto(textValue(request.transformation), key, iv).decryptText(this.encoding.base64Decode(textValue(request.value)))
    }
    if (request.kind === 'encode-uri') return encodeFormUri(this.encoding, request.value, request.charset)
    if (request.kind === 'crypto-symmetric') {
      const operation = textValue(request.operation)
      const transformation = textValue(request.transformation)
      const keyValue = request.key
      const ivValue = request.iv
      const key = keyValue === undefined || keyValue === null ? undefined : typeof keyValue === 'object' && keyValue !== null && !Array.isArray(keyValue) && '__legadoBase64' in keyValue
        ? base64DecodeWithFlags(this.encoding, (keyValue as Record<string, unknown>).__legadoBase64, 0)
        : typeof keyValue === 'string' ? this.encoding.encode(keyValue, 'UTF-8') : byteValue(keyValue)
      const iv = ivValue === undefined || ivValue === null
        ? undefined
        : typeof ivValue === 'object' && !Array.isArray(ivValue) && '__legadoBase64' in (ivValue as object)
          ? base64DecodeWithFlags(this.encoding, (ivValue as Record<string, unknown>).__legadoBase64, 0)
          : typeof ivValue === 'string' ? this.encoding.encode(ivValue, 'UTF-8') : byteValue(ivValue)
      const crypto = this.crypto.createSymmetricCrypto(transformation, key, iv)
      if (operation === 'decrypt') {
        const input = textValue(request.inputEncoding) === 'base64' ? base64DecodeWithFlags(this.encoding, request.value, 0) : textValue(request.inputEncoding) === 'hex' ? this.encoding.hexDecode(textValue(request.value)) : byteValue(request.value)
        const bytes = crypto.decrypt(input)
        return textValue(request.outputEncoding) === 'text' ? this.encoding.decode(bytes, textValue(request.charset) || 'UTF-8') : textValue(request.outputEncoding) === 'hex' ? this.encoding.hexEncode(bytes) : textValue(request.outputEncoding) === 'base64' ? this.encoding.base64Encode(bytes) : bytes
      }
      const inputEncoding = textValue(request.inputEncoding)
      const input = typeof request.value === 'string'
        ? inputEncoding === 'base64' ? this.encoding.base64Decode(textValue(request.value)) : inputEncoding === 'hex' ? this.encoding.hexDecode(textValue(request.value)) : this.encoding.encode(request.value, textValue(request.charset) || 'UTF-8')
        : byteValue(request.value)
      const bytes = crypto.encrypt(input)
      return textValue(request.outputEncoding) === 'text' ? this.encoding.decode(bytes, textValue(request.charset) || 'UTF-8') : textValue(request.outputEncoding) === 'hex' ? this.encoding.hexEncode(bytes) : textValue(request.outputEncoding) === 'base64' ? this.encoding.base64Encode(bytes) : bytes
    }
    if (request.kind === 'crypto-key') {
      if (this.crypto.generateSymmetricKey === undefined) throw new Error('__LEGADO_CAPABILITY__runtime symmetric key generation unavailable')
      return this.crypto.generateSymmetricKey(textValue(request.transformation))
    }
    if (request.kind === 'crypto-asymmetric') {
      if (this.crypto.createAsymmetricCrypto === undefined) throw new Error('__LEGADO_CAPABILITY__runtime asymmetric crypto unavailable')
      const crypto = this.crypto.createAsymmetricCrypto(textValue(request.transformation))
      if (request.privateKey !== undefined) crypto.setPrivateKey(typeof request.privateKey === 'string' ? request.privateKey : byteValue(request.privateKey))
      if (request.publicKey !== undefined) crypto.setPublicKey(typeof request.publicKey === 'string' ? request.publicKey : byteValue(request.publicKey))
      const inputEncoding = textValue(request.inputEncoding)
      const input = typeof request.value === 'string'
        ? inputEncoding === 'base64' ? this.encoding.base64Decode(textValue(request.value)) : inputEncoding === 'hex' ? this.encoding.hexDecode(textValue(request.value)) : this.encoding.encode(request.value, textValue(request.charset) || 'UTF-8')
        : byteValue(request.value)
      const usePublicKey = request.usePublicKey !== false
      const operation = textValue(request.operation)
      if (operation === 'decrypt') {
        const bytes = crypto.decrypt(input, usePublicKey)
        return textValue(request.outputEncoding) === 'text' ? this.encoding.decode(bytes, textValue(request.charset) || 'UTF-8') : textValue(request.outputEncoding) === 'hex' ? this.encoding.hexEncode(bytes) : textValue(request.outputEncoding) === 'base64' ? this.encoding.base64Encode(bytes) : bytes
      }
      const bytes = crypto.encrypt(input, usePublicKey)
      return textValue(request.outputEncoding) === 'text' ? this.encoding.decode(bytes, textValue(request.charset) || 'UTF-8') : textValue(request.outputEncoding) === 'hex' ? this.encoding.hexEncode(bytes) : textValue(request.outputEncoding) === 'base64' ? this.encoding.base64Encode(bytes) : bytes
    }
    if (request.kind === 'crypto-sign') {
      if (this.crypto.createSign === undefined) throw new Error('__LEGADO_CAPABILITY__runtime sign crypto unavailable')
      const signer = this.crypto.createSign(textValue(request.algorithm))
      if (request.privateKey !== undefined) signer.setPrivateKey(typeof request.privateKey === 'string' ? request.privateKey : byteValue(request.privateKey))
      if (request.publicKey !== undefined) signer.setPublicKey(typeof request.publicKey === 'string' ? request.publicKey : byteValue(request.publicKey))
      const input = typeof request.value === 'string' ? this.encoding.encode(request.value, textValue(request.charset) || 'UTF-8') : byteValue(request.value)
      if (textValue(request.operation) === 'verify') {
        const signature = typeof request.signature === 'string'
          ? textValue(request.signatureEncoding) === 'hex' ? this.encoding.hexDecode(request.signature) : this.encoding.base64Decode(request.signature)
          : byteValue(request.signature)
        return signer.verify(input, signature)
      }
      const signature = signer.sign(input)
      return textValue(request.outputEncoding) === 'hex' ? this.encoding.hexEncode(signature) : textValue(request.outputEncoding) === 'base64' ? this.encoding.base64Encode(signature) : signature
    }
    if (request.kind === 'font-query') {
      const useCache = request.useCache === undefined ? true : request.useCache === true
      let value = request.value
      if (typeof value === 'string' && textValue(request.inputEncoding) !== 'base64' && /^https?:\/\//iu.test(value.trim())) {
        if (this.requestBridge === undefined) throw new Error('__LEGADO_CAPABILITY__runtime font URL loading unavailable')
        const response = await this.requestBridge({ kind: 'network-response', url: value.trim(), method: 'GET', stage: workflowStage }, signal, source, requestObserver)
        const record = typeof response === 'object' && response !== null && !Array.isArray(response) ? response as Record<string, unknown> : {}
        value = record.bytes ?? record.bodyBytes ?? record.body
      } else if (typeof value === 'string' && textValue(request.inputEncoding) !== 'base64' && this.file !== undefined && /(?:^[/\\]|(?:^|[/\\])(?:cache|temp|download)[/\\]|\.(?:ttf|otf|woff2?)$)/iu.test(value.trim())) {
        value = await this.file.execute('readFile', { path: value.trim() }, signal, source)
      }
      const mapping = typeof value === 'string' && textValue(request.inputEncoding) === 'base64'
        ? this.font.queryBase64TTF(value, { signal, useCache })
        : typeof value === 'string'
          ? this.font.queryBase64TTF(value, { signal, useCache })
          : value === null || value === undefined
            ? null
            : this.font.queryTTF(byteValue(value), { signal, useCache })
      if (mapping === null) return null
      const id = `font-${this.nextFontId++}`
      this.fontMappings.set(id, mapping)
      return id
    }
    if (request.kind === 'font-query-method') {
      const mapping = this.fontMappings.get(textValue(request.name))
      if (mapping === undefined) throw new Error('__LEGADO_CAPABILITY__runtime font mapping unavailable')
      const operation = textValue(request.operation)
      if (operation === 'glyphId') return mapping.glyphIdByUnicode(Number(request.value))
      if (operation === 'glyph') return mapping.glyphByUnicode(Number(request.value)) ?? null
      if (operation === 'glyphById') return mapping.glyphById?.(Number(request.value)) ?? null
      if (operation === 'unicode') return mapping.unicodeByGlyph(request.value === undefined ? undefined : textValue(request.value))
      if (operation === 'blank') return mapping.isBlankUnicode(Number(request.value))
      throw new Error(`__LEGADO_CAPABILITY__runtime font.${operation} unavailable`)
    }
    if (request.kind === 'font-replace') {
      const error = request.errorFontId !== undefined
        ? this.fontMappings.get(textValue(request.errorFontId)) ?? null
        : request.errorBase64 === undefined || request.errorBase64 === null
          ? null
          : this.font.queryBase64TTF(textValue(request.errorBase64), { signal })
      const correct = request.correctFontId !== undefined
        ? this.fontMappings.get(textValue(request.correctFontId)) ?? null
        : request.correctBase64 === undefined || request.correctBase64 === null
          ? null
          : this.font.queryBase64TTF(textValue(request.correctBase64), { signal })
      return replaceFont(textValue(request.text), error, correct, request.filter === true)
    }
    if (request.kind === 'cache-get') {
      if (request.onlyDisk === true && this.cache.getFromDisk === undefined) throw new Error('__LEGADO_CAPABILITY__runtime cache.onlyDisk unavailable')
      const value = request.onlyDisk === true
        ? await this.cache.getFromDisk!(textValue(request.key), signal)
        : await this.cache.get(textValue(request.key), signal)
      return decodeSourceCacheValue(this.encoding, value)
    }
    if (request.kind === 'cache-put') {
      const key = textValue(request.key)
      const saveTime = Number(request.saveTime) || 0
      if (this.cache.putByteArray !== undefined && isByteValue(request.value)) return this.cache.putByteArray(key, byteValue(request.value), saveTime, signal)
      return this.cache.put(key, encodeSourceCacheValue(this.encoding, request.value), saveTime, signal)
    }
    if (request.kind === 'cache-delete') {
      const key = textValue(request.key)
      const result = await this.cache.delete(key, signal)
      await this.file?.invalidateCacheFile?.(key, signal, source)
      return result
    }
    if (request.kind === 'cache-memory-get') return decodeSourceCacheValue(this.encoding, await this.cache.getFromMemory(textValue(request.key)))
    if (request.kind === 'cache-memory-put') return this.cache.putMemory(textValue(request.key), encodeSourceCacheValue(this.encoding, request.value), signal)
    if (request.kind === 'cache-memory-delete') return this.cache.deleteMemory(textValue(request.key), signal)
    if (request.kind === 'cache-bytes-get') {
      if (this.cache.getByteArray !== undefined) return this.cache.getByteArray(textValue(request.key), signal)
      const value = await this.cache.get(textValue(request.key), signal)
      const decoded = decodeSourceCacheValue(this.encoding, value)
      return decoded instanceof Uint8Array ? decoded : undefined
    }
    if (request.kind === 'cache-file-get') return decodeSourceCacheValue(this.encoding, await this.cache.getFile(textValue(request.key)))
    if (request.kind === 'cache-file-put') return this.cache.putFile(textValue(request.key), encodeSourceCacheValue(this.encoding, request.value), Number(request.saveTime) || 0, signal)
    if (request.kind === 'cache-clear') {
      if (request.scope === 'jsLib') return this.clearSourceLibraries(source, signal)
      if (this.cache.clear === undefined) throw new Error('__LEGADO_CAPABILITY__runtime source.refreshJSLib unavailable')
      return this.cache.clear()
    }
    if (request.kind === 'time-format') {
      if (this.timeFormat === undefined) throw new Error('__LEGADO_CAPABILITY__runtime timeFormat unavailable')
      return this.timeFormat(Number(request.time))
    }
    if (request.kind === 'time-format-utc') {
      if (this.timeFormatUTC === undefined) throw new Error('__LEGADO_CAPABILITY__runtime timeFormatUTC unavailable')
      return this.timeFormatUTC(Number(request.time), textValue(request.format), Number(request.offsetMs))
    }
    if (request.kind === 'random-uuid') {
      if (this.randomUUID === undefined) throw new Error('__LEGADO_CAPABILITY__runtime randomUUID unavailable')
      return this.randomUUID()
    }
    if (request.kind === 'source-state') return this.handleSourceState(request, signal, source, workflowStage, currentBindings, workflowActions, requestObserver)
    if (request.kind === 'file') {
      if (this.file === undefined) throw new Error(`__LEGADO_CAPABILITY__runtime file.${textValue(request.operation)} unavailable`)
      const operation = textValue(request.operation) as SourceFileOperation
      return this.file.execute(operation, { ...request, sourceKey: source.bookSourceUrl }, signal, source)
    }
    if (request.kind === 'runtime-log') {
      const operation = textValue(request.operation) as 'toast' | 'longToast' | 'log' | 'logType'
      this.logger?.(operation, request.value)
      return operation === 'log' ? request.value : undefined
    }
    if (request.kind === 'webview-ua') {
      if (this.webViewUA === undefined) throw new Error('__LEGADO_CAPABILITY__runtime getWebViewUA unavailable')
      return this.webViewUA()
    }
    if (request.kind === 'runtime-concurrency') {
      if (this.concurrency === undefined) throw new Error('__LEGADO_CAPABILITY__runtime SourceLock unavailable')
      const operation = textValue(request.operation)
      const name = textValue(request.name)
      if (operation === 'acquire') return this.concurrency.acquire(request.single === true ? 'singleFlight' : 'lock', name, Number(request.timeoutMs ?? 15000), signal)
      if (operation === 'release') return this.concurrency.release(textValue(request.token))
      if (operation === 'tick') return this.concurrency.tick(name)
      throw new Error(`__LEGADO_CAPABILITY__runtime SourceLock.${operation} unavailable`)
    }
    if (request.kind === 'html-format') return formatChapterBody(textValue(request.value), textValue(request.url)).content
    if (request.kind === 'html-unescape') return unescapeHtml4(textValue(request.value))
    if (request.kind === 'source-eval-js' || request.kind === 'source-login' || request.kind === 'source-login-ui' || request.kind === 'source-login-action') {
      const loginJs = request.kind === 'source-eval-js' ? '' : inlineJavaScript(source.loginUrl) ?? (typeof source.loginUrl === 'string' ? source.loginUrl : '')
      if (request.kind !== 'source-eval-js' && loginJs.trim().length === 0) {
        if (request.kind === 'source-login') return undefined
        throw new Error('登录 UI v2 缺少 loginUi/loginAction 脚本')
      }
      const extra = typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {}
      let code = request.kind === 'source-eval-js' ? textValue(request.value) : `${loginJs}\nif (typeof login !== "function") throw new Error("Function login not implements!!!"); login.apply(this);`
      if (request.kind === 'source-login-ui') code = `${loginJs}\nif (typeof loginUi !== "function") throw new Error("Function loginUi not implements!!!"); loginUi(JSON.parse(String(__loginState)));`
      if (request.kind === 'source-login-action') code = `${loginJs}\nif (typeof loginAction !== "function") throw new Error("Function loginAction not implements!!!"); loginAction(String(__loginAction), JSON.parse(String(__loginState)), JSON.parse(String(__loginForm)));`
      const bindings: Record<string, unknown> = { ...currentBindings, ...(request.kind === 'source-eval-js' && typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input) ? extra : {}) }
      if (request.kind === 'source-login-ui') Object.assign(bindings, { __loginState: textValue(request.value), book: extra.book, chapter: extra.chapter })
      if (request.kind === 'source-login-action') Object.assign(bindings, { __loginAction: textValue(request.value), __loginState: textValue(request.data), __loginForm: textValue((extra as { formJson?: unknown }).formJson), book: extra.book, chapter: extra.chapter })
      const output = await this.runJavaScript(code, this.javascriptStage(workflowStage), source, '', signal, { bindings, mode: 'script', workflowStage, ...(workflowActions === undefined ? {} : { workflowActions }), ...(requestObserver === undefined ? {} : { requestObserver }) })
      if (output.status === 'empty') return undefined
      if (output.status !== 'success') throw new SourceRuleError(output.status, output.message ?? '书源登录脚本执行失败')
      return request.kind === 'source-login' ? undefined : output.value
    }
    if (request.kind === 'runtime-capability') {
      if (this.platform === undefined) throw new Error(`__LEGADO_CAPABILITY__runtime ${textValue(request.capability)} unavailable`)
      return this.platform.invoke(textValue(request.capability), request.input, { source, workflowStage, signal, bindings: currentBindings })
    }
    if (this.requestBridge === undefined) throw new Error('__LEGADO_CAPABILITY__network 书源网络或宿主 bridge 不可用')
    return this.requestBridge({ ...request, stage: workflowStage }, signal, source, requestObserver)
  }

  private async handleSourceState(request: SourceRuleBridgeRequest, signal: AbortSignal, source: NormalizedSource, workflowStage: WorkflowStage, currentBindings: Readonly<Record<string, unknown>>, workflowActions?: WorkflowJavaScriptRequest['workflowActions'], requestObserver?: RequestObserver): Promise<unknown> {
    const operation = textValue(request.operation)
    if (operation === 'getHeaderMap') {
      if (this.sourceState?.getHeaderMap !== undefined) return this.sourceState.getHeaderMap(source, request.value === true, signal)
      const result: Record<string, string> = {}
      const rawHeader = source.header
      if (typeof rawHeader === 'string' && rawHeader.trim().length > 0) {
        try {
          let headerValue: unknown = rawHeader
          const inline = inlineJavaScript(rawHeader)
          if (inline !== undefined && currentBindings.__legadoHeaderEvaluation !== true) {
            const output = await this.runJavaScript(inline, this.javascriptStage(workflowStage), source, '', signal, {
              bindings: { ...currentBindings, __legadoHeaderEvaluation: true },
              mode: 'script',
              workflowStage,
              ...(workflowActions === undefined ? {} : { workflowActions }),
              ...(requestObserver === undefined ? {} : { requestObserver }),
            })
            if (output.status === 'empty') headerValue = ''
            else if (output.status !== 'success') throw new SourceRuleError(output.status, output.message ?? '动态请求头执行失败')
            else headerValue = output.value
          }
          Object.assign(result, sourceHeaderObject(headerValue))
        } catch {
          // Android logs invalid dynamic headers and continues with the default map.
        }
      } else if (typeof rawHeader === 'object' && rawHeader !== null && !Array.isArray(rawHeader)) {
        for (const [key, value] of Object.entries(rawHeader)) result[key] = textValue(value)
      }
      if (!Object.keys(result).some((key) => key.toLowerCase() === 'user-agent') && this.webViewUA !== undefined) result['User-Agent'] = this.webViewUA()
      if (request.value === true) {
        const login = this.sourceState?.getLoginHeader !== undefined
          ? await this.sourceState.getLoginHeader(source, signal)
          : this.sessionLoginHeaders.get(source.bookSourceUrl)
        if (login != null) {
          try {
            const parsed: unknown = JSON.parse(login)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) for (const [key, value] of Object.entries(parsed)) result[key] = textValue(value)
          } catch {
            // Ignore malformed persisted login headers just like Android's getLoginHeaderMap.
          }
        }
      }
      return result
    }
    if (operation === 'getVariable') {
      if (this.sourceState?.getVariable !== undefined) return this.sourceState.getVariable(source, signal)
      return this.sessionSourceVariables.get(source.bookSourceUrl) ?? ''
    }
    if (operation === 'setVariable') {
      const value = request.value === null || request.value === undefined ? null : textValue(request.value)
      if (this.sourceState?.setVariable !== undefined) await this.sourceState.setVariable(source, value, signal)
      else if (value === null) this.sessionSourceVariables.delete(source.bookSourceUrl)
      else this.sessionSourceVariables.set(source.bookSourceUrl, value)
      return undefined
    }
    if (operation === 'getValue') {
      const key = textValue(request.name)
      if (this.sourceState?.getValue !== undefined) return this.sourceState.getValue(source, key, signal)
      return this.sessionSourceValues.get(source.bookSourceUrl)?.get(key) ?? ''
    }
    if (operation === 'putValue') {
      const key = textValue(request.name)
      const value = textValue(request.value)
      if (this.sourceState?.putValue !== undefined) return this.sourceState.putValue(source, key, value, signal)
      let values = this.sessionSourceValues.get(source.bookSourceUrl)
      if (values === undefined) {
        values = new Map<string, string>()
        this.sessionSourceValues.set(source.bookSourceUrl, values)
      }
      values.set(key, value)
      return value
    }
    if (operation === 'getLoginHeader') {
      if (this.sourceState?.getLoginHeader !== undefined) return this.sourceState.getLoginHeader(source, signal)
      return this.sessionLoginHeaders.get(source.bookSourceUrl) ?? null
    }
    if (operation === 'putLoginHeader') {
      const value = textValue(request.value)
      if (this.sourceState?.putLoginHeader !== undefined) await this.sourceState.putLoginHeader(source, value, signal)
      else this.sessionLoginHeaders.set(source.bookSourceUrl, value)
      return undefined
    }
    if (operation === 'removeLoginHeader') {
      if (this.sourceState?.removeLoginHeader !== undefined) await this.sourceState.removeLoginHeader(source, signal)
      else this.sessionLoginHeaders.delete(source.bookSourceUrl)
      return undefined
    }
    if (operation === 'getLoginInfo') {
      if (this.sourceState?.getLoginInfo !== undefined) return this.sourceState.getLoginInfo(source, signal)
      return this.sessionLoginInfo.get(source.bookSourceUrl) ?? null
    }
    if (operation === 'getLoginInfoMap') {
      const delegated = this.sourceState?.getLoginInfoMap === undefined ? undefined : await this.sourceState.getLoginInfoMap(source, signal)
      if (delegated !== undefined) return delegated
      const raw = this.sourceState?.getLoginInfo !== undefined
        ? await this.sourceState.getLoginInfo(source, signal)
        : this.sessionLoginInfo.get(source.bookSourceUrl)
      if (raw !== undefined && raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw)
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, textValue(value)])) : {}
        } catch {
          return {}
        }
      }
      const staticDefaults = loginInfoDefaults(source.loginUi)
      if (staticDefaults !== undefined) {
        if (Object.keys(staticDefaults).length > 0) {
          const json = JSON.stringify(staticDefaults)
          if (this.sourceState?.putLoginInfo !== undefined) await this.sourceState.putLoginInfo(source, json, signal)
          else this.sessionLoginInfo.set(source.bookSourceUrl, json)
        }
        return staticDefaults
      }
      const loginUiJs = inlineJavaScript(source.loginUi)
      if (loginUiJs !== undefined && currentBindings.__legadoLoginInfoEvaluation !== true) {
        const loginJs = inlineJavaScript(source.loginUrl) ?? (typeof source.loginUrl === 'string' ? source.loginUrl : '')
        const output = await this.runJavaScript(`${loginJs}\n${loginUiJs}`, this.javascriptStage(workflowStage), source, '', signal, {
          bindings: { ...currentBindings, __legadoLoginInfoEvaluation: true, result: {}, book: null, chapter: null },
          mode: 'script',
          workflowStage,
          ...(workflowActions === undefined ? {} : { workflowActions }),
          ...(requestObserver === undefined ? {} : { requestObserver }),
        })
        if (output.status === 'success') {
          const defaults = loginInfoDefaults(output.value)
          if (defaults !== undefined) {
            if (Object.keys(defaults).length === 0) return defaults
            const json = JSON.stringify(defaults)
            if (this.sourceState?.putLoginInfo !== undefined) await this.sourceState.putLoginInfo(source, json, signal)
            else this.sessionLoginInfo.set(source.bookSourceUrl, json)
            return defaults
          }
        }
      }
      return {}
    }
    if (operation === 'putLoginInfo') {
      const value = textValue(request.value)
      if (this.sourceState?.putLoginInfo !== undefined) return this.sourceState.putLoginInfo(source, value, signal)
      this.sessionLoginInfo.set(source.bookSourceUrl, value)
      return true
    }
    if (operation === 'removeLoginInfo') {
      if (this.sourceState?.removeLoginInfo !== undefined) await this.sourceState.removeLoginInfo(source, signal)
      else this.sessionLoginInfo.delete(source.bookSourceUrl)
      return undefined
    }
    throw new Error(`__LEGADO_CAPABILITY__runtime source.${operation} unavailable`)
  }

  private remember(document: HtmlDocument, node: ParserNode): NodeRef {
    const id = `node-${this.nextNodeId++}`
    this.nodes.set(id, { document, node })
    return { __legadoNode: 'source-rule-node', id }
  }

  private toList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [value]
  }

  private isParserNode(value: unknown): value is ParserNode {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string' && typeof (value as { kind?: unknown }).kind === 'string'
  }

  private javascriptStage(stage: WorkflowRuleRequest['stage']): 'mainJs' | 'book' | 'chapter' | 'search' | 'content' {
    return stage === 'search' ? 'search' : stage === 'detail' ? 'book' : 'content'
  }

  private workflowStageForJavaScript(stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content'): WorkflowStage {
    return stage === 'search' || stage === 'mainJs' ? 'search' : 'detail'
  }

  private check(state: EvaluationState): void {
    if (state.request.signal?.aborted === true) throw new SourceRuleError('cancelled', '规则求值已取消')
    state.budget.steps += 1
    if (state.budget.steps > this.maxSteps) throw new SourceRuleError('failed', '规则求值步数超过限制')
  }
}
