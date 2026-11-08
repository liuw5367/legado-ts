import { executeInfoMap } from './info-map.ts'
import { executeMainJsFlow } from './main-js-flow.ts'
import { executeRedirect } from './redirect.ts'
import { executeZipDownload } from './zip-download.ts'
import { decodeImage, parseRelaxedJsonPreservingKeyOrder } from '../../source-core/src/index.ts'
import { splitSourceRequestUrl } from '../../source-core/src/runtime/request-url.ts'
import { executeContentLifecycle } from './content-lifecycle.ts'
import { executeContentBatchFlow } from './content-batch-flow.ts'
import { executeLoginHeaderFlow } from './login-header-flow.ts'
import { executeBookFlow } from './book-flow.ts'
import { executeCookieMap } from './cookie-map.ts'
import { executeDateBridge } from './date-bridge.ts'
import { replaceBalancedInnerRules, splitCodeBalanced, splitTopLevel } from '../../source-core/src/rules/scanner.ts'
import { createNodeSourceSession, type NodeSourceRuntimeSnapshot, type NodeSourceSession } from '../../source-node/src/source-session.ts'
import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'
import { JsonPathParserAdapter } from '../../source-node/src/jsonpath.ts'
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
async function script(host: SourceRuleHost, expression: string, content: unknown = ''): Promise<unknown> {
  // 在真正的 QuickJS/Java bridge 内捕获异常，保留原始错误；不把宿主包装状态误当 API 返回值。
  const code = `JSON.stringify((function(){try{return {outcome:'return',value:(function(){${expression}})()}}catch(e){return {outcome:'throw',error:{class:String(e.name||'Error'),message:String(e.message||e)}}}})())`
  const raw = checked(await host.executeJavaScript(code, 'content', source, content))
  const result = JSON.parse(String(raw)) as { outcome: string; value?: unknown; error?: { class: string; message: string } }
  if (result.outcome === 'throw') throw new ObservedError(result.error!.class, result.error!.message)
  return result.value
}
export async function execute(item: CaseInput): Promise<unknown> {
  if (item.operation === 'rule.cookieMap') return executeCookieMap(item.input)
  if (item.operation === 'rule.dateBridge') return executeDateBridge(item.input)
  if (item.operation === 'request.redirect') return executeRedirect(item.input)
  if (item.operation === 'rule.zipDownload') return executeZipDownload(item.input)
  if (item.operation === 'flow.contentLifecycle') return executeContentLifecycle(item.input)
  if (item.operation === 'flow.contentBatch') return executeContentBatchFlow(item.input)
  if (item.operation === 'flow.loginHeader') return executeLoginHeaderFlow(item.input)
  if (item.operation === 'rule.infoMap') return executeInfoMap(item.input)
  if (item.operation === 'flow.mainJs') return executeMainJsFlow(item.input)
  if (item.operation === 'flow.discover') return executeBookFlow(item.input, 'discover')
  if (item.operation === 'flow.book' || item.operation === 'flow.toc') return executeBookFlow(item.input, item.operation === 'flow.toc' ? 'toc' : 'book')
  const i = item.input
  const str = (key: string): string => String(i[key] ?? '')
  const json = (key: string): string => JSON.stringify(i[key] ?? '')
  const host = new SourceRuleHost()
  switch (item.operation) {
    case 'rule.providerCrypto': {
      const cipherSetup = `var Cipher = Packages.javax.crypto.Cipher, spec = Packages.javax.crypto.spec;`
      if (str('kind') === 'gcm') return script(host, `${cipherSetup}
        var key = new spec.SecretKeySpec(java.hexDecodeToByteArray(${json('key')}), 'AES');
        var iv = new spec.GCMParameterSpec(128, java.hexDecodeToByteArray(${json('iv')}));
        var cipher = Cipher.getInstance('AES/GCM/NoPadding'), aad = ${json('aad')};
        cipher.init(Cipher.ENCRYPT_MODE, key, iv);
        cipher.updateAAD(java.strToBytes(aad));
        var encrypted = cipher.doFinal(java.strToBytes(${json('plaintext')}));
        function decrypt(associated) {
          cipher.init(Cipher.DECRYPT_MODE, key, iv);
          cipher.updateAAD(java.strToBytes(associated));
          return java.bytesToStr(cipher.doFinal(encrypted));
        }
        var plaintext = decrypt(aad), rejectsWrongAad = false;
        try { decrypt('wrong'); } catch (error) { rejectsWrongAad = true; }
        return {ciphertext: Array.from(encrypted, n => (n & 255).toString(16).padStart(2, '0')).join(''), plaintext, rejectsWrongAad};
      `)
      const result = await host.executeWorkflowJavaScript({ source, stage: 'book', code: `${cipherSetup}
        var security = Packages.java.security;
        var key = security.KeyFactory.getInstance('RSA').generatePrivate(new security.spec.PKCS8EncodedKeySpec(java.base64DecodeToByteArray(${json('privateKey')})));
        var options = new spec.OAEPParameterSpec('SHA-256', 'MGF1', new security.spec.MGF1ParameterSpec(${json('mgf')}), new spec.PSource.PSpecified(new Uint8Array()));
        var rsa = Cipher.getInstance('RSA/ECB/OAEPWithSHA-256AndMGF1Padding');
        rsa.init(Cipher.DECRYPT_MODE, key, options);
        java.bytesToStr(rsa.doFinal(java.base64DecodeToByteArray(${json('ciphertext')})));
      ` })
      if (result.status === 'capability-missing') return { status: result.status, plaintext: null }
      return { status: result.status, plaintext: checked(result) }
    }
    case 'rule.font':
      return script(host, `var bad = java.queryBase64TTF(${json('errorFont')}), good = java.queryBase64TTF(${json('correctFont')});
        var point = ${Number(i.point)}, missing = ${Number(i.missing)}, text = ${json('text')}, id = bad.getGlyfIdByUnicode(point), glyph = bad.getGlyfByUnicode(point);
        return {id, glyph, byId: bad.getGlyfById(id), missingId: bad.getGlyfIdByUnicode(missing), missingGlyph: bad.getGlyfByUnicode(missing),
          mapped: good.getUnicodeByGlyf(glyph), preserved: java.replaceFont(text,bad,good,false), filtered: java.replaceFont(text,bad,good,true)};
      `)
    case 'rule.legacyCrypto': {
      const bindings = `const transformation = "AES/CBC/PKCS5Padding", key = ${json('key')}, iv = ${json('iv')}, plaintext = ${json('plaintext')};`
      if (str('kind') === 'legacy') return script(host, `${bindings}
        return {
          plaintext: java.aesEncodeToString(${json('ciphertext')}, key, transformation, iv),
          base64Bytes: Array.from(java.aesEncodeToBase64ByteArray(plaintext, key, transformation, iv))
        };
      `)
      if (str('kind') !== 'factory') throw new UnsupportedOperation('未知加密兼容案例')
      return script(host, `${bindings}
        const first = java.createSymmetricCrypto(transformation, key, iv);
        const second = java.createSymmetricCrypto(transformation, key, iv);
        const original = first.encrypt(plaintext);
        const changed = first.setIv(java.strToBytes(${json('changedIv')}));
        const updated = first.encrypt(plaintext);
        return { first: Array.from(original), second: Array.from(updated), independent: Array.from(second.encrypt(plaintext)),
          decrypted: first.decryptStr(updated), sameInstance: changed === first };
      `)
    }
    case 'rule.coverStream': {
      let inputCloseCalls = 0
      const rules = new SourceRuleHost({ logger: (level, value) => {
        if (level === 'log' && value === 'input-closed') inputCloseCalls++
      } })
      const result = await decodeImage({
        rules,
        network: { request: async () => { throw new Error('离线封面解密不得发起请求') } },
      }, {
        source: { ...source, coverDecodeJs: str('script') }, src: str('src'),
        bytes: Buffer.from(str('bytes'), 'base64'), isCover: true,
      })
      return { status: result.status, bytes: result.value === null ? null : Buffer.from(result.value).toString('base64'), inputCloseCalls }
    }
    case 'rule.sourceState': {
      const key = json('key')
      const value = json('value')
      const bytes = JSON.stringify([...Buffer.from(str('bytes'), 'base64')])
      const executeState = async (session: NodeSourceSession, code: string) => {
        const result = await session.run((ports) => ports.rules.evaluate({
          source: session.source, stage: 'search', field: 'fixture', rule: `@js:${code}`, content: '',
        }))
        return JSON.parse(String(checked(result)))
      }
      const observe = async (session: NodeSourceSession, setup = '') => {
        const observed = await executeState(session, `${setup}
          var bytes = cache.getByteArray(${key});
          JSON.stringify({ cached: cache.get(${key}), bytes: bytes == null ? bytes : Array.from(bytes), variable: source.getVariable(), key: source.get(${key}) });
        `)
        return { ...observed, storedVariable: session.snapshotRuntimeState().sourceVariables?.[session.source.bookSourceUrl] ?? null }
      }
      const first = createNodeSourceSession(source)
      try {
        const missing = await observe(first)
        const empty = await observe(first, `cache.put(${key}, ""); cache.put(${key}, Uint8Array.from(${bytes})); source.putVariable("");`)
        const overwritten = await observe(first, `cache.put(${key}, ${value}); source.putVariable(${value}); source.put(${key}, ${value});`)
        const snapshot = JSON.parse(JSON.stringify(first.snapshotRuntimeState())) as NodeSourceRuntimeSnapshot
        const kind = str('kind')
        if (kind === 'isolation') {
          const other = createNodeSourceSession({ ...source, bookSourceUrl: 'https://second.fixture.invalid' }, { initialRuntimeState: snapshot })
          try {
            return { first: overwritten, other: await observe(other), unchanged: await observe(first) }
          } finally {
            other.close()
          }
        }
        if (kind !== 'roundtrip') throw new UnsupportedOperation('未知源状态案例')
        const restoredSession = createNodeSourceSession(source, { initialRuntimeState: snapshot })
        try {
          const restored = await observe(restoredSession)
          const deleted = await observe(restoredSession, `cache.delete(${key}); source.putVariable(null);`)
          return { missing, empty, overwritten, restored, deleted }
        } finally {
          restoredSession.close()
        }
      } finally {
        first.close()
      }
    }
    case 'rule.scriptLibrary': {
      const kind = str('kind')
      const first = { ...source, jsLib: str('library') }
      const second = { ...first, bookSourceUrl: 'https://second.fixture.invalid' }
      const executeLibrary = async (current: NormalizedSource, code = str('program')) => {
        const result = await host.executeWorkflowJavaScript({ source: current, stage: 'book', code, content: '' })
        return JSON.parse(String(checked(result)))
      }
      if (kind === 'date') {
        const previousTimeZone = process.env.TZ
        process.env.TZ = 'UTC'
        try {
          return await executeLibrary(first)
        } finally {
          if (previousTimeZone === undefined) delete process.env.TZ
          else process.env.TZ = previousTimeZone
        }
      }
      if (kind === 'closure') {
        const beforeRefresh = [await executeLibrary(first), await executeLibrary(first)]
        await executeLibrary(first, 'source.refreshJSLib(); JSON.stringify(null)')
        return [...beforeRefresh, await executeLibrary(first)]
      }
      if (kind !== 'scope' && kind !== 'peer-refresh') throw new UnsupportedOperation('未知 jsLib 案例')
      const beforeRefresh = [await executeLibrary(first), await executeLibrary(first), await executeLibrary(second)]
      await executeLibrary(first, 'source.refreshJSLib(); JSON.stringify(null)')
      return [...beforeRefresh, await executeLibrary(kind === 'scope' ? first : second)]
    }
    case 'rule.bridgeObjects': {
      switch (str('kind')) {
        case 'map': return script(host, 'var m = new Packages.java.util.HashMap(); var missing=m.get("item"); var first=m.put("item","甲"); var second=m.put("item","乙"); return {missing:missing,first:first,second:second,current:m.get("item"),size:m.size()};')
        case 'list': return script(host, 'var l = new Packages.java.util.ArrayList(); l.add("甲"); l.add(null); l.add("乙"); return {index:l.get(1),last:l.get(2),items:l.toArray()};')
        case 'node': return script(host, 'var n=java.getElements(".item").get(0); return {text:n.text(),selected:n.select("a").attr("href")};', i.content)
        case 'response': {
          const url = str('url')
          const bridge = new SourceRuleHost({ request: async () => ({ url, status: 206, body: str('content'), headers: i.headers }) })
          const output = await bridge.executeWorkflowJavaScript({
            source, stage: 'search', content: '', bindings: { __legadoUrlContext: { url, method: 'GET', headerMap: {} } },
            code: 'var r=java.getStrResponse(null,null,false); var h=r.headers(); JSON.stringify({body:r.body(),status:r.code(),missing:h.get("missing"),last:h.get("x-test"),all:h.values("X-Test")})',
          })
          return JSON.parse(String(checked(output)))
        }
        default: throw new UnsupportedOperation('未知返回对象案例')
      }
    }
    case 'rule.bridgeString':
      return script(host, `java.setBaseUrl(${json('baseUrl')}); java.setRedirectUrl(${json('redirectUrl')});
        var text = ${json('textRule')}, url = ${json('urlRule')};
        return {literal:java.getString(text,false),unescaped:java.getString(text,true),fallback:java.getString(text,null,false),
          url:java.getString(url,null,true),list:java.getStringList(url,null,false),urlList:java.getStringList(url,null,true)}`, i.content)
    case 'rule.regexReplace': {
      const result = await host.evaluate({ source, stage: 'detail', field: 'ruleContent', rule: str('rule'), content: str('content'), expect: 'text' })
      // Android AnalyzeRule.getString exposes an empty String; SourceRuleHost represents it as status=empty.
      if (result.status === 'empty') return ''
      return checked(result)
    }
    case 'rule.split': {
      const operator = str('operator') as '&&' | '||' | '%%'
      const result = i.code === true ? splitCodeBalanced(str('rule'), operator) : splitTopLevel(str('rule'), operator)
      if (result.diagnostic) throw new ObservedError(result.diagnostic.code, result.diagnostic.message)
      return result.parts.map((p) => p.text)
    }
    case 'rule.inner': {
      const values = (i.values ?? {}) as Record<string, unknown>
      return (await replaceBalancedInnerRules(str('rule'), '{$.', (path) => {
        const value = Object.hasOwn(values, path) ? values[path] : undefined
        return value === undefined || value === null ? undefined : String(value)
      })).text
    }
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
    case 'url.options': {
      const parsed = splitSourceRequestUrl(str('url'))
      return { url: parsed.url, options: parsed.options ?? null }
    }
    case 'json.continue': return script(host, `return {first:java.getStringList(${JSON.stringify('@json:' + str('rule'))}),next:java.getString(${JSON.stringify('@json:' + str('nextRule'))})}`, i.content)
    case 'json.read': {
      const content = str('content')
      const parsed = parseRelaxedJsonPreservingKeyOrder(content)
      if (parsed === undefined) throw new Error('invalid JSON input')
      return new JsonPathParserAdapter().evaluate(parsed, str('rule'))
    }
    case 'json.string': return script(host, `return java.getString(${JSON.stringify('@json:' + str('rule'))})`, i.content)
    case 'json.list': return script(host, `return java.getStringList(${JSON.stringify('@json:' + str('rule'))})`, i.content)
    case 'xpath.string': return script(host, `return java.getString(${JSON.stringify('@xpath:' + str('rule'))})`, i.content)
    case 'xpath.list': return script(host, `return java.getStringList(${JSON.stringify('@xpath:' + str('rule'))})`, i.content)
    case 'xpath.nodes': {
      // Android getElements 会先按 &&/||/%% 拆分 XPath 规则；直接调 parser.evaluate 会漏掉这层可观察语义。
      if (str('rule').length === 0) return null
      return script(host, `return java.getElements(${json('rule')}).map(function(node){if(node!=null&&typeof node.tagName==="function")return {kind:"element",tag:node.tagName(),text:node.text(),attribute:node.attr(${json('attribute')})};return {kind:"scalar",value:node==null?"":String(node)}})`, i.content)
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
