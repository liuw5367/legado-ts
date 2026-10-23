import { compileRule } from './compiler.ts'
import { compileSourcePattern, replaceWithJavaReplacement } from './pattern-guard.ts'
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
  ArchiveEntry,
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
  aad?: unknown
  authTagLength?: unknown
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
  oaepHash?: unknown
  oaepMgfHash?: unknown
  oaepLabel?: unknown
  signature?: unknown
  usePublicKey?: unknown
  useCache?: unknown
  timeoutMs?: unknown
  nanos?: unknown
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

/** Android 相对缓存目录文件 API 的受控宿主端口。路径解析和归档预算由宿主负责；请求型操作可从 input.budget 继承当前脚本请求预算。 */
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
  /** Java byte-stream compression entry points; the core never imports a platform zlib implementation. */
  compression?: {
    gzipDecode?: (value: Uint8Array, signal: AbortSignal) => Uint8Array | Promise<Uint8Array>
    /** Encode a bounded byte array for Hutool ZipUtil.gzip compatibility. */
    gzipEncode?: (value: Uint8Array, signal: AbortSignal) => Uint8Array | Promise<Uint8Array>
    inflateDecode?: (value: Uint8Array, signal: AbortSignal) => Uint8Array | Promise<Uint8Array>
    /** Decode a bounded ZIP into entries for the synchronous-looking Java ZipInputStream facade. */
    zipDecode?: (value: Uint8Array, signal: AbortSignal) => readonly ArchiveEntry[] | Promise<readonly ArchiveEntry[]>
  }
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
  /** Session identity for serializable jsLib state; never use a URL or account secret as this value. */
  jsLibSessionId?: string
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
    readNBytes: function(target, offset, length) {
      if (arguments.length === 0) return this.readAllBytes()
      const __start = offset === undefined ? 0 : Number(offset)
      const __count = length === undefined ? target.length - __start : Number(length)
      if ((!ArrayBuffer.isView(target) && !Array.isArray(target)) || !Number.isInteger(__start) || !Number.isInteger(__count) || __start < 0 || __count < 0 || __start + __count > target.length) throw new RangeError("invalid InputStream read range")
      if (__count === 0) return 0
      const __available = Math.min(__count, __bytes.length - __cursor)
      if (__available <= 0) return 0
      for (let __index = 0; __index < __available; __index++) target[__start + __index] = __bytes[__cursor + __index]
      __cursor += __available
      return __available
    },
    available: function() { return __bytes.length - __cursor },
    skip: function(count) {
      const __count = Math.max(0, Math.min(__bytes.length - __cursor, Math.trunc(Number(count) || 0)))
      __cursor += __count
      return __count
    },
    skipNBytes: function(count) {
      const __count = Number(count)
      if (!Number.isInteger(__count) || __count < 0) throw new RangeError("skipNBytes count must be non-negative")
      if (__count > __bytes.length - __cursor) { __cursor = __bytes.length; throw new Error("EOF while skipping bytes") }
      __cursor += __count
    },
    transferTo: function(output) {
      if (output === null || typeof output?.write !== "function") throw new TypeError("OutputStream is required")
      const __remaining = __bytes.length - __cursor
      if (__remaining > 0) output.write(__bytes, __cursor, __remaining)
      __cursor = __bytes.length
      return __remaining
    },
    mark: function() { __mark = __cursor },
    reset: function() { __cursor = __mark },
    markSupported: function() { return true },
    close: function() {},
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
  const inputEntries = () => {
    if (input !== null && typeof input === "object" && typeof input.entrySet === "function") {
      const entries = input.entrySet()
      const iterator = entries?.iterator?.()
      const result = []
      if (iterator) while (iterator.hasNext()) {
        const entry = iterator.next()
        const key = typeof entry?.getKey === "function" ? entry.getKey() : entry?.key
        const value = typeof entry?.getValue === "function" ? entry.getValue() : entry?.value
        result.push([key, value])
      }
      return result
    }
    return input !== null && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : []
  }
  for (const [key, value] of inputEntries()) assign(key, value)
  const keyOf = (key) => String(key)
  const mapEntry = (key) => ({ getKey: () => key, getValue: () => target[key], setValue: (next) => { const previous = target[key]; assign(key, next); return previous } })
  Object.defineProperties(target, {
    get: { value: (key) => { const name = keyOf(key); return Object.prototype.hasOwnProperty.call(target, name) ? target[name] : null } },
    getOrDefault: { value: (key, fallback) => { const name = keyOf(key); return Object.prototype.hasOwnProperty.call(target, name) ? target[name] : fallback } },
    put: { value: (key, value) => { const name = keyOf(key); const previous = Object.prototype.hasOwnProperty.call(target, name) ? target[name] : null; assign(name, value); return previous } },
    putIfAbsent: { value: (key, value) => { const name = keyOf(key); const exists = Object.prototype.hasOwnProperty.call(target, name); const previous = exists ? target[name] : null; if (!exists || previous === null) assign(name, value); return previous } },
    putAll: { value: (value) => { if (value !== null && typeof value === "object" && typeof value.entrySet === "function") { const entries = value.entrySet(); const iterator = entries?.iterator?.(); if (iterator) while (iterator.hasNext()) { const entry = iterator.next(); const key = typeof entry?.getKey === "function" ? entry.getKey() : entry?.key; const item = typeof entry?.getValue === "function" ? entry.getValue() : entry?.value; assign(key, item) } } else if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) assign(key, item); return target } },
    remove: { value: function(key, expected) { const name = keyOf(key); const exists = Object.prototype.hasOwnProperty.call(target, name); const previous = exists ? target[name] : null; if (arguments.length > 1) { if (!exists || !Object.is(previous, expected)) return false; delete target[name]; return true } delete target[name]; return previous } },
    replace: { value: function(key, oldOrValue, next) { const name = keyOf(key); const exists = Object.prototype.hasOwnProperty.call(target, name); const previous = exists ? target[name] : null; if (arguments.length > 2) { if (!exists || !Object.is(previous, oldOrValue)) return false; assign(name, next); return true } if (!exists) return previous; assign(name, oldOrValue); return previous } },
    replaceAll: { value: (callback) => { if (typeof callback !== "function") throw new TypeError("Map replaceAll callback must be a function"); for (const [key, value] of Object.entries(target)) assign(key, callback(key, value, target)); return undefined } },
    computeIfAbsent: { value: (key, callback) => { if (typeof callback !== "function") throw new TypeError("Map computeIfAbsent callback must be a function"); const name = keyOf(key); const previous = target[name]; if (previous !== undefined && previous !== null) return previous; const next = callback(key); if (next !== undefined && next !== null) assign(name, next); return next } },
    computeIfPresent: { value: (key, callback) => { if (typeof callback !== "function") throw new TypeError("Map computeIfPresent callback must be a function"); const name = keyOf(key); const previous = Object.prototype.hasOwnProperty.call(target, name) ? target[name] : null; if (previous === null || previous === undefined) return null; const next = callback(key, previous); if (next === undefined || next === null) delete target[name]; else assign(name, next); return next } },
    merge: { value: (key, value, callback) => { if (typeof callback !== "function") throw new TypeError("Map merge callback must be a function"); const name = keyOf(key); const previous = target[name]; if (previous === undefined || previous === null) { assign(name, value); return value } const next = callback(previous, value); if (next === undefined || next === null) delete target[name]; else assign(name, next); return next } },
    clear: { value: () => { for (const key of Object.keys(target)) delete target[key] } },
    containsKey: { value: (key) => Object.prototype.hasOwnProperty.call(target, keyOf(key)) },
    containsValue: { value: (value) => Object.values(target).some((item) => Object.is(item, value)) },
    keySet: { value: () => legadoListView(() => Object.keys(target), undefined, undefined, (index) => { const keys = Object.keys(target); if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= keys.length) throw new RangeError("List index out of bounds"); const key = keys[Number(index)]; delete target[key]; return key }, () => { for (const key of Object.keys(target)) delete target[key] }, undefined, false) },
    values: { value: () => legadoListView(() => Object.keys(target).map((key) => target[key]), (index, value) => { const keys = Object.keys(target); if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= keys.length) throw new RangeError("List index out of bounds"); const key = keys[Number(index)]; const previous = target[key]; assign(key, value); return previous }, undefined, (index) => { const keys = Object.keys(target); if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= keys.length) throw new RangeError("List index out of bounds"); const key = keys[Number(index)]; const previous = target[key]; delete target[key]; return previous }, () => { for (const key of Object.keys(target)) delete target[key] }, undefined, false) },
    entrySet: { value: () => legadoListView(() => Object.keys(target).map(mapEntry), undefined, undefined, (index) => { const keys = Object.keys(target); if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= keys.length) throw new RangeError("List index out of bounds"); const key = keys[Number(index)]; const entry = mapEntry(key); delete target[key]; return entry }, () => { for (const key of Object.keys(target)) delete target[key] }, (left, right) => { const leftKey = typeof left?.getKey === "function" ? left.getKey() : left?.key; const rightKey = typeof right?.getKey === "function" ? right.getKey() : right?.key; if (leftKey === undefined || rightKey === undefined || String(leftKey) !== String(rightKey)) return false; const leftValue = typeof left?.getValue === "function" ? left.getValue() : left?.value; const rightValue = typeof right?.getValue === "function" ? right.getValue() : right?.value; return Object.is(leftValue, rightValue) }, false) },
    size: { value: () => Object.keys(target).length },
    isEmpty: { value: () => Object.keys(target).length === 0 },
    forEach: { value: (callback) => { if (typeof callback === "function") for (const [key, value] of Object.entries(target)) callback(key, value, target) } },
  })
  return target
}
const legadoListView = (read, writeAt, insertAt, removeAt, clearView, equals, removeByIndex = true) => {
  const target = []
  const snapshot = () => { const value = read(); return Array.isArray(value) ? value.slice() : typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value) ? Array.from(value) : value?.toArray?.() ?? [] }
  const isIndex = (value) => typeof value === "number" && Number.isInteger(value)
  const indexOfValue = (value) => { const values = snapshot(); for (let index = 0; index < values.length; index++) if (equals ? equals(values[index], value) : Object.is(values[index], value)) return index; return -1 }
  const unsupported = () => { throw new Error("Unsupported collection view operation") }
  const at = (index) => { const values = snapshot(); const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= values.length) throw new RangeError("List index out of bounds"); return values[position] }
  const replace = (index, value) => { if (!writeAt) return unsupported(); return writeAt(Number(index), value) }
  const insert = (index, value) => { if (!insertAt) return unsupported(); return insertAt(Number(index), value) }
  const erase = (index) => { if (!removeAt) return unsupported(); return removeAt(Number(index)) }
  Object.defineProperties(target, {
    get: { value: at },
    set: { value: (index, value) => { const previous = at(index); replace(index, value); return previous } },
    size: { value: () => snapshot().length },
    isEmpty: { value: () => snapshot().length === 0 },
    contains: { value: (value) => indexOfValue(value) >= 0 },
    indexOf: { value: indexOfValue },
    toArray: { value: () => snapshot() },
    add: { value: function(indexOrValue, value) { if (arguments.length > 1) { const index = Number(indexOrValue); const length = snapshot().length; if (!Number.isInteger(index) || index < 0 || index > length) throw new RangeError("List index out of bounds"); insert(index, value); return true } insert(snapshot().length, indexOrValue); return true } },
    addAll: { value: (indexOrValues, values) => { const items = values !== undefined ? (values?.toArray?.() ?? values) : (indexOrValues?.toArray?.() ?? indexOrValues); if (!Array.isArray(items)) return false; const index = values !== undefined ? Number(indexOrValues) : snapshot().length; const length = snapshot().length; if (!Number.isInteger(index) || index < 0 || index > length) throw new RangeError("List index out of bounds"); for (let offset = 0; offset < items.length; offset++) insert(index + offset, items[offset]); return items.length > 0 } },
    remove: { value: (value) => { const indexed = removeByIndex && isIndex(value); const index = indexed ? Number(value) : indexOfValue(value); if (index < 0 || index >= snapshot().length) { if (indexed) throw new RangeError("List index out of bounds"); return false } const removed = erase(index); return indexed ? removed : true } },
    removeAt: { value: (index) => erase(Number(index)) },
    containsAll: { value: (values) => { const items = values?.toArray?.() ?? values; return Array.isArray(items) && items.every((value) => indexOfValue(value) >= 0) } },
    removeAll: { value: (values) => { const items = values?.toArray?.() ?? values; if (!Array.isArray(items)) return false; let changed = false; const current = snapshot(); for (let index = current.length - 1; index >= 0; index--) if (items.some((value) => equals ? equals(current[index], value) : Object.is(current[index], value))) { erase(index); changed = true } return changed } },
    retainAll: { value: (values) => { const items = values?.toArray?.() ?? values; if (!Array.isArray(items)) return false; let changed = false; const current = snapshot(); for (let index = current.length - 1; index >= 0; index--) if (!items.some((value) => equals ? equals(value, current[index]) : Object.is(value, current[index]))) { erase(index); changed = true } return changed } },
    lastIndexOf: { value: (value) => { const values = snapshot(); for (let index = values.length - 1; index >= 0; index--) if (equals ? equals(values[index], value) : Object.is(values[index], value)) return index; return -1 } },
    subList: { value: (from, to) => { const start = Number(from); const end = Number(to); const length = snapshot().length; if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) throw new RangeError("List index out of bounds"); let viewLength = end - start; return legadoListView(() => snapshot().slice(start, start + viewLength), writeAt ? (index, value) => writeAt(start + index, value) : undefined, insertAt ? (index, value) => { insertAt(start + index, value); viewLength++; } : undefined, removeAt ? (index) => { const result = removeAt(start + index); viewLength--; return result } : undefined, removeAt ? () => { for (let index = viewLength - 1; index >= 0; index--) removeAt(start + index); viewLength = 0 } : undefined, equals, removeByIndex) } },
    clear: { value: () => { if (clearView) return clearView(); for (let index = snapshot().length - 1; index >= 0; index--) erase(index) } },
    iterator: { value: () => { let index = 0; let canRemove = false; return { hasNext: () => index < snapshot().length, next: () => { const values = snapshot(); if (index >= values.length) throw new RangeError("No such element"); canRemove = true; return values[index++] }, remove: () => { if (!canRemove) throw new Error("Illegal iterator state"); erase(--index); canRemove = false } } } },
    listIterator: { value: (start) => { let cursor = start === undefined ? 0 : Number(start); let last = -1; if (!Number.isInteger(cursor) || cursor < 0 || cursor > snapshot().length) throw new RangeError("List iterator index out of bounds"); const iterator = { hasNext: () => cursor < snapshot().length, next: () => { const values = snapshot(); if (cursor >= values.length) throw new RangeError("No such element"); last = cursor; return values[cursor++] }, hasPrevious: () => cursor > 0, previous: () => { if (cursor <= 0) throw new RangeError("No such element"); last = --cursor; return snapshot()[cursor] }, nextIndex: () => cursor, previousIndex: () => cursor - 1, remove: () => { if (last < 0) throw new Error("Illegal iterator state"); erase(last); if (last < cursor) cursor--; last = -1 }, set: (value) => { if (last < 0) throw new Error("Illegal iterator state"); replace(last, value) }, add: (value) => { insert(cursor++, value); last = -1 } }; return iterator } },
    forEach: { value: (callback) => { if (typeof callback === "function") snapshot().forEach(callback); return undefined } },
    removeIf: { value: (predicate) => { if (typeof predicate !== "function") return false; let changed = false; for (let index = snapshot().length - 1; index >= 0; index--) if (predicate(snapshot()[index], index, target)) { erase(index); changed = true } return changed } },
    sort: { value: (comparator) => { const values = snapshot().sort(typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : undefined); for (let index = 0; index < values.length; index++) replace(index, values[index]); return target } },
    toString: { value: () => "[" + snapshot().map((value) => value === null || value === undefined ? "null" : String(value)).join(", ") + "]" },
  })
  const indexProperty = (property) => typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)
  return new Proxy(target, {
    get: (object, property, receiver) => indexProperty(property) ? snapshot()[Number(property)] : property === "length" ? snapshot().length : Reflect.get(object, property, receiver),
    set: (object, property, value, receiver) => { if (indexProperty(property)) { replace(Number(property), value); return true } return Reflect.set(object, property, value, receiver) },
    ownKeys: (object) => [...Array.from({ length: snapshot().length }, (_, index) => String(index)), ...Reflect.ownKeys(object).filter((property) => property !== "length" && !indexProperty(property)), "length"],
    getOwnPropertyDescriptor: (object, property) => indexProperty(property) && Number(property) < snapshot().length ? { configurable: true, enumerable: true, value: snapshot()[Number(property)], writable: false } : Reflect.getOwnPropertyDescriptor(object, property),
  })
}
const legadoList = (input) => {
  const target = Array.isArray(input) ? input.slice() : input?.toArray?.() ?? []
  const itemsOf = (values) => Array.isArray(values) ? values : values?.toArray?.() ?? []
  const isIndex = (value) => typeof value === "number" && Number.isInteger(value)
  Object.defineProperties(target, {
    get: { value: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= target.length) throw new RangeError("List index out of bounds"); return target[position] } },
    set: { value: (index, value) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= target.length) throw new RangeError("List index out of bounds"); const previous = target[position]; target[position] = value; return previous } },
    size: { value: () => target.length },
    isEmpty: { value: () => target.length === 0 },
    contains: { value: (value) => target.includes(value) },
    indexOf: { value: (value) => { for (let index = 0; index < target.length; index++) if (target[index] === value) return index; return -1 } },
    toArray: { value: () => target.slice() },
    add: { value: function(indexOrValue, value) { if (arguments.length > 1) { const index = Number(indexOrValue); if (!Number.isInteger(index) || index < 0 || index > target.length) throw new RangeError("List index out of bounds"); target.splice(index, 0, value); return true } target.push(indexOrValue); return true } },
    addAll: { value: (indexOrValues, values) => { const items = values !== undefined ? itemsOf(values) : itemsOf(indexOrValues); if (values !== undefined) { const index = Number(indexOrValues); if (!Number.isInteger(index) || index < 0 || index > target.length) throw new RangeError("List index out of bounds"); target.splice(index, 0, ...items) } else target.push(...items); return items.length > 0 } },
    remove: { value: (value) => { if (isIndex(value)) { const index = Number(value); if (index < 0 || index >= target.length) throw new RangeError("List index out of bounds"); return target.splice(index, 1)[0] } let index = -1; for (let position = 0; position < target.length; position++) if (target[position] === value) { index = position; break } return index < 0 ? false : (target.splice(index, 1), true) } },
    removeAt: { value: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= target.length) throw new RangeError("List index out of bounds"); return target.splice(position, 1)[0] } },
    containsAll: { value: (values) => itemsOf(values).every((value) => target.includes(value)) },
    removeAll: { value: (values) => { const items = itemsOf(values); const before = target.length; for (let index = target.length - 1; index >= 0; index -= 1) if (items.includes(target[index])) target.splice(index, 1); return target.length !== before } },
    retainAll: { value: (values) => { const items = itemsOf(values); const before = target.length; for (let index = target.length - 1; index >= 0; index -= 1) if (!items.includes(target[index])) target.splice(index, 1); return target.length !== before } },
    lastIndexOf: { value: (value) => { for (let index = target.length - 1; index >= 0; index--) if (target[index] === value) return index; return -1 } },
    subList: { value: (from, to) => { const start = Number(from); const end = Number(to); if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > target.length) throw new RangeError("List index out of bounds"); let viewLength = end - start; return legadoListView(() => target.slice(start, start + viewLength), (index, value) => { target[start + index] = value; return value }, (index, value) => { target.splice(start + index, 0, value); viewLength++ }, (index) => { const result = target.splice(start + index, 1)[0]; viewLength--; return result }, () => { target.splice(start, viewLength); viewLength = 0 }) } },
    clear: { value: () => { target.length = 0 } },
    iterator: { value: () => { let index = 0; let canRemove = false; return { hasNext: () => index < target.length, next: () => { if (index >= target.length) throw new RangeError("No such element"); canRemove = true; return target[index++] }, remove: () => { if (!canRemove) throw new Error("Illegal iterator state"); target.splice(--index, 1); canRemove = false } } } },
    listIterator: { value: (start) => { let cursor = start === undefined ? 0 : Number(start); let last = -1; if (!Number.isInteger(cursor) || cursor < 0 || cursor > target.length) throw new RangeError("List iterator index out of bounds"); const iterator = { hasNext: () => cursor < target.length, next: () => { if (cursor >= target.length) throw new RangeError("No such element"); last = cursor; return target[cursor++] }, hasPrevious: () => cursor > 0, previous: () => { if (cursor <= 0) throw new RangeError("No such element"); last = --cursor; return target[cursor] }, nextIndex: () => cursor, previousIndex: () => cursor - 1, remove: () => { if (last < 0) throw new Error("Illegal iterator state"); target.splice(last, 1); if (last < cursor) cursor -= 1; last = -1 }, set: (value) => { if (last < 0) throw new Error("Illegal iterator state"); target[last] = value }, add: (value) => { target.splice(cursor++, 0, value); last = -1 } }; return iterator } },
    forEach: { value: (callback) => { if (typeof callback === "function") Array.prototype.forEach.call(target, callback); return undefined } },
    removeIf: { value: (predicate) => { if (typeof predicate !== "function") return false; const before = target.length; for (let index = target.length - 1; index >= 0; index -= 1) if (predicate(target[index], index, target)) target.splice(index, 1); return target.length !== before } },
    sort: { value: (comparator) => { target.sort(typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : undefined); return target } },
    toString: { value: () => "[" + target.map((value) => value === null || value === undefined ? "null" : String(value)).join(", ") + "]" },
  })
  return target
}
const legadoJavaOptional = (value, present) => ({ isPresent: () => present, isEmpty: () => !present, get: () => { if (!present) throw new RangeError("No such element") ; return value }, orElse: (fallback) => present ? value : fallback, orElseGet: (callback) => present ? value : callback(), ifPresent: (callback) => { if (present && typeof callback === "function") callback(value); return undefined }, toString: () => present ? "Optional[" + String(value) + "]" : "Optional.empty" })
const legadoJavaStream = (input) => {
  const target = legadoList(input)
  const values = () => target.slice()
  Object.defineProperties(target, {
    count: { value: () => target.length },
    forEachOrdered: { value: (callback) => { if (typeof callback === "function") target.forEach(callback); return undefined } },
    map: { value: (callback) => { if (typeof callback !== "function") throw new TypeError("Stream mapper must be a function"); return legadoJavaStream(values().map(callback)) } },
    filter: { value: (callback) => { if (typeof callback !== "function") throw new TypeError("Stream predicate must be a function"); return legadoJavaStream(values().filter(callback)) } },
    flatMap: { value: (callback) => { if (typeof callback !== "function") throw new TypeError("Stream mapper must be a function"); const result = []; for (const value of values()) { const mapped = callback(value); if (mapped !== null && mapped !== undefined) result.push(...(Array.isArray(mapped) ? mapped : mapped.toArray?.() ?? [])) } return legadoJavaStream(result) } },
    distinct: { value: () => legadoJavaStream(values().filter((value, index, all) => all.findIndex((candidate) => Object.is(candidate, value)) === index)) },
    sorted: { value: (comparator) => { const result = values().sort(typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : undefined); return legadoJavaStream(result) } },
    limit: { value: (count) => { const size = Number(count); if (!Number.isInteger(size) || size < 0) throw new RangeError("Stream limit out of bounds"); return legadoJavaStream(values().slice(0, size)) } },
    skip: { value: (count) => { const size = Number(count); if (!Number.isInteger(size) || size < 0) throw new RangeError("Stream skip out of bounds"); return legadoJavaStream(values().slice(size)) } },
    peek: { value: (callback) => { if (typeof callback !== "function") throw new TypeError("Stream peek must be a function"); target.forEach(callback); return target } },
    findFirst: { value: () => legadoJavaOptional(target[0], target.length > 0) },
    findAny: { value: () => legadoJavaOptional(target[0], target.length > 0) },
    anyMatch: { value: (callback) => typeof callback === "function" && target.some(callback) },
    allMatch: { value: (callback) => typeof callback === "function" && target.every(callback) },
    noneMatch: { value: (callback) => typeof callback === "function" && target.every((value, index, all) => !callback(value, index, all)) },
    min: { value: (comparator) => { if (target.length === 0) return legadoJavaOptional(undefined, false); const compare = typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : (left, right) => left < right ? -1 : left > right ? 1 : 0; return legadoJavaOptional(target.slice(1).reduce((best, value) => compare(value, best) < 0 ? value : best, target[0]), true) } },
    max: { value: (comparator) => { if (target.length === 0) return legadoJavaOptional(undefined, false); const compare = typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : (left, right) => left < right ? -1 : left > right ? 1 : 0; return legadoJavaOptional(target.slice(1).reduce((best, value) => compare(value, best) > 0 ? value : best, target[0]), true) } },
    reduce: { value: function(identityOrCallback, callback) { if (typeof identityOrCallback !== "function" && typeof callback === "function") return Array.prototype.reduce.call(target, callback, identityOrCallback); if (typeof identityOrCallback !== "function") throw new TypeError("Stream reducer must be a function"); return target.length === 0 ? legadoJavaOptional(undefined, false) : legadoJavaOptional(target.slice(1).reduce(identityOrCallback, target[0]), true) } },
    toList: { value: () => legadoList(values()) },
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
const legadoJavaReplacement = (replacement, match) => {
  const text = String(replacement ?? "")
  const groupCount = Math.max(0, match.length - 1)
  let result = ""
  for (let index = 0; index < text.length; index++) {
    const current = text[index]
    if (current === "\\") {
      if (index + 1 >= text.length) throw new Error("Illegal group reference")
      result += text[++index]
      continue
    }
    if (current !== "$") {
      result += current
      continue
    }
    if (text[index + 1] === "{") {
      const close = text.indexOf("}", index + 2)
      if (close < 0 || close === index + 2) throw new Error("Illegal group reference")
      const name = text.slice(index + 2, close)
      if (match.groups === undefined || !Object.prototype.hasOwnProperty.call(match.groups, name)) throw new Error("No group with name <" + name + ">")
      result += match.groups[name] ?? ""
      index = close
      continue
    }
    if (!/\d/u.test(text[index + 1] ?? "")) throw new Error("Illegal group reference")
    let groupIndex = Number(text[++index])
    let cursor = index + 1
    while (cursor < text.length && /\d/u.test(text[cursor])) {
      const candidate = groupIndex * 10 + Number(text[cursor])
      if (candidate > groupCount) break
      groupIndex = candidate
      index = cursor
      cursor += 1
    }
    if (groupIndex > groupCount) throw new Error("No group " + groupIndex)
    result += match[groupIndex] ?? ""
  }
  return result
}
const legadoJavaReplace = (input, regex, replacement, replaceAll) => {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g"
  const matcher = new RegExp(regex.source, flags)
  let result = ""
  let cursor = 0
  let match
  while ((match = matcher.exec(input)) !== null) {
    result += input.slice(cursor, match.index) + legadoJavaReplacement(replacement, match)
    cursor = match.index + match[0].length
    if (!replaceAll) break
    if (match[0].length === 0) {
      if (match.index >= input.length) break
      matcher.lastIndex = match.index + 1
    }
  }
  return result + input.slice(cursor)
}
const legadoJavaSplit = (text, separator, limit) => {
  const max = limit === undefined ? 0 : Number(limit)
  if (max === 1) return [text]
  const regex = legadoJavaRegex(separator)
  let values = text.split(regex)
  if (max > 0 && values.length > max) values = values.slice(0, max - 1).concat(values.slice(max - 1).join(String(separator)))
  if (max === 0) while (values.length > 0 && values[values.length - 1] === "") values.pop()
  return values
}
const legadoJavaCodePoint = (text, index) => {
  const code = text.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) return { value: (code - 0xd800) * 0x400 + low - 0xdc00 + 0x10000, width: 2 }
  }
  return { value: code, width: 1 }
}
const legadoJavaStringIndex = (text, index, allowEnd = false) => {
  const value = Number(index)
  const maximum = allowEnd ? text.length : text.length - 1
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new RangeError("String index out of bounds")
  return value
}
const legadoJavaCodePointCount = (text, begin, end) => {
  const start = Number(begin)
  const finish = Number(end)
  if (!Number.isInteger(start) || !Number.isInteger(finish) || start < 0 || finish < start || finish > text.length) throw new RangeError("String index out of bounds")
  let count = 0
  for (let index = start; index < finish; count += 1) index += legadoJavaCodePoint(text, index).width
  return count
}
const legadoJavaOffsetByCodePoints = (text, index, offset) => {
  let position = legadoJavaStringIndex(text, index, true)
  let remaining = Number(offset)
  if (!Number.isInteger(remaining)) throw new RangeError("Invalid code point offset")
  if (remaining >= 0) {
    while (remaining > 0) {
      if (position >= text.length) throw new RangeError("String index out of bounds")
      position += legadoJavaCodePoint(text, position).width
      remaining -= 1
    }
    return position
  }
  while (remaining < 0) {
    if (position <= 0) throw new RangeError("String index out of bounds")
    position -= 1
    const code = text.charCodeAt(position)
    if (code >= 0xdc00 && code <= 0xdfff && position > 0) {
      const high = text.charCodeAt(position - 1)
      if (high >= 0xd800 && high <= 0xdbff) position -= 1
    }
    remaining += 1
  }
  return position
}
const legadoJavaLines = (text) => {
  if (text.length === 0) return []
  const lines = text.split(/\r\n|[\n\r]/u)
  if (text.endsWith("\n") || text.endsWith("\r")) lines.pop()
  return lines.map((line) => legadoJavaString(line))
}
const legadoJavaLeadingWhitespaceEnd = (text) => {
  let index = 0
  while (index < text.length) {
    const point = legadoJavaCodePoint(text, index)
    if (!legadoJavaWhitespace(point.value)) break
    index += point.width
  }
  return index
}
const legadoJavaRemoveLeadingWhitespace = (text, amount) => {
  let index = 0
  let remaining = amount
  while (index < text.length && remaining > 0) {
    const point = legadoJavaCodePoint(text, index)
    if (!legadoJavaWhitespace(point.value)) break
    index += point.width
    remaining -= 1
  }
  return text.slice(index)
}
const legadoJavaIndent = (text, amount) => {
  const value = Number(amount)
  if (!Number.isInteger(value)) throw new RangeError("Invalid indentation")
  const normalized = text.replace(/\r\n?|\n/gu, "\n")
  const lines = normalized.split("\n")
  if (normalized.endsWith("\n")) lines.pop()
  if (value > 0 && (value > 16 * 1024 * 1024 || lines.length > Math.floor((16 * 1024 * 1024 - text.length) / value))) throw new RangeError("String indent exceeds runtime limit")
  const prefix = value > 0 ? " ".repeat(value) : ""
  const remove = value < 0 ? -value : 0
  const result = lines.map((line) => value >= 0 ? prefix + line : legadoJavaRemoveLeadingWhitespace(line, remove))
  return result.join("\n") + "\n"
}
const legadoJavaStripIndent = (text) => {
  const normalized = text.replace(/\r\n?|\n/gu, "\n")
  const hadTerminator = normalized.endsWith("\n")
  const lines = normalized.split("\n")
  if (hadTerminator) lines.pop()
  const indents = lines.filter((line) => legadoJavaLeadingWhitespaceEnd(line) < line.length).map((line) => Array.from(line.slice(0, legadoJavaLeadingWhitespaceEnd(line))).length)
  const minimum = indents.length === 0 ? 0 : Math.min(...indents)
  const result = lines.map((line) => { const leading = legadoJavaLeadingWhitespaceEnd(line); return leading === line.length ? "" : legadoJavaRemoveLeadingWhitespace(line, minimum) })
  return result.join("\n") + (hadTerminator ? "\n" : "")
}
const legadoJavaTranslateEscapes = (text) => {
  const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", s: " ", '"': '"', "'": "'", "\\": "\\" }
  let result = ""
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") { result += text[index]; continue }
    if (index + 1 >= text.length) throw new Error("Invalid escape sequence")
    const next = text[++index]
    if (Object.prototype.hasOwnProperty.call(simple, next)) { result += simple[next]; continue }
    if (next === "\n") continue
    if (next === "\r") { if (text[index + 1] === "\n") index += 1; continue }
    if (/^[0-7]$/u.test(next)) {
      let digits = next
      const maximum = next <= "3" ? 3 : 2
      while (digits.length < maximum && index + 1 < text.length && /^[0-7]$/u.test(text[index + 1])) digits += text[++index]
      result += String.fromCharCode(Number.parseInt(digits, 8)); continue
    }
    throw new Error("Invalid escape sequence: " + next)
  }
  return result
}
const legadoJavaWhitespace = (codePoint) => codePoint === 0x20 || codePoint >= 0x09 && codePoint <= 0x0d || codePoint >= 0x1c && codePoint <= 0x1f || codePoint === 0x1680 || codePoint >= 0x2000 && codePoint <= 0x2006 || codePoint >= 0x2008 && codePoint <= 0x200a || codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x205f || codePoint === 0x3000
const legadoJavaStrip = (text, leading, trailing) => {
  let start = 0
  let end = text.length
  if (leading) while (start < end && legadoJavaWhitespace(legadoJavaCodePoint(text, start).value)) start += legadoJavaCodePoint(text, start).width
  if (trailing) while (end > start) { const position = end - 1; const code = text.charCodeAt(position); const codePoint = code >= 0xdc00 && code <= 0xdfff && position > 0 && text.charCodeAt(position - 1) >= 0xd800 && text.charCodeAt(position - 1) <= 0xdbff ? { value: (text.charCodeAt(position - 1) - 0xd800) * 0x400 + code - 0xdc00 + 0x10000, width: 2 } : { value: code, width: 1 }; if (!legadoJavaWhitespace(codePoint.value)) break; end -= codePoint.width }
  return text.slice(start, end)
}
const legadoJavaSubstring = (text, start, end) => {
  const from = Number(start)
  const to = end === undefined ? text.length : Number(end)
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || from > to) throw new RangeError("String index out of bounds")
  return legadoJavaString(text.slice(from, to))
}
const legadoJavaStringHashCode = (text) => { let hash = 0; for (let index = 0; index < text.length; index += 1) hash = ((hash * 31) + text.charCodeAt(index)) | 0; return hash }
const legadoJavaRegionMatches = (text, ignoreCase, thisOffset, other, otherOffset, length) => {
  if (other === null || other === undefined) return false
  const leftOffset = Number(thisOffset)
  const rightOffset = Number(otherOffset)
  const count = Number(length)
  if (!Number.isInteger(leftOffset) || !Number.isInteger(rightOffset) || !Number.isInteger(count) || leftOffset < 0 || rightOffset < 0 || count < 0 || leftOffset + count > text.length) return false
  const value = String(other)
  if (rightOffset + count > value.length) return false
  const left = text.slice(leftOffset, leftOffset + count)
  const right = value.slice(rightOffset, rightOffset + count)
  return ignoreCase === true ? left.toLowerCase() === right.toLowerCase() : left === right
}
const legadoJavaString = (input) => {
  const text = String(input ?? "")
  const value = {}
  Object.defineProperties(value, {
    getBytes: { value: (charset) => request({ kind: "encode-bytes", value: text, charset: charset === undefined ? "UTF-8" : String(charset) }) },
    length: { value: () => text.length },
    isEmpty: { value: () => text.length === 0 },
    equals: { value: (other) => other !== null && other !== undefined && text === String(other) },
    equalsIgnoreCase: { value: (other) => other !== null && other !== undefined && text.toLowerCase() === String(other).toLowerCase() },
    contains: { value: (part) => text.includes(String(part ?? "")) },
    startsWith: { value: (part, offset) => part !== null && part !== undefined && text.startsWith(String(part), offset === undefined ? 0 : Math.max(0, Number(offset))) },
    endsWith: { value: (part) => part !== null && part !== undefined && text.endsWith(String(part)) },
    substring: { value: (start, end) => legadoJavaSubstring(text, start, end) },
    subSequence: { value: (start, end) => legadoJavaSubstring(text, start, end) },
    charAt: { value: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= text.length) throw new RangeError("String index out of bounds"); return text.charAt(position) } },
    indexOf: { value: (part, start) => { const from = start === undefined ? 0 : Number(start); if (!Number.isInteger(from)) throw new RangeError("String index out of bounds"); const position = Math.max(0, from); if (typeof part === "number") { if (!Number.isInteger(part) || part < 0 || part > 0x10ffff) return -1; return text.indexOf(String.fromCodePoint(part), position) } return part === null || part === undefined ? -1 : text.indexOf(String(part), position) } },
    lastIndexOf: { value: (part, start) => { const requested = start === undefined ? text.length : Number(start); if (!Number.isInteger(requested)) throw new RangeError("String index out of bounds"); if (requested < 0) return -1; const from = Math.min(text.length, requested); if (typeof part === "number") { const codePoint = Number(part); if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return -1; return text.lastIndexOf(String.fromCodePoint(codePoint), from) } return text.lastIndexOf(String(part ?? ""), from) } },
    codePointAt: { value: (index) => legadoJavaCodePoint(text, legadoJavaStringIndex(text, index)).value },
    codePointBefore: { value: (index) => { const position = legadoJavaStringIndex(text, index, true); if (position === 0) throw new RangeError("String index out of bounds"); const previous = position - 1; const low = text.charCodeAt(previous); if (low >= 0xdc00 && low <= 0xdfff && previous > 0) { const high = text.charCodeAt(previous - 1); if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + low - 0xdc00 + 0x10000 } return low } },
    codePointCount: { value: (begin, end) => legadoJavaCodePointCount(text, begin, end) },
    offsetByCodePoints: { value: (index, offset) => legadoJavaOffsetByCodePoints(text, index, offset) },
    getChars: { value: (begin, end, destination, destinationBegin) => { const start = Number(begin); const finish = Number(end); const targetStart = Number(destinationBegin); if (!Number.isInteger(start) || !Number.isInteger(finish) || !Number.isInteger(targetStart) || start < 0 || finish < start || finish > text.length || targetStart < 0 || destination === null || destination === undefined || typeof destination.length !== "number" || targetStart + finish - start > destination.length) throw new RangeError("String char array range out of bounds"); const typed = typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(destination); for (let index = start; index < finish; index += 1) destination[targetStart + index - start] = typed ? text.charCodeAt(index) : text.charAt(index); return undefined } },
    trim: { value: () => legadoJavaString(text.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, "")) },
    strip: { value: () => legadoJavaString(legadoJavaStrip(text, true, true)) },
    stripLeading: { value: () => legadoJavaString(legadoJavaStrip(text, true, false)) },
    stripTrailing: { value: () => legadoJavaString(legadoJavaStrip(text, false, true)) },
    isBlank: { value: () => legadoJavaStrip(text, true, true).length === 0 },
    repeat: { value: (count) => { const times = Number(count); if (!Number.isInteger(times) || times < 0) throw new RangeError("Invalid repeat count"); if (text.length > 0 && text.length * times > 16 * 1024 * 1024) throw new RangeError("String repeat exceeds runtime limit"); return legadoJavaString(text.repeat(times)) } },
    contentEquals: { value: (other) => other !== null && other !== undefined && text === String(other) },
    lines: { value: () => legadoJavaStream(legadoJavaLines(text)) },
    chars: { value: () => legadoJavaStream(Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))) },
    codePoints: { value: () => { const points = []; for (let index = 0; index < text.length;) { const point = legadoJavaCodePoint(text, index); points.push(point.value); index += point.width } return legadoJavaStream(points) } },
    indent: { value: (amount) => legadoJavaString(legadoJavaIndent(text, amount)) },
    stripIndent: { value: () => legadoJavaString(legadoJavaStripIndent(text)) },
    translateEscapes: { value: () => legadoJavaString(legadoJavaTranslateEscapes(text)) },
    transform: { value: (callback) => { if (typeof callback !== "function") throw new TypeError("String.transform requires a function"); return callback(legadoJavaString(text)) } },
    intern: { value: () => legadoJavaString(text) },
    formatted: { value: (...args) => legadoJavaString(legadoJavaFormat(text, args)) },
    toLowerCase: { value: () => legadoJavaString(text.toLowerCase()) },
    toUpperCase: { value: () => legadoJavaString(text.toUpperCase()) },
    split: { value: (separator, limit) => legadoList(legadoJavaSplit(text, String(separator ?? ""), limit)) },
    replace: { value: (from, to) => { if (from === null || from === undefined || to === null || to === undefined) throw new TypeError("String replacement must not be null"); const source = String(from); const replacement = String(to); const result = source.length === 0 ? replacement + Array.from({ length: text.length }, (_, index) => text.charAt(index)).join(replacement) + replacement : text.split(source).join(replacement); if (result.length > 16 * 1024 * 1024) throw new RangeError("String replace exceeds runtime limit"); return legadoJavaString(result) } },
    replaceAll: { value: (pattern, replacement) => legadoJavaString(legadoJavaReplace(text, legadoJavaRegex(pattern, "g"), replacement, true)) },
    replaceFirst: { value: (pattern, replacement) => legadoJavaString(legadoJavaReplace(text, legadoJavaRegex(pattern), replacement, false)) },
    matches: { value: (pattern) => { const regex = legadoJavaRegex(pattern); const match = regex.exec(text); return match !== null && match[0] === text } },
    compareTo: { value: (other) => { const value = String(other ?? ""); const length = Math.min(text.length, value.length); for (let index = 0; index < length; index++) { const difference = text.charCodeAt(index) - value.charCodeAt(index); if (difference !== 0) return difference } return text.length - value.length } },
    compareToIgnoreCase: { value: (other) => legadoJavaString(text.toLowerCase()).compareTo(String(other ?? "").toLowerCase()) },
    concat: { value: (other) => legadoJavaString(text + String(other ?? "")) },
    // Java String.toCharArray 按 UTF-16 code unit 返回，不能使用按 Unicode code point 展开的 Array.from。
    toCharArray: { value: () => Array.from({ length: text.length }, (_, index) => text.charAt(index)) },
    regionMatches: { value: function(ignoreCase, thisOffset, other, otherOffset, length) { if (arguments.length < 5) return legadoJavaRegionMatches(text, false, ignoreCase, thisOffset, other, otherOffset); return legadoJavaRegionMatches(text, ignoreCase, thisOffset, other, otherOffset, length) } },
    hashCode: { value: () => legadoJavaStringHashCode(text) },
    toString: { value: () => text },
    toJSON: { value: () => text },
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
const legadoJavaLocaleValue = (language, country, variant) => {
  const normalizedLanguage = String(language ?? "").toLowerCase()
  const normalizedCountry = String(country ?? "").toUpperCase()
  const normalizedVariant = String(variant ?? "")
  const tag = [normalizedLanguage, normalizedCountry].filter(Boolean).join("-") + (normalizedVariant.length > 0 ? "-" + normalizedVariant : "")
  return { __legadoLocale: tag, getLanguage: () => normalizedLanguage, getCountry: () => normalizedCountry, getVariant: () => normalizedVariant, toLanguageTag: () => tag, toString: () => tag.length === 0 ? "" : tag.replaceAll("-", "_") }
}
const legadoJavaLocale = function(language, country, variant) { return legadoJavaLocaleValue(language, country, variant) }
Object.assign(legadoJavaLocale, {
  ROOT: legadoJavaLocaleValue("", ""),
  US: legadoJavaLocaleValue("en", "US"),
  UK: legadoJavaLocaleValue("en", "GB"),
  ENGLISH: legadoJavaLocaleValue("en", ""),
  CHINA: legadoJavaLocaleValue("zh", "CN"),
  CHINESE: legadoJavaLocaleValue("zh", ""),
  getDefault: () => legadoJavaLocaleValue("en", "US"),
  forLanguageTag: (tag) => { const parts = String(tag ?? "").replaceAll("_", "-").split("-"); return legadoJavaLocaleValue(parts[0] ?? "", parts[1] ?? "", parts.slice(2).join("-")) },
})
const legadoJavaFormatObjectText = (value) => value === null || value === undefined ? "null" : String(value)
const legadoJavaFormatInteger = (value, conversion) => {
  if (typeof value === "bigint") return { value, signedPrimitive: false }
  if (value !== null && typeof value === "object" && typeof value.__legadoBigInteger === "bigint") return { value: value.__legadoBigInteger, signedPrimitive: false }
  const number = Number(value?.valueOf?.() ?? value)
  if (!Number.isFinite(number) || !Number.isInteger(number)) throw new RangeError("Illegal format argument")
  const integer = BigInt(number)
  if ((conversion === "x" || conversion === "X" || conversion === "o") && number < 0) return { value: BigInt.asUintN(32, integer), signedPrimitive: true }
  return { value: integer, signedPrimitive: false }
}
const legadoJavaFormatPad = (value, width, flags) => {
  if (width === undefined || value.length >= width) return value
  const count = width - value.length
  if (flags.includes("-")) return value + " ".repeat(count)
  return " ".repeat(count) + value
}
const legadoJavaFormatNumeric = (body, negative, flags, width, prefix = "") => {
  const parenthesized = negative && flags.includes("(")
  const sign = parenthesized ? "" : negative ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : ""
  const suffix = parenthesized ? ")" : ""
  const total = sign + prefix + body + suffix
  if (width === undefined || total.length >= width) return total
  const count = width - total.length
  if (flags.includes("-")) return total + " ".repeat(count)
  if (flags.includes("0")) return sign + prefix + "0".repeat(count) + body + suffix
  return " ".repeat(count) + total
}
const legadoJavaFormatLocale = (locale) => {
  const tag = String(locale && typeof locale === "object" ? locale.__legadoLocale ?? "" : locale ?? "").toLowerCase()
  if (tag.startsWith("de") || tag.startsWith("es") || tag.startsWith("it") || tag.startsWith("pt")) return { decimal: ",", grouping: "." }
  if (tag.startsWith("fr")) return { decimal: ",", grouping: "\u202f" }
  return { decimal: ".", grouping: "," }
}
const legadoJavaFormatLocaleTag = (locale) => {
  const value = String(locale && typeof locale === "object" ? locale.__legadoLocale ?? "" : locale ?? "en-US")
  return value.replaceAll("_", "-") || "en-US"
}
const legadoJavaFormatDateValue = (value) => {
  let time
  if (value !== null && value !== undefined && typeof value.getTime === "function") time = Number(value.getTime())
  else if (typeof value === "bigint") time = Number(value)
  else if (value !== null && value !== undefined && typeof value.valueOf === "function") time = Number(value.valueOf())
  else time = Number(value)
  if (!Number.isFinite(time)) throw new RangeError("Illegal format date argument")
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) throw new RangeError("Illegal format date argument")
  return date
}
const legadoJavaFormatDate = (value, conversion, locale) => {
  const date = legadoJavaFormatDateValue(value)
  const localeTag = legadoJavaFormatLocaleTag(locale)
  const suffix = conversion[1]
  const kind = suffix
  const pad = (item, width) => String(item).padStart(width, "0")
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()
  const millis = date.getMilliseconds()
  const weekday = date.getDay()
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1
  const language = localeTag.toLowerCase().split("-")[0]
  const dayNames = language === "zh" ? ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  const dayShortNames = language === "zh" ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const monthNames = language === "zh" ? ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"] : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const monthShortNames = language === "zh" ? monthNames : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const dayName = (format) => format === "long" ? dayNames[weekday] : dayShortNames[weekday]
  const monthName = (format) => format === "long" ? monthNames[month - 1] : monthShortNames[month - 1]
  const zoneOffsetMinutes = -date.getTimezoneOffset()
  const zoneSign = zoneOffsetMinutes < 0 ? "-" : "+"
  const zoneAbsolute = Math.abs(zoneOffsetMinutes)
  const zone = zoneSign + pad(Math.floor(zoneAbsolute / 60), 2) + pad(zoneAbsolute % 60, 2)
  const zoneName = "GMT" + zone
  const hour12 = hour % 12 || 12
  const am = hour < 12
  const weekOfYear = (firstDay) => {
    const firstWeekday = new Date(year, 0, 1).getDay()
    return Math.floor((dayOfYear + 6 - ((firstWeekday - firstDay + 7) % 7)) / 7)
  }
  const isoWeekDate = new Date(year, month - 1, day + (4 - (weekday === 0 ? 7 : weekday)))
  const isoYear = isoWeekDate.getFullYear()
  const isoWeekStart = new Date(isoYear, 0, 4)
  isoWeekStart.setDate(isoWeekStart.getDate() - (isoWeekStart.getDay() === 0 ? 6 : isoWeekStart.getDay() - 1))
  const isoWeek = Math.floor((Date.UTC(isoWeekDate.getFullYear(), isoWeekDate.getMonth(), isoWeekDate.getDate()) - Date.UTC(isoWeekStart.getFullYear(), isoWeekStart.getMonth(), isoWeekStart.getDate())) / 604_800_000) + 1
  const rendered = {
    a: () => suffix === "A" ? dayName("long") : dayName("short"),
    A: () => dayName("long"),
    b: () => suffix === "B" ? monthName("long") : monthName("short"),
    B: () => monthName("long"),
    h: () => monthName("short"),
    c: () => dayName("short") + " " + monthName("short") + " " + pad(day, 2) + " " + pad(hour, 2) + ":" + pad(minute, 2) + ":" + pad(second, 2) + " " + zoneName + " " + year,
    C: () => pad(Math.floor(year / 100), 2),
    d: () => pad(day, 2),
    e: () => String(day),
    H: () => pad(hour, 2),
    I: () => pad(hour12, 2),
    k: () => String(hour),
    l: () => String(hour12),
    M: () => pad(minute, 2),
    S: () => pad(second, 2),
    L: () => pad(millis, 3),
    N: () => pad(millis, 3) + "000000",
    p: () => am ? "am" : "pm",
    Q: () => String(date.getTime()),
    s: () => String(Math.trunc(date.getTime() / 1000)),
    z: () => zone,
    Z: () => zoneName,
    Y: () => pad(year, 4),
    y: () => pad(year % 100, 2),
    G: () => String(isoYear),
    g: () => pad(isoYear % 100, 2),
    j: () => pad(dayOfYear, 3),
    m: () => pad(month, 2),
    U: () => pad(weekOfYear(0), 2),
    V: () => pad(isoWeek, 2),
    W: () => pad(weekOfYear(1), 2),
    F: () => pad(year, 4) + "-" + pad(month, 2) + "-" + pad(day, 2),
    D: () => pad(month, 2) + "/" + pad(day, 2) + "/" + pad(year % 100, 2),
    R: () => pad(hour, 2) + ":" + pad(minute, 2),
    T: () => pad(hour, 2) + ":" + pad(minute, 2) + ":" + pad(second, 2),
    r: () => pad(hour12, 2) + ":" + pad(minute, 2) + ":" + pad(second, 2) + " " + (am ? "am" : "pm"),
  }[kind]
  if (rendered === undefined) throw new Error("Unsupported String.format date conversion: " + conversion)
  const result = rendered()
  return conversion[0] === "T" ? result.toUpperCase() : result
}
const legadoJavaFormat = (format, args, locale) => {
  const text = String(format ?? "")
  const localeInfo = legadoJavaFormatLocale(locale)
  const sourceArgs = Array.isArray(args) ? args : []
  let output = ""
  let cursor = 0
  let nextArgument = 0
  let previousArgument = -1
  const append = (value) => { output += value; if (output.length > 16 * 1024 * 1024) throw new RangeError("String.format exceeds runtime limit") }
  while (cursor < text.length) {
    if (text[cursor] !== "%") { append(text[cursor]); cursor += 1; continue }
    const match = text.slice(cursor).match(/^%(?:(\d+)\$)?([-#+ 0,(<]*)(\d+)?(?:\.(\d+))?([tT][a-zA-Z]|[a-zA-Z%])/u)
    if (match === null) throw new Error("Invalid String.format pattern")
    const argumentIndex = match[1] === undefined ? undefined : Number(match[1]) - 1
    const flags = match[2] ?? ""
    const width = match[3] === undefined ? undefined : Number(match[3])
    const precision = match[4] === undefined ? undefined : Number(match[4])
    const conversion = match[5]
    if (argumentIndex !== undefined && argumentIndex < 0) throw new Error("Invalid String.format argument index")
    if (flags.includes("-") && flags.includes("0")) throw new Error("Invalid String.format flags")
    if (conversion === "%") {
      if (argumentIndex !== undefined || flags.length > 0 || width !== undefined || precision !== undefined) throw new Error("Invalid String.format percent conversion")
      append("%"); cursor += match[0].length; continue
    }
    if (conversion === "n") {
      if (argumentIndex !== undefined || flags.length > 0 || width !== undefined || precision !== undefined) throw new Error("Invalid String.format newline conversion")
      append("\n"); cursor += match[0].length; continue
    }
    const selected = flags.includes("<") ? previousArgument : argumentIndex ?? nextArgument++
    if (!Number.isInteger(selected) || selected < 0 || selected >= sourceArgs.length) throw new Error("Missing String.format argument")
    previousArgument = selected
    const value = sourceArgs[selected]
    if (/^[tT]/u.test(conversion)) {
      if (precision !== undefined || /[+# 0,(]/u.test(flags)) throw new Error("Invalid String.format date flags")
      append(legadoJavaFormatPad(legadoJavaFormatDate(value, conversion, locale), width, flags))
      cursor += match[0].length
      continue
    }
    const upper = conversion === conversion.toUpperCase()
    const kind = conversion.toLowerCase()
    let rendered
    if (kind === "s") {
      rendered = legadoJavaFormatObjectText(value)
      if (precision !== undefined) rendered = rendered.slice(0, precision)
      if (upper) rendered = rendered.toUpperCase()
      append(legadoJavaFormatPad(rendered, width, flags))
    } else if (kind === "b") {
      rendered = value === null || value === undefined ? "false" : typeof value === "boolean" ? String(value) : "true"
      if (upper) rendered = rendered.toUpperCase()
      append(legadoJavaFormatPad(rendered, width, flags))
    } else if (kind === "h") {
      if (value === null || value === undefined) rendered = "null"
      else if (typeof value?.hashCode === "function") rendered = (Number(value.hashCode()) >>> 0).toString(16)
      else { let hash = 0; for (const char of legadoJavaFormatObjectText(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; rendered = (hash >>> 0).toString(16) }
      if (upper) rendered = rendered.toUpperCase()
      append(legadoJavaFormatPad(rendered, width, flags))
    } else if (kind === "c") {
      const numeric = typeof value === "number" || typeof value === "bigint" ? Number(value) : undefined
      if (numeric !== undefined) { if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) throw new RangeError("Illegal format character"); rendered = String.fromCodePoint(numeric) } else { const source = legadoJavaFormatObjectText(value); if (source.length === 0) throw new RangeError("Illegal format character"); rendered = String.fromCodePoint(source.codePointAt(0)) }
      if (upper) rendered = rendered.toUpperCase()
      append(legadoJavaFormatPad(rendered, width, flags))
    } else if (kind === "d" || kind === "o" || kind === "x") {
      if (precision !== undefined || flags.includes("#") && kind === "d") throw new Error("Invalid String.format integer flags")
      const integer = legadoJavaFormatInteger(value, kind)
      const negative = !integer.signedPrimitive && integer.value < 0n
      const magnitude = negative ? -integer.value : integer.value
      const radix = kind === "d" ? 10 : kind === "o" ? 8 : 16
      let body = magnitude.toString(radix)
      if (flags.includes(",") && kind === "d") { const parts = []; for (let end = body.length; end > 0; end -= 3) parts.unshift(body.slice(Math.max(0, end - 3), end)); body = parts.join(localeInfo.grouping) }
      if (upper) body = body.toUpperCase()
      const prefix = flags.includes("#") ? kind === "x" ? upper ? "0X" : "0x" : kind === "o" ? "0" : "" : ""
      append(legadoJavaFormatNumeric(body, negative, flags, width, prefix))
    } else if (kind === "f" || kind === "e" || kind === "g") {
      const number = Number(value?.valueOf?.() ?? value)
      if (Number.isNaN(number)) rendered = upper ? "NAN" : "NaN"
      else if (!Number.isFinite(number)) rendered = (number < 0 ? "-" : "") + (upper ? "INFINITY" : "Infinity")
      else {
        const negative = Object.is(number, -0) || number < 0
        const absolute = Math.abs(number)
        const digits = precision === undefined ? 6 : precision
        if (kind === "f") rendered = absolute.toFixed(digits)
        else if (kind === "e") rendered = absolute.toExponential(digits).replace(/e([+-])(\d)$/u, "e$10$2")
        else rendered = absolute.toPrecision(digits).replace(/e([+-])(\d)$/u, "e$10$2")
        if (localeInfo.decimal !== ".") rendered = rendered.replace(".", localeInfo.decimal)
        if (kind === "f" && flags.includes(",")) { const decimalIndex = rendered.indexOf(localeInfo.decimal); const whole = decimalIndex < 0 ? rendered : rendered.slice(0, decimalIndex); const fraction = decimalIndex < 0 ? "" : rendered.slice(decimalIndex); const parts = []; for (let end = whole.length; end > 0; end -= 3) parts.unshift(whole.slice(Math.max(0, end - 3), end)); rendered = parts.join(localeInfo.grouping) + fraction }
        if (upper) rendered = rendered.toUpperCase()
        append(legadoJavaFormatNumeric(rendered, negative, flags, width))
        cursor += match[0].length
        continue
      }
      append(legadoJavaFormatPad(rendered, width, flags))
    } else throw new Error("Unsupported String.format conversion: " + conversion)
    cursor += match[0].length
  }
  return output
}
// Java 的字符数组重载按 UTF-16 char 连接；不能复用 byte[] 解码路径，否则数值会被当作 UTF-8 字节。
const legadoJavaCharArrayText = (value, offset, length) => {
  if (value === null || value === undefined || typeof value.length !== "number") throw new RangeError("char array is required")
  const chars = Array.from(value)
  const start = offset === undefined ? 0 : Number(offset)
  const count = length === undefined ? chars.length - start : Number(length)
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > chars.length) throw new RangeError("char array range out of bounds")
  return chars.slice(start, start + count).map((item) => typeof item === "number" ? String.fromCharCode(item) : String(item)).join("")
}
Object.assign(legadoJavaLangString, {
  valueOf: (value) => value === null || value === undefined ? legadoJavaString("null") : Array.isArray(value) ? legadoJavaString(legadoJavaCharArrayText(value)) : legadoJavaString(value),
  copyValueOf: (value, offset, length) => legadoJavaString(legadoJavaCharArrayText(value, offset, length)),
  join: (delimiter, values, ...rest) => { const separator = String(delimiter ?? "null"); const collection = values !== null && values !== undefined && typeof values !== "string" && (Array.isArray(values) || typeof values.toArray === "function" || typeof values[Symbol.iterator] === "function"); const items = rest.length > 0 ? [values, ...rest] : collection ? legadoJavaCollectionValues(values) : values === undefined ? [] : [values]; return legadoJavaString(items.map((item) => item === null || item === undefined ? "null" : String(item)).join(separator)) },
  format: (formatOrLocale, ...args) => { const localeTag = formatOrLocale !== null && formatOrLocale !== undefined ? formatOrLocale.__legadoLocale : undefined; const locale = localeTag === undefined ? undefined : String(localeTag); const format = locale === undefined ? formatOrLocale : args.shift(); return legadoJavaString(legadoJavaFormat(format, args, locale)) },
})
const legadoStringBuilder = function(initial) {
  let value = typeof initial === "number" ? "" : initial === undefined ? "" : String(initial)
  let capacity = typeof initial === "number" ? Number(initial) : initial === undefined ? 16 : value.length + 16
  if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError("StringBuilder capacity out of bounds")
  const budget = 16 * 1024 * 1024
  const textOf = (item, offset, length) => Array.isArray(item) || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(item)) ? legadoJavaCharArrayText(item, offset, length) : item === null || item === undefined ? "null" : String(item)
  const update = (next) => { if (next.length > budget) throw new RangeError("StringBuilder exceeds runtime limit"); if (next.length > capacity) capacity = Math.max(next.length, capacity * 2 + 2); value = next; return target }
  const target = {
    append: function(item, offset, length) { return update(value + textOf(item, offset, length)) },
    appendCodePoint: (codePoint) => { const point = Number(codePoint); if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) throw new RangeError("StringBuilder code point out of bounds"); return update(value + String.fromCodePoint(point)) },
    insert: (index, item, offset, length) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position > value.length) throw new RangeError("StringBuilder index out of bounds"); return update(value.slice(0, position) + textOf(item, offset, length) + value.slice(position)) },
    delete: (start, end) => { const from = Number(start); const to = Number(end); if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > value.length) throw new RangeError("StringBuilder index out of bounds"); return update(value.slice(0, from) + value.slice(to)) },
    deleteCharAt: (index) => target.delete(index, Number(index) + 1),
    replace: (start, end, replacement) => { const from = Number(start); const to = Number(end); if (replacement === null || replacement === undefined || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > value.length) throw new RangeError("StringBuilder replacement out of bounds"); return update(value.slice(0, from) + String(replacement) + value.slice(to)) },
    charAt: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= value.length) throw new RangeError("StringBuilder index out of bounds"); return value.charAt(position) },
    setCharAt: (index, character) => { const position = Number(index); if (character === null || character === undefined || !Number.isInteger(position) || position < 0 || position >= value.length) throw new RangeError("StringBuilder index out of bounds"); const replacement = String(character); if (replacement.length === 0) throw new RangeError("StringBuilder character is required"); update(value.slice(0, position) + replacement.charAt(0) + value.slice(position + 1)); return undefined },
    codePointAt: (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= value.length) throw new RangeError("StringBuilder index out of bounds"); return legadoJavaCodePoint(value, position).value },
    codePointBefore: (index) => { const position = Number(index); if (!Number.isInteger(position) || position <= 0 || position > value.length) throw new RangeError("StringBuilder index out of bounds"); const previous = position - 1; const low = value.charCodeAt(previous); if (low >= 0xdc00 && low <= 0xdfff && previous > 0) { const high = value.charCodeAt(previous - 1); if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + low - 0xdc00 + 0x10000 } return low },
    codePointCount: (begin, end) => legadoJavaCodePointCount(value, begin, end),
    offsetByCodePoints: (index, offset) => legadoJavaOffsetByCodePoints(value, index, offset),
    getChars: (begin, end, destination, destinationBegin) => { const start = Number(begin); const finish = Number(end); const targetStart = Number(destinationBegin); if (!Number.isInteger(start) || !Number.isInteger(finish) || !Number.isInteger(targetStart) || start < 0 || finish < start || finish > value.length || targetStart < 0 || destination === null || destination === undefined || typeof destination.length !== "number" || targetStart + finish - start > destination.length) throw new RangeError("StringBuilder char array range out of bounds"); const typed = typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(destination); for (let index = start; index < finish; index += 1) destination[targetStart + index - start] = typed ? value.charCodeAt(index) : value.charAt(index); return undefined },
    substring: (start, end) => { const from = Number(start); const to = end === undefined ? value.length : Number(end); if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > value.length) throw new RangeError("StringBuilder index out of bounds"); return value.slice(from, to) },
    subSequence: (start, end) => target.substring(start, end),
    indexOf: (part, start) => value.indexOf(String(part ?? "null"), start === undefined ? 0 : Number(start)),
    lastIndexOf: (part, start) => value.lastIndexOf(String(part ?? "null"), start === undefined ? value.length : Number(start)),
    reverse: () => { value = Array.from(value).reverse().join(""); return target },
    length: () => value.length,
    capacity: () => capacity,
    ensureCapacity: (minimum) => { const requested = Number(minimum); if (!Number.isInteger(requested) || requested < 0) throw new RangeError("StringBuilder capacity out of bounds"); if (requested > capacity) capacity = Math.max(requested, capacity * 2 + 2); return undefined },
    trimToSize: () => { capacity = value.length; return undefined },
    setLength: (length) => { const next = Number(length); if (!Number.isInteger(next) || next < 0) throw new RangeError("StringBuilder length out of bounds"); return update(next <= value.length ? value.slice(0, next) : value + "\u0000".repeat(next - value.length)) && undefined },
    toString: () => value,
  }
  return target
}
// Java 的 radix 解析要求完整消费字符串，且只接受 2..36 的 ASCII 数字；Number.parseInt 会静默接受尾随字符。
const legadoParseBigInt = (value, radix) => {
  const base = radix === undefined ? 10 : Number(radix)
  if (!Number.isInteger(base) || base < 2 || base > 36) throw new RangeError("radix out of range")
  if (value === null || value === undefined) throw new RangeError("invalid integer")
  const text = String(value)
  if (text.length === 0) throw new RangeError("invalid integer")
  let index = 0
  let negative = false
  if (text[index] === "+" || text[index] === "-") {
    negative = text[index] === "-"
    index += 1
  }
  if (index >= text.length) throw new RangeError("invalid integer")
  let number = 0n
  for (; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const digit = code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 90 ? code - 55 : code >= 97 && code <= 122 ? code - 87 : -1
    if (digit < 0 || digit >= base) throw new RangeError("invalid integer")
    number = number * BigInt(base) + BigInt(digit)
  }
  return negative ? -number : number
}
const legadoInteger = { toHexString: (value) => (Number(value) >>> 0).toString(16), toString: (value, radix) => Math.trunc(Number(value)).toString(radix === undefined ? 10 : Number(radix)), parseInt: (value, radix) => { const number = legadoParseBigInt(value, radix); if (number < -(2n ** 31n) || number > (2n ** 31n) - 1n) throw new RangeError("integer value out of range"); return Number(number) }, valueOf: (value) => Number(value), compare: (left, right) => Number(left) < Number(right) ? -1 : Number(left) > Number(right) ? 1 : 0, max: (left, right) => Math.max(Number(left), Number(right)), min: (left, right) => Math.min(Number(left), Number(right)) }
const legadoNumber = { toHexString: (value) => Math.trunc(Number(value)).toString(16), toString: legadoInteger.toString, parseInt: legadoInteger.parseInt, valueOf: legadoInteger.valueOf, compare: legadoInteger.compare, max: legadoInteger.max, min: legadoInteger.min }
const legadoLong = { MIN_VALUE: -(2n ** 63n), MAX_VALUE: (2n ** 63n) - 1n, parseLong: (value, radix) => { const number = legadoParseBigInt(value, radix); if (number < -(2n ** 63n) || number > (2n ** 63n) - 1n) throw new RangeError("long value out of range"); return number }, toString: (value, radix) => BigInt(value).toString(radix === undefined ? 10 : Number(radix)), valueOf: (value) => BigInt(value), compare: (left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0, max: (left, right) => BigInt(left) > BigInt(right) ? BigInt(left) : BigInt(right), min: (left, right) => BigInt(left) < BigInt(right) ? BigInt(left) : BigInt(right) }
const legadoBigInteger = function(value, radix) {
  let number
  if (value && typeof value === "object" && typeof value.__legadoBigInteger === "bigint") number = value.__legadoBigInteger
  else if (value instanceof Uint8Array || Array.isArray(value)) { let hex = Array.from(value instanceof Uint8Array ? value : Uint8Array.from(value)).map((item) => Number(item).toString(16).padStart(2, "0")).join(""); number = hex.length === 0 ? 0n : BigInt("0x" + hex); if (Number((value instanceof Uint8Array ? value : Uint8Array.from(value))[0] ?? 0) >= 128) number -= 1n << BigInt((value instanceof Uint8Array ? value : Uint8Array.from(value)).length * 8) }
  else number = radix === undefined ? BigInt(String(value ?? "0").trim().replace(/^[+]/u, "")) : legadoParseBigInt(value, radix)
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
const legadoSet = function(input) { const values = []; const itemsOf = (items) => Array.isArray(items) ? items : items?.toArray?.() ?? []; const add = (value) => { if (values.some((item) => Object.is(item, value))) return false; values.push(value); return true }; for (const value of itemsOf(input)) add(value); return { add, addAll: (items) => { let changed = false; for (const value of itemsOf(items)) changed = add(value) || changed; return changed }, contains: (value) => values.some((item) => Object.is(item, value)), containsAll: (items) => itemsOf(items).every((item) => values.some((value) => Object.is(value, item))), remove: (value) => { const index = values.findIndex((item) => Object.is(item, value)); if (index < 0) return false; values.splice(index, 1); return true }, removeAll: (items) => { const candidates = itemsOf(items); const before = values.length; for (let index = values.length - 1; index >= 0; index -= 1) if (candidates.some((item) => Object.is(item, values[index]))) values.splice(index, 1); return values.length !== before }, retainAll: (items) => { const candidates = itemsOf(items); const before = values.length; for (let index = values.length - 1; index >= 0; index -= 1) if (!candidates.some((item) => Object.is(item, values[index]))) values.splice(index, 1); return values.length !== before }, clear: () => { values.length = 0 }, size: () => values.length, isEmpty: () => values.length === 0, toArray: () => values.slice(), iterator: () => { let index = 0; let canRemove = false; return { hasNext: () => index < values.length, next: () => { if (index >= values.length) throw new RangeError("No such element"); canRemove = true; return values[index++] }, remove: () => { if (!canRemove) throw new Error("Illegal iterator state"); values.splice(--index, 1); canRemove = false } } }, forEach: (callback) => values.forEach(callback), toString: () => "[" + values.map((value) => value === null || value === undefined ? "null" : String(value)).join(", ") + "]" } }
const legadoJavaMath = { abs: (value) => Math.abs(Number(value)), max: (left, right) => Math.max(Number(left), Number(right)), min: (left, right) => Math.min(Number(left), Number(right)), round: (value) => Math.round(Number(value)), floor: (value) => Math.floor(Number(value)), ceil: (value) => Math.ceil(Number(value)), pow: (left, right) => Math.pow(Number(left), Number(right)), signum: (value) => Math.sign(Number(value)), toRadians: (value) => Number(value) * Math.PI / 180, toDegrees: (value) => Number(value) * 180 / Math.PI }
const legadoBytesValue = (value) => value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? new Uint8Array(value) : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" })
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
  UNIX_LINES: 1,
  CASE_INSENSITIVE: 2,
  COMMENTS: 4,
  MULTILINE: 8,
  DOTALL: 32,
  UNICODE_CASE: 64,
  LITERAL: 16,
  UNICODE_CHARACTER_CLASS: 256,
  quote: (pattern) => "\\Q" + String(pattern ?? "") + "\\E",
  compile: (pattern, flags) => {
    const numericFlags = Number(flags ?? 0)
    const patternText = String(pattern ?? "")
    let javaFlags = ""
    if ((numericFlags & 2) !== 0) javaFlags += "i"
    if ((numericFlags & 8) !== 0) javaFlags += "m"
    if ((numericFlags & 32) !== 0) javaFlags += "s"
    let prefix = ""
    if ((numericFlags & 1) !== 0) prefix += "d"
    if ((numericFlags & 4) !== 0) prefix += "x"
    if ((numericFlags & 256) !== 0) prefix += "U"
    if ((numericFlags & 64) !== 0) prefix += "u"
    const patternSource = (prefix.length === 0 ? "" : "(?" + prefix + ")") + ((numericFlags & 16) !== 0 ? legadoPattern.quote(patternText) : patternText)
    const compiled = request({ kind: "pattern-compile", pattern: patternSource, flags: javaFlags + "d" })
    const compiledFlags = String(compiled.flags ?? "")
    const makeRegex = (global) => new RegExp(String(compiled.source), compiledFlags + (global && !compiledFlags.includes("g") ? "g" : ""))
    const countGroups = (source) => {
      let count = 0
      let escaped = false
      let inClass = false
      for (let index = 0; index < source.length; index++) {
        const current = source[index]
        if (escaped) { escaped = false; continue }
        if (current === "\\") { escaped = true; continue }
        if (current === "[") { inClass = true; continue }
        if (current === "]") { inClass = false; continue }
        if (current !== "(" || inClass) continue
        if (source[index + 1] !== "?") { count += 1; continue }
        if (source.startsWith("(?<", index) && source[index + 3] !== "=" && source[index + 3] !== "!") count += 1
      }
      return count
    }
    const patternGroupCount = countGroups(String(compiled.source))
    const patternApi = {
      pattern: () => patternText,
      flags: () => numericFlags,
      matcher: (value) => {
      const input = String(value ?? "")
      const regex = makeRegex(true)
      let last = null
      let lastOffset = 0
      let regionStart = 0
      let regionEnd = input.length
      let advanceEmpty = false
      const groupBounds = (index) => {
        if (last === null) return [-1, -1]
        const named = typeof index === "string" && index.length > 0
        const groupIndex = named ? undefined : Number(index ?? 0)
        const group = named ? last.groups?.[index] : last[groupIndex]
        if (group === undefined) return [-1, -1]
        const bounds = named ? last.indices?.groups?.[index] : last.indices?.[groupIndex]
        if (Array.isArray(bounds)) return [bounds[0] + lastOffset, bounds[1] + lastOffset]
        if (groupIndex === 0) return [last.index + lastOffset, last.index + lastOffset + group.length]
        const local = String(last[0]).indexOf(String(group))
        return local < 0 ? [-1, -1] : [last.index + lastOffset + local, last.index + lastOffset + local + String(group).length]
      }
      const clear = () => { last = null; lastOffset = 0; advanceEmpty = false; regex.lastIndex = regionStart }
      const scopedText = () => input.slice(regionStart, regionEnd)
      const scopedRegex = (prefix, suffix) => new RegExp(prefix + compiled.source + suffix, compiledFlags.replace("d", "") + (compiledFlags.includes("d") ? "d" : ""))
      const replaceInRegion = (replacement, replaceAll) => {
        const value = legadoJavaReplace(scopedText(), makeRegex(false), replacement, replaceAll)
        return input.slice(0, regionStart) + value + input.slice(regionEnd)
      }
      const api = {
        find: () => {
          if (advanceEmpty) {
            regex.lastIndex = Math.min(regionEnd + 1, regex.lastIndex + 1)
            advanceEmpty = false
          }
          const match = regex.exec(input)
          if (match === null || match.index + match[0].length > regionEnd) { last = null; return false }
          last = match
          lastOffset = 0
          advanceEmpty = match[0].length === 0
          return true
        },
        matches: () => {
          const match = scopedRegex("^(?:", ")$").exec(scopedText())
          if (match === null) { last = null; return false }
          last = match
          lastOffset = regionStart
          return true
        },
        lookingAt: () => {
          const match = scopedRegex("^(?:", ")").exec(scopedText())
          if (match === null) { last = null; return false }
          last = match
          lastOffset = regionStart
          return true
        },
        group: (index) => {
          if (last === null) return null
          if (typeof index === "string" && index.length > 0) {
            if (last.groups === undefined || !Object.prototype.hasOwnProperty.call(last.groups, index)) throw new Error("No group with name <" + index + ">")
            return last.groups[index] ?? null
          }
          const groupIndex = Number(index ?? 0)
          if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > patternGroupCount) throw new Error("No group " + groupIndex)
          return last[groupIndex] ?? null
        },
        groupCount: () => patternGroupCount,
        replaceAll: (replacement) => replaceInRegion(replacement, true),
        replaceFirst: (replacement) => replaceInRegion(replacement, false),
        start: (index) => groupBounds(index)[0],
        end: (index) => groupBounds(index)[1],
        region: (start, end) => {
          const from = Number(start)
          const to = Number(end)
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > input.length) throw new RangeError("Matcher region out of bounds")
          regionStart = from
          regionEnd = to
          clear()
          return api
        },
        regionStart: () => regionStart,
        regionEnd: () => regionEnd,
        reset: () => { clear(); return api },
      }
      regex.lastIndex = regionStart
      return api
    },
    }
    return { ...patternApi, matches: (value) => patternApi.matcher(value).matches(), toString: () => patternText }
  }
}
const legadoMatcher = { quoteReplacement: (value) => String(value ?? "").replace(/[\\$]/gu, "\\$&") }
const legadoBase64 = {
  getEncoder: () => { const flags = 2; const encoder = { encodeToString: (value) => request({ kind: "base64-encode", value, flags }), encode: (value) => legadoJavaString(request({ kind: "base64-encode", value, flags })).getBytes("UTF-8"), withoutPadding: () => { const noPadding = 3; return { encodeToString: (value) => request({ kind: "base64-encode", value, flags: noPadding }), encode: (value) => legadoJavaString(request({ kind: "base64-encode", value, flags: noPadding })).getBytes("UTF-8") } } }; return encoder },
  getDecoder: () => ({ decode: (value) => request({ kind: "base64-decode-bytes", value: String(value) }) }),
}
const legadoByteArrayInputStream = function(input, offset, length) {
  const bytes = legadoBytesValue(input)
  const start = offset === undefined ? 0 : Number(offset)
  const requested = length === undefined ? bytes.length - start : Number(length)
  if (!Number.isInteger(start) || !Number.isInteger(requested) || start < 0 || requested < 0 || start > bytes.length) throw new RangeError("ByteArrayInputStream range out of bounds")
  const end = Math.min(bytes.length, start + requested)
  let cursor = start
  let mark = start
  const targetLength = (target) => target !== null && target !== undefined && (Array.isArray(target) || ArrayBuffer.isView(target)) ? target.length : -1
  const readInto = (target, targetOffset, count, eofValue) => {
    const size = targetLength(target)
    const outputOffset = targetOffset === undefined ? 0 : Number(targetOffset)
    const outputCount = count === undefined ? size - outputOffset : Number(count)
    if (size < 0 || !Number.isInteger(outputOffset) || !Number.isInteger(outputCount) || outputOffset < 0 || outputCount < 0 || outputOffset + outputCount > size) throw new RangeError("invalid InputStream read range")
    if (outputCount === 0) return 0
    const available = Math.min(outputCount, end - cursor)
    if (available <= 0) return eofValue
    for (let index = 0; index < available; index++) target[outputOffset + index] = bytes[cursor + index]
    cursor += available
    return available
  }
  const readAllBytes = () => { const result = bytes.slice(cursor, end); cursor = end; return result }
  const api = {
    read: function(target, targetOffset, count) {
      if (arguments.length === 0) return cursor < end ? bytes[cursor++] : -1
      return readInto(target, targetOffset, count, -1)
    },
    readNBytes: function(target, targetOffset, count) {
      if (arguments.length === 0) return readAllBytes()
      return readInto(target, targetOffset, count, 0)
    },
    readAllBytes,
    available: () => end - cursor,
    skip: (count) => { const amount = Math.max(0, Math.min(end - cursor, Math.trunc(Number(count) || 0))); cursor += amount; return amount },
    skipNBytes: (count) => { const amount = Number(count); if (!Number.isInteger(amount) || amount < 0) throw new RangeError("skipNBytes count must be non-negative"); if (amount > end - cursor) { cursor = end; throw new Error("EOF while skipping bytes") } cursor += amount; return undefined },
    transferTo: (output) => { if (output === null || typeof output?.write !== "function") throw new TypeError("OutputStream is required"); const remaining = end - cursor; if (remaining > 0) output.write(bytes, cursor, remaining); cursor = end; return remaining },
    mark: () => { mark = cursor },
    reset: () => { cursor = mark },
    markSupported: () => true,
    close: () => undefined,
  }
  return api
}
const legadoCompressedInputStream = (input, kind) => {
  const bytes = request({ kind, value: legadoBytesValue(input?.readAllBytes?.() ?? input) })
  const delegate = legadoByteArrayInputStream(bytes)
  return {
    read: (...args) => delegate.read(...args),
    readNBytes: (...args) => delegate.readNBytes(...args),
    readAllBytes: () => delegate.readAllBytes(),
    available: () => delegate.available(),
    skip: (count) => delegate.skip(count),
    skipNBytes: (count) => delegate.skipNBytes(count),
    transferTo: (output) => delegate.transferTo(output),
    mark: () => delegate.mark(),
    reset: () => delegate.reset(),
    markSupported: () => delegate.markSupported(),
    close: () => delegate.close(),
  }
}
const legadoGzipInputStream = function(input) { return legadoCompressedInputStream(input, "gzip-decode") }
const legadoInflaterInputStream = function(input) { return legadoCompressedInputStream(input, "inflate-decode") }
const legadoZipInputStream = function(input) {
  const entries = request({ kind: "zip-decode", value: legadoBytesValue(input?.readAllBytes?.() ?? input) })
  if (!Array.isArray(entries)) throw new Error("Invalid ZIP decoder result")
  let index = -1
  let current
  let delegate
  let closed = false
  const entryObject = (value) => {
    const path = String(value?.path ?? "")
    return {
      getName: () => path,
      getSize: () => value?.size === undefined ? Number(value?.data?.length ?? -1) : Number(value.size),
      getCompressedSize: () => value?.compressedSize === undefined ? -1 : Number(value.compressedSize),
      getCrc: () => value?.crc === undefined ? -1 : Number(value.crc),
      getMethod: () => value?.method === undefined ? -1 : Number(value.method),
      getComment: () => value?.comment === undefined ? null : String(value.comment),
      isDirectory: () => path.endsWith("/"),
      toString: () => path,
    }
  }
  const ensureOpen = () => { if (closed) throw new Error("ZipInputStream is closed") }
  const nextEntry = () => {
    ensureOpen()
    delegate?.close?.()
    index += 1
    current = index < entries.length ? entries[index] : undefined
    delegate = current === undefined ? undefined : legadoByteArrayInputStream(legadoBytesValue(current.data))
    return current === undefined ? null : entryObject(current)
  }
  return {
    getNextEntry: nextEntry,
    closeEntry: () => { ensureOpen(); delegate?.close?.(); delegate = undefined; return undefined },
    read: (...args) => { ensureOpen(); return delegate === undefined ? -1 : delegate.read(...args) },
    readNBytes: (...args) => { ensureOpen(); return delegate === undefined ? args.length === 0 ? new Uint8Array() : 0 : delegate.readNBytes(...args) },
    readAllBytes: () => { ensureOpen(); return delegate === undefined ? new Uint8Array() : delegate.readAllBytes() },
    available: () => { ensureOpen(); return delegate?.available?.() ?? 0 },
    skip: (count) => { ensureOpen(); return delegate?.skip?.(count) ?? 0 },
    skipNBytes: (count) => { ensureOpen(); return delegate?.skipNBytes?.(count) ?? (Number(count) === 0 ? undefined : (() => { throw new Error("EOF while skipping bytes") })()) },
    transferTo: (output) => { ensureOpen(); return delegate?.transferTo?.(output) ?? 0 },
    mark: () => undefined,
    reset: () => { throw new Error("ZipInputStream does not support mark/reset") },
    markSupported: () => false,
    close: () => { closed = true; delegate?.close?.(); delegate = undefined; current = undefined },
  }
}
const legadoByteArrayOutputStream = function(initial) {
  const capacity = initial === undefined ? 32 : Number(initial)
  if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError("ByteArrayOutputStream size must be non-negative")
  let chunks = []
  let total = 0
  const append = (bytes) => { if (total + bytes.length > 16 * 1024 * 1024) throw new RangeError("ByteArrayOutputStream exceeds runtime limit"); if (bytes.length > 0) { chunks.push(bytes.slice()); total += bytes.length } }
  const bytesFromCharset = (charset) => charset === undefined || charset === null ? "UTF-8" : typeof charset === "object" && typeof charset.name === "function" ? String(charset.name()) : String(charset)
  const api = {
    write: function(value, offset, length) {
      if (typeof value === "number" && arguments.length === 1) { append(Uint8Array.of(Number(value) & 255)); return undefined }
      const bytes = legadoBytesValue(value)
      const start = offset === undefined ? 0 : Number(offset)
      const count = length === undefined ? bytes.length - start : Number(length)
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("OutputStream write range out of bounds")
      append(bytes.slice(start, start + count))
      return undefined
    },
    writeBytes: (value) => { api.write(value); return undefined },
    writeTo: (output) => { if (output === null || typeof output?.write !== "function") throw new TypeError("OutputStream is required"); output.write(api.toByteArray()); return undefined },
    toByteArray: () => legadoConcatBytes(chunks),
    size: () => total,
    reset: () => { chunks = []; total = 0 },
    close: () => undefined,
    flush: () => undefined,
    toString: (charset) => request({ kind: "decode-bytes", value: api.toByteArray(), charset: bytesFromCharset(charset) }),
  }
  return api
}
const legadoReaderCharset = (charset) => charset === undefined || charset === null ? "UTF-8" : typeof charset === "object" && typeof charset.name === "function" ? String(charset.name()) : String(charset)
const legadoCharsToString = (chars) => { let result = ""; for (let index = 0; index < chars.length; index += 8192) result += String.fromCharCode(...chars.slice(index, index + 8192)); return result }
const legadoInputStreamReader = function(input, charset) {
  const bytes = legadoBytesValue(input?.readAllBytes?.() ?? input)
  const text = request({ kind: "decode-bytes", value: bytes, charset: legadoReaderCharset(charset) })
  let cursor = 0
  let closed = false
  const ensureOpen = () => { if (closed) throw new Error("Reader is closed") }
  const readInto = (target, targetOffset, count, eofValue) => {
    const size = target !== null && target !== undefined && (Array.isArray(target) || ArrayBuffer.isView(target)) ? target.length : -1
    const start = targetOffset === undefined ? 0 : Number(targetOffset)
    const amount = count === undefined ? size - start : Number(count)
    if (size < 0 || !Number.isInteger(start) || !Number.isInteger(amount) || start < 0 || amount < 0 || start + amount > size) throw new RangeError("Reader read range out of bounds")
    if (amount === 0) return 0
    const available = Math.min(amount, text.length - cursor)
    if (available <= 0) return eofValue
    for (let index = 0; index < available; index++) target[start + index] = text.charCodeAt(cursor + index)
    cursor += available
    return available
  }
  const api = {
    read: function(target, targetOffset, count) { ensureOpen(); if (arguments.length === 0) return cursor < text.length ? text.charCodeAt(cursor++) : -1; return readInto(target, targetOffset, count, -1) },
    readAll: () => { ensureOpen(); const result = text.slice(cursor); cursor = text.length; return result },
    skip: (count) => { ensureOpen(); const amount = Math.max(0, Math.min(text.length - cursor, Math.trunc(Number(count) || 0))); cursor += amount; return amount },
    ready: () => { ensureOpen(); return cursor < text.length },
    markSupported: () => false,
    mark: () => { throw new Error("InputStreamReader does not support mark/reset") },
    reset: () => { throw new Error("InputStreamReader does not support mark/reset") },
    close: () => { if (!closed) { closed = true; input?.close?.() } },
  }
  return api
}
const legadoBufferedReader = function(reader) {
  let pendingCode
  let closed = false
  const ensureOpen = () => { if (closed) throw new Error("BufferedReader is closed") }
  const nextCode = () => { if (pendingCode !== undefined) { const code = pendingCode; pendingCode = undefined; return code } return reader.read() }
  const readLine = () => {
    ensureOpen()
    const chars = []
    while (true) {
      const code = nextCode()
      if (code < 0) return chars.length === 0 ? null : legadoCharsToString(chars)
      if (code === 10) return legadoCharsToString(chars)
      if (code === 13) { const next = nextCode(); if (next >= 0 && next !== 10) pendingCode = next; return legadoCharsToString(chars) }
      chars.push(code)
      if (chars.length >= 1048576) return legadoCharsToString(chars)
    }
  }
  const api = {
    readLine,
    read: function(target, targetOffset, count) {
      ensureOpen()
      if (arguments.length === 0) return nextCode()
      const size = target !== null && target !== undefined && (Array.isArray(target) || ArrayBuffer.isView(target)) ? target.length : -1
      const start = targetOffset === undefined ? 0 : Number(targetOffset)
      const amount = count === undefined ? size - start : Number(count)
      if (size < 0 || !Number.isInteger(start) || !Number.isInteger(amount) || start < 0 || amount < 0 || start + amount > size) throw new RangeError("BufferedReader read range out of bounds")
      if (amount === 0) return 0
      let index = 0
      while (index < amount) { const code = nextCode(); if (code < 0) break; target[start + index] = code; index += 1 }
      return index === 0 ? -1 : index
    },
    skip: (count) => { ensureOpen(); const amount = Math.max(0, Math.trunc(Number(count) || 0)); let skipped = 0; while (skipped < amount && nextCode() >= 0) skipped += 1; return skipped },
    ready: () => { ensureOpen(); return pendingCode !== undefined || reader.ready?.() === true },
    markSupported: () => reader.markSupported?.() === true,
    mark: (limit) => { ensureOpen(); if (pendingCode !== undefined) throw new Error("BufferedReader pending line terminator cannot be marked"); reader.mark?.(limit) },
    reset: () => { ensureOpen(); pendingCode = undefined; if (typeof reader.reset !== "function") throw new Error("BufferedReader does not support reset"); return reader.reset() },
    lines: () => { const values = []; let line; while ((line = readLine()) !== null) values.push(line); return legadoList(values) },
    close: () => { if (!closed) { closed = true; reader.close?.() } },
  }
  return api
}
const legadoSecretKeySpec = function(value, algorithm) { const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" }); return { getEncoded: () => bytes, getKey: () => bytes, getAlgorithm: () => String(algorithm ?? ""), getFormat: () => "RAW", encoded: bytes } }
const legadoIvParameterSpec = function(value, offset, length) { const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" }); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("IvParameterSpec range out of bounds"); const result = bytes.slice(start, start + count); return { getIV: () => result, getEncoded: () => result } }
const legadoGcmParameterSpec = function(tLen, value) { const bits = Number(tLen); if (!Number.isInteger(bits) || bits < 32 || bits > 128 || bits % 8 !== 0) throw new RangeError("GCM tag length must be 32..128 bits"); const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" }); return { getTLen: () => bits, getIV: () => bytes, getEncoded: () => bytes } }
const legadoMgf1ParameterSpec = function(digest) { const name = String(digest ?? "SHA-1"); return { getDigestAlgorithm: () => name, getAlgorithm: () => "MGF1" } }
const legadoPSourceSpecified = function(value) { const bytes = value === undefined || value === null ? new Uint8Array() : value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value), charset: "UTF-8" }); return { getAlgorithm: () => "PSpecified", getValue: () => bytes } }
const legadoPSource = { PSpecified: legadoPSourceSpecified }
const legadoOaepParameterSpec = function(digest, mgfAlgorithm, mgfParameters, pSource) { return { getDigestAlgorithm: () => String(digest ?? "SHA-1"), getMGFAlgorithm: () => String(mgfAlgorithm ?? "MGF1"), getMGFParameters: () => mgfParameters, getPSource: () => pSource ?? legadoPSourceSpecified(new Uint8Array()) } }
const legadoDesKeySpec = function(value, offset) { const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" }); const start = offset === undefined ? 0 : Number(offset); if (!Number.isInteger(start) || start < 0 || start + 8 > bytes.length) throw new RangeError("DESKeySpec range out of bounds"); const result = bytes.slice(start, start + 8); return { getKey: () => result } }
const legadoSecretKeyFactory = { getInstance: (algorithm) => ({ generateSecret: (spec) => { const bytes = spec?.getKey?.() ?? spec?.getEncoded?.() ?? spec?.encoded; return { getEncoded: () => bytes, getAlgorithm: () => String(algorithm), getFormat: () => "RAW" } } }) }
const legadoCipher = {
  ENCRYPT_MODE: 1,
  DECRYPT_MODE: 2,
  getInstance: (transformation) => {
    let mode
    let key
    let privateKey
    let publicKey
    let keyUsePublic
    let iv
    let aadChunks = []
    let authTagLength
    let oaepHash
    let oaepMgfHash
    let oaepLabel
    let chunks = []
    const api = {
      init: (nextMode, secret, parameters) => { mode = Number(nextMode); privateKey = secret?.__legadoPrivateKey; publicKey = secret?.__legadoPublicKey; keyUsePublic = publicKey !== undefined ? true : privateKey !== undefined ? false : undefined; key = secret?.getEncoded?.() ?? secret?.encoded ?? secret; iv = parameters?.getIV?.() ?? parameters?.getEncoded?.() ?? (parameters instanceof Uint8Array || Array.isArray(parameters) || typeof parameters === "string" ? parameters : undefined); authTagLength = parameters?.getTLen?.(); const mgf = parameters?.getMGFParameters?.(); oaepHash = parameters?.getDigestAlgorithm?.(); oaepMgfHash = mgf?.getDigestAlgorithm?.(); const source = parameters?.getPSource?.(); oaepLabel = source?.getValue?.(); chunks = []; aadChunks = []; return api },
      update: (value) => { chunks.push(legadoBytesValue(value)); return new Uint8Array() },
      updateAAD: (value, offset, length) => { const bytes = legadoBytesValue(value); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("Cipher AAD range out of bounds"); aadChunks.push(bytes.slice(start, start + count)); return undefined },
      doFinal: (value) => { if (value !== undefined) chunks.push(legadoBytesValue(value)); if (mode !== 1 && mode !== 2) throw new Error("Cipher is not initialized"); const transformationText = String(transformation); const asymmetric = /^RSA(?:\/|$)/iu.test(transformationText); const operation = mode === 2 ? "decrypt" : "encrypt"; const result = asymmetric ? request({ kind: "crypto-asymmetric", operation, transformation: transformationText, ...(privateKey === undefined ? (keyUsePublic === false ? { privateKey: key } : {}) : { privateKey }), ...(publicKey === undefined ? (keyUsePublic === false ? {} : { publicKey: key }) : { publicKey }), usePublicKey: keyUsePublic === undefined ? mode !== 2 : keyUsePublic, value: legadoConcatBytes(chunks), ...(oaepHash === undefined ? {} : { oaepHash }), ...(oaepMgfHash === undefined ? {} : { oaepMgfHash }), ...(oaepLabel === undefined ? {} : { oaepLabel }), inputEncoding: "bytes", outputEncoding: "bytes" }) : request({ kind: "crypto-symmetric", operation, transformation: transformationText, key, iv, value: legadoConcatBytes(chunks), ...(aadChunks.length === 0 ? {} : { aad: legadoConcatBytes(aadChunks) }), ...(authTagLength === undefined ? {} : { authTagLength }), inputEncoding: "bytes", outputEncoding: "bytes" }); chunks = []; aadChunks = []; return result },
      getAlgorithm: () => String(transformation),
      getIV: () => iv,
      getBlockSize: () => 0,
      reset: () => { chunks = []; aadChunks = []; return api },
    }
    return api
  },
}
const legadoMac = { getInstance: (algorithm) => { let key; let chunks = []; const api = { init: (secret) => { key = secret?.getEncoded?.() ?? secret?.encoded ?? secret; chunks = []; return api }, update: (value, offset, length) => { const bytes = legadoBytesValue(value); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("Mac update range out of bounds"); chunks.push(bytes.slice(start, start + count)); return api }, doFinal: (value) => { if (value !== undefined) api.update(value); const hex = request({ kind: "hmac-hex", value: legadoConcatBytes(chunks), key, algorithm: String(algorithm) }); chunks = []; return request({ kind: "hex-decode-bytes", value: hex }) }, reset: () => { chunks = []; return api }, getAlgorithm: () => String(algorithm) }; return api } }
const legadoDatatypeConverter = { printHexBinary: (value) => String(request({ kind: "hex-encode", value }) ?? "").toUpperCase(), parseHexBinary: (value) => request({ kind: "hex-decode-bytes", value: String(value ?? "") }) }
const legadoEncodedKeySpec = function(value, offset, length) { const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : request({ kind: "base64-decode-bytes", value: String(value ?? "") }); const start = offset === undefined ? 0 : Number(offset); const count = length === undefined ? bytes.length - start : Number(length); if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new RangeError("EncodedKeySpec range out of bounds"); const result = bytes.slice(start, start + count); return { getEncoded: () => result } }
const legadoKeyFactory = { getInstance: (algorithm) => ({ generatePrivate: (spec) => ({ getEncoded: () => spec?.getEncoded?.(), __legadoPrivateKey: spec?.getEncoded?.(), getAlgorithm: () => String(algorithm) }), generatePublic: (spec) => ({ getEncoded: () => spec?.getEncoded?.(), __legadoPublicKey: spec?.getEncoded?.(), getAlgorithm: () => String(algorithm) }) }) }
const legadoSignature = { getInstance: (algorithm) => { let privateKey; let publicKey; let chunks = []; const api = { initSign: (key) => { privateKey = key?.getEncoded?.() ?? key?.__legadoPrivateKey ?? key; chunks = []; return api }, initVerify: (key) => { publicKey = key?.getEncoded?.() ?? key?.__legadoPublicKey ?? key; chunks = []; return api }, update: (value) => { chunks.push(legadoBytesValue(value)); return api }, sign: () => { const result = request({ kind: "crypto-sign", operation: "sign", algorithm: String(algorithm), privateKey, value: legadoConcatBytes(chunks), outputEncoding: "bytes" }); chunks = []; return result }, verify: (value) => { const result = request({ kind: "crypto-sign", operation: "verify", algorithm: String(algorithm), publicKey, value: legadoConcatBytes(chunks), signature: legadoBytesValue(value) }); chunks = []; return result }, getAlgorithm: () => String(algorithm), reset: () => { chunks = []; return api } }; return api } }
const legadoUrlEncoder = { encode: (value, charset) => request({ kind: "encode-uri", value: String(value ?? ""), charset: charset === undefined ? "UTF-8" : String(charset) }) }
const legadoAndroidBase64 = { DEFAULT: 0, NO_PADDING: 1, NO_WRAP: 2, CRLF: 4, URL_SAFE: 8, NO_CLOSE: 16, encodeToString: (value, flags) => request({ kind: "base64-encode", value, flags: Number(flags ?? 0) }), encode: (value, flags) => legadoJavaString(request({ kind: "base64-encode", value, flags: Number(flags ?? 0) })).getBytes("UTF-8"), decode: (value, flags) => request({ kind: "base64-decode-bytes", value, flags: Number(flags ?? 0) }) }
const legadoJavaSystemProperties = { "file.encoding": "UTF-8", "file.separator": "/", "line.separator": "\n", "path.separator": ":" }
let legadoJavaNanoTime = Date.now() * 1000000
const legadoJavaSystemStream = (operation) => {
  const write = (value, newline) => request({ kind: "runtime-log", operation, value: String(value === undefined ? "" : value) + (newline ? "\n" : "") })
  return { print: (value) => write(value, false), println: (value) => write(value, true), append: (value) => write(value, false), flush: () => undefined, close: () => undefined }
}
const legadoJavaSystem = {
  currentTimeMillis: () => Date.now(),
  nanoTime: () => { const now = Date.now() * 1000000; legadoJavaNanoTime = Math.max(legadoJavaNanoTime + 1, now); return legadoJavaNanoTime },
  lineSeparator: () => "\n",
  getProperty: (key, fallback) => Object.prototype.hasOwnProperty.call(legadoJavaSystemProperties, String(key)) ? legadoJavaSystemProperties[String(key)] : fallback === undefined ? null : String(fallback),
  setProperty: (key, value) => { const name = String(key); const previous = Object.prototype.hasOwnProperty.call(legadoJavaSystemProperties, name) ? legadoJavaSystemProperties[name] : null; legadoJavaSystemProperties[name] = String(value); return previous },
  clearProperty: (key) => { const name = String(key); const previous = Object.prototype.hasOwnProperty.call(legadoJavaSystemProperties, name) ? legadoJavaSystemProperties[name] : null; delete legadoJavaSystemProperties[name]; return previous },
  arraycopy: (source, sourcePosition, destination, destinationPosition, length) => { const from = Number(sourcePosition); const to = Number(destinationPosition); const count = Number(length); if ((!Array.isArray(source) && !(typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(source))) || (!Array.isArray(destination) && !(typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(destination))) || !Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(count) || from < 0 || to < 0 || count < 0 || from + count > source.length || to + count > destination.length) throw new RangeError("arraycopy range out of bounds"); const values = Array.from(source).slice(from, from + count); for (let index = 0; index < values.length; index++) destination[to + index] = values[index] },
  gc: () => undefined,
  runFinalization: () => undefined,
  exit: () => { throw new Error("__LEGADO_CAPABILITY__runtime System.exit unavailable") },
  out: legadoJavaSystemStream("log"),
  err: legadoJavaSystemStream("logType"),
}
const legadoJavaUUIDText = (value) => { const text = String(value ?? ""); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) throw new Error("Invalid UUID string"); return text.toLowerCase() }
const legadoJavaUUIDValue = (value) => { const text = legadoJavaUUIDText(value); return { toString: () => text, toJSON: () => text, valueOf: () => text, equals: (other) => other !== null && other !== undefined && String(other?.toString?.() ?? other).toLowerCase() === text, hashCode: () => { const hex = text.replaceAll("-", ""); let hash = 0; for (let index = 0; index < 4; index++) hash ^= Number.parseInt(hex.slice(index * 8, index * 8 + 8), 16); return hash | 0 }, version: () => Number.parseInt(text[14] ?? "0", 16), variant: () => 2 } }
const legadoJavaUUID = { randomUUID: () => legadoJavaUUIDValue(request({ kind: "random-uuid" })), fromString: (value) => legadoJavaUUIDValue(value) }
const legadoJavaThread = { sleep: (millis, nanos) => { const value = Number(millis); const extra = nanos === undefined ? 0 : Number(nanos); if (!Number.isInteger(value) || value < 0 || !Number.isInteger(extra) || extra < 0 || extra > 999999) throw new RangeError("Illegal sleep time"); if (value === 0 && extra === 0) return undefined; return request({ kind: "runtime-sleep", time: value, nanos: extra }) }, yield: () => undefined, currentThread: () => ({ getName: () => "main", getId: () => 1, isAlive: () => true, isDaemon: () => false, isInterrupted: () => false }) }
const legadoAndroidTextUtils = { isEmpty: (value) => value === null || value === undefined || String(value).length === 0, equals: (left, right) => left === right || left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right), isDigitsOnly: (value) => /^\d*$/u.test(String(value ?? "")) }
const legadoAndroidBuild = { MODEL: "legado-node", MANUFACTURER: "legado-node", BRAND: "legado-node", DEVICE: "legado-node", PRODUCT: "legado-node", VERSION: { RELEASE: "0", SDK_INT: 0 } }
const legadoJavaLang = { String: legadoJavaLangString, StringBuilder: legadoStringBuilder, Integer: legadoInteger, Long: legadoLong, Double: legadoNumber, Float: legadoNumber, Boolean: { parseBoolean: (value) => String(value).toLowerCase() === "true" }, Character: { isDigit: (value) => /\d/u.test(String(value)), isLetter: (value) => /\p{L}/u.test(String(value)), toLowerCase: (value) => String(value).toLowerCase(), toUpperCase: (value) => String(value).toUpperCase() }, Math: legadoJavaMath, CharSequence: legadoJavaLangString, System: legadoJavaSystem, Thread: legadoJavaThread }
const legadoJavaCollectionValues = (value) => {
  if (Array.isArray(value)) return Array.from(value)
  if (value !== null && value !== undefined && typeof value.toArray === "function") return Array.from(value.toArray() ?? [])
  if (value !== null && value !== undefined && typeof value[Symbol.iterator] === "function") return Array.from(value)
  return []
}
const legadoJavaArrayLike = (value) => Array.isArray(value) || typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)
const legadoJavaListSize = (value) => Array.isArray(value) ? value.length : Number(value?.size?.() ?? 0)
const legadoJavaListGet = (value, index) => { const position = Number(index); const size = legadoJavaListSize(value); if (!Number.isInteger(position) || position < 0 || position >= size) throw new RangeError("List index out of bounds"); return typeof value?.get === "function" ? value.get(position) : value[position] }
const legadoJavaListSet = (value, index, item) => { const position = Number(index); const size = legadoJavaListSize(value); if (!Number.isInteger(position) || position < 0 || position >= size) throw new RangeError("List index out of bounds"); return typeof value?.set === "function" ? value.set(position, item) : (value[position] = item, undefined) }
const legadoJavaListAdd = (value, item) => { if (typeof value?.add === "function") return value.add(item); if (Array.isArray(value)) { value.push(item); return true } throw new TypeError("Collection is not mutable") }
const legadoJavaComparator = (comparator) => typeof comparator === "function" ? comparator : comparator?.compare ? (left, right) => comparator.compare(left, right) : (left, right) => left < right ? -1 : left > right ? 1 : 0
const legadoJavaArrayBounds = (value, from, to) => { const length = value?.length ?? 0; const start = from === undefined ? 0 : Number(from); const end = to === undefined ? length : Number(to); if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) throw new RangeError("Array index out of bounds"); return [start, end] }
const legadoJavaArrayText = (value, deep) => {
  if (value === null || value === undefined) return "null"
  if (!legadoJavaArrayLike(value)) return String(value)
  return "[" + value.map((item) => deep && Array.isArray(item) ? legadoJavaArrayText(item, true) : item === null || item === undefined ? "null" : String(item)).join(", ") + "]"
}
const legadoJavaReadOnlySet = (source) => {
  const values = () => legadoJavaCollectionValues(source)
  const unsupported = () => { throw new Error("Unsupported unmodifiable collection operation") }
  return {
    contains: (value) => values().some((item) => Object.is(item, value)),
    containsAll: (items) => legadoJavaCollectionValues(items).every((item) => values().some((value) => Object.is(value, item))),
    size: () => values().length,
    isEmpty: () => values().length === 0,
    toArray: () => values(),
    iterator: () => { const snapshot = values(); let index = 0; return { hasNext: () => index < snapshot.length, next: () => { if (index >= snapshot.length) throw new RangeError("No such element"); return snapshot[index++] }, remove: unsupported } },
    forEach: (callback) => { if (typeof callback === "function") values().forEach(callback); return undefined },
    add: unsupported,
    addAll: unsupported,
    remove: unsupported,
    removeAll: unsupported,
    retainAll: unsupported,
    clear: unsupported,
    toString: () => "[" + values().map((value) => value === null || value === undefined ? "null" : String(value)).join(", ") + "]",
  }
}
const legadoJavaReadOnlyMap = (source) => {
  const unsupported = () => { throw new Error("Unsupported unmodifiable map operation") }
  const get = (key) => typeof source?.get === "function" ? source.get(key) : Object.prototype.hasOwnProperty.call(source ?? {}, String(key)) ? source[String(key)] : null
  const keys = () => typeof source?.keySet === "function" ? source.keySet() : Object.keys(source ?? {})
  const values = () => typeof source?.values === "function" ? source.values() : Object.values(source ?? {})
  const entries = () => {
    if (typeof source?.entrySet === "function") return legadoJavaCollectionValues(source.entrySet()).map((entry) => { const key = typeof entry?.getKey === "function" ? entry.getKey() : entry?.[0]; return { getKey: () => key, getValue: () => get(key), setValue: unsupported } })
    return Object.keys(source ?? {}).map((key) => ({ getKey: () => key, getValue: () => source[key], setValue: unsupported }))
  }
  return {
    get,
    getOrDefault: (key, fallback) => { const present = typeof source?.containsKey === "function" ? source.containsKey(key) : Object.prototype.hasOwnProperty.call(source ?? {}, String(key)); return present ? get(key) : fallback },
    containsKey: (key) => typeof source?.containsKey === "function" ? source.containsKey(key) : Object.prototype.hasOwnProperty.call(source ?? {}, String(key)),
    containsValue: (value) => typeof source?.containsValue === "function" ? source.containsValue(value) : values().some((item) => Object.is(item, value)),
    size: () => typeof source?.size === "function" ? source.size() : Object.keys(source ?? {}).length,
    isEmpty: () => (typeof source?.isEmpty === "function" ? source.isEmpty() : Object.keys(source ?? {}).length === 0),
    keySet: () => legadoJavaReadOnlySet(keys()),
    values: () => legadoJavaReadOnlySet(values()),
    entrySet: () => legadoJavaReadOnlySet(entries()),
    forEach: (callback) => { if (typeof callback === "function") for (const entry of entries()) callback(entry.getKey(), entry.getValue(), source) },
    put: unsupported,
    putIfAbsent: unsupported,
    putAll: unsupported,
    remove: unsupported,
    replace: unsupported,
    replaceAll: unsupported,
    computeIfAbsent: unsupported,
    computeIfPresent: unsupported,
    merge: unsupported,
    clear: unsupported,
    toString: () => "{" + entries().map((entry) => String(entry.getKey()) + "=" + String(entry.getValue())).join(", ") + "}",
  }
}
const legadoJavaMapBackedSet = (map) => {
  if (typeof map?.size === "function" && map.size() !== 0) throw new Error("Map must be empty")
  const set = {
    add: (value) => { if (map.containsKey(value)) return false; map.put(value, true); return true },
    addAll: (items) => { let changed = false; for (const value of legadoJavaCollectionValues(items)) changed = set.add(value) || changed; return changed },
    contains: (value) => map.containsKey(value),
    containsAll: (items) => legadoJavaCollectionValues(items).every((value) => set.contains(value)),
    remove: (value) => map.containsKey(value) ? (map.remove(value), true) : false,
    removeAll: (items) => { let changed = false; for (const value of legadoJavaCollectionValues(items)) changed = set.remove(value) || changed; return changed },
    retainAll: (items) => { const keep = legadoJavaCollectionValues(items); let changed = false; for (const value of set.toArray()) if (!keep.some((item) => Object.is(item, value))) changed = set.remove(value) || changed; return changed },
    clear: () => map.clear(),
    size: () => map.size(),
    isEmpty: () => map.isEmpty(),
    toArray: () => legadoJavaCollectionValues(map.keySet()),
    iterator: () => { const iterator = map.keySet().iterator(); return { hasNext: () => iterator.hasNext(), next: () => iterator.next(), remove: () => iterator.remove() } },
    forEach: (callback) => { if (typeof callback === "function") set.toArray().forEach(callback); return undefined },
    toString: () => "[" + set.toArray().join(", ") + "]",
  }
  return set
}
const legadoJavaArrays = {
  asList: (value) => { const source = legadoJavaArrayLike(value) ? value : Array.from(value ?? []); return legadoListView(() => source, (index, item) => { const previous = source[index]; source[index] = item; return previous }, undefined, undefined, undefined) },
  toString: (value) => legadoJavaArrayText(value, false),
  deepToString: (value) => legadoJavaArrayText(value, true),
  equals: (left, right) => { const a = Array.from(left ?? []); const b = Array.from(right ?? []); return a.length === b.length && a.every((item, index) => Object.is(item, b[index])) },
  deepEquals: (left, right) => { const equal = (a, b) => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item, index) => equal(item, b[index])) : Object.is(a, b); return equal(left, right) },
  forEach: (value, callback) => { if (typeof callback === "function") legadoJavaCollectionValues(value).forEach(callback); return undefined },
  copyOf: (value, length) => { const size = Number(length); if (!Number.isInteger(size) || size < 0) throw new RangeError("negative array size"); return Array.from(value ?? []).slice(0, size).concat(Array(Math.max(0, size - (value?.length ?? 0))).fill(null)) },
  copyOfRange: (value, from, to) => { const source = Array.from(value ?? []); const start = Number(from); const end = Number(to); if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start > source.length) throw new RangeError("Array index out of bounds"); return source.slice(start, end).concat(Array(Math.max(0, end - Math.max(start, source.length))).fill(null)) },
  fill: function(value, fromOrItem, toOrItem, maybeItem) { if (!legadoJavaArrayLike(value)) return undefined; const [from, to, item] = arguments.length >= 4 ? [...legadoJavaArrayBounds(value, fromOrItem, toOrItem), maybeItem] : [0, value.length, fromOrItem]; for (let index = from; index < to; index++) value[index] = item; return undefined },
  sort: function(value, fromOrComparator, toOrComparator, maybeComparator) { if (!legadoJavaArrayLike(value)) return undefined; const range = typeof fromOrComparator === "number" ? legadoJavaArrayBounds(value, fromOrComparator, toOrComparator) : [0, value.length]; const comparator = arguments.length >= 4 ? maybeComparator : typeof fromOrComparator === "number" ? undefined : fromOrComparator; const sorted = Array.from(value.slice(range[0], range[1])).sort(legadoJavaComparator(comparator)); for (let index = 0; index < sorted.length; index++) value[range[0] + index] = sorted[index]; return undefined },
  binarySearch: function(value, first, second, third, fourth) { const ranged = arguments.length >= 4; const range = ranged ? legadoJavaArrayBounds(value, first, second) : [0, value.length]; const key = ranged ? third : first; const comparator = ranged ? fourth : second; const compare = legadoJavaComparator(comparator); let low = range[0]; let high = range[1] - 1; while (low <= high) { const middle = (low + high) >> 1; const result = compare(value[middle], key); if (result < 0) low = middle + 1; else if (result > 0) high = middle - 1; else return middle } return -low - 1 },
}
const legadoJavaCollections = {
  sort: (list, comparator) => { const values = legadoJavaCollectionValues(list).sort(legadoJavaComparator(comparator)); for (let index = 0; index < values.length; index++) legadoJavaListSet(list, index, values[index]); return undefined },
  reverse: (list) => { for (let left = 0, right = legadoJavaListSize(list) - 1; left < right; left++, right--) { const value = legadoJavaListGet(list, left); legadoJavaListSet(list, left, legadoJavaListGet(list, right)); legadoJavaListSet(list, right, value) } return undefined },
  shuffle: (list) => { for (let index = legadoJavaListSize(list) - 1; index > 0; index--) { const swap = Math.floor(Math.random() * (index + 1)); const value = legadoJavaListGet(list, index); legadoJavaListSet(list, index, legadoJavaListGet(list, swap)); legadoJavaListSet(list, swap, value) } return undefined },
  swap: (list, left, right) => { const first = legadoJavaListGet(list, left); legadoJavaListSet(list, left, legadoJavaListGet(list, right)); legadoJavaListSet(list, right, first); return undefined },
  max: (list, comparator) => { const values = legadoJavaCollectionValues(list); if (values.length === 0) throw new RangeError("No such element"); const compare = legadoJavaComparator(comparator); return values.slice(1).reduce((best, value) => compare(value, best) > 0 ? value : best, values[0]) },
  min: (list, comparator) => { const values = legadoJavaCollectionValues(list); if (values.length === 0) throw new RangeError("No such element"); const compare = legadoJavaComparator(comparator); return values.slice(1).reduce((best, value) => compare(value, best) < 0 ? value : best, values[0]) },
  binarySearch: (list, key, comparator) => legadoJavaArrays.binarySearch(legadoJavaCollectionValues(list), key, comparator),
  unmodifiableList: (list) => legadoListView(() => legadoJavaCollectionValues(list), undefined, undefined, undefined, undefined),
  unmodifiableSet: (set) => legadoJavaReadOnlySet(set),
  unmodifiableMap: (map) => legadoJavaReadOnlyMap(map),
  synchronizedList: (list) => list,
  synchronizedSet: (set) => set,
  synchronizedMap: (map) => map,
  newSetFromMap: (map) => legadoJavaMapBackedSet(map),
  singletonList: (value) => legadoJavaCollections.unmodifiableList([value]),
  singleton: (value) => legadoJavaCollections.unmodifiableSet(legadoSet([value])),
  singletonMap: (key, value) => legadoJavaCollections.unmodifiableMap(legadoMap({ [String(key)]: value })),
  emptyList: () => legadoJavaCollections.unmodifiableList([]),
  emptySet: () => legadoJavaCollections.unmodifiableSet(legadoSet([])),
  emptyMap: () => legadoJavaCollections.unmodifiableMap(legadoMap()),
  nCopies: (count, value) => { const size = Number(count); if (!Number.isInteger(size) || size < 0) throw new RangeError("Illegal collection size"); return legadoJavaCollections.unmodifiableList(Array(size).fill(value)) },
  addAll: (list, ...items) => { for (const item of items) legadoJavaListAdd(list, item); return items.length > 0 },
  fill: (list, value) => { for (let index = 0; index < legadoJavaListSize(list); index++) legadoJavaListSet(list, index, value); return undefined },
  copy: (destination, source) => { const values = legadoJavaCollectionValues(source); if (legadoJavaListSize(destination) < values.length) throw new RangeError("Source does not fit in destination"); for (let index = 0; index < values.length; index++) legadoJavaListSet(destination, index, values[index]); return undefined },
  frequency: (list, value) => legadoJavaCollectionValues(list).filter((item) => Object.is(item, value)).length,
  replaceAll: (list, oldValue, newValue) => { let changed = false; for (let index = 0; index < legadoJavaListSize(list); index++) if (Object.is(legadoJavaListGet(list, index), oldValue)) { legadoJavaListSet(list, index, newValue); changed = true } return changed },
  disjoint: (left, right) => { const values = legadoJavaCollectionValues(right); return legadoJavaCollectionValues(left).every((item) => !values.some((candidate) => Object.is(item, candidate))) },
  indexOfSubList: (list, subList) => { const values = legadoJavaCollectionValues(list); const sub = legadoJavaCollectionValues(subList); if (sub.length === 0) return 0; for (let index = 0; index <= values.length - sub.length; index++) if (sub.every((item, offset) => Object.is(values[index + offset], item))) return index; return -1 },
  lastIndexOfSubList: (list, subList) => { const values = legadoJavaCollectionValues(list); const sub = legadoJavaCollectionValues(subList); if (sub.length === 0) return values.length; for (let index = values.length - sub.length; index >= 0; index--) if (sub.every((item, offset) => Object.is(values[index + offset], item))) return index; return -1 },
}
const legadoJavaUtil = { HashMap: function(initial) { return legadoMap(initial) }, LinkedHashMap: function(initial) { return legadoMap(initial) }, ArrayList: function(initial) { return legadoList(initial) }, HashSet: function(initial) { return legadoSet(initial) }, LinkedHashSet: function(initial) { return legadoSet(initial) }, Arrays: legadoJavaArrays, Collections: legadoJavaCollections, Locale: legadoJavaLocale, regex: { Pattern: legadoPattern, Matcher: legadoMatcher }, Base64: legadoBase64 }
const legadoJavaZip = { GZIPInputStream: legadoGzipInputStream, InflaterInputStream: legadoInflaterInputStream, ZipInputStream: legadoZipInputStream }
const legadoJsoupParse = (input) => {
  const html = String(input ?? "")
  const select = (selector) => { const previous = legadoContent; try { legadoContent = html; return java.getElements(String(selector ?? "")) } finally { legadoContent = previous } }
  return { select, text: () => String(java.getString("@text", html) ?? ""), html: () => String(java.getString("@html", html) ?? ""), body: () => select("body")[0] ?? null, head: () => select("head")[0] ?? null, title: () => String(java.getString("title@text", html) ?? ""), toString: () => html }
}
const legadoJsoup = { parse: legadoJsoupParse }
const legadoJsoupConnection = { Method: { GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", HEAD: "HEAD", PATCH: "PATCH" } }
const legadoJsoupNodes = { Element: function(value) { return value } }
legadoJavaUtil.regex.Pattern = legadoPattern
legadoJavaUtil.regex.Matcher = legadoMatcher
const legadoJavaIo = { ByteArrayInputStream: legadoByteArrayInputStream, ByteArrayOutputStream: legadoByteArrayOutputStream, InputStreamReader: legadoInputStreamReader, BufferedReader: legadoBufferedReader }
const legadoJavaSecurity = { MessageDigest: legadoMessageDigest, Signature: legadoSignature, KeyFactory: legadoKeyFactory, spec: { PKCS8EncodedKeySpec: legadoEncodedKeySpec, X509EncodedKeySpec: legadoEncodedKeySpec }, interfaces: {} }
const legadoStandardCharsets = { UTF_8: "UTF-8", UTF_16: "UTF-16", ISO_8859_1: "ISO-8859-1" }
const legadoName = (value, name) => { try { Object.defineProperty(value, "__legadoName", { value: name, configurable: false, enumerable: false }); } catch {} return value }
for (const [name, value] of Object.entries(legadoJavaLang)) legadoName(value, name)
for (const [name, value] of Object.entries(legadoJavaUtil)) legadoName(value, name)
for (const [name, value] of Object.entries(legadoJavaIo)) legadoName(value, name)
legadoName(legadoJavaUtil.regex.Pattern, "Pattern")
legadoName(legadoJavaUtil.regex.Matcher, "Matcher")
legadoName(legadoJavaSecurity.MessageDigest, "MessageDigest")
legadoName(legadoBase64, "Base64")
legadoName(legadoByteArrayInputStream, "ByteArrayInputStream")
legadoName(legadoByteArrayOutputStream, "ByteArrayOutputStream")
legadoName(legadoInputStreamReader, "InputStreamReader")
legadoName(legadoBufferedReader, "BufferedReader")
legadoName(legadoBigInteger, "BigInteger")
legadoName(legadoBigDecimal, "BigDecimal")
legadoName(legadoJavaUUID, "UUID")
legadoName(legadoJavaSystem, "System")
legadoName(legadoJavaThread, "Thread")
legadoName(legadoAndroidTextUtils, "TextUtils")
legadoName(legadoAndroidBuild, "Build")
legadoName(legadoJavaZip.GZIPInputStream, "GZIPInputStream")
legadoName(legadoJavaZip.InflaterInputStream, "InflaterInputStream")
legadoName(legadoJavaZip.ZipInputStream, "ZipInputStream")
legadoName(legadoIvParameterSpec, "IvParameterSpec")
legadoName(legadoGcmParameterSpec, "GCMParameterSpec")
legadoName(legadoMgf1ParameterSpec, "MGF1ParameterSpec")
legadoName(legadoPSourceSpecified, "PSpecified")
legadoName(legadoOaepParameterSpec, "OAEPParameterSpec")
legadoName(legadoDesKeySpec, "DESKeySpec")
legadoName(legadoSecretKeyFactory, "SecretKeyFactory")
legadoName(legadoCipher, "Cipher")
legadoName(legadoEncodedKeySpec, "PKCS8EncodedKeySpec")
legadoName(legadoKeyFactory, "KeyFactory")
legadoName(legadoSignature, "Signature")
legadoName(legadoJsoup, "Jsoup")
legadoName(legadoJsoupNodes.Element, "Element")
legadoName(legadoSecretKeySpec, "SecretKeySpec")
legadoName(legadoMac, "Mac")
legadoName(legadoDatatypeConverter, "DatatypeConverter")
legadoName(legadoUrlEncoder, "URLEncoder")
legadoName(legadoAndroidBase64, "Base64")
const legadoHutoolBase64 = {
  encode: (value) => request({ kind: "base64-encode", value: value instanceof Uint8Array || value instanceof ArrayBuffer ? value : String(value ?? ""), flags: 2 }),
  decode: (value) => request({ kind: "base64-decode-bytes", value: String(value ?? ""), flags: 0 }),
  decodeStr: (value, charset) => request({ kind: "base64-decode-text", value: String(value ?? ""), charset: charset === undefined ? "UTF-8" : String(charset), flags: 0 }),
  isBase64: (value) => { try { request({ kind: "base64-decode-bytes", value: String(value ?? ""), flags: 0 }); return true } catch { return false } },
}
const legadoHutoolStrUtil = {
  reverse: (value) => Array.from(String(value ?? "")).reverse().join(""),
  isBlank: (value) => value == null || String(value).trim().length === 0,
  isNotBlank: (value) => value != null && String(value).trim().length > 0,
}
const legadoHutoolHexUtil = {
  encodeHexStr: (value) => request({ kind: "hex-encode", value }),
  decodeHex: (value) => request({ kind: "hex-decode-bytes", value: String(value ?? "") }),
  isHexNumber: (value) => /^[0-9a-f]+$/iu.test(String(value ?? "")),
}
const legadoHutoolDigest = (algorithm, value) => request({ kind: "digest", value, algorithm })
const legadoHutoolDigestBytes = (algorithm, value) => request({ kind: "hex-decode-bytes", value: legadoHutoolDigest(algorithm, value) })
const legadoHutoolDigestUtil = {
  md5Hex: (value) => legadoHutoolDigest("MD5", value),
  sha1Hex: (value) => legadoHutoolDigest("SHA-1", value),
  sha256Hex: (value) => legadoHutoolDigest("SHA-256", value),
  sha512Hex: (value) => legadoHutoolDigest("SHA-512", value),
  md5: (value) => legadoHutoolDigestBytes("MD5", value),
  sha1: (value) => legadoHutoolDigestBytes("SHA-1", value),
  sha256: (value) => legadoHutoolDigestBytes("SHA-256", value),
  digestHex: (algorithm, value) => legadoHutoolDigest(algorithm, value),
  digest: (algorithm, value) => legadoHutoolDigestBytes(algorithm, value),
  digester: (algorithm) => ({ digestHex: (value) => legadoHutoolDigest(algorithm, value), digest: (value) => legadoHutoolDigestBytes(algorithm, value) }),
}
const legadoHutoolZipUtil = {
  gzip: (value) => request({ kind: "gzip-encode", value: value instanceof Uint8Array || value instanceof ArrayBuffer ? value : request({ kind: "encode-bytes", value: String(value ?? ""), charset: "UTF-8" }) }),
}
const legadoOkHttpMediaType = function(value) { const type = String(value ?? ""); return { type, toString: () => type } }
legadoOkHttpMediaType.parse = (value) => legadoOkHttpMediaType(value)
const legadoOkHttpRequestBody = function(value, mediaType) {
  const raw = value == null ? "" : value
  const bytes = () => raw instanceof Uint8Array || raw instanceof ArrayBuffer ? (raw instanceof Uint8Array ? raw : new Uint8Array(raw)) : request({ kind: "encode-bytes", value: String(raw), charset: "UTF-8" })
  const body = { __legadoOkHttpBody: true, value: raw, mediaType: mediaType ?? null, contentType: () => mediaType ?? null, contentLength: () => bytes().byteLength, bytes, string: () => raw instanceof Uint8Array || raw instanceof ArrayBuffer ? request({ kind: "decode-bytes", value: bytes(), charset: "UTF-8" }) : String(raw) }
  return body
}
const legadoOkHttpHeaders = (value) => legadoResponseHeaders(value)
const legadoOkHttpHeaderMap = (value) => {
  const source = value && typeof value === "object" ? value : {}
  const result = {}
  for (const [name, item] of Object.entries(source)) result[String(name)] = Array.isArray(item) ? item.map((entry) => String(entry ?? "")).join(",") : String(item ?? "")
  return result
}
const legadoOkHttpRequestBuilder = function() {
  let target = ""
  let method = "GET"
  let body = null
  const headers = {}
  const findHeader = (name) => Object.keys(headers).find((key) => key.toLowerCase() === String(name).toLowerCase())
  const builder = {
    url: (value) => { target = String(value ?? ""); return builder },
    get: () => { method = "GET"; body = null; return builder },
    head: () => { method = "HEAD"; body = null; return builder },
    post: (value) => { method = "POST"; body = value; return builder },
    put: (value) => { method = "PUT"; body = value; return builder },
    delete: (value) => { method = "DELETE"; body = value ?? null; return builder },
    method: (value, valueBody) => { method = String(value ?? "GET").toUpperCase(); body = valueBody ?? null; return builder },
    header: (name, value) => { const previous = findHeader(name); if (previous !== undefined && previous !== String(name)) delete headers[previous]; headers[String(name)] = String(value ?? ""); return builder },
    addHeader: (name, value) => { const key = findHeader(name) ?? String(name); if (Object.prototype.hasOwnProperty.call(headers, key)) headers[key] = Array.isArray(headers[key]) ? [...headers[key], String(value ?? "")] : [headers[key], String(value ?? "")]; else headers[key] = String(value ?? ""); return builder },
    removeHeader: (name) => { const key = findHeader(name); if (key !== undefined) delete headers[key]; return builder },
    build: () => {
      if (target.trim().length === 0) throw new Error("OkHttp Request URL is missing")
      const request = { url: () => target, method: () => method, headers: () => legadoOkHttpHeaders(headers), body: () => body, __legadoUrl: target, __legadoMethod: method, __legadoHeaders: headers, __legadoBody: body }
      return request
    },
  }
  return builder
}
const legadoOkHttpResponse = (raw, requestValue) => {
  const response = raw && typeof raw === "object" ? raw : legadoResponseCompat(String(requestValue?.__legadoUrl ?? ""), raw)
  const getBody = () => typeof response.body === "function" ? response.body() : response.body
  const getBytes = () => typeof response.bodyAsBytes === "function" ? response.bodyAsBytes() : response.bytes instanceof Uint8Array ? response.bytes : request({ kind: "encode-bytes", value: String(getBody() ?? ""), charset: "UTF-8" })
  const getHeaders = () => typeof response.headers === "function" ? response.headers() : legadoOkHttpHeaders(response.headers)
  const code = () => typeof response.code === "function" ? Number(response.code()) : Number(response.status ?? response.code ?? 200)
  const message = () => typeof response.message === "function" ? String(response.message() ?? "") : String(response.message ?? response.statusMessage ?? "")
  const body = { string: () => String(getBody() ?? ""), bytes: getBytes, contentLength: () => getBytes().byteLength, contentType: () => { const value = getHeaders()?.get?.("content-type"); return value == null ? null : legadoOkHttpMediaType(value) }, close: () => undefined }
  return { request: () => requestValue, body: () => body, code, message, headers: getHeaders, isSuccessful: () => code() >= 200 && code() < 300, close: () => undefined, cacheResponse: () => null, networkResponse: () => null, priorResponse: () => null, toString: () => (String(code()) + " " + message()).trim() }
}
const legadoOkHttpClient = function() {
  return {
    newCall: (requestValue) => ({ execute: () => {
      const target = String(requestValue?.__legadoUrl ?? requestValue?.url?.() ?? "")
      const method = String(requestValue?.__legadoMethod ?? requestValue?.method?.() ?? "GET").toUpperCase()
      const headers = legadoOkHttpHeaderMap(requestValue?.__legadoHeaders ?? requestValue?.headers?.())
      const bodyObject = requestValue?.__legadoBody?.__legadoOkHttpBody === true ? requestValue.__legadoBody : null
      const bodyValue = bodyObject === null ? requestValue?.__legadoBody : bodyObject.value
      const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
      if (bodyObject !== null && bodyObject.mediaType !== null && bodyObject.mediaType !== undefined && !hasContentType) {
        headers["Content-Type"] = String(bodyObject.mediaType?.toString?.() ?? bodyObject.mediaType?.type ?? bodyObject.mediaType)
      }
      const raw = method === "POST" ? java.post(target, bodyValue, headers) : method === "HEAD" ? java.head(target, headers) : method === "GET" ? java.get(target, headers) : java.ajax({ url: target, method, headers, body: bodyValue })
      return legadoOkHttpResponse(raw, requestValue)
    } }),
  }
}
const legadoOkHttpPackage = { MediaType: legadoOkHttpMediaType, RequestBody: { create: function(value, mediaType) { return value && typeof value === "object" && value.type !== undefined ? legadoOkHttpRequestBody(mediaType, value) : legadoOkHttpRequestBody(value, mediaType) } }, Request: { Builder: legadoOkHttpRequestBuilder }, OkHttpClient: legadoOkHttpClient, Headers: { of: (value) => legadoOkHttpHeaders(value) } }
legadoName(legadoHutoolBase64, "Base64")
legadoName(legadoHutoolStrUtil, "StrUtil")
legadoName(legadoHutoolHexUtil, "HexUtil")
legadoName(legadoHutoolDigestUtil, "DigestUtil")
legadoName(legadoHutoolZipUtil, "ZipUtil")
legadoName(legadoOkHttpMediaType, "MediaType")
legadoName(legadoOkHttpRequestBody, "RequestBody")
legadoName(legadoOkHttpRequestBuilder, "Builder")
legadoName(legadoOkHttpClient, "OkHttpClient")
legadoName(legadoOkHttpPackage.RequestBody, "RequestBody")
legadoName(legadoOkHttpPackage.Request, "Request")
legadoName(legadoOkHttpPackage.Headers, "Headers")
const legadoExistingPackages = globalThis.Packages
legadoJavaUtil.UUID = legadoJavaUUID
legadoName(legadoJavaUtil.UUID, "UUID")
legadoName(legadoJavaSecurity.spec.PKCS8EncodedKeySpec, "PKCS8EncodedKeySpec")
legadoName(legadoJavaSecurity.spec.X509EncodedKeySpec, "X509EncodedKeySpec")
const legadoPackages = { java: { lang: legadoJavaLang, math: { BigInteger: legadoBigInteger, BigDecimal: legadoBigDecimal, MathContext: function(precision) { return { precision: Number(precision) } } }, util: { ...legadoJavaUtil, zip: legadoJavaZip }, security: legadoJavaSecurity, nio: { charset: { StandardCharsets: legadoStandardCharsets } }, net: { URLEncoder: legadoUrlEncoder, URL: function(value, base) { return java.toURL(value, base) } }, io: legadoJavaIo }, javax: { crypto: { Cipher: legadoCipher, Mac: legadoMac, SecretKeyFactory: legadoSecretKeyFactory, spec: { SecretKeySpec: legadoSecretKeySpec, IvParameterSpec: legadoIvParameterSpec, GCMParameterSpec: legadoGcmParameterSpec, OAEPParameterSpec: legadoOaepParameterSpec, PSource: legadoPSource, DESKeySpec: legadoDesKeySpec } }, xml: { bind: { DatatypeConverter: legadoDatatypeConverter } }, }, android: { util: { Base64: legadoAndroidBase64 }, text: { TextUtils: legadoAndroidTextUtils }, os: { Build: legadoAndroidBuild } }, org: { jsoup: { Jsoup: legadoJsoup, Connection: legadoJsoupConnection, nodes: legadoJsoupNodes } }, okhttp3: legadoOkHttpPackage, cn: { hutool: { core: { codec: { Base64: legadoHutoolBase64 }, util: { StrUtil: legadoHutoolStrUtil, HexUtil: legadoHutoolHexUtil, ZipUtil: legadoHutoolZipUtil } }, crypto: { digest: { DigestUtil: legadoHutoolDigestUtil } } } } }
legadoPackages.java.security.spec.MGF1ParameterSpec = legadoMgf1ParameterSpec
legadoName(legadoPackages.java.nio.charset.StandardCharsets, "StandardCharsets")
legadoName(legadoPackages.java.net.URL, "URL")
if (legadoExistingPackages && legadoExistingPackages.io) legadoPackages.io = legadoExistingPackages.io
globalThis.Packages = legadoPackages
globalThis.org = legadoPackages.org
globalThis.javax = legadoPackages.javax
globalThis.android = legadoPackages.android
java.lang = legadoPackages.java.lang
java.util = legadoPackages.java.util
java.security = legadoPackages.java.security
java.io = legadoPackages.java.io
java.net = legadoPackages.java.net
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
Object.defineProperties(globalThis.infoMap, { remove: { value: (key) => { const name = String(key); const previous = Object.prototype.hasOwnProperty.call(globalThis.infoMap, name) ? globalThis.infoMap[name] : null; delete globalThis.infoMap[name]; return previous } }, clear: { value: () => { for (const key of Object.keys(globalThis.infoMap)) delete globalThis.infoMap[key] } }, containsKey: { value: (key) => Object.prototype.hasOwnProperty.call(globalThis.infoMap, String(key)) }, size: { value: () => Object.keys(globalThis.infoMap).length }, isEmpty: { value: () => Object.keys(globalThis.infoMap).length === 0 } })
java.setBaseUrl = (value) => { if (value !== null && value !== undefined) globalThis.baseUrl = String(value); return java }
let __legadoRedirectUrlObject = null
const __legadoCurrentRedirectUrl = () => {
  if (__legadoRedirectUrlObject !== null) return __legadoRedirectUrlObject
  const current = String(globalThis.redirectUrl ?? "").trim()
  if (current.length === 0) return null
  try {
    __legadoRedirectUrlObject = java.toURL(current)
  } catch {}
  return __legadoRedirectUrlObject
}
java.setRedirectUrl = (value) => {
  const raw = String(value ?? "")
  if (/^data:.*?;base64,/u.test(raw)) return __legadoCurrentRedirectUrl()
  try {
    const parsed = java.toURL(raw)
    __legadoRedirectUrlObject = parsed
    globalThis.redirectUrl = String(parsed?.url ?? raw)
    return parsed
  } catch {
    return __legadoCurrentRedirectUrl()
  }
}
const __legadoLocal = {}
java.setLocal = (key, value) => { __legadoLocal[String(key)] = value; return java }
java.getLocal = (key) => __legadoLocal[String(key)]
java.evalJS = (code, extra) => request({ kind: "source-eval-js", value: String(code ?? ""), input: { __legadoEvalResult: extra } })
java.reGetBook = () => request({ kind: "workflow-action", action: "reGetBook", input: globalThis.book })
java.refreshTocUrl = () => request({ kind: "workflow-action", action: "refreshTocUrl", input: globalThis.book })
const __legadoGetString = java.getString
java.getString = (rule, content, isUrl) => typeof content === "boolean" && isUrl === undefined ? __legadoGetString(rule, content, undefined) : __legadoGetString(rule, content, isUrl)
const __legadoGetStringList = java.getStringList
java.getStringList = (rule, content, isUrl) => rule == null || String(rule).trim().length === 0 ? null : legadoList(__legadoGetStringList(rule, content, isUrl))
const __legadoGetElements = java.getElements
java.getElements = (rule) => rule == null || String(rule).trim().length === 0 ? [] : legadoList(__legadoGetElements(rule))
const __legadoGetFile = java.getFile
const __legadoDecorateFile = (value, fallbackPath) => {
  const pathValue = String(fallbackPath ?? "")
  const target = value !== null && typeof value === "object" ? value : { path: pathValue, absolutePath: pathValue, name: pathValue.split("/").at(-1) ?? "" }
  const filePath = () => String(target.path ?? pathValue)
  const refresh = () => legadoFileRequest("getFile", { path: filePath() }) ?? target
  const infoValue = (name, fallback) => {
    const current = refresh()
    return current !== null && typeof current === "object" ? current[name] ?? fallback : fallback
  }
  Object.defineProperties(target, {
    exists: { configurable: true, value: () => Boolean(infoValue("exists", false)) },
    isFile: { configurable: true, value: () => Boolean(infoValue("isFile", false)) },
    isDirectory: { configurable: true, value: () => Boolean(infoValue("isDirectory", false)) },
    getName: { configurable: true, value: () => String(infoValue("name", filePath().split("/").at(-1) ?? "")) },
    getPath: { configurable: true, value: () => String(infoValue("path", filePath())) },
    getAbsolutePath: { configurable: true, value: () => {
      const current = refresh()
      return String(current !== null && typeof current === "object" ? current.absolutePath ?? current.path ?? filePath() : filePath())
    } },
    length: { configurable: true, value: () => Number(infoValue("length", 0)) },
    lastModified: { configurable: true, value: () => Number(infoValue("lastModified", 0)) },
    canRead: { configurable: true, value: () => Boolean(infoValue("exists", false)) },
    canWrite: { configurable: true, value: () => Boolean(infoValue("exists", false)) },
    listFiles: { configurable: true, value: () => { const listed = legadoFileRequest("listFiles", { path: filePath() }); const items = Array.isArray(listed) ? listed : listed?.toArray?.() ?? []; return legadoList(items.map((item) => __legadoDecorateFile(item, item !== null && typeof item === "object" ? item.path : ""))) } },
  })
  return target
}
java.getFile = (path) => __legadoDecorateFile(__legadoGetFile(path), path)
const __legadoToURLCompat = java.toURL
java.toURL = (value, base) => {
  const result = __legadoToURLCompat(value, base)
  if (result === null || typeof result !== "object") return result
  const __legadoURLText = String(result.url ?? "")
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(__legadoURLText)) throw new Error("Malformed URL")
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
  const __legadoURLPort = String(result.port ?? "")
  const __legadoURLProtocol = String(result.protocol ?? "").toLowerCase()
  const __legadoURLDefaultPort = __legadoURLProtocol === "http:" ? 80 : __legadoURLProtocol === "https:" ? 443 : __legadoURLProtocol === "ftp:" ? 21 : -1
  Object.assign(result, {
    getProtocol: () => String(result.protocol ?? "").replace(/:$/u, ""),
    getHost: () => String(result.host ?? ""),
    getPort: () => __legadoURLPort.length === 0 ? -1 : Number(__legadoURLPort),
    getDefaultPort: () => __legadoURLDefaultPort,
    getPath: () => String(result.pathname ?? ""),
    getQuery: () => String(result.query ?? "") || null,
    getRef: () => { const value = String(result.hash ?? ""); return value.length > 0 ? value.slice(1) : null },
    getFile: () => String(result.file ?? String(result.pathname ?? "") + String(result.search ?? "")),
    getAuthority: () => String(result.authority ?? result.host ?? ""),
    getUserInfo: () => String(result.userInfo ?? "") || null,
  })
  const query = String(result.query ?? "")
  const entries = []
  const decode = (item) => { try { return decodeURIComponent(String(item).replaceAll("+", " ")) } catch { return String(item) } }
  const encode = (item) => encodeURIComponent(String(item)).replaceAll("%20", "+")
  for (const part of query.split("&")) {
    if (part.length === 0) continue
    const index = part.indexOf("=")
    entries.push([index < 0 ? part : part.slice(0, index), decode(index < 0 ? "" : part.slice(index + 1))])
  }
  const params = result.searchParams && typeof result.searchParams === "object" ? result.searchParams : null
  if (params === null) return result
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
  const __legadoUrlMapPut = (key, value) => { const name = __legadoMapKey(key); const current = __legadoUrlContext.headerMap ?? {}; const previous = Object.prototype.hasOwnProperty.call(current, name) ? current[name] : null; __legadoUrlContext.headerMap = { ...current, [name]: String(value ?? "") }; __legadoSyncUrlMap(); return previous }
  const __legadoUrlMapRemove = (key) => { const name = __legadoMapKey(key); const current = __legadoUrlContext.headerMap ?? {}; const previous = Object.prototype.hasOwnProperty.call(current, name) ? current[name] : null; if (Object.prototype.hasOwnProperty.call(current, name)) { const next = { ...current }; delete next[name]; __legadoUrlContext.headerMap = next } __legadoSyncUrlMap(); return previous }
  const __legadoUrlMapEntries = (value) => { if (value !== null && typeof value === "object" && typeof value.entrySet === "function") { const entries = value.entrySet(); const iterator = entries?.iterator?.(); const result = []; if (iterator) while (iterator.hasNext()) { const entry = iterator.next(); result.push([typeof entry?.getKey === "function" ? entry.getKey() : entry?.key, typeof entry?.getValue === "function" ? entry.getValue() : entry?.value]); } return result } return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [] }
  const __legadoUrlMapPutAll = (value) => { for (const [key, item] of __legadoUrlMapEntries(value)) __legadoUrlMapPut(key, item); return __legadoUrlMap }
  const __legadoUrlMapEntry = (key) => ({ getKey: () => key, getValue: () => __legadoUrlContext.headerMap?.[key] ?? null, setValue: (value) => __legadoUrlMapPut(key, value) })
  Object.defineProperties(__legadoUrlMap, { get: { value: (key) => { const name = __legadoMapKey(key); return Object.prototype.hasOwnProperty.call(__legadoUrlContext.headerMap ?? {}, name) ? __legadoUrlContext.headerMap?.[name] : null } }, put: { value: __legadoUrlMapPut }, putAll: { value: __legadoUrlMapPutAll }, remove: { value: __legadoUrlMapRemove }, clear: { value: () => { __legadoUrlContext.headerMap = {}; __legadoSyncUrlMap() } }, containsKey: { value: (key) => Object.prototype.hasOwnProperty.call(__legadoUrlContext.headerMap ?? {}, __legadoMapKey(key)) }, containsValue: { value: (value) => Object.values(__legadoUrlContext.headerMap ?? {}).some((item) => item === String(value ?? "")) }, getOrDefault: { value: (key, fallback) => { const name = __legadoMapKey(key); return Object.prototype.hasOwnProperty.call(__legadoUrlContext.headerMap ?? {}, name) ? __legadoUrlContext.headerMap?.[name] : fallback } }, values: { value: () => legadoList(Object.values(__legadoUrlContext.headerMap ?? {})) }, entrySet: { value: () => legadoList(Object.keys(__legadoUrlContext.headerMap ?? {}).map(__legadoUrlMapEntry)) }, size: { value: () => Object.keys(__legadoUrlContext.headerMap ?? {}).length }, isEmpty: { value: () => Object.keys(__legadoUrlContext.headerMap ?? {}).length === 0 }, keySet: { value: () => legadoList(Object.keys(__legadoUrlContext.headerMap ?? {})) }, forEach: { value: (callback) => { if (typeof callback === "function") for (const [key, value] of Object.entries(__legadoUrlContext.headerMap ?? {})) callback(key, value, __legadoUrlMap) } } })
  __legadoSyncUrlMap()
  Object.defineProperties(java, { ruleUrl: { configurable: true, get: () => String(__legadoUrlContext.ruleUrl ?? "") }, url: { configurable: true, get: () => String(__legadoUrlContext.url ?? ""), set: (value) => { __legadoUrlContext.url = String(value ?? ""); __legadoUrlContext.urlDirty = true } }, headerMap: { configurable: true, get: () => __legadoUrlMap } })
  java.getHeaderMap = () => __legadoUrlMap
  java.initUrl = () => { const value = String(__legadoUrlContext.ruleUrl ?? __legadoUrlContext.url ?? ""); __legadoUrlContext.url = value; __legadoUrlContext.urlDirty = true }
  const __legadoResponseHeaders = (headers) => legadoResponseHeaders(headers)
  const __legadoStrResponse = (raw) => { const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; const target = String(record.url ?? __legadoUrlContext.url ?? ""); const body = String(record.body ?? raw ?? ""); const status = Number(record.status ?? record.code ?? 200); const headers = record.headers ?? {}; const message = String(record.message ?? record.statusMessage ?? ""); const headersValue = __legadoResponseHeaders(headers); const response = { body, status, code: status, url: target, headers: headersValue, redirected: Boolean(record.redirected), bytes: record.bytes }; Object.defineProperty(response, "__legadoResponseType", { value: "StrResponse", enumerable: false, configurable: false }); const rawResponse = { request: () => ({ url: () => String(record.requestUrl ?? target), method: () => String(record.requestMethod ?? "GET"), headers: () => __legadoResponseHeaders(record.requestHeaders ?? {}) }), url: () => target, code: () => status, statusCode: () => status, message: () => message, headers: () => __legadoResponseHeaders(headers), header: (name) => __legadoResponseHeaders(headers).get(name), isSuccessful: () => status >= 200 && status < 300 }; Object.defineProperties(rawResponse, { request: { value: rawResponse.request, configurable: true }, url: { value: rawResponse.url, configurable: true }, code: { value: rawResponse.code, configurable: true }, statusCode: { value: rawResponse.statusCode, configurable: true }, message: { value: rawResponse.message, configurable: true }, headers: { value: rawResponse.headers, configurable: true }, header: { value: rawResponse.header, configurable: true }, isSuccessful: { value: rawResponse.isSuccessful, configurable: true } }); Object.defineProperties(response, { statusCode: { value: () => status, configurable: true }, message: { value: () => message, configurable: true }, header: { value: (name) => __legadoResponseHeaders(headers).get(name), configurable: true }, isSuccessful: { value: () => status >= 200 && status < 300, configurable: true }, bodyAsBytes: { value: () => record.bytes instanceof Uint8Array ? record.bytes : record.bodyBytes instanceof Uint8Array ? record.bodyBytes : request({ kind: "encode-bytes", value: body, charset: "UTF-8" }), configurable: true }, errorBody: { value: () => record.errorBody ?? null, configurable: true }, callTime: { value: () => Number(record.callTime ?? 0), configurable: true }, raw: { value: () => rawResponse, configurable: true }, toString: { value: () => String(status) + " " + message, configurable: true } }); Object.defineProperties(response, { body: { value: __legadoCallableResponseValue(body), enumerable: true, configurable: true }, code: { value: __legadoCallableResponseValue(status), enumerable: true, configurable: true }, url: { value: __legadoCallableResponseValue(target), enumerable: true, configurable: true }, headers: { value: __legadoCallableResponseValue(headersValue), enumerable: true, configurable: true }, callTime: { value: __legadoCallableResponseValue(Number(record.callTime ?? 0)), enumerable: true, configurable: true }, errorBody: { value: __legadoCallableResponseValue(record.errorBody ?? null), enumerable: true, configurable: true }, raw: { value: __legadoCallableResponseValue(rawResponse), enumerable: true, configurable: true } }); return response }
  const __legadoUrlRequest = (kind, jsStr, sourceRegex, useWebView) => request({ kind: "url-context-response", input: { url: String(__legadoUrlContext.url ?? ""), headers: { ...(__legadoUrlContext.headerMap ?? {}) }, body: __legadoUrlContext.body, method: __legadoUrlContext.method, options: __legadoUrlContext.options, baseUrl: __legadoUrlContext.baseUrl, redirectUrl: __legadoUrlContext.redirectUrl, responseKind: kind, jsStr, sourceRegex, useWebView: useWebView !== false } })
  java.getStrResponse = (jsStr, sourceRegex, useWebView) => __legadoStrResponse(__legadoUrlRequest("string", jsStr, sourceRegex, useWebView))
  java.getResponse = () => legadoResponseCompat(String(__legadoUrlContext.url ?? ""), __legadoUrlRequest("response"))
  java.getHeaderMap = () => __legadoUrlMap
}
globalThis.__legadoJavaPackages = { JavaImporter, Packages, JavaAdapter, MessageDigest: legadoMessageDigest, StringBuilder: legadoStringBuilder, Integer: legadoInteger, HashMap: legadoJavaUtil.HashMap, ArrayList: legadoJavaUtil.ArrayList, Pattern: legadoPattern, Matcher: legadoMatcher, Base64: legadoBase64, Locale: legadoJavaLocale }
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
java.getElement = (rule) => { if (rule == null || String(rule).trim().length === 0) return null; const result = evaluateRule(String(rule), { expect: "nodes", content: legadoContent }); return Array.isArray(result) ? __legadoElementsGraph(result) : __legadoNodeGraph(result) }
java.getElements = (rule) => rule == null || String(rule).trim().length === 0 ? [] : __legadoElementsGraph(evaluateRule(String(rule), { expect: "nodes", content: legadoContent }))
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

type DigestAlgorithmName = 'md5' | 'sha1' | 'sha256' | 'sha512' | 'sm3'

function digestAlgorithm(value: unknown): DigestAlgorithmName {
  const normalized = textValue(value).toLowerCase().replace(/[^a-z0-9]/gu, '')
  if (normalized === 'md5' || normalized === 'hmacmd5') return 'md5'
  if (normalized === 'sha1' || normalized === 'hmacsha1') return 'sha1'
  if (normalized === 'sha256' || normalized === 'hmacsha256') return 'sha256'
  if (normalized === 'sha512' || normalized === 'hmacsha512') return 'sha512'
  if (normalized === 'sm3' || normalized === 'hmacsm3') return 'sm3'
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

function escapeLegacyCssIdentifier(value: string): string {
  let output = ''
  const characters = [...value]
  for (const [index, character] of characters.entries()) {
    const codePoint = character.codePointAt(0) ?? 0
    const first = index === 0
    const nextCodePoint = characters[index + 1]?.codePointAt(0)
    const asciiLetter = (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)
    const digit = codePoint >= 0x30 && codePoint <= 0x39
    const leadingHyphenDigit = first && codePoint === 0x2d && nextCodePoint !== undefined && nextCodePoint >= 0x30 && nextCodePoint <= 0x39
    const loneHyphen = value.length === 1 && codePoint === 0x2d
    const safe = asciiLetter || codePoint >= 0x80 || codePoint === 0x5f || (codePoint === 0x2d && !leadingHyphenDigit && !loneHyphen) || (!first && digit)
    if (safe) output += character
    else output += `\\${codePoint.toString(16)} `
  }
  return output
}

function normalizeSelector(selector: string): string {
  const position = parseBracketSelection(selector) ?? parseLegacySelection(selector)
  const legacyPrefix = /^(?:class|tag|id)\./u.test(selector)
  const attributeStart = legacyPrefix ? selector.indexOf('[') : -1
  const base = position?.base ?? (attributeStart >= 0 ? selector.slice(0, attributeStart) : selector)
  const suffix = position !== undefined ? selector.slice(base.length) : attributeStart >= 0 ? selector.slice(attributeStart) : ''
  if (base.startsWith('class.')) {
    const classNames = base.slice('class.'.length).trim().split(/\s+/u).filter(Boolean)
    return (classNames.length === 0 ? '.' : classNames.map((className) => `.${escapeLegacyCssIdentifier(className)}`).join('')) + suffix
  }
  if (base.startsWith('tag.')) return escapeLegacyCssIdentifier(base.slice('tag.'.length)) + suffix
  if (base.startsWith('id.')) return `#${escapeLegacyCssIdentifier(base.slice('id.'.length))}` + suffix
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
  private readonly compression?: SourceRuleRuntimeOptions['compression']
  private readonly timeFormat?: SourceRuleRuntimeOptions['timeFormat']
  private readonly timeFormatUTC?: SourceRuleRuntimeOptions['timeFormatUTC']
  private readonly randomUUID?: SourceRuleRuntimeOptions['randomUUID']
  private readonly sourceState?: SourceRuleRuntimeOptions['sourceState']
  private readonly file?: SourceRuleRuntimeOptions['file']
  private readonly webViewUA?: SourceRuleRuntimeOptions['webViewUA']
  private readonly logger?: SourceRuleRuntimeOptions['logger']
  private readonly platform?: SourceRuleRuntimeOptions['platform']
  private readonly concurrency?: SourceRuleRuntimeOptions['concurrency']
  private readonly jsLibSessionId: string
  private readonly sessionLoginHeaders = new Map<string, string>()
  private readonly sessionLoginInfo = new Map<string, string>()
  private readonly sessionSourceVariables = new Map<string, string>()
  private readonly sessionSourceValues = new Map<string, Map<string, string>>()
  private readonly jsLibClearGenerations = new Map<string, number>()
  private readonly jsLibStateQueues = new Map<string, Promise<void>>()
  private readonly activeJsLibOwners = new WeakSet<object>()
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
    this.compression = options.compression
    this.timeFormat = options.timeFormat
    this.timeFormatUTC = options.timeFormatUTC
    this.randomUUID = options.randomUUID
    this.sourceState = options.sourceState
    this.file = options.file
    this.webViewUA = options.webViewUA
    this.logger = options.logger
    this.platform = options.platform
    this.concurrency = options.concurrency
    this.jsLibSessionId = options.jsLibSessionId ?? 'runtime'
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

  private async acquireJsLibStateLock(key: string, signal: AbortSignal): Promise<() => void> {
    const previous = this.jsLibStateQueues.get(key)
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const queued = (previous ?? Promise.resolve()).then(() => gate)
    this.jsLibStateQueues.set(key, queued)
    let removeAbortListener: (() => void) | undefined
    try {
      if (previous !== undefined) {
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new Error('__LEGADO_CANCELLED__jsLib state wait cancelled'))
          removeAbortListener = () => signal.removeEventListener('abort', onAbort)
          signal.addEventListener('abort', onAbort, { once: true })
        })
        await Promise.race([previous, aborted])
      }
      if (signal.aborted) throw new Error('__LEGADO_CANCELLED__jsLib state wait cancelled')
    } catch (error) {
      removeAbortListener?.()
      releaseGate()
      if (this.jsLibStateQueues.get(key) === queued) this.jsLibStateQueues.delete(key)
      throw error
    }
    removeAbortListener?.()
    let released = false
    return () => {
      if (released) return
      released = true
      releaseGate()
      if (this.jsLibStateQueues.get(key) === queued) this.jsLibStateQueues.delete(key)
    }
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
    if (!rule.replacement.firstMatchOnly) return replaceWithJavaReplacement(text, compiled.regex, replacement, true)
    const first = compiled.regex.exec(text)
    if (first === null) return ''
    return replaceWithJavaReplacement(first[0], compiled.regex, replacement, false)
  }

  private async runJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown, signal?: AbortSignal, context?: { baseUrl?: string; redirectUrl?: string; content?: unknown; bindings?: Readonly<Record<string, unknown>>; mutableBindings?: readonly string[]; workflowStage?: WorkflowStage; ruleState?: EvaluationState; jsLibOwner?: object; mode?: 'script' | 'function-body'; captureBindings?: readonly string[]; captureGlobals?: boolean; globalState?: Readonly<Record<string, unknown>>; workflowActions?: WorkflowJavaScriptRequest['workflowActions']; javascriptBudget?: WorkflowJavaScriptRequest['javascriptBudget']; requestBudget?: Partial<RequestBudget>; resultInputKind?: WorkflowImageDecodeRequest['resultInputKind']; requestObserver?: RequestObserver }): Promise<WorkflowRuleOutput> {
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
      'const __legadoInfoMapValue = bindings.infoMap && typeof bindings.infoMap === "object" && !Array.isArray(bindings.infoMap) ? { ...bindings.infoMap } : {}; globalThis.infoMap = __legadoInfoMapValue; let __legadoInfoMapSaveTime = 0; const __legadoInfoMapEntries = (value) => { if (value && typeof value === "object" && typeof value.entrySet === "function") { const result = []; const entries = value.entrySet(); const iterator = entries?.iterator?.(); if (iterator) while (iterator.hasNext()) { const entry = iterator.next(); result.push([typeof entry?.getKey === "function" ? entry.getKey() : entry?.[0], typeof entry?.getValue === "function" ? entry.getValue() : entry?.[1]]); } return result; } if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value); return null; }; const __legadoInfoMapView = (kind) => { const keys = () => Object.keys(globalThis.infoMap); const removeKey = (index) => { const list = keys(); if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= list.length) throw new RangeError("List index out of bounds"); const key = list[Number(index)]; const previous = globalThis.infoMap[key]; delete globalThis.infoMap[key]; return previous; }; if (kind === "keys") return legadoListView(keys, undefined, undefined, removeKey, () => { for (const key of keys()) delete globalThis.infoMap[key]; }, undefined, false); if (kind === "values") return legadoListView(() => keys().map((key) => globalThis.infoMap[key]), (index, value) => { const list = keys(); if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= list.length) throw new RangeError("List index out of bounds"); const key = list[Number(index)]; const previous = globalThis.infoMap[key]; globalThis.infoMap[key] = String(value ?? ""); return previous; }, undefined, removeKey, () => { for (const key of keys()) delete globalThis.infoMap[key]; }, undefined, false); return legadoListView(() => keys().map((key) => [key, globalThis.infoMap[key]]), undefined, undefined, removeKey, () => { for (const key of keys()) delete globalThis.infoMap[key]; }, (left, right) => Array.isArray(left) && Array.isArray(right) && String(left[0]) === String(right[0]) && String(left[1]) === String(right[1]), false); }; Object.defineProperties(globalThis.infoMap, { get: { value: function(name) { return arguments.length === 0 ? globalThis.infoMap : Object.prototype.hasOwnProperty.call(globalThis.infoMap, String(name)) ? globalThis.infoMap[String(name)] : null; } }, put: { value: (name, value) => { const key = String(name); const previous = Object.prototype.hasOwnProperty.call(globalThis.infoMap, key) ? globalThis.infoMap[key] : null; globalThis.infoMap[key] = String(value ?? ""); return previous; } }, putAll: { value: (value) => { const entries = __legadoInfoMapEntries(value); if (entries !== null) for (const [key, item] of entries) globalThis.infoMap[String(key)] = String(item ?? ""); } }, set: { value: (value) => { const entries = __legadoInfoMapEntries(value); if (entries !== null) { for (const key of Object.keys(globalThis.infoMap)) delete globalThis.infoMap[key]; for (const [key, item] of entries) globalThis.infoMap[String(key)] = String(item ?? ""); } } }, keys: { get: () => __legadoInfoMapView("keys") }, values: { get: () => __legadoInfoMapView("values") }, entries: { get: () => __legadoInfoMapView("entries") }, keySet: { value: () => __legadoInfoMapView("keys") }, containsValue: { value: (value) => Object.values(globalThis.infoMap).some((item) => item === String(value ?? "")) }, save: { value: (time, need) => { __legadoInfoMapSaveTime = time == null ? 0 : Number(time); request({ kind: "workflow-action", action: "saveInfoMap", input: { infoMap: { ...globalThis.infoMap }, time: __legadoInfoMapSaveTime, need: need !== false } }); } }, saveNow: { value: () => { request({ kind: "workflow-action", action: "saveInfoMap", input: { infoMap: { ...globalThis.infoMap }, time: __legadoInfoMapSaveTime, now: true, need: true } }); } } });',
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
      'let legadoContent = result; const legadoValueText = (value) => Array.isArray(value) ? value.map((item) => String(item ?? "")).join("\\n") : String(value ?? ""); const legadoNodeRead = (node, rule) => legadoValueText(evaluateRule(String(rule), { expect: "text", content: node })); const legadoNode = (node) => { if (node == null || typeof node !== "object" || node.__legadoNode !== "source-rule-node") return node; const value = { ...node }; Object.defineProperties(value, { attr: { value: (name) => legadoNodeRead(node, String(name)) }, text: { value: () => legadoNodeRead(node, "@text") }, ownText: { value: () => legadoNodeRead(node, "@ownText") }, html: { value: () => legadoNodeRead(node, "@html") }, select: { value: (rule) => legadoElements(evaluateRule(String(rule), { expect: "nodes", content: node })) }, toString: { value: () => legadoNodeRead(node, "@text") } }); return value; }; const legadoElements = (values) => { const list = (Array.isArray(values) ? values : values == null ? [] : [values]).map(legadoNode); Object.defineProperties(list, { toArray: { value: () => list.slice() }, attr: { value: (name) => list.length === 0 || typeof list[0].attr !== "function" ? "" : list[0].attr(name) }, text: { value: () => list.map((item) => typeof item.text === "function" ? item.text() : String(item ?? "")).filter(Boolean).join(" ") }, ownText: { value: () => list.map((item) => typeof item.ownText === "function" ? item.ownText() : String(item ?? "")).filter(Boolean).join(" ") }, html: { value: () => list.map((item) => typeof item.html === "function" ? item.html() : String(item ?? "")).join("\\n") }, select: { value: (rule) => { const selected = []; for (const item of list) { if (item != null && typeof item.select === "function") { const nested = item.select(rule); if (Array.isArray(nested)) selected.push(...nested); } } return legadoElements(selected); } } }); return list; }; const legadoResponseHeaders = (headers) => { const source = headers !== null && typeof headers === "object" && !Array.isArray(headers) ? headers : {}; const entries = []; for (const [key, value] of Object.entries(source)) { const values = Array.isArray(value) ? value : [value]; for (const item of values) entries.push([String(key), String(item ?? "")]); } const keyOf = (name) => String(name).toLowerCase(); const matches = (name) => { const wanted = keyOf(name); return entries.filter((entry) => keyOf(entry[0]) === wanted); }; const get = (name) => { const found = matches(name); return found.length === 0 ? null : found[found.length - 1][1]; }; const parseHttpDate = (value) => { const text = String(value); if (text.length === 0) return null; const zone = "(?:[A-Za-z]{1,5}|[+-]\\\\d{4}|[+-]\\\\d{2}:?\\\\d{2})"; const time = "\\\\d{2}[-:]\\\\d{2}[-:]\\\\d{2}"; const accepted = [new RegExp("^[A-Za-z]{3},\\\\s+\\\\d{2}\\\\s+[A-Za-z]{3}\\\\s+\\\\d{4}\\\\s+" + time + "\\\\s+" + zone + "$", "i"), new RegExp("^[A-Za-z]{4,9},\\\\s+\\\\d{2}-[A-Za-z]{3}-\\\\d{2}\\\\s+" + time + "\\\\s+" + zone + "$", "i"), /^[A-Za-z]{3}\\s+[A-Za-z]{3}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}$/i, new RegExp("^[A-Za-z]{3},?\\\\s*\\\\d{2}(?:-|\\\\s)[A-Za-z]{3}(?:-|\\\\s)\\\\d{2,4}\\\\s+" + time + "\\\\s+" + zone + "$", "i"), new RegExp("^[A-Za-z]{3}\\\\s+[A-Za-z]{3}\\\\s+\\\\d{1,2}\\\\s+\\\\d{4}\\\\s+\\\\d{2}:\\\\d{2}:\\\\d{2}\\\\s+" + zone + "$", "i"), new RegExp("^[A-Za-z]{3},?\\\\s+\\\\d{2}-\\\\d{2}-\\\\d{4}\\\\s+\\\\d{2}:\\\\d{2}:\\\\d{2}\\\\s+" + zone + "$", "i")]; if (!accepted.some((pattern) => pattern.test(text))) return null; const asctime = accepted[2].test(text); const numeric = accepted[5].test(text); let normalized = text; if (numeric) { const match = /^([A-Za-z]{3},?\\s+)(\\d{2})-(\\d{2})-(\\d{4})(\\s+\\d{2}:\\d{2}:\\d{2}\\s+.+)$/i.exec(text); if (match === null) return null; const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; const month = Number(match[3]); if (month < 1 || month > 12) return null; normalized = match[1] + match[2] + "-" + months[month - 1] + "-" + match[4] + match[5]; } normalized = normalized.replace(/\\s(\\d{2})-(\\d{2})-(\\d{2})(?=\\s|$)/, " $1:$2:$3"); const zoneAliases = { UTC: "GMT", GMT: "GMT", EST: "GMT-0500", EDT: "GMT-0400", CST: "GMT-0600", CDT: "GMT-0500", MST: "GMT-0700", MDT: "GMT-0600", PST: "GMT-0800", PDT: "GMT-0700", CET: "GMT+0100", CEST: "GMT+0200", EET: "GMT+0200", EEST: "GMT+0300", JST: "GMT+0900", KST: "GMT+0900" }; normalized = normalized.replace(/\\s([A-Za-z]{1,5})$/, (_all, name) => " " + (zoneAliases[String(name).toUpperCase()] ?? String(name))); if (asctime) normalized += " GMT"; const parsed = Date.parse(normalized); return Number.isNaN(parsed) ? null : new Date(parsed); }; const names = () => { const result = []; for (const [name] of entries) if (!result.some((item) => keyOf(item) === keyOf(name))) result.push(name); return result.sort((left, right) => { const a = keyOf(left); const b = keyOf(right); return a < b ? -1 : a > b ? 1 : 0; }); }; const toMultimap = () => { const map = Object.create(null); for (const [name, value] of entries) { const key = keyOf(name); (map[key] ??= []).push(value); } const result = {}; for (const [key, values] of Object.entries(map).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)) result[key] = legadoList(values); return result; }; const sensitive = (name) => /^(?:authorization|cookie|proxy-authorization|set-cookie)$/iu.test(keyOf(name)); const indexed = (index) => { const position = Number(index); if (!Number.isInteger(position) || position < 0 || position >= entries.length) throw new RangeError("Headers index out of bounds"); return entries[position]; }; const result = { ...source }; Object.defineProperties(result, { get: { value: get }, getDate: { value: (name) => { const value = get(name); return value === null ? null : parseHttpDate(value); } }, getInstant: { value: (name) => { const value = get(name); return value === null ? null : parseHttpDate(value); } }, values: { value: (name) => legadoList(matches(name).map((entry) => entry[1])) }, names: { value: () => legadoList(names()) }, size: { value: () => entries.length }, name: { value: (index) => indexed(index)[0] }, value: { value: (index) => indexed(index)[1] }, byteCount: { value: () => entries.reduce((count, entry) => count + 2 + entry[0].length + entry[1].length, 0) }, toMultimap: { value: toMultimap }, toString: { value: () => entries.map((entry) => String(entry[0]) + ": " + (sensitive(entry[0]) ? "██" : String(entry[1])) + "\\n").join("") } }); return result }; const legadoResponse = (url, raw) => { const record = raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; const body = typeof raw === "string" ? raw : String(record.body ?? raw ?? ""); const status = Number(record.status ?? record.code ?? 200); const target = String(record.url ?? url); const headers = record.headers ?? {}; const header = (name) => { const wanted = String(name).toLowerCase(); for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return Array.isArray(value) ? value.map((item) => String(item ?? "")).join(",") : String(value ?? ""); return null; }; const request = { url: () => target }; const rawResponse = {}; Object.defineProperties(rawResponse, { request: { value: () => request, configurable: true }, url: { value: () => target, configurable: true }, code: { value: () => status, configurable: true }, message: { value: () => String(record.message ?? ""), configurable: true } }); const response = {}; Object.defineProperties(response, { body: { value: () => body, configurable: true }, code: { value: () => status, configurable: true }, statusCode: { value: () => status, configurable: true }, message: { value: () => String(record.message ?? ""), configurable: true }, headers: { value: () => headers, configurable: true }, header: { value: header, configurable: true }, url: { value: () => target, configurable: true }, isSuccessful: { value: () => status >= 200 && status < 300, configurable: true }, raw: { value: () => rawResponse, configurable: true }, toString: { value: () => body, configurable: true } }); return response; };',
      'const java = { ajax: (value, method, body) => value != null && typeof value === "object" ? request(Object.assign({ kind: "network" }, value)) : method != null && typeof method === "object" ? request(Object.assign({ kind: "network", url: String(value) }, method)) : request({ kind: "network", url: String(value), method: method ?? "GET", body }), get: (value, options) => options !== undefined || /^(?:https?:)?\\/\\//.test(String(value)) ? legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "GET", options })) : Object.prototype.hasOwnProperty.call(bindings, String(value)) ? bindings[String(value)] : getVar(String(value)), connect: (value, options) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "GET", options })), put: (name, value) => { setVar(name, value); return value; }, cacheContent: (chapter, content) => request({ kind: "workflow-action", action: "cacheContent", input: { chapter, content } }), setContent: (content, baseUrl) => { if (content === null || content === undefined) throw new Error("内容不可空（Content cannot be null）"); legadoContent = content; if (baseUrl !== undefined && baseUrl !== null) { globalThis.baseUrl = String(baseUrl); } return java; }, getElement: (rule) => { const value = evaluateRule(String(rule), { expect: "nodes", content: legadoContent }); return Array.isArray(value) ? legadoElements(value) : legadoNode(value); }, getElements: (rule) => legadoElements(evaluateRule(String(rule), { expect: "nodes", content: legadoContent })), getString: (rule, content, isUrl) => legadoValueText(evaluateRule(String(rule), { expect: "text", content: content === undefined ? legadoContent : content })), getStringList: (rule, content, isUrl) => { const value = evaluateRule(String(rule), { expect: "text", content: content === undefined ? legadoContent : content }); return Array.isArray(value) ? value.map((item) => String(item ?? "")).filter(Boolean) : String(value ?? "").split("\\n").filter(Boolean); }, getWebViewUA: () => request({ kind: "runtime-capability", capability: "getWebViewUA" }), base64Encode: (value) => request({ kind: "base64-encode", value }), base64Decode: (value) => request({ kind: "base64-decode-text", value }), base64DecodeToString: (value) => request({ kind: "base64-decode-text", value }), base64DecodeToByteArray: (value, flags) => value == null || String(value).trim().length === 0 ? null : request({ kind: "base64-decode-bytes", value, flags }), strToBytes: (value, charset) => request({ kind: "encode-bytes", value: String(value), charset: charset === undefined ? "UTF-8" : String(charset) }), bytesToStr: (value, charset) => request({ kind: "decode-bytes", value, charset: charset === undefined ? "UTF-8" : String(charset) }), toNumChapter: (value) => value == null ? null : request({ kind: "to-num-chapter", value }), hexDecodeToByteArray: (value) => request({ kind: "hex-decode-bytes", value }), hexDecodeToString: (value) => request({ kind: "hex-decode-text", value }), hexEncodeToString: (value) => request({ kind: "hex-encode", value }), md5Encode: (value) => request({ kind: "md5", value }), digestHex: (value, algorithm) => request({ kind: "digest", value, algorithm }), digestBase64Str: (value, algorithm) => request({ kind: "digest-base64", value, algorithm }), HMacHex: (value, algorithm, key) => request({ kind: "hmac-hex", value, algorithm, key }), HMacBase64: (value, algorithm, key) => request({ kind: "hmac-base64", value, algorithm, key }), encodeURI: (value) => encodeURI(String(value)), decodeURI: (value) => decodeURI(String(value)), aesBase64DecodeToString: (value, key, transformation, iv) => request({ kind: "aes-decode-text", value, key, transformation, iv }), replaceFont: (text, errorBase64, correctBase64, filter) => request({ kind: "font-replace", text, errorBase64, correctBase64, filter }), toast: () => undefined, longToast: () => undefined, log: () => undefined, timeFormat: (value) => String(value), timeFormatUTC: (time, format, offsetMs) => request({ kind: "time-format-utc", time: Number(time), format: String(format), offsetMs: Number(offsetMs) }), randomUUID: () => request({ kind: "random-uuid" }), getAppVariant: () => request({ kind: "runtime-capability", capability: "getAppVariant" }), androidId: () => request({ kind: "runtime-capability", capability: "androidId" }), deviceID: () => request({ kind: "runtime-capability", capability: "deviceID" }) };',
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
      'const __legadoCallableResponseValue = (value) => { const target = function() { return value; }; Object.defineProperties(target, { __legadoCallableResponse: { value: true, configurable: false }, __legadoCallableValue: { value, configurable: false } }); return new Proxy(target, { apply: () => value, get: (_target, key) => { if (key === "__legadoCallableResponse") return true; if (key === "__legadoCallableValue") return value; if (key === "toJSON") return () => value; if (key === "valueOf") return () => value; if (key === "toString") return () => String(value); if (key === Symbol.toPrimitive) return () => value; const objectValue = Object(value); const property = objectValue[key]; if (typeof property === "function") return property.bind(objectValue); if (property !== undefined) return property; return Reflect.get(target, key); }, set: (_target, key, next) => { if (value !== null && typeof value === "object") { value[key] = next; return true; } return false; } }); };',
      'const __legadoCreateStrResponse = (url, body) => { const target = String(url ?? ""); const bodyValue = body == null ? null : String(body); const response = legadoResponseCompat(target, { url: target, status: 200, code: 200, message: "OK", body: bodyValue, headers: {} }); const headersValue = response.headers(); Object.defineProperty(response, "__legadoResponseType", { value: "StrResponse", enumerable: false, configurable: false }); Object.defineProperties(response, { url: { value: __legadoCallableResponseValue(target), enumerable: true, configurable: true }, body: { value: __legadoCallableResponseValue(bodyValue), enumerable: true, configurable: true }, code: { value: __legadoCallableResponseValue(200), enumerable: true, configurable: true }, headers: { value: __legadoCallableResponseValue(headersValue), enumerable: true, configurable: true }, status: { value: 200, enumerable: true, configurable: true }, callTime: { value: __legadoCallableResponseValue(0), enumerable: true, configurable: true }, errorBody: { value: __legadoCallableResponseValue(null), enumerable: true, configurable: true }, toJSON: { value: () => ({ url: target, body: bodyValue, status: 200, code: 200, headers: {} }), enumerable: false, configurable: true } }); return response; };',
      'globalThis.Packages.io.legado.app.help.http.StrResponse = function(url, body) { return __legadoCreateStrResponse(url, body); };',
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
      'const legadoGetString = (rule, content, isUrl) => { if (rule == null || String(rule).trim().length === 0) return ""; let sourceContent = content; let shouldUnescape = true; let resolveUrl = isUrl === true; if (typeof content === "boolean" && isUrl === undefined) { shouldUnescape = content; sourceContent = undefined; resolveUrl = false; } const value = legadoValueText(evaluateRule(String(rule), { expect: "text", content: sourceContent == null ? legadoContent : sourceContent })); const decoded = shouldUnescape ? request({ kind: "html-unescape", value }) : value; if (!resolveUrl) return decoded; return decoded.trim().length === 0 ? String(baseUrl ?? "") : legadoResolveJavaUrl(decoded); }; const legadoGetStringList = (rule, content, isUrl) => { if (rule == null || String(rule).trim().length === 0) return null; const value = evaluateRule(String(rule), { expect: "text", content: content == null ? legadoContent : content }); if (value == null) return null; const values = Array.isArray(value) ? value.map((item) => String(item ?? "")) : String(value).split("\\n"); if (isUrl !== true) return values; const result = []; for (const absolute of legadoResolveJavaUrls(values)) if (absolute && !result.includes(absolute)) result.push(absolute); return result; }; Object.assign(java, { ajax: (value, callTimeout) => { try { if (value != null && typeof value === "object" && !Array.isArray(value)) return request(Object.assign({ kind: "network" }, value)); const urlValue = legadoJavaUrl(value); if (callTimeout != null && typeof callTimeout === "object" && !Array.isArray(callTimeout)) return request(Object.assign({ kind: "network", url: urlValue }, callTimeout)); const input = { kind: "network", url: urlValue, method: "GET" }; if (callTimeout != null) input.options = { timeout: Number(callTimeout) }; return request(input); } catch (error) { if (legadoJavaErrorMustPropagate(error)) throw error; return legadoJavaErrorText(error); } }, get: (value, headers, timeout) => { const urlValue = String(value); if (headers === undefined && timeout === undefined && !/^(?:https?:)?\\/\\//.test(urlValue)) return Object.prototype.hasOwnProperty.call(bindings, urlValue) ? bindings[urlValue] : getVar(urlValue); const headerMap = legadoJavaHeaders(headers); return legadoResponse(urlValue, request({ kind: "network-response", url: urlValue, method: "GET", headers: headerMap, options: legadoJavaRequestOptions(timeout) })); }, connect: (value, header, timeout) => { const urlValue = String(value); try { const headerMap = legadoJavaConnectHeaders(header); const input = { kind: "network-response", url: urlValue, method: "GET" }; if (headerMap !== undefined) input.headers = headerMap; if (timeout != null) input.options = { timeout: Number(timeout) }; return legadoResponse(urlValue, request(input)); } catch (error) { if (legadoJavaErrorMustPropagate(error)) throw error; return legadoResponse(urlValue, { url: urlValue, status: 200, code: 200, body: legadoJavaErrorText(error) }); } }, getString: legadoGetString, getStringList: legadoGetStringList, post: (value, body, headers, timeout) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "POST", body, headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) })), head: (value, headers, timeout) => legadoResponse(String(value), request({ kind: "network-response", url: String(value), method: "HEAD", headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) })) });',
      // Jsoup Connection.Response/StrResponse 的可观察方法：网络 bridge 只传 DTO，
      // 在 QuickJS 侧重新挂载方法，避免把 Node/Undici 对象泄露给书源。
      'const legadoUtf8Bytes = (value) => { const encoded = encodeURIComponent(String(value)); const result = []; for (let index = 0; index < encoded.length;) { if (encoded[index] === "%") { result.push(parseInt(encoded.slice(index + 1, index + 3), 16)); index += 3; } else { result.push(encoded.charCodeAt(index)); index += 1; } } return Uint8Array.from(result); };',
      'const legadoResponseCompat = (url, raw) => { const response = legadoResponse(url, raw); const record = raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; const body = typeof raw === "string" ? raw : String(record.body ?? raw ?? ""); const status = Number(record.status ?? record.code ?? 200); const target = String(record.url ?? url); const headers = record.headers != null && typeof record.headers === "object" && !Array.isArray(record.headers) ? record.headers : {}; const bytes = record.bytes instanceof Uint8Array ? record.bytes : record.bodyBytes instanceof Uint8Array ? record.bodyBytes : legadoUtf8Bytes(body); const header = (name) => { const wanted = String(name).toLowerCase(); for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return Array.isArray(value) ? value.map((item) => String(item ?? "")).join(",") : String(value ?? ""); return null; }; const contentType = header("content-type"); const charset = record.charset == null ? (/charset\\s*=\\s*[\\x22\\x27]?([^;\\x22\\x27\\s]+)/i.exec(contentType)?.[1] ?? null) : String(record.charset); const message = String(record.message ?? record.statusMessage ?? ""); const requestObject = {}; Object.defineProperties(requestObject, { url: { value: () => String(record.requestUrl ?? target), configurable: true }, method: { value: () => String(record.requestMethod ?? "GET"), configurable: true }, headers: { value: () => legadoResponseHeaders(record.requestHeaders ?? {}), configurable: true } }); const rawResponse = {}; Object.defineProperties(rawResponse, { request: { value: () => requestObject, configurable: true }, url: { value: () => target, configurable: true }, code: { value: () => status, configurable: true }, statusCode: { value: () => status, configurable: true }, message: { value: () => message, configurable: true }, headers: { value: () => legadoResponseHeaders(headers), configurable: true }, header: { value: header, configurable: true }, isSuccessful: { value: () => status >= 200 && status < 300, configurable: true } }); Object.defineProperties(response, { status: { value: status, configurable: true }, headers: { value: () => legadoResponseHeaders(headers), configurable: true }, header: { value: header, configurable: true }, bodyAsBytes: { value: () => bytes, configurable: true }, bytes: { value: bytes, configurable: true }, charset: { value: () => charset, configurable: true }, contentType: { value: () => contentType, configurable: true }, statusMessage: { value: () => message, configurable: true }, statusCode: { value: () => status, configurable: true }, message: { value: () => message, configurable: true }, redirected: { value: Boolean(record.redirected), configurable: true }, errorBody: { value: () => record.errorBody ?? null, configurable: true }, callTime: { value: () => Number(record.callTime ?? 0), configurable: true }, raw: { value: () => rawResponse, configurable: true }, toString: { value: () => `${status} ${message}`.trim(), configurable: true } }); return response; };',
      'java.get = (value, headers, timeout) => { const urlValue = String(value); if (headers === undefined && timeout === undefined && !/^(?:https?:)?\\/\\//.test(urlValue)) return Object.prototype.hasOwnProperty.call(bindings, urlValue) ? bindings[urlValue] : getVar(urlValue); const headerMap = legadoJavaHeaders(headers); return legadoResponseCompat(urlValue, request({ kind: "network-response", url: urlValue, method: "GET", headers: headerMap, options: legadoJavaRequestOptions(timeout) })); };',
      'java.connect = (value, header, timeout) => { const urlValue = String(value); try { const headerMap = legadoJavaConnectHeaders(header); const input = { kind: "network-response", url: urlValue, method: "GET" }; if (headerMap !== undefined) input.headers = headerMap; if (timeout != null) input.options = { timeout: Number(timeout) }; return legadoResponseCompat(urlValue, request(input)); } catch (error) { if (legadoJavaErrorMustPropagate(error)) throw error; return legadoResponseCompat(urlValue, { url: urlValue, status: 200, code: 200, body: legadoJavaErrorText(error), message: "OK" }); } };',
      'java.post = (value, body, headers, timeout) => legadoResponseCompat(String(value), request({ kind: "network-response", url: String(value), method: "POST", body, headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) })); java.head = (value, headers, timeout) => legadoResponseCompat(String(value), request({ kind: "network-response", url: String(value), method: "HEAD", headers: legadoJavaHeaders(headers), options: legadoJavaRequestOptions(timeout) }));',
      'java.ajaxAll = (values, skipRateLimit) => { const urls = (Array.isArray(values) ? values : [values]).map((value) => String(value)); const batch = request({ kind: "network-all", urls, skipRateLimit: skipRateLimit === true }); return (Array.isArray(batch) ? batch : []).map((raw, index) => legadoResponseCompat(urls[index] ?? "", raw)); };',
      'java.ajaxTestAll = (values, timeout, skipRateLimit) => { const urls = (Array.isArray(values) ? values : [values]).map((value) => String(value)); const batch = request({ kind: "network-all", urls, isTest: true, skipRateLimit: skipRateLimit === true, options: timeout === undefined ? undefined : { timeout: Number(timeout) } }); return (Array.isArray(batch) ? batch : []).map((raw, index) => legadoResponseCompat(urls[index] ?? "", raw)); };',
      'const legadoCryptoConfig = (transformation, key, iv, aad, authTagLength) => ({ transformation: String(transformation), key, ...(iv === undefined || iv === null ? {} : { iv }), ...(aad === undefined ? {} : { aad }), ...(authTagLength === undefined ? {} : { authTagLength }) }); const legadoCryptoBase64 = (value) => ({ __legadoBase64: String(value) }); const legadoCryptoInput = (value) => typeof value === "string" ? (/^(?:[0-9a-f]{2})+$/iu.test(value) ? "hex" : "base64") : "bytes"; const legadoSecretKey = (value) => ({ getEncoded: () => value, encoded: value, toString: () => java.base64Encode(value) }); const legadoCrypto = (transformation, key, iv) => { let currentKey = key; let currentIv = iv; let currentAad; let currentAuthTagLength; if (currentKey === undefined || currentKey === null) currentKey = request({ kind: "crypto-key", transformation: String(transformation) }); const call = (operation, value, outputEncoding, charset) => request({ kind: "crypto-symmetric", operation, ...legadoCryptoConfig(transformation, currentKey, currentIv, currentAad, currentAuthTagLength), value, inputEncoding: operation === "decrypt" ? legadoCryptoInput(value) : undefined, outputEncoding, ...(charset === undefined ? {} : { charset: String(charset) }) }); const api = { decrypt: (value) => call("decrypt", value, "bytes"), decryptStr: (value, charset) => call("decrypt", value, "text", charset === undefined ? "UTF-8" : charset), encrypt: (value) => call("encrypt", value, "bytes"), encryptBase64: (value) => call("encrypt", value, "base64"), encryptHex: (value) => call("encrypt", value, "hex"), setIv: (nextIv) => { currentIv = nextIv; return api; }, setAAD: (nextAad) => { currentAad = nextAad; return api; }, setAuthTagLength: (bits) => { currentAuthTagLength = Number(bits); return api; }, getIv: () => currentIv, getSecretKey: () => legadoSecretKey(currentKey) }; return api; };',
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
      'const legadoToURL = (value, base) => { const raw = String(value ?? ""); let resolved; try { resolved = request({ kind: "resolve-url", url: base === undefined || base === null || String(base).length === 0 ? "" : String(base), value: raw }); } catch { throw new Error("Malformed URL"); } const text = String(resolved ?? raw); const match = /^(?:(\\w+):)?\\/\\/([^/?#]*)([^?#]*)?(?:\\?([^#]*))?(?:#(.*))?$/u.exec(text); const protocol = match?.[1] == null ? "" : `${match[1]}:`; const authority = match?.[2] ?? ""; const pathname = match?.[3] ?? ""; const query = match?.[4] ?? ""; const hash = match?.[5] == null ? "" : `#${match[5]}`; const userAt = authority.lastIndexOf("@"); const userInfo = userAt < 0 ? "" : authority.slice(0, userAt); const hostPort = userAt < 0 ? authority : authority.slice(userAt + 1); let hostname = hostPort; let port = ""; if (hostPort.startsWith("[")) { const end = hostPort.indexOf("]"); hostname = end < 0 ? hostPort : hostPort.slice(0, end + 1); port = end >= 0 && hostPort[end + 1] === ":" ? hostPort.slice(end + 2) : ""; } else { const colon = hostPort.lastIndexOf(":"); if (colon > -1 && hostPort.indexOf(":") === colon) { hostname = hostPort.slice(0, colon); port = hostPort.slice(colon + 1); } } const params = query.length === 0 ? null : {}; if (params !== null) for (const part of query.split("&")) { if (part.length === 0) continue; const index = part.indexOf("="); if (index < 0) continue; const name = part.slice(0, index); const item = part.slice(index + 1); const decodedName = decodeURIComponent(name.replaceAll("+", " ")); const decodedValue = decodeURIComponent(item.replaceAll("+", " ")); params[name] = decodedValue; } const search = query.length === 0 ? "" : `?${query}`; const origin = protocol.length === 0 ? "" : `${protocol}//${hostname}${port.length > 0 ? `:${port}` : ""}`; const file = pathname + search; return { url: text, href: text, protocol, host: hostname, hostname, port, pathname, path: pathname, search, query, hash, origin, authority: hostPort, userInfo, file, searchParams: params, toString: () => text }; }; java.toURL = (value, base) => legadoToURL(value, base);',
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
    const jsLibOwner = context?.jsLibOwner ?? ruleState
    const runSignal = signal ?? new AbortController().signal
    let jsLibStateRelease: (() => void) | undefined
    let ownsJsLibStateLock = false
    try {
      const libraries = await this.loadSourceLibraries(source, runSignal, context?.workflowStage ?? this.workflowStageForJavaScript(stage), context?.requestObserver)
      const jsLibStateKey = libraries.length > 0 ? `jsLibState:${this.jsLibSessionId}:${sourceDefinitionFingerprint(source)}` : undefined
      if (jsLibStateKey !== undefined && !this.activeJsLibOwners.has(jsLibOwner)) {
        this.activeJsLibOwners.add(jsLibOwner)
        ownsJsLibStateLock = true
        try {
          jsLibStateRelease = await this.acquireJsLibStateLock(jsLibStateKey, runSignal)
        } catch (error) {
          this.activeJsLibOwners.delete(jsLibOwner)
          ownsJsLibStateLock = false
          throw error
        }
      }
      const jsLibClearGeneration = jsLibStateKey === undefined ? undefined : this.jsLibClearGenerations.get(jsLibStateKey) ?? 0
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
            && ['network', 'network-all', 'network-response', 'url-context-response', 'file'].includes(String((payload as SourceRuleBridgeRequest).kind))
            ? { ...(payload as SourceRuleBridgeRequest), budget: { ...context.requestBudget, ...((payload as SourceRuleBridgeRequest).budget ?? {}) } }
            : payload
          return this.handleBridge(bridged, bridgeSignal, source, context?.ruleState?.request.stage ?? context?.workflowStage ?? this.workflowStageForJavaScript(stage), bindings, context?.workflowActions, context?.requestObserver, context?.jsLibOwner ?? ruleState, context?.requestBudget)
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
          if ((this.jsLibClearGenerations.get(jsLibStateKey) ?? 0) === jsLibClearGeneration) await this.cache.put(jsLibStateKey, `${sourceCacheJsonPrefix}${JSON.stringify(state)}`, 0, runSignal)
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
    } finally {
      if (ownsJsLibStateLock) {
        jsLibStateRelease?.()
        this.activeJsLibOwners.delete(jsLibOwner)
      }
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
    const stateKey = `jsLibState:${this.jsLibSessionId}:${fingerprint}`
    this.jsLibClearGenerations.set(stateKey, (this.jsLibClearGenerations.get(stateKey) ?? 0) + 1)
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

  private async handleBridge(input: unknown, signal: AbortSignal, source: NormalizedSource, workflowStage: WorkflowStage, currentBindings: Readonly<Record<string, unknown>> = this.bindings, workflowActions?: WorkflowJavaScriptRequest['workflowActions'], requestObserver?: RequestObserver, jsLibOwner?: object, requestBudget?: Partial<RequestBudget>): Promise<unknown> {
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
    if (request.kind === 'gzip-decode' || request.kind === 'gzip-encode' || request.kind === 'inflate-decode') {
      const codec = request.kind === 'gzip-decode' ? this.compression?.gzipDecode : request.kind === 'gzip-encode' ? this.compression?.gzipEncode : this.compression?.inflateDecode
      if (codec === undefined) throw new Error(`__LEGADO_CAPABILITY__runtime ${request.kind} unavailable`)
      return codec(byteValue(request.value), signal)
    }
    if (request.kind === 'zip-decode') {
      const decoder = this.compression?.zipDecode
      if (decoder === undefined) throw new Error('__LEGADO_CAPABILITY__runtime zip-decode unavailable')
      return decoder(byteValue(request.value), signal)
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
      if (request.aad !== undefined) {
        if (crypto.setAAD === undefined) throw new Error('__LEGADO_CAPABILITY__runtime crypto.aad unavailable')
        crypto.setAAD(byteValue(request.aad))
      }
      if (request.authTagLength !== undefined) {
        if (crypto.setAuthTagLength === undefined) throw new Error('__LEGADO_CAPABILITY__runtime crypto.tag-length unavailable')
        crypto.setAuthTagLength(Number(request.authTagLength))
      }
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
      if (request.oaepHash !== undefined || request.oaepMgfHash !== undefined || request.oaepLabel !== undefined) {
        if (crypto.setOaepParameters === undefined) throw new Error('__LEGADO_CAPABILITY__runtime crypto.oaep-parameters unavailable')
        crypto.setOaepParameters(
          request.oaepHash === undefined || request.oaepHash === null ? undefined : textValue(request.oaepHash),
          request.oaepMgfHash === undefined || request.oaepMgfHash === null ? undefined : textValue(request.oaepMgfHash),
          request.oaepLabel === undefined || request.oaepLabel === null ? undefined : byteValue(request.oaepLabel),
        )
      }
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
        const response = await this.requestBridge({ kind: 'network-response', url: value.trim(), method: 'GET', stage: workflowStage, ...(requestBudget === undefined ? {} : { budget: requestBudget }) }, signal, source, requestObserver)
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
      if (this.cache.putByteArray !== undefined && isByteValue(request.value)) {
        await this.cache.putByteArray(key, byteValue(request.value), saveTime, signal)
        return undefined
      }
      await this.cache.put(key, encodeSourceCacheValue(this.encoding, request.value), saveTime, signal)
      return undefined
    }
    if (request.kind === 'cache-delete') {
      const key = textValue(request.key)
      await this.cache.delete(key, signal)
      await this.file?.invalidateCacheFile?.(key, signal, source)
      return undefined
    }
    if (request.kind === 'cache-memory-get') return decodeSourceCacheValue(this.encoding, await this.cache.getFromMemory(textValue(request.key)))
    if (request.kind === 'cache-memory-put') {
      await this.cache.putMemory(textValue(request.key), encodeSourceCacheValue(this.encoding, request.value), signal)
      return undefined
    }
    if (request.kind === 'cache-memory-delete') {
      await this.cache.deleteMemory(textValue(request.key), signal)
      return undefined
    }
    if (request.kind === 'cache-bytes-get') {
      if (this.cache.getByteArray !== undefined) return this.cache.getByteArray(textValue(request.key), signal)
      const value = await this.cache.get(textValue(request.key), signal)
      const decoded = decodeSourceCacheValue(this.encoding, value)
      return decoded instanceof Uint8Array ? decoded : undefined
    }
    if (request.kind === 'cache-file-get') return decodeSourceCacheValue(this.encoding, await this.cache.getFile(textValue(request.key)))
    if (request.kind === 'cache-file-put') {
      await this.cache.putFile(textValue(request.key), encodeSourceCacheValue(this.encoding, request.value), Number(request.saveTime) || 0, signal)
      return undefined
    }
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
    if (request.kind === 'runtime-sleep') {
      const millis = Number(request.time)
      const nanos = Number(request.nanos ?? 0)
      if (!Number.isInteger(millis) || millis < 0 || !Number.isInteger(nanos) || nanos < 0 || nanos > 999999) throw new RangeError('Illegal sleep time')
      if (signal.aborted) throw new Error('__LEGADO_CANCELLED__')
      const delay = millis + nanos / 1000000
      if (delay === 0) return undefined
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (error === undefined) resolve()
          else reject(error)
        }
        const timer = setTimeout(() => finish(), delay)
        const onAbort = () => { clearTimeout(timer); finish(new Error('__LEGADO_CANCELLED__')) }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      return undefined
    }
    if (request.kind === 'source-state') return this.handleSourceState(request, signal, source, workflowStage, currentBindings, workflowActions, requestObserver, jsLibOwner)
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
      const rawExtra = typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {}
      const hasEvalResult = request.kind === 'source-eval-js' && Object.prototype.hasOwnProperty.call(rawExtra, '__legadoEvalResult')
      const evalResult = hasEvalResult ? rawExtra.__legadoEvalResult : undefined
      const extra = hasEvalResult ? Object.fromEntries(Object.entries(rawExtra).filter(([key]) => key !== '__legadoEvalResult')) : rawExtra
      let code = request.kind === 'source-eval-js' ? textValue(request.value) : `${loginJs}\nif (typeof login !== "function") throw new Error("Function login not implements!!!"); login.apply(this);`
      if (request.kind === 'source-login-ui') code = `${loginJs}\nif (typeof loginUi !== "function") throw new Error("Function loginUi not implements!!!"); loginUi(JSON.parse(String(__loginState)));`
      if (request.kind === 'source-login-action') code = `${loginJs}\nif (typeof loginAction !== "function") throw new Error("Function loginAction not implements!!!"); loginAction(String(__loginAction), JSON.parse(String(__loginState)), JSON.parse(String(__loginForm)));`
      const bindings: Record<string, unknown> = { ...currentBindings, ...(request.kind === 'source-eval-js' && typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input) ? extra : {}) }
      if (hasEvalResult) bindings.result = evalResult
      if (request.kind === 'source-login-ui') Object.assign(bindings, { __loginState: textValue(request.value), book: extra.book, chapter: extra.chapter })
      if (request.kind === 'source-login-action') Object.assign(bindings, { __loginAction: textValue(request.value), __loginState: textValue(request.data), __loginForm: textValue((extra as { formJson?: unknown }).formJson), book: extra.book, chapter: extra.chapter })
      const output = await this.runJavaScript(code, this.javascriptStage(workflowStage), source, hasEvalResult ? evalResult : '', signal, { bindings, mode: 'script', ...(jsLibOwner === undefined ? {} : { jsLibOwner }), workflowStage, ...(workflowActions === undefined ? {} : { workflowActions }), ...(requestObserver === undefined ? {} : { requestObserver }) })
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

  private async handleSourceState(request: SourceRuleBridgeRequest, signal: AbortSignal, source: NormalizedSource, workflowStage: WorkflowStage, currentBindings: Readonly<Record<string, unknown>>, workflowActions?: WorkflowJavaScriptRequest['workflowActions'], requestObserver?: RequestObserver, jsLibOwner?: object): Promise<unknown> {
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
              ...(jsLibOwner === undefined ? {} : { jsLibOwner }),
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
          ...(jsLibOwner === undefined ? {} : { jsLibOwner }),
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
