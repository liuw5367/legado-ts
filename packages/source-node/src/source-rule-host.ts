import {
  SourceRuleRuntime,
} from '@legado/source-core'
import type {
  SourceRuleRuntimeOptions,
  WorkflowJavaScriptRequest,
  WorkflowImageDecodeRequest,
  WorkflowRuleOutput,
  WorkflowRulePort,
  WorkflowRuleRequest,
  SourceFunctionName,
  SourceFunctionOutput,
  SourceFunctionRequest,
  NormalizedSource,
} from '@legado/source-core'
import { randomUUID } from 'node:crypto'
import { NodeCryptoHost } from './crypto.ts'
import { NodeEncodingHost } from './encoding.ts'
import { NodeFontHost } from './font.ts'
import { HtmlParserAdapter } from './html.ts'
import { QuickJSJavaScriptHost } from './javascript.ts'
import { JsonPathParserAdapter } from './jsonpath.ts'
import { XPathParserAdapter } from './xpath.ts'
import { DEFAULT_ANDROID_USER_AGENT } from './http.ts'

export type { SourceRuleBridgeRequest } from '@legado/source-core'

export interface SourceRuleHostOptions extends Omit<SourceRuleRuntimeOptions, 'encoding' | 'crypto' | 'font' | 'html' | 'json' | 'xpath' | 'javascript'> {
  encoding?: NodeEncodingHost
  crypto?: NodeCryptoHost
  font?: NodeFontHost
}

function formatJavaDate(time: number, pattern: string, offsetMs?: number): string | null {
  if (!Number.isFinite(time) || !Number.isFinite(offsetMs ?? 0)) return null
  if (pattern.length > 512) return null
  const date = new Date(time + (offsetMs ?? 0))
  if (Number.isNaN(date.getTime())) return null
  const utc = offsetMs !== undefined
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  const hour = utc ? date.getUTCHours() : date.getHours()
  const minute = utc ? date.getUTCMinutes() : date.getMinutes()
  const second = utc ? date.getUTCSeconds() : date.getSeconds()
  const millis = utc ? date.getUTCMilliseconds() : date.getMilliseconds()
  const weekday = utc ? date.getUTCDay() : date.getDay()
  const offsetMinutes = Math.trunc((offsetMs ?? -date.getTimezoneOffset() * 60_000) / 60_000)
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`
  // 按 Java SimpleDateFormat 常用日期字段展开，单引号包围的文字原样保留。
  const dayOfYear = Math.floor((date.getTime() - (utc ? Date.UTC(year, 0, 1) : new Date(year, 0, 1).getTime())) / 86_400_000) + 1
  const firstDayOfYear = utc ? new Date(Date.UTC(year, 0, 1)).getUTCDay() : new Date(year, 0, 1).getDay()
  const firstDayOfMonth = utc ? new Date(Date.UTC(year, month - 1, 1)).getUTCDay() : new Date(year, month - 1, 1).getDay()
  const weekOfYear = Math.floor((dayOfYear + firstDayOfYear - 1) / 7) + 1
  const weekOfMonth = Math.floor((day + firstDayOfMonth - 1) / 7) + 1
  const dayOfWeek = weekday === 0 ? 7 : weekday
  const isoWeekDate = new Date(date.getTime())
  if (utc) isoWeekDate.setUTCDate(isoWeekDate.getUTCDate() + 4 - dayOfWeek)
  else isoWeekDate.setDate(isoWeekDate.getDate() + 4 - dayOfWeek)
  const weekYear = utc ? isoWeekDate.getUTCFullYear() : isoWeekDate.getFullYear()
  const timezoneName = utc ? 'UTC' : new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(date).find((item) => item.type === 'timeZoneName')?.value ?? offset
  return pattern.replace(/'([^']|'')*'|Y+|y+|M+|L+|d+|D+|H+|k+|K+|h+|m+|s+|S+|E+|u+|a|w+|W+|F+|z+|G+|Z|X+/gu, (token) => {
    if (token === "''") return "'"
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (token[0] === 'Y') return token.length === 2 ? String(weekYear % 100).padStart(2, '0') : String(weekYear).padStart(token.length, '0')
    if (token[0] === 'y') return token.length === 2 ? String(year % 100).padStart(2, '0') : String(year).padStart(token.length, '0')
    if (token[0] === 'M' || token[0] === 'L') {
      if (token.length <= 2) return token.length === 1 ? String(month) : String(month).padStart(2, '0')
      return new Intl.DateTimeFormat(undefined, { month: token.length === 3 ? 'short' : 'long', ...(utc ? { timeZone: 'UTC' } : {}) }).format(date)
    }
    if (token[0] === 'd') return token.length === 1 ? String(day) : String(day).padStart(token.length, '0')
    if (token[0] === 'D') return token.length === 1 ? String(dayOfYear) : String(dayOfYear).padStart(token.length, '0')
    if (token[0] === 'H' || token[0] === 'h') {
      const value = token[0] === 'h' ? (hour % 12 || 12) : hour
      return token.length === 1 ? String(value) : String(value).padStart(token.length, '0')
    }
    if (token[0] === 'k') { const value = hour === 0 ? 24 : hour; return token.length === 1 ? String(value) : String(value).padStart(token.length, '0') }
    if (token[0] === 'K') { const value = hour % 12; return token.length === 1 ? String(value) : String(value).padStart(token.length, '0') }
    if (token[0] === 'm') return token.length === 1 ? String(minute) : String(minute).padStart(token.length, '0')
    if (token[0] === 's') return token.length === 1 ? String(second) : String(second).padStart(token.length, '0')
    if (token[0] === 'S') return String(millis).padStart(token.length, '0')
    if (token[0] === 'E') return new Intl.DateTimeFormat(undefined, { weekday: token.length >= 4 ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2020, 5, 7 + weekday)))
    if (token[0] === 'u') return token.length === 1 ? String(dayOfWeek) : String(dayOfWeek).padStart(token.length, '0')
    if (token === 'a') return hour < 12 ? 'AM' : 'PM'
    if (token[0] === 'w') return token.length === 1 ? String(weekOfYear) : String(weekOfYear).padStart(token.length, '0')
    if (token[0] === 'W') return token.length === 1 ? String(weekOfMonth) : String(weekOfMonth).padStart(token.length, '0')
    if (token[0] === 'F') return String(Math.floor((day - 1) / 7) + 1)
    if (token[0] === 'z') return timezoneName
    if (token[0] === 'G') return token.length >= 4 ? 'AD' : 'AD'
    if (token === 'Z') return offset
    if (token[0] === 'X') {
      if (offsetMinutes === 0) return 'Z'
      if (token.length === 1) return offset.slice(0, 3)
      return token.length === 2 ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`
    }
    return token
  })
}

/** Node 侧组合平台解析器、QuickJS 与编码能力，书源规则解释由 source-core 执行。 */
export class SourceRuleHost implements WorkflowRulePort {
  private readonly runtime: SourceRuleRuntime

  public constructor(options: SourceRuleHostOptions = {}) {
    const encoding = options.encoding ?? new NodeEncodingHost()
    this.runtime = new SourceRuleRuntime({
      encoding,
      crypto: options.crypto ?? new NodeCryptoHost(encoding),
      font: options.font ?? new NodeFontHost({ encoding }),
      html: new HtmlParserAdapter(),
      json: new JsonPathParserAdapter(),
      xpath: new XPathParserAdapter(),
      javascript: new QuickJSJavaScriptHost(),
      ...(options.request === undefined ? {} : { request: options.request }),
      ...(options.setConcurrentRate === undefined ? {} : { setConcurrentRate: options.setConcurrentRate }),
      ...(options.initialVariables === undefined ? {} : { initialVariables: options.initialVariables }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      timeFormat: options.timeFormat ?? ((time) => formatJavaDate(time, 'yyyy/MM/dd HH:mm') ?? ''),
      timeFormatUTC: options.timeFormatUTC ?? ((time, format, offsetMs) => formatJavaDate(time, format, offsetMs)),
      randomUUID: options.randomUUID ?? randomUUID,
      ...(options.sourceState === undefined ? {} : { sourceState: options.sourceState }),
      ...(options.file === undefined ? {} : { file: options.file }),
      webViewUA: options.webViewUA ?? (() => DEFAULT_ANDROID_USER_AGENT),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
  }

  public setBindings(bindings: Readonly<Record<string, unknown>>): void {
    this.runtime.setBindings(bindings)
  }

  public setVariable(name: string, value: string | null): void {
    this.runtime.setVariable(name, value)
  }

  public snapshotVariables(scope: 'source'): Readonly<Record<string, string>> {
    return this.runtime.snapshotVariables(scope)
  }

  public executeJavaScript(code: string, stage: 'mainJs' | 'book' | 'chapter' | 'search' | 'content', source: NormalizedSource, content: unknown = '', signal?: AbortSignal): Promise<WorkflowRuleOutput> {
    return this.runtime.executeJavaScript(code, stage, source, content, signal)
  }

  public executeWorkflowJavaScript(request: WorkflowJavaScriptRequest): Promise<WorkflowRuleOutput> {
    return this.runtime.executeWorkflowJavaScript(request)
  }

  public executeImageDecodeScript(request: WorkflowImageDecodeRequest): Promise<WorkflowRuleOutput> {
    return this.runtime.executeImageDecodeScript(request)
  }

  public executeSourceFunction(request: SourceFunctionRequest): Promise<SourceFunctionOutput> {
    return this.runtime.executeSourceFunction(request)
  }

  public evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput> {
    return this.runtime.evaluate(request)
  }
}

export type { SourceFunctionName, SourceFunctionRequest }
