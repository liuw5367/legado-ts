import { splitTopLevel } from '../../source-core/src/rules/scanner.ts'
import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'
import { XPathParserAdapter } from '../../source-node/src/xpath.ts'
import { JsonPathParserAdapter } from '../../source-node/src/jsonpath.ts'
import type { NormalizedSource, WorkflowRuleOutput, ParserNode } from '../../source-core/src/index.ts'

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
async function script(host: SourceRuleHost, expression: string, content: unknown = ''): Promise<unknown> {
  // 在真正的 QuickJS/Java bridge 内捕获异常，保留原始错误；不把宿主包装状态误当 API 返回值。
  const code = `JSON.stringify((function(){try{return {outcome:'return',value:(function(){${expression}})()}}catch(e){return {outcome:'throw',error:{class:String(e.name||'Error'),message:String(e.message||e)}}}})())`
  const raw = checked(await host.executeJavaScript(code, 'content', source, content))
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
      if (i.code === true) throw new UnsupportedOperation('TS scanner 没有独立 code 模式；代码内规则由实际 JSON/JS 入口验证')
      const operator = str('operator') as '&&' | '||' | '%%'
      const result = splitTopLevel(str('rule'), operator)
      if (result.diagnostic) throw new ObservedError(result.diagnostic.code, result.diagnostic.message)
      return result.parts.map((p) => p.text)
    }
    case 'rule.inner': throw new UnsupportedOperation('TS 没有独立 innerRule API；内嵌 JSON 规则由 json.string/json.list 案例覆盖')
    case 'regex.first':
    case 'regex.all': return script(host, `return java.${item.operation === 'regex.first' ? 'getElement' : 'getElements'}(${JSON.stringify(':' + (i.patterns as string[]).join('&&'))})`, i.text)
    case 'string.api': {
      let expression: string
      switch (str('method')) {
        case 'length': expression = 'text.length()'; break
        case 'charAt': expression = `String(text.charAt(${Number(i.index)}))`; break
        case 'substring': expression = `String(text.substring(${Number(i.index)}))`; break
        case 'substringRange': expression = `String(text.substring(${Number(i.index)},${Number(i.end)}))`; break
        case 'indexOf': expression = `text.indexOf(${json('value')})`; break
        case 'indexOfFrom': expression = `text.indexOf(${json('value')},${Number(i.index)})`; break
        case 'codePointAt': expression = `text.codePointAt(${Number(i.index)})`; break
        case 'codePointCount': expression = `text.codePointCount(${Number(i.index)},${Number(i.end)})`; break
        case 'offsetByCodePoints': expression = `text.offsetByCodePoints(${Number(i.index)},${Number(i.end)})`; break
        case 'getBytes': return script(host, `var bytes=new Packages.java.lang.String(${json('text')}).getBytes(${JSON.stringify(str('charset') || 'UTF-8')}); var value={type:'bytes',base64:Packages.java.util.Base64.getEncoder().encodeToString(bytes)}; return ${i.continue ? `{value:value,next:String(new Packages.java.lang.String(bytes,${JSON.stringify(str('charset') || 'UTF-8')}))}` : 'value'}`)
        default: throw new UnsupportedOperation(`未知 String 方法: ${str('method')}`)
      }
      return script(host, `var text=new Packages.java.lang.String(${json('text')}); var value=${expression}; return ${i.continue ? '{value:value,next:String(value).length}' : 'value'}`)
    }
    case 'integer.parseInt':
    case 'integer.parseLongRadix':
    case 'integer.bigInteger': {
      const expression = item.operation === 'integer.parseInt' ? `Packages.java.lang.Integer.parseInt(${json('text')},${Number(i.radix)})` : item.operation === 'integer.parseLongRadix' ? `{type:'integer',decimal:String(Packages.java.lang.Long.parseLong(${json('text')},${Number(i.radix)}))}` : `String(new Packages.java.math.BigInteger(${json('text')},${Number(i.radix)}).toString(${Number(i.outRadix ?? 10)}))`
      return script(host, `var value=${expression}; return ${i.continue ? "{value:value,next:'v:'+String(value.decimal===undefined?value:value.decimal)}" : 'value'}`)
    }
    case 'collection.sequence': return script(host, `var map=new Packages.java.util.HashMap(); var list=new Packages.java.util.ArrayList(); var view=list; return ${json('actions')}.map(function(raw){var a=JSON.parse(raw); if(${json('kind')}==='map'){switch(a[0]){case 'put':return map.put(a[1],a[2]);case 'get':return map.get(a[1]);case 'containsKey':return map.containsKey(a[1]);case 'remove':return map.remove(a[1]);case 'size':return map.size();case 'clear':map.clear();return null;default:throw new Error('未知 Map 操作')}} switch(a[0]){case 'add':return view.add(a[1]);case 'get':return view.get(a[1]);case 'set':return view.set(a[1],a[2]);case 'remove':return view.remove(a[1]);case 'size':return view.size();case 'subList':view=view.subList(a[1],a[2]);return view.toArray();case 'root':view=list;return view.toArray();case 'rootSet':return list.set(a[1],a[2]);case 'snapshot':return view.toArray();case 'clear':view.clear();return null;default:throw new Error('未知 List 操作')}})`)
    case 'pattern.matcher': return script(host, `var m=Packages.java.util.regex.Pattern.compile(${json('pattern')},${Number(i.flags ?? 0)}).matcher(${json('text')}); return ${json('actions')}.map(function(raw){var a=JSON.parse(raw); switch(a[0]){case 'find':return a.length>1?m.find(a[1]):m.find();case 'matches':return m.matches();case 'group':return m.group(a[1]);case 'start':return m.start(a[1]);case 'end':return m.end(a[1]);case 'reset':a.length>1?m.reset(a[1]):m.reset();return 'reset';case 'replaceAll':return String(m.replaceAll(a[1]));default:throw new Error('未知 Matcher 操作')}})`)
    case 'pattern.split': return script(host, `return Packages.java.util.regex.Pattern.compile(${json('pattern')}).split(${json('text')},${Number(i.limit)}).toArray().map(function(v){return String(v)})`)
    case 'string.split': return script(host, `return new Packages.java.lang.String(${json('text')}).split(${json('pattern')},${Number(i.limit)}).toArray().map(function(v){return String(v)})`)
    case 'string.replaceAll':
    case 'string.replaceFirst': return script(host, `return String(new Packages.java.lang.String(${json('text')}).${item.operation.slice(7)}(${json('pattern')},${json('replacement')}))`)
    case 'pattern.quote': return script(host, `return Packages.java.util.regex.Pattern.quote(${json('text')})`)
    case 'integer.parseLong': return script(host, `return {type:'integer',decimal:String(Packages.java.lang.Long.parseLong(${json('text')}))}`)
    case 'encoding.java64': {
      const factory = str('mode') === 'url' ? 'Url' : str('mode') === 'mime' ? 'Mime' : ''
      const method = i.action === 'encode' ? `get${factory}Encoder()` : `get${factory}Decoder()`
      return script(host, `var B=Packages.java.util.Base64; var codec=B.${method}; ${i.padding === false && i.action === 'encode' ? 'codec=codec.withoutPadding();' : ''} var value=${i.action === 'encode' ? `codec.encodeToString(B.getDecoder().decode(${json('text')}))` : `B.getEncoder().encodeToString(codec.decode(${json('text')}))`}; return ${i.continue ? "{value:value,next:'v:'+value}" : 'value'}`)
    }
    case 'encoding.digest': return script(host, `var B=Packages.java.util.Base64; var d=Packages.java.security.MessageDigest.getInstance(${json('algorithm')}); var value=B.getEncoder().encodeToString(d.digest(B.getDecoder().decode(${json('text')}))); return ${i.continue ? "{value:value,next:B.getEncoder().encodeToString(d.digest(new Uint8Array()))}" : 'value'}`)
    case 'encoding.base64Encode': return script(host, `return Packages.java.util.Base64.getEncoder().encodeToString(new Packages.java.lang.String(${json('text')}).getBytes('UTF-8'))`)
    case 'encoding.base64Decode': return script(host, `var bytes=Packages.java.util.Base64.getDecoder().decode(${json('text')}); return {type:'bytes',base64:Packages.java.util.Base64.getEncoder().encodeToString(bytes)}`)
    case 'encoding.urlEncode': return script(host, `return Packages.java.net.URLEncoder.encode(${json('text')},${JSON.stringify(str('charset') || 'UTF-8')})`)
    case 'encoding.urlDecode': return script(host, `return Packages.java.net.URLDecoder.decode(${json('text')},${JSON.stringify(str('charset') || 'UTF-8')})`)
    case 'encoding.md5': return script(host, `return java.md5Encode(${json('text')})`)
    case 'url.parts': return script(host, `var u=java.toURL(${json('url')}${i.base === undefined ? '' : `,${json('base')}`}); return {protocol:u.getProtocol(),host:u.getHost(),port:u.getPort(),defaultPort:u.getDefaultPort(),path:u.getPath(),file:u.getFile(),query:u.getQuery(),ref:u.getRef(),authority:u.getAuthority(),userInfo:u.getUserInfo()}`)
    case 'json.continue': return script(host, `return {first:java.getStringList(${JSON.stringify('@json:' + str('rule'))}),next:java.getString(${JSON.stringify('@json:' + str('nextRule'))})}`, i.content)
    case 'json.read': return new JsonPathParserAdapter().evaluate(JSON.parse(str('content')), str('rule'))
    case 'json.string': return script(host, `return java.getString(${JSON.stringify('@json:' + str('rule'))})`, i.content)
    case 'json.list': return script(host, `return java.getStringList(${JSON.stringify('@json:' + str('rule'))})`, i.content)
    case 'xpath.string': return script(host, `return java.getString(${JSON.stringify('@xpath:' + str('rule'))})`, i.content)
    case 'xpath.list': return script(host, `return java.getStringList(${JSON.stringify('@xpath:' + str('rule'))})`, i.content)
    case 'xpath.nodes': {
      const parser = new XPathParserAdapter()
      const document = parser.parse(str('content'))
      const nodes = parser.evaluate(document, str('rule'))
      if (nodes === null) return null
      if (!Array.isArray(nodes)) throw new UnsupportedOperation('节点案例必须选择节点序列')
      return nodes.map((item) => { const node = item as ParserNode; return { tag: document.describe(node).tagName, text: document.read(node, 'text'), attribute: document.attr(node, str('attribute')) ?? '' } })
    }
    case 'css.nodes': return script(host, `return java.getElements(${json('rule')}).toArray().map(function(n){return {tag:n.tagName(),text:n.text(),id:n.idName()}})`, i.content)
    case 'corpus.cssString': {
      const context = i.contextRule === undefined ? '' : `,java.getElements(${json('contextRule')}).first()`
      return script(host, `return java.getString(${json('rule')}${context})`, i.content)
    }
    case 'chapter.number': return script(host, `return java.toNumChapter(${i.text === undefined ? 'null' : json('text')})`)
    case 'corpus.script': {
      const nodes = i.nodes === true
      const bindings = i.custom === undefined ? undefined : { book: { variable: JSON.stringify({ custom: i.custom }) } }
      if (bindings !== undefined) host.setBindings(bindings)
      const output = await host.evaluate({ source, stage: 'detail', field: nodes ? 'chapterList' : 'fixture', rule: str('rule'), content: i.content, expect: nodes ? 'nodes' : 'text', ...(bindings === undefined ? {} : { bindings }) })
      const value = checked(output)
      const project = '.map(n=>({tag:n.tagName(),text:n.text(),id:n.idName()}))'
      const workflow = nodes
        ? await script(host, `return java.getElements("<js>result</js>")${project}`, value)
        : Array.isArray(value) ? value.map(String).join('\n') : String(value ?? '')
      const bridge = await script(host, nodes ? `return java.getElements(${json('rule')})${project}` : `return java.getString(${json('rule')})`, i.content)
      return { workflow, bridge }
    }
    case 'css.string':
    case 'css.list':
    {
      // 只做公共接口形态映射：text 字段列表按换行合并，合法空结果分别映射为 null/[] 或空串。
      const output = await host.evaluate({ source, stage: 'detail', field: 'fixture', rule: str('rule'), content: i.content })
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
