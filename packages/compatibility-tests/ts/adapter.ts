import { splitTopLevel } from '../../source-core/src/rules/scanner.ts'
import { compileRule } from '../../source-core/src/rules/compiler.ts'
import { evaluateRule } from '../../source-core/src/rules/evaluator.ts'
import { MemoryVariableView } from '../../source-core/src/rules/variables.ts'
import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'
import { NodeEncodingHost } from '../../source-node/src/encoding.ts'
import type { NormalizedSource, WorkflowRuleOutput } from '../../source-core/src/index.ts'

interface CaseInput {
  operation: string
  input: Record<string, unknown>
}
const source = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'compatibility-tests' } as NormalizedSource

export class UnsupportedOperation extends Error {}
export class ObservedError extends Error {
  public readonly rawClass: string
  public constructor(rawClass: string, message: string) { super(message); this.rawClass = rawClass }
}
function checked(output: WorkflowRuleOutput): unknown {
  if (output.status === 'capability-missing') throw new UnsupportedOperation(output.message ?? '缺少能力')
  if (output.status !== 'success' && output.status !== 'empty') throw new ObservedError(output.status, output.message ?? output.status)
  return output.value
}
async function script(host: SourceRuleHost, expression: string): Promise<unknown> {
  // 在真正的 QuickJS/Java bridge 内捕获异常，保留原始错误；不把宿主包装状态误当 API 返回值。
  const code = `JSON.stringify((function(){try{return {outcome:'return',value:(function(){${expression}})()}}catch(e){return {outcome:'throw',error:{class:String(e.name||'Error'),message:String(e.message||e)}}}})())`
  const raw = checked(await host.executeJavaScript(code, 'content', source))
  const result = JSON.parse(String(raw)) as { outcome: string; value?: unknown; error?: { class: string; message: string } }
  if (result.outcome === 'throw') throw new ObservedError(result.error!.class, result.error!.message)
  return result.value
}
export async function execute(item: CaseInput): Promise<unknown> {
  const i = item.input
  const str = (key: string): string => String(i[key] ?? '')
  const json = (key: string): string => JSON.stringify(i[key] ?? '')
  const host = new SourceRuleHost()
  switch (item.operation) {
    case 'rule.split': {
      const operator = str('operator') as '&&' | '||' | '%%'
      const result = splitTopLevel(str('rule'), operator)
      if (result.diagnostic) throw new ObservedError(result.diagnostic.code, result.diagnostic.message)
      return result.parts.map((p) => p.text)
    }
    case 'rule.inner': throw new UnsupportedOperation('TS 没有独立 innerRule API；内嵌 JSON 规则由 json.string/json.list 案例覆盖')
    case 'regex.first':
    case 'regex.all': {
      const patterns = i.patterns as string[]
      let content = str('text')
      let rows: unknown[][] = []
      for (const pattern of patterns) {
        const compiled = compileRule(`:${pattern}`, { allInOne: true })
        if (!compiled.rule) throw new ObservedError('compile-error', JSON.stringify(compiled.diagnostics))
        const output = evaluateRule(compiled.rule, { requestId: 'compatibility', source, content, variables: new MemoryVariableView() })
        if (output.status !== 'success' && output.status !== 'empty') throw new ObservedError(output.status, JSON.stringify(output.diagnostics))
        rows = (output.value ?? []) as unknown[][]
        content = rows.map((row) => row[0]).join('')
      }
      return item.operation === 'regex.first' ? rows[0] ?? null : rows
    }
    case 'string.split': return script(host, `return new Packages.java.lang.String(${json('text')}).split(${json('pattern')},${Number(i.limit)}).toArray().map(function(v){return String(v)})`)
    case 'string.replaceAll':
    case 'string.replaceFirst': return script(host, `return String(new Packages.java.lang.String(${json('text')}).${item.operation.slice(7)}(${json('pattern')},${json('replacement')}))`)
    case 'pattern.quote': return script(host, `return Packages.java.util.regex.Pattern.quote(${json('text')})`)
    case 'integer.parseLong': return script(host, `return {type:'integer',decimal:String(Packages.java.lang.Long.parseLong(${json('text')}))}`)
    case 'encoding.base64Encode': return new NodeEncodingHost().base64Encode(str('text'))
    case 'encoding.base64Decode': return { type: 'bytes', base64: Buffer.from(new NodeEncodingHost().base64Decode(str('text'))).toString('base64') }
    case 'encoding.urlEncode': return script(host, `return Packages.java.net.URLEncoder.encode(${json('text')},'UTF-8')`)
    case 'encoding.urlDecode': return script(host, `return Packages.java.net.URLDecoder.decode(${json('text')},'UTF-8')`)
    case 'encoding.md5': return script(host, `return java.md5Encode(${json('text')})`)
    case 'url.parts': return script(host, `var u=java.toURL(${json('url')}${i.base === undefined ? '' : `,${json('base')}`}); return {protocol:u.getProtocol(),host:u.getHost(),port:u.getPort(),defaultPort:u.getDefaultPort(),path:u.getPath(),file:u.getFile(),query:u.getQuery(),ref:u.getRef(),authority:u.getAuthority(),userInfo:u.getUserInfo()}`)
    case 'css.string':
    case 'css.list':
    case 'json.string':
    case 'json.list': {
      // 只做公共接口形态映射：text 字段列表按换行合并，合法空结果分别映射为 null/[] 或空串。
      const output = await host.evaluate({ source, stage: 'detail', field: 'fixture', rule: item.operation.startsWith('json.') ? `@json:${str('rule')}` : str('rule'), content: i.content })
      const value = checked(output)
      if (item.operation.endsWith('.string')) {
        if (value === null || value === undefined) return item.operation.startsWith('css') ? null : ''
        return Array.isArray(value) ? value.map(String).join('\n') : String(value)
      }
      if (value === null || value === undefined) return []
      return Array.isArray(value) ? value.map(String) : [String(value)]
    }
    default: throw new UnsupportedOperation(`未注册的操作: ${item.operation}`)
  }
}
