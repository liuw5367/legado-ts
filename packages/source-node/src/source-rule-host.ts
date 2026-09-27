import {
  SourceRuleRuntime,
} from '@legado/source-core'
import type {
  SourceRuleRuntimeOptions,
  WorkflowJavaScriptRequest,
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

export type { SourceRuleBridgeRequest } from '@legado/source-core'

export interface SourceRuleHostOptions extends Omit<SourceRuleRuntimeOptions, 'encoding' | 'crypto' | 'font' | 'html' | 'json' | 'xpath' | 'javascript'> {
  encoding?: NodeEncodingHost
  crypto?: NodeCryptoHost
  font?: NodeFontHost
}

function formatJavaDate(time: number, pattern: string, offsetMs?: number): string | null {
  if (!Number.isFinite(time) || !Number.isFinite(offsetMs ?? 0)) return null
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
  return pattern.replace(/'([^']|'')*'|y+|M+|d+|H+|h+|m+|s+|S+|E+|a|Z|X+/gu, (token) => {
    if (token === "''") return "'"
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (token[0] === 'y') return token.length === 2 ? String(year % 100).padStart(2, '0') : String(year).padStart(token.length, '0')
    if (token[0] === 'M') {
      if (token.length <= 2) return token.length === 1 ? String(month) : String(month).padStart(2, '0')
      return new Intl.DateTimeFormat(undefined, { month: token.length === 3 ? 'short' : 'long', ...(utc ? { timeZone: 'UTC' } : {}) }).format(date)
    }
    if (token[0] === 'd') return token.length === 1 ? String(day) : String(day).padStart(token.length, '0')
    if (token[0] === 'H' || token[0] === 'h') {
      const value = token[0] === 'h' ? (hour % 12 || 12) : hour
      return token.length === 1 ? String(value) : String(value).padStart(token.length, '0')
    }
    if (token[0] === 'm') return token.length === 1 ? String(minute) : String(minute).padStart(token.length, '0')
    if (token[0] === 's') return token.length === 1 ? String(second) : String(second).padStart(token.length, '0')
    if (token[0] === 'S') return String(millis).padStart(token.length, '0')
    if (token[0] === 'E') return new Intl.DateTimeFormat(undefined, { weekday: token.length >= 4 ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2020, 5, 7 + weekday)))
    if (token === 'a') return hour < 12 ? 'AM' : 'PM'
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
      ...(options.initialVariables === undefined ? {} : { initialVariables: options.initialVariables }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      timeFormat: options.timeFormat ?? ((time) => formatJavaDate(time, 'yyyy/MM/dd HH:mm') ?? ''),
      timeFormatUTC: options.timeFormatUTC ?? ((time, format, offsetMs) => formatJavaDate(time, format, offsetMs)),
      randomUUID: options.randomUUID ?? randomUUID,
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

  public executeSourceFunction(request: SourceFunctionRequest): Promise<SourceFunctionOutput> {
    return this.runtime.executeSourceFunction(request)
  }

  public evaluate(request: WorkflowRuleRequest): Promise<WorkflowRuleOutput> {
    return this.runtime.evaluate(request)
  }
}

export type { SourceFunctionName, SourceFunctionRequest }
