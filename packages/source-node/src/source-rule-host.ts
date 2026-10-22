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
  /** Date formatter locale used for month/weekday names. */
  locale?: string
  /** Optional IANA zone for the local timeFormat helper. */
  timeZone?: string
}

const dateTokenMaximum: Readonly<Record<string, number>> = { G: 5, y: Number.POSITIVE_INFINITY, Y: Number.POSITIVE_INFINITY, u: 1, M: 4, L: 4, d: 2, D: 3, H: 2, k: 2, K: 2, h: 2, m: 2, s: 2, S: 3, E: 5, a: 1, w: 2, W: 1, F: 1, z: 4, Z: 5, X: 3 }

function validJavaDatePattern(pattern: string): boolean {
  if (pattern.length > 512) return false
  let quoted = false
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index]!
    if (character === "'") {
      if (pattern[index + 1] === "'") { index += 2; continue }
      quoted = !quoted; index += 1; continue
    }
    if (quoted || !/[A-Za-z]/u.test(character)) { index += 1; continue }
    let end = index + 1
    while (end < pattern.length && pattern[end] === character) end += 1
    const maximum = dateTokenMaximum[character]
    if (maximum === undefined || end - index > maximum) return false
    index = end
  }
  return !quoted
}

function timeZoneOffsetMs(time: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(time))
    const value = parts.find((item) => item.type === 'timeZoneName')?.value ?? 'GMT'
    const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/u.exec(value)
    if (match?.groups?.sign === undefined) return 0
    const minutes = Number(match.groups.hours) * 60 + Number(match.groups.minutes ?? 0)
    return (match.groups.sign === '-' ? -minutes : minutes) * 60_000
  } catch {
    return null
  }
}

function javaWeekFields(year: number, month: number, day: number, locale: string): { weekYear: number; weekOfYear: number; weekOfMonth: number } {
  const localeInfo = new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay: number; minimalDays: number } }
  const weekInfo = localeInfo.weekInfo ?? { firstDay: 1, minimalDays: 1 }
  const firstDay = weekInfo.firstDay % 7
  const millisecondsPerDay = 86_400_000
  const startOfWeek = (value: number): number => value - ((new Date(value).getUTCDay() - firstDay + 7) % 7) * millisecondsPerDay
  const firstWeekOfYear = (targetYear: number): number => {
    const firstDayOfYear = Date.UTC(targetYear, 0, 1)
    const start = startOfWeek(firstDayOfYear)
    return firstDayOfYear - start < weekInfo.minimalDays * millisecondsPerDay ? start + 7 * millisecondsPerDay : start
  }
  const current = startOfWeek(Date.UTC(year, month - 1, day))
  let weekYear = year
  let first = firstWeekOfYear(year)
  if (current < first) { weekYear -= 1; first = firstWeekOfYear(weekYear) }
  else if (current >= firstWeekOfYear(year + 1)) { weekYear += 1; first = firstWeekOfYear(weekYear) }
  const weekOfYear = Math.floor((current - first) / (7 * millisecondsPerDay)) + 1
  const monthStart = startOfWeek(Date.UTC(year, month - 1, 1))
  const weekOfMonth = Math.floor((current - monthStart) / (7 * millisecondsPerDay)) + 1
  return { weekYear, weekOfYear, weekOfMonth }
}

function formatJavaDate(time: number, pattern: string, offsetMs?: number, locale = 'en-US'): string | null {
  if (!Number.isFinite(time) || !Number.isFinite(offsetMs ?? 0)) return null
  if (!validJavaDatePattern(pattern)) return null
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
  const weeks = javaWeekFields(year, month, day, locale)
  const dayOfWeek = weekday === 0 ? 7 : weekday
  const timezoneName = utc ? 'UTC' : new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(date).find((item) => item.type === 'timeZoneName')?.value ?? offset
  return pattern.replace(/'([^']|'')*'|Y+|y+|M+|L+|d+|D+|H+|k+|K+|h+|m+|s+|S+|E+|u+|a|w+|W+|F+|z+|G+|Z+|X+/gu, (token) => {
    if (token === "''") return "'"
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (token[0] === 'Y') return token.length === 2 ? String(weeks.weekYear % 100).padStart(2, '0') : String(weeks.weekYear).padStart(token.length, '0')
    if (token[0] === 'y') return token.length === 2 ? String(year % 100).padStart(2, '0') : String(year).padStart(token.length, '0')
    if (token[0] === 'M' || token[0] === 'L') {
      if (token.length <= 2) return token.length === 1 ? String(month) : String(month).padStart(2, '0')
      return new Intl.DateTimeFormat(locale, { month: token.length === 3 ? 'short' : 'long', ...(utc ? { timeZone: 'UTC' } : {}) }).format(date)
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
    if (token[0] === 'E') return new Intl.DateTimeFormat(locale, { weekday: token.length >= 4 ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2020, 5, 7 + weekday)))
    if (token[0] === 'u') return token.length === 1 ? String(dayOfWeek) : String(dayOfWeek).padStart(token.length, '0')
    if (token === 'a') return hour < 12 ? 'AM' : 'PM'
    if (token[0] === 'w') return token.length === 1 ? String(weeks.weekOfYear) : String(weeks.weekOfYear).padStart(token.length, '0')
    if (token[0] === 'W') return String(weeks.weekOfMonth)
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
      timeFormat: options.timeFormat ?? ((time) => {
        const offset = options.timeZone === undefined ? undefined : timeZoneOffsetMs(time, options.timeZone)
        return offset === null ? '' : formatJavaDate(time, 'yyyy/MM/dd HH:mm', offset ?? undefined, options.locale) ?? ''
      }),
      timeFormatUTC: options.timeFormatUTC ?? ((time, format, offsetMs) => formatJavaDate(time, format, offsetMs, options.locale)),
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
