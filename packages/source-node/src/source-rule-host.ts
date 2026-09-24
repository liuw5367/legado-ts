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
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
  }

  public setBindings(bindings: Readonly<Record<string, unknown>>): void {
    this.runtime.setBindings(bindings)
  }

  public setVariable(name: string, value: string | null): void {
    this.runtime.setVariable(name, value)
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
