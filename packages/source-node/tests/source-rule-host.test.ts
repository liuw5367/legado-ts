import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { MemorySourceScriptCache } from '../../source-core/src/index.ts'
import type { NormalizedSource, WorkflowRuleRequest } from '../../source-core/src/index.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const source = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'fixture' } as NormalizedSource

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of input) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createZip(entries: readonly { name: string; data: Uint8Array; method: 0 | 8; comment?: string }[]): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const comment = Buffer.from(entry.comment ?? '', 'utf8')
    const data = Buffer.from(entry.data)
    const compressed = entry.method === 8 ? deflateRawSync(data) : data
    const checksum = crc32(data)
    const localHeader = Buffer.alloc(30 + name.length + compressed.length)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(entry.method, 8)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    name.copy(localHeader, 30)
    compressed.copy(localHeader, 30 + name.length)
    local.push(localHeader)

    const centralHeader = Buffer.alloc(46 + name.length + comment.length)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(entry.method, 10)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(comment.length, 32)
    centralHeader.writeUInt32LE(offset, 42)
    name.copy(centralHeader, 46)
    comment.copy(centralHeader, 46 + name.length)
    central.push(centralHeader)
    offset += localHeader.length
  }
  const localBytes = Buffer.concat(local)
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localBytes.length, 16)
  return Uint8Array.from(Buffer.concat([localBytes, centralBytes, end]))
}

async function evaluate(host: SourceRuleHost, rule: string, content: unknown, stage: WorkflowRuleRequest['stage'] = 'search') {
  return host.evaluate({ source, stage, field: 'fixture', rule, content })
}

/** 列表规则要求节点结果，必须显式声明 expect。 */
async function evaluateNodes(host: SourceRuleHost, rule: string, content: unknown) {
  return host.evaluate({ source, stage: 'search', field: 'bookList', rule, content, expect: 'nodes' })
}

test('规则宿主支持 HTML 列表节点继续提取文本和属性', async () => {
  const host = new SourceRuleHost()
  const html = '<section><ul><li class="book" href="/book/1"><h2 class="title">我本无意成仙</h2><span class="author">作者</span></li></ul></section>'
  const list = await evaluateNodes(host, 'section@.book', html)
  assert.equal(list.status, 'success')
  assert.ok(Array.isArray(list.value))
  const item = (list.value as unknown[])[0]
  assert.ok(item)

  const title = await evaluate(host, '.title@text', item)
  assert.equal(title.status, 'success')
  assert.deepEqual(title.value, ['我本无意成仙'])

  const dataUrl = await evaluate(host, '@href', item)
  assert.equal(dataUrl.status, 'success')
  assert.equal(dataUrl.value, '/book/1')
  const bareUrl = await evaluate(host, 'href', item)
  assert.equal(bareUrl.status, 'success')
  assert.equal(bareUrl.value, '/book/1')
})

test('HTML 规则的 text 选择器只匹配元素自身文本，html 返回外层元素', async () => {
  const host = new SourceRuleHost()
  const html = '<div class="outer">needle<span>nested</span><p><b>needle descendant</b></p><script>bad()</script></div>'

  const byOwnText = await evaluate(host, 'div@text.needle@all', html)
  assert.equal(byOwnText.status, 'success')
  assert.deepEqual(byOwnText.value, ['<b>needle descendant</b>'])

  const withHtml = await evaluate(host, 'div@html', html)
  assert.equal(withHtml.status, 'success')
  assert.deepEqual(withHtml.value, ['<div class="outer">needle<span>nested</span><p><b>needle descendant</b></p></div>'])
})

test('HTML 规则兼容 Android 的多 class 简写选择器', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, 'class.pull-right smaller-5@text', '<div class="pull-right smaller-5">作者</div>')
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value, ['作者'])
})

test('legacy class/id 选择器按 Android 字面值匹配 CSS 标识符', async () => {
  const host = new SourceRuleHost()
  const html = '<section><p class="badge:hot">类名</p><p id="book:item">编号</p></section>'
  const classResult = await evaluate(host, 'class.badge:hot@text', html)
  assert.equal(classResult.status, 'success')
  assert.deepEqual(classResult.value, ['类名'])
  const idResult = await evaluate(host, 'id.book:item@text', html)
  assert.equal(idResult.status, 'success')
  assert.deepEqual(idResult.value, ['编号'])
})

test('带 XML 声明的默认规则保持 Android XML 大小写语义', async () => {
  const host = new SourceRuleHost()
  const xml = '<?xml version="1.0"?><Root><Item ID="upper">大写</Item><item id="lower">小写</item></Root>'
  const upper = await evaluate(host, 'tag.Item@text', xml)
  assert.equal(upper.status, 'success')
  assert.deepEqual(upper.value, ['大写'])
  const lower = await evaluate(host, 'tag.item@text', xml)
  assert.equal(lower.status, 'success')
  assert.deepEqual(lower.value, ['小写'])
  const attribute = await evaluate(host, 'tag.Item@ID', xml)
  assert.equal(attribute.status, 'success')
  assert.deepEqual(attribute.value, ['upper'])
})

test('没有会话限流写端时 source.putConcurrent 显式报告缺失能力', async () => {
  const output = await evaluate(new SourceRuleHost(), '@js:source.putConcurrent("1/100")', '')
  assert.equal(output.status, 'capability-missing')
})

test('Android JsExtensions 和 BaseSource 方法清单全部注册到 JS 运行时', async () => {
  const javaNames = [
    'getSource', 'getTag', 'getSourceNavigationContext', 'getBatchContext', 'cacheContent', 'refreshBookInfo', 'refreshBookToc', 'refreshContent',
    'copyText', 'clearTtsCache', 'searchBook', 'addBook', 'showPhoto', 'open',
    'ajax', 'ajaxAll', 'ajaxTestAll', 'connect', 'webView', 'webViewGetSource', 'webViewGetOverrideUrl', 'openVideoPlayer', 'startBrowser', 'startBrowserAwait',
    'getVerificationCode', 'importScript', 'cacheFile', 'getCookie', 'downloadFile', 'get', 'head', 'post', 'strToBytes', 'bytesToStr', 'base64Decode',
    'base64DecodeToByteArray', 'base64Encode', 'hexDecodeToByteArray', 'hexDecodeToString', 'hexEncodeToString', 'timeFormatUTC', 'timeFormat', 'encodeURI',
    'htmlFormat', 't2s', 's2t', 'getWebViewUA', 'getFile', 'readFile', 'readTxtFile', 'deleteFile', 'unzipFile', 'un7zFile', 'unrarFile', 'unArchiveFile',
    'getTxtInFolder', 'getZipStringContent', 'getRarStringContent', 'get7zStringContent', 'getZipByteArrayContent', 'getRarByteArrayContent', 'get7zByteArrayContent',
    'queryBase64TTF', 'queryTTF', 'replaceFont', 'toNumChapter', 'toURL', 'toast', 'longToast', 'log', 'logType', 'randomUUID', 'androidId', 'openUrl', 'showBrowser',
    'singleFlight', 'lock', 'tick', 'getReadBookConfig', 'getReadBookConfigMap', 'getThemeMode', 'getThemeConfig', 'getThemeConfigMap',
    'md5Encode', 'md5Encode16', 'createSymmetricCrypto', 'createAsymmetricCrypto', 'createSign', 'aesDecodeToByteArray', 'aesDecodeToString', 'aesDecodeArgsBase64Str',
    'aesBase64DecodeToByteArray', 'aesBase64DecodeToString', 'aesEncodeToByteArray', 'aesEncodeToString', 'aesEncodeToBase64ByteArray', 'aesEncodeToBase64String',
    'aesEncodeArgsBase64Str', 'desDecodeToString', 'desBase64DecodeToString', 'desEncodeToString', 'desEncodeToBase64String', 'tripleDESDecodeStr',
    'tripleDESDecodeArgsBase64Str', 'tripleDESEncodeBase64Str', 'tripleDESEncodeArgsBase64Str', 'digestHex', 'digestBase64Str', 'HMacHex', 'HMacBase64',
  ]
  const sourceNames = ['getKey', 'getSource', 'getTag', 'getLoginUiJs', 'isLoginUiV2', 'evalLoginUiV2', 'evalLoginActionV2', 'getLoginJs', 'hasLoginForm', 'hasLogin', 'login', 'getHeaderMap', 'getLoginHeader', 'getLoginHeaderMap', 'putLoginHeader', 'removeLoginHeader', 'getLoginInfo', 'getLoginInfoMap', 'putLoginInfo', 'putLoginInfoMap', 'removeLoginInfo', 'setVariable', 'putVariable', 'getVariable', 'put', 'get', 'refreshExplore', 'refreshJSLib', 'putConcurrent', 'evalJS']
  const result = await evaluate(new SourceRuleHost(), `@js:JSON.stringify({java: Object.fromEntries(${JSON.stringify(javaNames)}.map((name) => [name, typeof java[name]])), source: Object.fromEntries(${JSON.stringify(sourceNames)}.map((name) => [name, typeof source[name]]))})`, '')
  assert.equal(result.status, 'success')
  const values = JSON.parse(String(result.value)) as { java: Record<string, string>; source: Record<string, string> }
  assert.deepEqual(Object.values(values.java), Array.from({ length: javaNames.length }, () => 'function'))
  assert.deepEqual(Object.values(values.source), Array.from({ length: sourceNames.length }, () => 'function'))
})

test('JavaImporter、Packages、Map/List 和 Java String 常见用法可运行', async () => {
  const host = new SourceRuleHost()
  const code = `var importer = new JavaImporter(Packages.java.lang, Packages.java.security);
    with (importer) {
      var digest = MessageDigest.getInstance('MD5').digest(String('123').getBytes());
      var map = new Packages.java.util.HashMap({ user: 'alice' });
      map.put('role', 'reader');
      var list = new Packages.java.util.ArrayList(['a']);
      list.add('b');
    var response = new Packages.io.legado.app.help.http.StrResponse('https://fixture.invalid', 'body');
    JSON.stringify({ digest: [digest.length, digest[0]], text: String('Book').substring(1, 3).toString(), map: [map.get('user'), map.get('role'), map.size()], list: [list.get(1), list.size()], response: [response.url, response.body, response.code] });
    }`
  const result = await evaluate(host, `@js:${code}`, '')
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), { digest: [16, 32], text: 'oo', map: ['alice', 'reader', 2], list: ['b', 2], response: ['https://fixture.invalid', 'body', 200] })
})

test('JavaImporter 提供受控 OkHttp 和 Hutool 请求/编码 facade', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    if (input.kind === 'network-response') return {
      body: '{"ok":true}',
      status: 201,
      message: 'Created',
      headers: { 'Content-Type': 'application/json', 'X-Reply': 'yes' },
      url: String(input.url),
      bytes: new TextEncoder().encode('{"ok":true}'),
    }
    throw new Error(`unexpected bridge request: ${input.kind}`)
  } })
  const result = await evaluate(host, `@js:
    var importer = new JavaImporter(Packages.okhttp3, Packages.cn.hutool.core.codec, Packages.cn.hutool.core.util, Packages.cn.hutool.crypto.digest);
    with (importer) {
      var mediaType = MediaType.parse('application/json');
      var requestBody = RequestBody.create('{"name":"book"}', mediaType);
      var requestValue = new Request.Builder().url('https://fixture.invalid/api').post(requestBody).addHeader('X-Test', 'one').addHeader('X-Test', 'two').build();
      var response = new OkHttpClient().newCall(requestValue).execute();
      JSON.stringify({
        request: [requestValue.url(), requestValue.method(), requestValue.headers().get('x-test'), requestValue.body().string(), requestValue.body().contentType().toString()],
        response: [response.code(), response.message(), response.body().string(), Array.from(response.body().bytes()), response.headers().get('x-reply'), response.isSuccessful()],
        tools: [Base64.encode('hello'), Array.from(Base64.decode('aGVsbG8=')), StrUtil.reverse('书源'), HexUtil.encodeHexStr('ok'), DigestUtil.md5Hex('123')],
        gzip: Array.from(ZipUtil.gzip('zip')).length > 0
      });
    }`, '')
  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(JSON.parse(String(result.value)), {
    request: ['https://fixture.invalid/api', 'POST', 'two', '{"name":"book"}', 'application/json'],
    response: [201, 'Created', '{"ok":true}', [123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125], 'yes', true],
    tools: ['aGVsbG8=', [104, 101, 108, 108, 111], '源书', '6f6b', '202cb962ac59075b964b07152d234b70'],
    gzip: true,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    kind: 'network-response',
    url: 'https://fixture.invalid/api',
    method: 'POST',
    body: '{"name":"book"}',
    headers: { 'X-Test': 'one,two', 'Content-Type': 'application/json' },
    options: { timeout: 30000, followRedirects: false },
    stage: 'search',
  })
})

test('Packages Java System、UUID 和 Thread 提供可闭环的时间、数组、随机值与休眠语义', async () => {
  const host = new SourceRuleHost({ randomUUID: () => '01234567-89ab-4cde-8123-456789abcdef' })
  const result = await evaluate(host, `@js:
    var importer = new JavaImporter(Packages.java.lang.System, Packages.java.lang.Thread, Packages.java.util.UUID);
    with (importer) {
      var values = [0, 0, 0, 0];
      System.arraycopy([1, 2, 3], 0, values, 1, 3);
      var uuid = UUID.randomUUID();
      var parsed = UUID.fromString('01234567-89ab-4cde-8123-456789abcdef');
      var property = [System.setProperty('fixture', 'value'), System.getProperty('fixture'), System.clearProperty('fixture'), System.getProperty('fixture'), System.getProperty('missing', 'fallback')];
      Thread.sleep(1);
      JSON.stringify({ values: values, uuid: [String(uuid), uuid.toString(), uuid.version(), uuid.variant(), uuid.equals(parsed)], time: [System.currentTimeMillis() > 0, System.nanoTime() > 0], property: property, thread: [Thread.currentThread().getName(), Thread.currentThread().getId()] });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    values: [0, 1, 2, 3],
    uuid: ['01234567-89ab-4cde-8123-456789abcdef', '01234567-89ab-4cde-8123-456789abcdef', 4, 2, true],
    time: [true, true],
    property: [null, 'value', 'value', null, 'fallback'],
    thread: ['main', 1],
  })
})

test('Java/Android 包别名、TextUtils、Build 和 GZIPInputStream 可消费真实书源写法', async () => {
  const encoded = Buffer.from(gzipSync(Buffer.from('压缩正文', 'utf8'))).toString('base64')
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang, Packages.java.io, Packages.java.util, Packages.java.util.zip, Packages.android.text);
    with (importer) {
      var input = new GZIPInputStream(new ByteArrayInputStream(Base64.getDecoder().decode('${encoded}')));
      var buffer = new java.lang.String('        ').getBytes();
      var output = new ByteArrayOutputStream();
      var count = input.read(buffer);
      while (count > 0) { output.write(buffer, 0, count); count = input.read(buffer); }
      JSON.stringify({ alias: new java.lang.String('ok').toString(), text: output.toString('UTF-8'), empty: [TextUtils.isEmpty(null), TextUtils.isEmpty(''), TextUtils.isEmpty('x')], digits: [TextUtils.isDigitsOnly('123'), TextUtils.isDigitsOnly('12a')], build: [Packages.android.os.Build.MODEL, Packages.android.os.Build.MANUFACTURER], jsoup: org.jsoup.Jsoup.parse('<ul><li>A</li><li>B</li></ul>').select('li').text(), available: input.available() });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    alias: 'ok',
    text: '压缩正文',
    empty: [true, true, false],
    digits: [true, false],
    build: ['legado-node', 'legado-node'],
    jsoup: 'A B',
    available: 0,
  })
})

test('Java ZipInputStream 可按条目顺序读取 stored/deflate 内容并暴露 ZipEntry 元数据', async () => {
  const zip = createZip([
    { name: 'folder/', data: new Uint8Array(), method: 0, comment: '目录' },
    { name: 'plain.txt', data: Buffer.from('普通条目', 'utf8'), method: 0 },
    { name: 'compressed.txt', data: Buffer.from('压缩条目', 'utf8'), method: 8 },
  ])
  const encoded = Buffer.from(zip).toString('base64')
  const result = await evaluate(new SourceRuleHost(), `@js:
    var input = new Packages.java.util.zip.ZipInputStream(new Packages.java.io.ByteArrayInputStream(Packages.java.util.Base64.getDecoder().decode('${encoded}')));
    var buffer = new Packages.java.lang.String('        ').getBytes();
    var entries = [];
    var entry;
    while ((entry = input.getNextEntry()) !== null) {
      var output = new Packages.java.io.ByteArrayOutputStream();
      var count = input.read(buffer);
      while (count > 0) { output.write(buffer, 0, count); count = input.read(buffer); }
      entries.push([entry.getName(), entry.getMethod(), entry.getSize(), entry.getCompressedSize(), entry.getCrc(), entry.getComment(), entry.isDirectory(), output.toString('UTF-8')]);
      input.closeEntry();
    }
    input.close();
    JSON.stringify(entries);`, '')
  assert.equal(result.status, 'success', result.message)
  const entries = JSON.parse(String(result.value)) as unknown[]
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map((entry) => (entry as unknown[]).slice(0, 2)), [['folder/', 0], ['plain.txt', 0], ['compressed.txt', 8]])
  assert.deepEqual(entries.map((entry) => (entry as unknown[])[7]), ['', '普通条目', '压缩条目'])
  assert.deepEqual((entries as unknown[][]).map((entry) => entry[5]), ['目录', null, null])
  assert.deepEqual((entries as unknown[][]).map((entry) => entry[6]), [true, false, false])
  assert.equal((entries[0] as unknown[])[2], 0)
  assert.ok((entries[1] as unknown[])[2] as number > 0)
  assert.ok((entries[2] as unknown[])[3] as number > 0)
})

test('Packages StrResponse 构造对象同时支持 Android 方法和属性序列化', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:
    var response = Packages.io.legado.app.help.http.StrResponse('https://fixture.invalid/book', 'body');
    JSON.stringify({ methods: [response.url(), response.body(), response.code(), response.headers().names(), response.raw().request().url(), response.callTime(), response.errorBody(), response.toString()], properties: [response.url, response.body, response.code, response.status] });`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    methods: ['https://fixture.invalid/book', 'body', 200, [], 'https://fixture.invalid/book', 0, null, '200 OK'],
    properties: ['https://fixture.invalid/book', 'body', 200, 200],
  })

  const returned = await evaluate(host, `@js:Packages.io.legado.app.help.http.StrResponse('https://fixture.invalid/returned', 'returned')`, '')
  assert.equal(returned.status, 'success', returned.message)
  assert.deepEqual(returned.value, { url: 'https://fixture.invalid/returned', body: 'returned', status: 200, code: 200, headers: {} })
})

test('纯 Java 类族保持 UTF-16、精确数值、增量摘要和字节流语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang, Packages.java.math, Packages.java.security, Packages.javax.crypto, Packages.javax.crypto.spec, Packages.javax.xml.bind, Packages.java.io);
    with (importer) {
      var chars = new String('😀').toCharArray();
      var decoded = new String([0xE6, 0xB5, 0x8B], 'UTF-8').toString();
      var integer = new BigInteger('9007199254740993').add(new BigInteger('7')).toString();
      var decimal = new BigDecimal('1.20').add(new BigDecimal('2.3')).toPlainString();
      var digest = MessageDigest.getInstance('SHA-256'); digest.update(new String('a').getBytes()); digest.update(new String('b').getBytes());
      var mac = Mac.getInstance('HmacSHA256'); mac.init(new SecretKeySpec(new String('key').getBytes(), 'HmacSHA256')); mac.update(new String('a').getBytes()); mac.update(new String('b').getBytes());
      var output = new ByteArrayOutputStream(); output.write([65, 66]); output.write([67], 0, 1);
      var reader = new BufferedReader(new InputStreamReader(new ByteArrayInputStream(new String('一\\n二').getBytes()), 'UTF-8'));
      JSON.stringify({ chars: chars.join(','), decoded: decoded, integer: integer, decimal: decimal, digest: DatatypeConverter.printHexBinary(digest.digest()), mac: DatatypeConverter.printHexBinary(mac.doFinal()), bytes: Array.from(output.toByteArray()), lines: [reader.readLine(), reader.readLine(), reader.readLine()] });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    chars: '\ud83d,\ude00',
    decoded: '测',
    integer: '9007199254741000',
    decimal: '3.50',
    digest: 'FB8E20FC2E4C3F248C60C39BD652F3C1347298BB977B8B4D5903B85055620603',
    mac: '5C1C0C948CBEF5AD7D191E46E5901FA0395F85F694FA4633F665A1A637017B65',
    bytes: [65, 66, 67],
    lines: ['一', '二', null],
  })
})

test('Java 字符串和整数重载保持 null、字符数组与 radix 解析语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String, Packages.java.lang.Integer, Packages.java.lang.Long, Packages.java.math.BigInteger);
    with (importer) {
      var integer = Integer.parseInt('ff', 16);
      var long = Long.parseLong('-8000000000000000', 16);
      var big = new BigInteger('ff', 16).toString();
      var invalid = [];
      try { Integer.parseInt('12x', 10); } catch (error) { invalid.push('integer'); }
      try { Long.parseLong('fg', 16); } catch (error) { invalid.push('long'); }
      try { Long.parseLong('9223372036854775808', 10); } catch (error) { invalid.push('range'); }
      try { String.copyValueOf(['a'], 2, 1); } catch (error) { invalid.push('chars'); }
      JSON.stringify({ strings: [String.valueOf(null), String.valueOf(['a', 'b']), String.copyValueOf(['a', 'b', 'c'], 1, 2)], numbers: [integer, long.toString(), big], invalid: invalid });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    strings: ['null', 'ab', 'bc'],
    numbers: [255, '-9223372036854775808', '255'],
    invalid: ['integer', 'long', 'range', 'chars'],
  })
})

test('Java String Unicode、字符数组和空白方法保持 UTF-16 语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String, Packages.java.util.ArrayList);
    with (importer) {
      var text = new String('A😀\\u2003B');
      var chars = ['?', '?', '?', '?', '?'];
      text.getChars(1, 3, chars, 1);
      var blank = new String('\\u2003\\u3000');
      var list = new ArrayList(['a', null, 'c']);
      JSON.stringify({
        codePoints: [text.codePointAt(1), text.codePointBefore(3), text.codePointBefore(2), text.codePointCount(0, text.length()), text.offsetByCodePoints(1, 1), text.offsetByCodePoints(3, -1)],
        chars: chars,
        search: [text.lastIndexOf('B'), text.lastIndexOf(0x1f600)],
        blank: [blank.isBlank(), new String('\\u2003 x\\u3000').strip().toString(), new String('\\u2003x').stripLeading().toString(), new String('x\\u3000').stripTrailing().toString()],
        repeat: new String('ab').repeat(2).toString(),
        equals: [text.contentEquals('A😀\\u2003B'), text.contentEquals(null)],
        join: [String.join('-', ['a', 'b']), String.join('/', list), String.join('-', 'ab')]
      });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    codePoints: [0x1f600, 0x1f600, 0xd83d, 4, 3, 1],
    chars: ['?', '\ud83d', '\ude00', '?', '?'],
    search: [4, 1],
    blank: [true, 'x', 'x', 'x'],
    repeat: 'abab',
    equals: [true, false],
    join: ['a-b', 'a/null/c', 'ab'],
  })

  const invalid = await evaluate(new SourceRuleHost(), `@js:
    var text = new Packages.java.lang.String('😀');
    var errors = [];
    try { text.codePointAt(2); } catch (error) { errors.push('at'); }
    try { text.offsetByCodePoints(0, -1); } catch (error) { errors.push('offset'); }
    try { text.repeat(-1); } catch (error) { errors.push('repeat'); }
    JSON.stringify(errors);`, '')
  assert.equal(invalid.status, 'success', invalid.message)
  assert.deepEqual(JSON.parse(String(invalid.value)), ['at', 'offset', 'repeat'])
})

test('Java String.format 和 Locale 覆盖书源常见的数值、字符串与定位格式', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String, Packages.java.util.Locale, Packages.java.math.BigInteger);
    with (importer) {
      var common = String.format('%05d/%-6s/%#08x/%.2f/%B/%c/%%', 12, '书', 31, 1.25, true, 65);
      var positional = String.format(Locale.ROOT, '%2\\$s=%1\\$d/%<05d', 7, 'ok');
      var locale = String.format(new Locale('de', 'DE'), '%,.2f', 1234.5);
      var big = String.format('%032x', new BigInteger('1'));
      var instance = new String('%.1f').formatted(1.25);
      var hash = String.format('%h/%H', 'abc', 'abc');
      JSON.stringify({ common: common, positional: positional, locale: locale, big: big, instance: instance, hash: hash, localeName: Locale.forLanguageTag('zh-CN').toString() });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    common: '00012/书     /0x00001f/1.25/TRUE/A/%',
    positional: 'ok=7/00007',
    locale: '1.234,50',
    big: '00000000000000000000000000000001',
    instance: '1.3',
    hash: '17862/17862',
    localeName: 'zh_CN',
  })

  const date = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String, Packages.java.util.Locale);
    with (importer) {
      var value = new Date(0);
      JSON.stringify({
        date: String.format(Locale.ROOT, '%1$tF %1$tT %1$tR', value),
        fields: String.format('%tY/%<tm/%<td/%<tH/%<tM/%<tS/%<tL/%<tN/%<tj/%<tQ/%<ts', value),
        names: String.format(Locale.US, '%tA %<tB %<tp', value),
        upper: String.format('%TB/%<TA/%<Tp', value),
        weeks: String.format('%tV/%<tG/%<tg/%<tU/%<tW', value),
        numeric: String.format('%tF/%<tQ', 0)
      });
    }`, '')
  assert.equal(date.status, 'success', date.message)
  const local = new Date(0)
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  const dayOfYear = Math.floor((Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) - Date.UTC(local.getFullYear(), 0, 1)) / 86_400_000) + 1
  const weekOfYear = (firstDay: number) => Math.floor((dayOfYear + 6 - ((new Date(local.getFullYear(), 0, 1).getDay() - firstDay + 7) % 7)) / 7)
  const isoDate = new Date(local.getFullYear(), local.getMonth(), local.getDate() + (4 - (local.getDay() === 0 ? 7 : local.getDay())))
  const isoYear = isoDate.getFullYear()
  const isoStart = new Date(isoYear, 0, 4)
  isoStart.setDate(isoStart.getDate() - (isoStart.getDay() === 0 ? 6 : isoStart.getDay() - 1))
  const isoWeek = Math.floor((Date.UTC(isoDate.getFullYear(), isoDate.getMonth(), isoDate.getDate()) - Date.UTC(isoStart.getFullYear(), isoStart.getMonth(), isoStart.getDate())) / 604_800_000) + 1
  assert.deepEqual(JSON.parse(String(date.value)), {
    date: `${local.getFullYear()}-${pad(local.getMonth() + 1, 2)}-${pad(local.getDate(), 2)} ${pad(local.getHours(), 2)}:${pad(local.getMinutes(), 2)}:${pad(local.getSeconds(), 2)} ${pad(local.getHours(), 2)}:${pad(local.getMinutes(), 2)}`,
    fields: `${local.getFullYear()}/${pad(local.getMonth() + 1, 2)}/${pad(local.getDate(), 2)}/${pad(local.getHours(), 2)}/${pad(local.getMinutes(), 2)}/${pad(local.getSeconds(), 2)}/${pad(local.getMilliseconds(), 3)}/${pad(local.getMilliseconds(), 3)}000000/${pad(dayOfYear, 3)}/0/0`,
    names: `${new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(local)} ${new Intl.DateTimeFormat('en-US', { month: 'long' }).format(local)} ${local.getHours() < 12 ? 'am' : 'pm'}`,
    upper: `${new Intl.DateTimeFormat('en-US', { month: 'long' }).format(local).toUpperCase()}/${new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(local).toUpperCase()}/${local.getHours() < 12 ? 'AM' : 'PM'}`,
    weeks: `${pad(isoWeek, 2)}/${isoYear}/${pad(isoYear % 100, 2)}/${pad(weekOfYear(0), 2)}/${pad(weekOfYear(1), 2)}`,
    numeric: `${local.getFullYear()}-${pad(local.getMonth() + 1, 2)}-${pad(local.getDate(), 2)}/0`,
  })

  const unsupported = await evaluate(new SourceRuleHost(), `@js:var importer = new JavaImporter(Packages.java.lang.String); with (importer) String.format('%tX', new Date())`, '')
  assert.equal(unsupported.status, 'failed')
  assert.match(unsupported.message ?? '', /Unsupported String\.format date conversion/u)
})

test('Java String lines/chars/codePoints 和纯文本变换提供受控 Stream 语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String);
    with (importer) {
      var text = new String(' A\\r\\n😀\\n');
      var lines = text.lines();
      var mapped = text.lines().map(function(value) { return value.toUpperCase().toString(); }).filter(function(value) { return value.length > 1; });
      var observed = []; text.lines().forEach(function(value) { observed.push(value.toString()); });
      var iterator = text.lines().iterator(); var first = iterator.next().toString();
      var reduced = text.lines().map(function(value) { return value.toString(); }).reduce('', function(left, right) { return left + right; });
      var sorted = text.lines().flatMap(function(value) { return [value, value]; }).distinct().sorted(function(left, right) { return right.toString().localeCompare(left.toString()); }).skip(0).limit(2);
      var escaped = new String('a\\\\n\\\\141\\\\s\\\\\\\\').translateEscapes().toString();
      JSON.stringify({ lines: [lines.toArray(), lines.count(), lines.findFirst().get()], chars: text.chars().toArray().slice(0, 4), points: text.codePoints().toArray(), mapped: [mapped.toArray(), mapped.count()], observed: observed, first: first, reduced: reduced, sorted: sorted.toArray().map(function(value) { return value.toString(); }), optionalEmpty: [new String('').lines().findFirst().isPresent(), new String('').lines().findFirst().orElse('none')], internedText: new String('same').intern().toString(), listSize: text.lines().toList().size(), indent: new String('a\\n b').indent(2).toString(), stripIndent: new String('\\n    a  \\n      b  \\n').stripIndent().toString(), escaped: escaped, transformed: new String('ok').transform(function(value) { return value.toUpperCase(); }).toString() });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    lines: [[' A', '😀'], 2, ' A'],
    chars: [32, 65, 13, 10],
    points: [32, 65, 13, 10, 0x1f600, 10],
    mapped: [[' A', '😀'], 2],
    observed: [' A', '😀'],
    first: ' A',
    reduced: ' A😀',
    sorted: ['😀', ' A'],
    optionalEmpty: [false, 'none'],
    internedText: 'same',
    listSize: 2,
    indent: '  a\n   b\n',
    stripIndent: '\na  \n  b  \n',
    escaped: 'a\na \\',
    transformed: 'OK',
  })

  const invalid = await evaluate(new SourceRuleHost(), `@js:var importer = new JavaImporter(Packages.java.lang.String); with (importer) new String('\\\\q').translateEscapes()`, '')
  assert.equal(invalid.status, 'failed')
  assert.match(invalid.message ?? '', /Invalid escape sequence/u)
})

test('Java String 基础方法遵循 null、偏移、空目标和 UTF-16 边界', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String);
    with (importer) {
      var text = new String('a😀a');
      var split = new String('a,,b,');
      JSON.stringify({ length: text.length(), equals: [text.equals(null), new String('').equals(null), new String('A').equalsIgnoreCase('a')], starts: [text.startsWith('😀', 1), text.startsWith('a', -1), text.endsWith('a'), text.endsWith(null)], replace: [text.replace('a', '-').toString(), text.replace('', '|').toString()], split: [split.split(',', 0).toArray(), split.split(',', -1).toArray()].map(function(values) { return values.map(function(value) { return value.toString(); }); }), region: [text.regionMatches(1, '😀a', 0, 3), text.regionMatches(true, 1, '😀A', 0, 3)], hash: text.hashCode(), bytes: Array.from(new String('一').getBytes('UTF-8')) });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    length: 4,
    equals: [false, false, true],
    starts: [true, true, true, false],
    replace: ['-😀-', '|a|\ud83d|\ude00|a|'],
    split: [['a', '', 'b'], ['a', '', 'b', '']],
    region: [true, true],
    hash: 57849693,
    bytes: [228, 184, 128],
  })
})

test('Java String/StringBuilder/Pattern 重载保持教程中的 Java 语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String, Packages.java.lang.StringBuilder, Packages.java.lang.Integer, Packages.java.util.regex.Pattern);
    with (importer) {
      var text = new String('a/b/');
      var builder = new StringBuilder('abc');
      builder.insert(1, 'X').deleteCharAt(2).append('!').reverse();
      var matcher = Pattern.compile('([a-z]+)(\\\\d+)').matcher('x12 y34');
      var first = matcher.find() ? [matcher.group(), matcher.group(1), matcher.start(1), matcher.end(1)] : null;
      var second = matcher.find() ? matcher.group() : null;
      var scoped = Pattern.compile('(?i:abc)-(?-i:DEF)');
      JSON.stringify({ split: [text.split('/').size(), text.split('/', -1).size()], replace: [text.replaceAll('/', '-').toString(), text.replaceFirst('/', '-').toString()], compare: [text.compareTo('a/b/'), text.matches('a/b/')], integer: [Integer.toString(-42), Integer.compare(1, 3), Integer.compare(3, 1)], builder: builder.toString(), pattern: [first, second, Pattern.quote('a+b')], scoped: [scoped.matcher('AbC-DEF').find(), scoped.matcher('AbC-def').find()] });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    split: [2, 3],
    replace: ['a-b-', 'a-b/'],
    compare: [0, true],
    integer: ['-42', -1, 1],
    builder: '!cXa',
    pattern: [['x12', 'x', 0, 1], 'y34', '\\Qa+b\\E'],
    scoped: [true, false],
  })
})

test('Pattern 数值 flags 映射到 Java 语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.util.regex.Pattern);
    with (importer) {
      var unicodeClasses = Pattern.compile('\\\\w+', Pattern.UNICODE_CHARACTER_CLASS).matcher('中文').find();
      var unicodeCaseOnly = Pattern.compile('abc', Pattern.UNICODE_CASE).matcher('abc').find();
      var comments = Pattern.compile('a  # ignored\\nb', Pattern.COMMENTS).matcher('ab').find();
      var unixLines = Pattern.compile('^.$', Pattern.MULTILINE | Pattern.UNIX_LINES).matcher('a\\r').find();
      var regularLines = Pattern.compile('^.$', Pattern.MULTILINE).matcher('a\\r').find();
      JSON.stringify([unicodeClasses, unicodeCaseOnly, comments, unixLines, regularLines]);
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [true, true, true, false, true])

  const unsupported = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.util.regex.Pattern);
    with (importer) Pattern.compile('abc', Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);`, '')
  assert.equal(unsupported.status, 'failed')
  assert.match(unsupported.message ?? '', /unsupported|Unicode/u)
})

test('StringBuilder 支持字符数组、code point、范围和容量重载', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.StringBuilder);
    with (importer) {
      var builder = new StringBuilder(2);
      builder.append([65, 66, 67], 1, 2).appendCodePoint(0x1f600);
      var chars = ['', '', '']; builder.getChars(1, 3, chars, 0);
      var original = builder.toString();
      var ranges = [builder.codePointAt(2), builder.codePointBefore(4), builder.codePointCount(0, 4), builder.offsetByCodePoints(0, 2), builder.substring(1, 3), builder.subSequence(0, 2)];
      builder.insert(1, 'X'); var setResult = builder.setCharAt(0, 'Z'); builder.replace(1, 2, 'Y');
      var capacity = [builder.capacity(), builder.ensureCapacity(10), builder.capacity()]; builder.trimToSize();
      var zeroBuilder = new StringBuilder(); zeroBuilder.setLength(2);
      JSON.stringify({ original: original, chars: chars, ranges: ranges, updated: builder.toString(), setResult: setResult === undefined, capacity: capacity.concat(builder.capacity()), zeroes: zeroBuilder.toString() });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    original: 'BC😀',
    chars: ['C', '\ud83d', ''],
    ranges: [0x1f600, 0x1f600, 3, 2, 'C\ud83d', 'BC'],
    updated: 'ZYC😀',
    setResult: true,
    capacity: [6, null, 14, 5],
    zeroes: '\u0000\u0000',
  })
})

test('Java 字节流与 Reader 补齐构造器、单字节写入、范围读取和换行语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.io, Packages.java.lang.String);
    with (importer) {
      var input = new ByteArrayInputStream([10, 20, 30, 40], 1, 2);
      var first = input.read();
      var target = [0, 0, 0];
      var count = input.read(target);
      var emptyRead = input.readNBytes(target, 0, 0);
      var skipped = input.skip(10);
      var clamped = new ByteArrayInputStream([1, 2, 3], 1, 8).readAllBytes();
      var transferred = new ByteArrayOutputStream(0);
      var transferInput = new ByteArrayInputStream([50, 51]);
      var transferCount = transferInput.transferTo(transferred);
      var output = new ByteArrayOutputStream();
      output.write(321); output.write([66, 67]); output.writeBytes([68]);
      var copied = new ByteArrayOutputStream(); output.writeTo(copied);
      var reader = new BufferedReader(new InputStreamReader(new ByteArrayInputStream(new String('一\\r二\\r\\n三\\n四').getBytes()), 'UTF-8'));
      var lines = [reader.readLine(), reader.readLine(), reader.readLine(), reader.readLine(), reader.readLine()];
      var readChars = [0, 0]; var reader2 = new InputStreamReader(new ByteArrayInputStream(new String('ab').getBytes()));
      var readCount = reader2.read(readChars, 0, 2); var readerSkip = reader2.skip(1);
      JSON.stringify({ first: first, target: target, count: count, emptyRead: emptyRead, skipped: skipped, available: input.available(), clamped: Array.from(clamped), transfer: [transferCount, Array.from(transferred.toByteArray())], output: [Array.from(output.toByteArray()), Array.from(copied.toByteArray()), output.toString('UTF-8'), output.size()], lines: lines, chars: [readCount, readChars, readerSkip, reader2.ready()] });
    }`, '')
  assert.equal(result.status, 'success', String(result.message ?? result.value))
  assert.deepEqual(JSON.parse(String(result.value)), {
    first: 20,
    target: [30, 0, 0],
    count: 1,
    emptyRead: 0,
    skipped: 0,
    available: 0,
    clamped: [2, 3],
    transfer: [2, [50, 51]],
    output: [[65, 66, 67, 68], [65, 66, 67, 68], 'ABCD', 4],
    lines: ['一', '二', '三', '四', null],
    chars: [2, [97, 98], 0, false],
  })
})

test('Pattern/Matcher 支持命名组、Java 替换占位符和 quoteReplacement', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.util.regex.Pattern, Packages.java.util.regex.Matcher);
    with (importer) {
      var pattern = Pattern.compile('(?<word>[a-z]+)');
      var matcher = pattern.matcher('aa bb');
      var first = matcher.find() ? [matcher.group('word'), matcher.start('word'), matcher.end('word'), matcher.groupCount()] : null;
      var second = matcher.find() ? matcher.group(0) : null;
      var replaced = pattern.matcher('aa bb').replaceAll('$0-\${word}-$1');
      var firstReplaced = pattern.matcher('aa bb').replaceFirst('$0-\${word}-$1');
      var quoted = Matcher.quoteReplacement('$1\\\\x');
      var quotedPattern = Pattern.quote('a\\\\E+b');
      var quotedMatch = Pattern.compile(quotedPattern).matcher('a\\\\E+b').matches();
      var positionsMatcher = Pattern.compile('(?:)').matcher('ab');
      var positions = [];
      while (positionsMatcher.find()) positions.push(positionsMatcher.start());
      var emptyReplace = Pattern.compile('$').matcher('ab').replaceAll('X');
      var regionMatcher = Pattern.compile('a').matcher('xaay').region(1, 3);
      var region = regionMatcher.find() ? [regionMatcher.group(), regionMatcher.start(), regionMatcher.end(), regionMatcher.regionStart(), regionMatcher.regionEnd(), regionMatcher.replaceAll('z')] : null;
      var ten = Pattern.compile('(a)(b)').matcher('ab').replaceAll('$10');
      JSON.stringify({ first: first, second: second, replaced: replaced, firstReplaced: firstReplaced, quoted: quoted, quotedPattern: quotedPattern, quotedMatch: quotedMatch, positions: positions, emptyReplace: emptyReplace, region: region, ten: ten });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    first: ['aa', 0, 2, 1],
    second: 'bb',
    replaced: 'aa-aa-aa bb-bb-bb',
    firstReplaced: 'aa-aa-aa bb',
    quoted: '\\$1\\\\x',
    quotedPattern: '\\Qa\\E\\\\E\\Q+b\\E',
    quotedMatch: true,
    positions: [0, 1, 2],
    emptyReplace: 'abX',
    region: ['a', 1, 2, 1, 3, 'xzzy'],
    ten: 'a0',
  })
})

test('Java Map/List/Set 支持教程常用的视图、计算和迭代器方法', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.util.HashMap, Packages.java.util.ArrayList, Packages.java.util.HashSet);
    with (importer) {
      var map = new HashMap({ a: 1, b: 2 });
      var putIfAbsent = map.putIfAbsent('a', 9);
      var computed = map.computeIfAbsent('c', function(key) { return key + '!'; });
      var merged = map.merge('a', 3, function(left, right) { return left + right; });
      var replaced = map.replace('b', 4);
      var entry = map.entrySet().get(0);
      entry.setValue(8);
      var callbackMap = new HashMap({ a: 1, b: 2 });
      var replaceAllOrder = [];
      callbackMap.replaceAll(function(key, value) { replaceAllOrder.push(key + ':' + value); return value + 1; });
      var forEachOrder = [];
      callbackMap.forEach(function(key, value) { forEachOrder.push(key + ':' + value); });
      var list = new ArrayList(['x', 'y']);
      var iterator = list.listIterator();
      var iterated = [iterator.next(), iterator.next(), iterator.previous(), iterator.nextIndex(), iterator.previousIndex()];
      iterator.set('Y');
      iterator.add('z');
      var invalid = [];
      try { list.remove(99); } catch (error) { invalid.push('remove'); }
      var endIterator = new ArrayList(['only']).iterator();
      endIterator.next();
      try { endIterator.next(); } catch (error) { invalid.push('iterator'); }
      try { endIterator.remove(); endIterator.remove(); } catch (error) { invalid.push('iterator-remove'); }
      var set = new HashSet(['x', 'y', 'z']);
      set.removeAll(new HashSet(['z']));
      var setContainsAll = set.containsAll(['x', 'y']);
      var setIterator = set.iterator();
      var setValues = [setIterator.next(), setIterator.next()];
      var setInvalid = [];
      try { setIterator.next(); } catch (error) { setInvalid.push('iterator'); }
      try { setIterator.remove(); setIterator.remove(); } catch (error) { setInvalid.push('iterator-remove'); }
      JSON.stringify({ map: [putIfAbsent, computed, merged, replaced, map.get('a'), map.get('b'), map.get('c'), entry.getValue(), map.get('missing'), map.remove('missing'), map.replace('missing', 1)], callbacks: [replaceAllOrder, forEachOrder, callbackMap.get('a'), callbackMap.get('b')], list: [iterated, list.toArray(), invalid], set: [set.contains('z'), setContainsAll, set.toArray(), setValues, setInvalid] });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    map: [1, 'c!', 4, 2, 8, 4, 'c!', 8, null, null, null],
    callbacks: [['a:1', 'b:2'], ['a:2', 'b:3'], 2, 3],
    list: [['x', 'y', 'y', 1, 0], ['x', 'z', 'Y'], ['remove', 'iterator', 'iterator-remove']],
    set: [false, true, ['x'], ['x', 'y'], ['iterator', 'iterator-remove']],
  })
})

test('Java Map 视图和 List.subList 保持父容器的实时读写传播', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.util.HashMap, Packages.java.util.ArrayList);
    with (importer) {
      var map = new HashMap({ a: 1, b: 2 });
      var keys = map.keySet();
      var values = map.values();
      var entries = map.entrySet();
      map.put('c', 3);
      var before = [keys.toArray(), keys.length, keys[2], values.toArray(), entries.size()];
      keys.remove('a');
      values.set(0, 20);
      var entry = entries.get(0);
      entry.setValue(21);
      var entryValue = entry.getValue();
      entries.remove(entry);
      var valueMap = new HashMap({ a: 2, b: 3 });
      var removedValue = valueMap.values().remove(3);
      var list = new ArrayList(['x', 'y', 'z']);
      var sub = list.subList(1, 3);
      sub.set(0, 'B');
      sub.remove(1);
      sub.add('D');
      var copy = new HashMap(map);
      copy.putAll(new HashMap({ d: 4 }));
      JSON.stringify({ before: before, map: [map.size(), keys.toArray(), values.toArray(), entries.size()], entry: entryValue, valueMap: [removedValue, valueMap.size(), valueMap.get('b')], copy: [copy.size(), copy.get('c'), copy.get('d')], list: [list.toArray(), sub.toArray()] });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    before: [['a', 'b', 'c'], 3, 'c', [1, 2, 3], 3],
    map: [1, ['c'], [3], 1],
    entry: 21,
    valueMap: [true, 1, null],
    copy: [2, 3, 4],
    list: [['x', 'B', 'D'], ['B', 'D']],
  })
})

test('Java Arrays 和 Collections 常用重载保持固定大小与只读语义', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.util.Arrays, Packages.java.util.Collections, Packages.java.util.ArrayList, Packages.java.util.HashMap, Packages.java.util.HashSet);
    with (importer) {
      var array = [1, 3, 5, 7];
      var fixed = Arrays.asList(array);
      fixed.set(1, 4);
      var fixedErrors = [];
      try { fixed.add(8); } catch (error) { fixedErrors.push('add'); }
      try { fixed.remove(0); } catch (error) { fixedErrors.push('remove'); }
      var binary = Arrays.binarySearch(array, 0, array.length, 5);
      Arrays.fill(array, 1, 3, 9);
      var bytes = new Uint8Array([3, 1]);
      var byteList = Arrays.asList(bytes);
      byteList.set(1, 4);
      Arrays.sort(bytes);
      Arrays.fill(bytes, 0, 1, 9);
      var copies = [Arrays.copyOf([1, 2], 4), Arrays.copyOfRange([1, 2], 1, 4)];
      var list = new ArrayList([3, 1, 2]);
      Collections.sort(list);
      var sortedBinary = Collections.binarySearch(list, 2);
      Collections.swap(list, 0, 2);
      var extremes = [Collections.min(list), Collections.max(list)];
      var replaced = Collections.replaceAll(list, 2, 8);
      Collections.addAll(list, 5, 4);
      var destination = new ArrayList([0, 0, 0, 0, 0]);
      Collections.copy(destination, list);
      var readOnly = Collections.unmodifiableList(list);
      var readOnlyErrors = [];
      try { readOnly.set(0, 10); } catch (error) { readOnlyErrors.push('set'); }
      try { readOnly.clear(); } catch (error) { readOnlyErrors.push('clear'); }
      var singleton = Collections.singletonList('only');
      try { singleton.add('other'); } catch (error) { readOnlyErrors.push('singleton'); }
      var syncList = Collections.synchronizedList(list);
      syncList.add(6);
      var map = new HashMap({ a: 1 });
      var readOnlyMap = Collections.unmodifiableMap(map);
      var mapErrors = [];
      try { readOnlyMap.put('b', 2); } catch (error) { mapErrors.push('put'); }
      try { readOnlyMap.entrySet().iterator().next().setValue(2); } catch (error) { mapErrors.push('entry'); }
      var set = new HashSet(['a', 'b']);
      var readOnlySet = Collections.unmodifiableSet(set);
      try { readOnlySet.remove('a'); } catch (error) { mapErrors.push('set'); }
      var backing = new HashMap();
      var mapSet = Collections.newSetFromMap(backing);
      mapSet.add('x');
      mapSet.add('y');
      mapSet.remove('x');
      var arraySum = 0;
      Arrays.forEach([1, 2, 3], function(value) { arraySum += value; });
      JSON.stringify({ array: array, fixed: fixed.toArray(), fixedErrors: fixedErrors, binary: binary, bytes: [Array.from(bytes), byteList.toArray()], copies: copies, list: list.toArray(), sortedBinary: sortedBinary, extremes: extremes, replaced: replaced, destination: destination.toArray(), frequency: Collections.frequency(list, 8), readOnly: readOnly.toArray(), readOnlyErrors: readOnlyErrors, copiesOf: Collections.nCopies(2, 'x').toArray(), text: Arrays.toString(array), deep: Arrays.deepToString([[1], [2, 3]]), map: [readOnlyMap.get('a'), readOnlyMap.size(), readOnlyMap.entrySet().iterator().next().getValue()], mapErrors: mapErrors, set: [readOnlySet.toArray(), mapSet.toArray(), backing.keySet().toArray()], singletonMap: [Collections.singletonMap('k', 'v').get('k'), Collections.emptyMap().isEmpty()], arraySum: arraySum });
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    array: [1, 9, 9, 7],
    fixed: [1, 9, 9, 7],
    fixedErrors: ['add', 'remove'],
    binary: 2,
    bytes: [[9, 4], [9, 4]],
    copies: [[1, 2, null, null], [2, null, null]],
    list: [3, 8, 1, 5, 4, 6],
    sortedBinary: 1,
    extremes: [1, 3],
    replaced: true,
    destination: [3, 8, 1, 5, 4],
    frequency: 1,
    readOnly: [3, 8, 1, 5, 4, 6],
    readOnlyErrors: ['set', 'clear', 'singleton'],
    copiesOf: ['x', 'x'],
    text: '[1, 9, 9, 7]',
    deep: '[[1], [2, 3]]',
    map: [1, 1, 1],
    mapErrors: ['put', 'entry', 'set'],
    set: [['a', 'b'], ['y'], ['y']],
    singletonMap: ['v', true],
    arraySum: 6,
  })
})

test('Element/Elements 返回对象支持关系、视图方法和受控修改', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var element = java.getElements('div.card').first();
    var children = element.children();
    var sibling = element.nextElementSibling();
    var clone = element.clone();
    element.attr('data-state', 'ready');
    JSON.stringify({ tag: element.tagName(), id: element.idName(), className: element.className(), has: element.hasAttr('data-state'), parent: element.parent().tagName(), child: children.first().text(), childCount: children.size(), sibling: sibling.text(), clone: clone.text(), matched: element.is('div.card') });`,
    '<section><div class="card" id="one"><span>第一项</span></div><div class="card" id="two">第二项</div></section>')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    tag: 'div',
    id: 'one',
    className: 'card',
    has: true,
    parent: 'section',
    child: '第一项',
    childCount: 1,
    sibling: '第二项',
    clone: '第一项',
    matched: true,
  })
})

test('Element remove 和 Elements 属性视图会传播到后续规则', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var elements = java.getElements('li.item');
    elements.attr('data-kind', 'chapter');
    elements.get(0).remove();
    JSON.stringify([elements.size(), elements.get(1).attr('data-kind'), elements.get(0).parent().children().size()]);`,
    '<ul><li class="item">一</li><li class="item">二</li></ul>')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [2, 'chapter', 1])
})

test('JavaImporter 可加载教程中的 URL、Base64、DatatypeConverter 和 HMAC 类', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang.String, Packages.javax.crypto.Mac, Packages.javax.crypto.spec.SecretKeySpec, Packages.java.net.URLEncoder, Packages.javax.xml.bind.DatatypeConverter, Packages.android.util.Base64);
    with (importer) {
      var mac = Mac.getInstance('HmacSHA256');
      mac.init(new SecretKeySpec(String('key').getBytes('UTF-8'), 'HmacSHA256'));
      var signature = mac.doFinal(String('data').getBytes('UTF-8'));
      var encoded = Base64.encodeToString(signature, Base64.NO_WRAP);
      var javaEncoded = Packages.java.util.Base64.getEncoder().encode(signature);
      var androidEncoded = Base64.encode(signature, Base64.NO_WRAP);
      JSON.stringify([URLEncoder.encode('a b', 'UTF-8'), DatatypeConverter.printHexBinary(signature), Array.from(Base64.decode(encoded, Base64.DEFAULT)), Array.from(javaEncoded), Array.from(androidEncoded)]);
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [
    'a+b',
    '5031FE3D989C6D1537A013FA6E739DA23463FDAEC3B70137D828E36ACE221BD0',
    [80, 49, 254, 61, 152, 156, 109, 21, 55, 160, 19, 250, 110, 115, 157, 162, 52, 99, 253, 174, 195, 183, 1, 55, 216, 40, 227, 106, 206, 34, 27, 208],
    [85, 68, 72, 43, 80, 90, 105, 99, 98, 82, 85, 51, 111, 66, 80, 54, 98, 110, 79, 100, 111, 106, 82, 106, 47, 97, 55, 68, 116, 119, 69, 51, 50, 67, 106, 106, 97, 115, 52, 105, 71, 57, 65, 61],
    [85, 68, 72, 43, 80, 90, 105, 99, 98, 82, 85, 51, 111, 66, 80, 54, 98, 110, 79, 100, 111, 106, 82, 106, 47, 97, 55, 68, 116, 119, 69, 51, 50, 67, 106, 106, 97, 115, 52, 105, 71, 57, 65, 61],
  ])
})

test('source Map 兼容方法、URL 查询参数重复值和 jsLib 全局状态可恢复', async () => {
  const host = new SourceRuleHost()
  const stateSource = { ...source, jsLib: 'var tutorialCounter = (typeof tutorialCounter === "undefined" ? 0 : tutorialCounter) + 1;' } as NormalizedSource
  const first = await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:source.putLoginInfo(JSON.stringify({ user: "alice" })); var m = source.getLoginInfoMap(); JSON.stringify([m.get("user"), m.containsKey("user"), m.size(), java.toURL("https://a.test/p?q=1&q=2").searchParams.getAll("q")])', content: '' })
  assert.equal(first.status, 'success')
  assert.deepEqual(JSON.parse(String(first.value)), ['alice', true, 1, ['1', '2']])
  const second = await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:tutorialCounter', content: '' })
  assert.equal(second.value, 2)
  const refreshed = await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:source.refreshJSLib(); "ok"', content: '' })
  assert.equal(refreshed.value, 'ok')
  const afterRefresh = await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:tutorialCounter', content: '' })
  assert.equal(afterRefresh.value, 1)
})

test('jsLib 可序列化状态按规则宿主会话隔离，不因共享缓存而串源', async () => {
  const cache = new MemorySourceScriptCache()
  const stateSource = { ...source, jsLib: 'var isolatedCounter = (typeof isolatedCounter === "undefined" ? 0 : isolatedCounter) + 1;' } as NormalizedSource
  const first = new SourceRuleHost({ cache })
  const second = new SourceRuleHost({ cache })
  assert.equal((await first.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:isolatedCounter', content: '' })).value, 1)
  assert.equal((await second.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:isolatedCounter', content: '' })).value, 1)
})

test('jsLib 共享状态在并发规则执行中按源会话串行提交', async () => {
  const host = new SourceRuleHost()
  const stateSource = { ...source, jsLib: 'var concurrentCounter = (typeof concurrentCounter === "undefined" ? 0 : concurrentCounter) + 1;' } as NormalizedSource
  const outputs = await Promise.all(Array.from({ length: 8 }, () => host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:concurrentCounter', content: '' })))
  assert.deepEqual(outputs.map((item) => item.value).sort((left, right) => Number(left) - Number(right)), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal((await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:concurrentCounter', content: '' })).value, 9)
})

test('jsLib 刷新后嵌套 evalJS 不会被外层旧快照覆盖', async () => {
  const host = new SourceRuleHost()
  const stateSource = { ...source, jsLib: 'var refreshCounter = (typeof refreshCounter === "undefined" ? 0 : refreshCounter) + 1;' } as NormalizedSource
  const refreshed = await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:source.refreshJSLib(); source.evalJS("refreshCounter = 99"); "ok"', content: '' })
  assert.equal(refreshed.value, 'ok')
  assert.equal((await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:refreshCounter', content: '' })).value, 100)
})

test('jsLib 等待队列取消后会释放后续执行', async () => {
  const host = new SourceRuleHost()
  const stateSource = { ...source, jsLib: 'var cancelledCounter = (typeof cancelledCounter === "undefined" ? 0 : cancelledCounter) + 1;' } as NormalizedSource
  const first = host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:Packages.java.lang.Thread.sleep(40); cancelledCounter', content: '' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const controller = new AbortController()
  const second = host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:cancelledCounter', content: '', signal: controller.signal })
  controller.abort()
  assert.equal((await second).status, 'cancelled')
  assert.equal((await first).status, 'success')
  assert.equal((await host.evaluate({ source: stateSource, stage: 'search', field: 'fixture', rule: '@js:cancelledCounter', content: '' })).value, 2)
})

test('java.toURL 保留 IPv6 authority 和已编码查询参数名', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:JSON.stringify((() => { const url = java.toURL("https://[2001:db8::1]:8080/p?a%20b=x+y#frag"); const noQuery = java.toURL("https://user:pass@example.test/p"); return [url.host, url.hostname, url.port, url.origin, url.search, url.searchParams.get("a%20b"), url.searchParams.toString(), noQuery.searchParams === null, noQuery.getProtocol(), noQuery.getHost(), noQuery.getPort(), noQuery.getDefaultPort(), noQuery.getPath(), noQuery.getFile(), noQuery.getQuery(), noQuery.getRef(), noQuery.getAuthority(), noQuery.getUserInfo()]; })())', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['[2001:db8::1]:8080', '[2001:db8::1]', '8080', 'https://[2001:db8::1]:8080', '?a%20b=x+y', 'x y', 'a%20b=x+y', true, 'https', 'example.test', -1, 443, '/p', '/p', null, null, 'example.test', 'user:pass'])
})

test('java.toURL 对无基址非法地址抛出可识别异常并提供 FTP 默认端口', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:JSON.stringify((() => { let message = ""; try { java.toURL("not a URL"); } catch (error) { message = String(error?.message ?? error); } const ftp = java.toURL("ftp://example.test/file"); return [message, ftp.getDefaultPort(), ftp.getPort()]; })())', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['Malformed URL', 21, -1])
})

test('java.toURL 的查询参数视图支持重复值和 Android 风格变更', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:JSON.stringify((() => { const url = java.toURL("https://example.test/p?old=1&q=a&q=b"); const params = url.searchParams; const before = [params.get("q"), params.getAll("q"), params.has("old")]; params.set("q", "c d"); params.append("q", "e"); params.delete("old"); return [before, params.toString(), url.search, params.getAll("q")]; })())', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [['a', ['a', 'b'], true], 'q=c+d&q=e', '?q=c+d&q=e', ['c d', 'e']])
})

test('规则宿主支持 JSON、XPath 和选择器后的 JavaScript 转换', async () => {
  const host = new SourceRuleHost()
  const json = { data: [{ name: '我本无意成仙', path: '/book/1' }] }
  const books = await evaluate(host, '$.data[*]', json)
  assert.equal(books.status, 'success')
  assert.deepEqual(books.value, json.data)

  const name = await evaluate(host, '$.name', json.data[0])
  assert.equal(name.status, 'success')
  assert.deepEqual(name.value, ['我本无意成仙'])

  const transformed = await evaluate(host, '$.name@js:result[0].toUpperCase()', json.data[0])
  assert.equal(transformed.status, 'success')
  assert.equal(transformed.value, '我本无意成仙')

  const xpath = await evaluate(host, '@xpath://book/title/text()', '<book><title>第一章</title></book>')
  assert.equal(xpath.status, 'success')
  assert.deepEqual(xpath.value, ['第一章'])
})

test('XPath 列表保留节点上下文以便后续读取标题和 href', async () => {
  const host = new SourceRuleHost()
  const list = await evaluateNodes(host, '@xpath://li', '<ul><li href=/c/1><a>第一章</a></li><li href=/c/2><a>第二章</a></li></ul>')
  assert.equal(list.status, 'success')
  assert.ok(Array.isArray(list.value))
  const first = (list.value as unknown[])[0]
  assert.ok(first)
  assert.deepEqual((await evaluate(host, '@xpath:.//a/text()', first)).value, ['第一章'])
  assert.deepEqual((await evaluate(host, '@xpath:./@href', first)).value, ['/c/1'])
  assert.deepEqual((await evaluate(host, '@xpath:ancestor::ul', first)).value, ['第一章第二章'])
})

test('CSS 与 XPath 节点可以按 Android 语义交叉继续查询', async () => {
  const host = new SourceRuleHost()
  const html = '<ul><li class="chapter" href="/c/1"><a>第一章</a></li><li class="chapter" href="/c/2"><a>第二章</a></li></ul>'

  const cssNodes = await evaluateNodes(host, 'ul@.chapter', html)
  assert.equal(cssNodes.status, 'success')
  const cssFirst = (cssNodes.value as unknown[])[0]
  assert.ok(cssFirst)
  const xpathFromCss = await evaluate(host, '@xpath:.//a/text()', cssFirst)
  assert.deepEqual(xpathFromCss.value, ['第一章'])

  const xpathNodes = await evaluateNodes(host, '@xpath://li', html)
  assert.equal(xpathNodes.status, 'success')
  const xpathFirst = (xpathNodes.value as unknown[])[0]
  assert.ok(xpathFirst)
  const cssFromXpath = await evaluate(host, 'a@text', xpathFirst)
  assert.deepEqual(cssFromXpath.value, ['第一章'])
})

test('规则宿主的 JavaScript 可以使用书源 bridge 的编码能力', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, '@js:java.base64Encode(result)', '我本无意成仙')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '5oiR5pys5peg5oSP5oiQ5LuZ')
})

test('规则宿主支持 Android 的章节数字和字节编码重载', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:
    var utf8 = java.strToBytes('测试')
    var gbk = java.strToBytes('测试', 'GBK')
    JSON.stringify([
      java.toNumChapter('第十一章：开端'),
      java.toNumChapter('第１２章'),
      java.toNumChapter('没有章节号'),
      java.toNumChapter(null),
      Array.from(utf8),
      java.bytesToStr(utf8),
      java.bytesToStr(gbk, 'GBK')
    ])`, '')
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), [
    '第11章：开端',
    '第12章',
    '没有章节号',
    null,
    [230, 181, 139, 232, 175, 149],
    '测试',
    '测试',
  ])
})

test('规则宿主支持 Android 的字节数组与 HMAC 摘要重载', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:JSON.stringify([
    Array.from(java.base64DecodeToByteArray(java.base64Encode('测试'))),
    Array.from(java.hexDecodeToByteArray('e6b58b')),
    java.hexDecodeToString('e6b58b'),
    java.hexEncodeToString('测试'),
    java.digestBase64Str('data', 'SHA-256'),
    java.HMacHex('data', 'HmacSHA256', 'key'),
    java.HMacBase64('data', 'HmacSHA256', 'key')
  ])`, '')
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), [
    [230, 181, 139, 232, 175, 149],
    [230, 181, 139],
    '测',
    'e6b58be8af95',
    'Om6weQ85rIfJTzhWst0sXREOaBFgImGpqSPTuyOtyLc=',
    '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0',
    'UDH+PZicbRU3oBP6bnOdojRj/a7DtwE32Cjjas4iG9A=',
  ])
})

test('java.getString 和 java.getStringList 通过完整规则内核读取当前内容', async () => {
  const host = new SourceRuleHost()
  const json = JSON.stringify({ book: { name: '书名' }, chapters: [{ name: '第一章' }, { name: '第二章' }] })
  const string = await evaluate(host, "@js:java.getString('$.book.name')", json)
  assert.equal(string.status, 'success')
  assert.equal(string.value, '书名')

  const list = await evaluate(host, "@js:java.getStringList('$.chapters[*].name')", json)
  assert.equal(list.status, 'success')
  assert.deepEqual(list.value, ['第一章', '第二章'])

  const html = await evaluate(host, "@js:java.getString('.title@text')", '<h1 class="title">书名</h1>')
  assert.equal(html.value, '书名')
  const htmlList = await evaluate(host, "@js:java.getStringList('.chapter@text')", '<div class="chapter">第一章</div><div class="chapter">第二章</div>')
  assert.deepEqual(htmlList.value, ['第一章', '第二章'])
})

test('java.getString 区分 unescape 重载并把 null 内容回退到当前上下文', async () => {
  const host = new SourceRuleHost()
  const escaped = await evaluate(host, "@js:JSON.stringify([java.getString('.title@text', false), java.getString('.title@text', true), java.getString('.title@text', null, false)])", '<h1 class="title">甲&amp;beta;</h1>')
  assert.equal(escaped.status, 'success', escaped.message)
  assert.deepEqual(JSON.parse(String(escaped.value)), ['甲&beta;', '甲β', '甲β'])
})

test('AnalyzeRule 重载保留空规则、列表空项和 evalJS 的 result 参数', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:JSON.stringify({
    emptyString: java.getString(''),
    emptyList: java.getStringList(''),
    nullList: java.getStringList(null),
    emptyElements: java.getElements(''),
    list: java.getStringList('.item@text'),
    evaluated: java.evalJS('result.value + ":" + baseUrl', { value: '嵌套结果' })
  })`, '<div class="item"></div><div class="item">第二项</div>')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    emptyString: '',
    emptyList: null,
    nullList: null,
    emptyElements: [],
    list: ['第二项'],
    evaluated: '嵌套结果:https://fixture.invalid',
  })
})

test('java.getElements 提供 Android 书源使用的节点链式 API', async () => {
  const host = new SourceRuleHost()
  const html = '<ul><li class="item"><a href="/one">第一章</a></li><li class="item"><a href="/two">第二章</a></li></ul>'
  const result = await evaluate(host, '@js:var items = java.getElements(".item"); items[0].select("a").attr("href") + "|" + items[0].text() + "|" + items.toArray().length', html)
  assert.equal(result.status, 'success')
  assert.equal(result.value, '/one|第一章|2')

  const collection = await evaluate(host, '@js:var items = java.getElement(".item"); items.length + "|" + items.select("a").attr("href")', html)
  assert.equal(collection.status, 'success')
  assert.equal(collection.value, '2|/one')

  const replaced = await evaluate(host, "@js:java.setContent('<div class=\"other\">新内容</div>'); java.getElement('.other').text()", html)
  assert.equal(replaced.status, 'success')
  assert.equal(replaced.value, '新内容')
})

test('AnalyzeRule 继承方法保持 Android 的链式返回和 URL 返回语义', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:
    var before = redirectUrl;
    var localResult = java.setLocal('token', 'ok');
    var contentResult = java.setContent('<p>替换内容</p>', 'https://fixture.invalid/base/');
    var afterContent = redirectUrl;
    var baseResult = java.setBaseUrl('https://fixture.invalid/other/');
    var redirectResult = java.setRedirectUrl('https://cdn.fixture.invalid/final/index');
    var invalidResult = java.setRedirectUrl('not-a-url');
    var dataResult = java.setRedirectUrl('data:text/plain;base64,QQ==');
    JSON.stringify({
      localIsJava: localResult === java,
      localValue: java.getLocal('token'),
      contentIsJava: contentResult === java,
      baseIsJava: baseResult === java,
      before: before,
      afterContent: afterContent,
      baseUrl: baseUrl,
      redirectUrl: redirectUrl,
      redirect: redirectResult && redirectResult.url,
      invalidSame: invalidResult === redirectResult,
      dataSame: dataResult === redirectResult
    })`, '<p>原始内容</p>')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    localIsJava: true,
    localValue: 'ok',
    contentIsJava: true,
    baseIsJava: true,
    before: 'https://fixture.invalid',
    afterContent: 'https://fixture.invalid',
    baseUrl: 'https://fixture.invalid/other/',
    redirectUrl: 'https://cdn.fixture.invalid/final/index',
    redirect: 'https://cdn.fixture.invalid/final/index',
    invalidSame: true,
    dataSame: true,
  })
})

test('java.ajaxAll 返回可调用 body、code 和 url 的响应对象', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    if (input.kind === 'network-all') return input.urls?.map((url) => ({ body: `body:${String(url)}`, code: 204, headers: { Location: String(url) }, url: String(url) })) ?? []
    return `body:${String(input.url)}`
  } })
  const result = await evaluate(host, '@js:java.ajaxAll(["https://a.test", "https://b.test"]).map((item) => item.body() + ":" + item.code() + ":" + item.header("Location")).join("|")', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'body:https://a.test:204:https://a.test|body:https://b.test:204:https://b.test')
  assert.deepEqual(calls, [{ kind: 'network-all', urls: ['https://a.test', 'https://b.test'], skipRateLimit: false, stage: 'search' }])
})

test('java.get 和 java.connect 返回 Android 风格的响应对象', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    return { body: 'redirect-body', status: 302, headers: { Location: 'https://b.test/' }, url: 'https://b.test/' }
  } })
  const result = await evaluate(host, '@js:var response = java.get("https://a.test", {}); var connected = java.connect("https://a.test"); [response.statusCode(), response.body(), response.header("location"), response.url(), response.isSuccessful(), connected.raw().request().url()].join("|")', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '302|redirect-body|https://b.test/|https://b.test/|false|https://b.test/')
  assert.deepEqual(calls, [
    { kind: 'network-response', url: 'https://a.test', method: 'GET', headers: {}, options: { timeout: 30000, followRedirects: false }, stage: 'search' },
    { kind: 'network-response', url: 'https://a.test', method: 'GET', stage: 'search' },
  ])
})

test('java.connect 支持 JSON 请求头和超时重载', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    return { body: 'connected', status: 200, headers: {}, url: String(input.url) }
  } })
  const result = await evaluate(host, '@js:java.connect("https://a.test", JSON.stringify({"X-Test": 42}), 321).body()', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'connected')
  assert.deepEqual(calls, [{
    kind: 'network-response',
    url: 'https://a.test',
    method: 'GET',
    headers: { 'X-Test': '42' },
    options: { timeout: 321 },
    stage: 'search',
  }])
})

test('java.post、java.head 和 ajaxTestAll 保留 Android 请求形态', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    if (input.kind === 'network-all') return input.urls?.map((url) => ({ body: `body:${String(url)}`, status: 200, url: String(url), headers: {} })) ?? []
    return { body: input.method === 'HEAD' ? '' : String(input.body ?? 'post-body'), status: input.method === 'HEAD' ? 204 : 201, url: String(input.url), headers: input.headers ?? {} }
  } })
  const result = await evaluate(host, '@js:var post = java.post("https://a.test/post", "q=1", {"X-Test":"yes"}, 123); var head = java.head("https://a.test/head", {"X-Test":"yes"}); var all = java.ajaxTestAll(["https://a.test/one", "https://a.test/two"], 456, true); [post.code(), post.body(), head.code(), all.map((item) => item.url()).join(",")].join("|")', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '201|q=1|204|https://a.test/one,https://a.test/two')
  assert.deepEqual(calls, [
    { kind: 'network-response', url: 'https://a.test/post', method: 'POST', body: 'q=1', headers: { 'X-Test': 'yes' }, options: { timeout: 123, followRedirects: false }, stage: 'search' },
    { kind: 'network-response', url: 'https://a.test/head', method: 'HEAD', headers: { 'X-Test': 'yes' }, options: { timeout: 30000, followRedirects: false }, stage: 'search' },
    { kind: 'network-all', urls: ['https://a.test/one', 'https://a.test/two'], isTest: true, skipRateLimit: true, options: { timeout: 456 }, stage: 'search' },
  ])
})

test('java.ajax 的第二参数是超时并把普通网络错误转成正文', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    if (input.kind === 'network') return 'ajax-body'
    throw new Error('network unavailable')
  } })
  const result = await evaluate(host, '@js:java.ajax("https://a.test", 456)', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'ajax-body')
  assert.deepEqual(calls, [{ kind: 'network', url: 'https://a.test', method: 'GET', options: { timeout: 456 }, stage: 'search' }])

  const connect = await evaluate(host, '@js:var response = java.connect("https://a.test"); [response.code(), response.isSuccessful(), response.body()].join("|")', '')
  assert.equal(connect.status, 'success')
  assert.match(String(connect.value), /^200\|true\|.*network unavailable/us)
})

test('网络响应桥接保留字节、字符集和 Headers/Raw 方法', async () => {
  const host = new SourceRuleHost({ request: async (input) => ({
    body: '中文',
    status: 206,
    statusMessage: 'Partial Content',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Location: 'https://b.test/' },
    url: 'https://b.test/',
    bytes: new TextEncoder().encode('中文'),
    requestUrl: String(input.url),
  }) })
  const result = await evaluate(host, '@js:var response = java.get("https://a.test", {}); [response.bodyAsBytes().length, response.charset(), response.contentType(), response.headers().get("location"), response.raw().request().url(), response.statusMessage()].join("|")', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '6|utf-8|text/plain; charset=utf-8|https://b.test/|https://a.test|Partial Content')
})

test('网络响应 Headers 对齐 OkHttp 的重复值、索引、映射和敏感头脱敏', async () => {
  const host = new SourceRuleHost({ request: async (input) => ({
    body: 'headers-body',
    status: 206,
    statusMessage: 'Partial Content',
    headers: {
      'X-Test': ['first', 'second'],
      Authorization: 'secret',
      Zed: 'last',
    },
    url: String(input.url),
    requestUrl: String(input.url),
    requestHeaders: { 'X-Test': ['request-first', 'request-second'] },
  }) })
  const result = await evaluate(host, '@js:var response = java.get("https://a.test", {}); var headers = response.headers(); var raw = response.raw(); JSON.stringify({ status: response.status, get: headers.get("x-test"), header: response.header("x-test"), absent: headers.get("missing"), values: headers.values("X-TEST"), names: headers.names().toArray(), size: headers.size(), first: [headers.name(0), headers.value(0)], multimap: headers.toMultimap(), byteCount: headers.byteCount(), text: headers.toString(), rawHeaders: raw.headers().get("x-test"), requestHeaders: raw.request().headers().get("x-test") })', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    status: 206,
    get: 'second',
    header: 'first,second',
    absent: null,
    values: ['first', 'second'],
    names: ['Authorization', 'X-Test', 'Zed'],
    size: 4,
    first: ['X-Test', 'first'],
    multimap: { authorization: ['secret'], 'x-test': ['first', 'second'], zed: ['last'] },
    byteCount: 57,
    text: 'X-Test: first\nX-Test: second\nAuthorization: ██\nZed: last\n',
    rawHeaders: 'second',
    requestHeaders: 'request-second',
  })
})

test('网络响应 Headers 的日期方法按 OkHttp HTTP-date 格式解析并固定无时区格式为 UTC', async () => {
  const host = new SourceRuleHost({ request: async (input) => ({
    body: 'date-body',
    status: 200,
    headers: {
      Date: 'Sun, 06 Nov 1994 08:49:37 GMT',
      'X-Legacy': 'Sunday, 06-Nov-94 08:49:37 GMT',
      'X-Asctime': 'Sun Nov  6 08:49:37 1994',
      'X-Numeric': 'Sun, 06-11-1994 08:49:37 GMT',
      'X-Dashed': 'Sun, 06-Nov-1994 08-49-37 GMT',
      'X-Invalid': '1994-11-06',
      'X-Trailing': 'Sun, 06 Nov 1994 08:49:37 GMT trailing',
    },
    url: String(input.url),
  }) })
  const result = await evaluate(host, '@js:var headers = java.get("https://a.test", {}).headers(); JSON.stringify({ standard: headers.getDate("date"), instant: headers.getInstant("date"), legacy: headers.getDate("x-legacy"), asctime: headers.getDate("x-asctime"), numeric: headers.getDate("x-numeric"), dashed: headers.getDate("x-dashed"), invalid: headers.getDate("x-invalid"), trailing: headers.getDate("x-trailing") })', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    standard: '1994-11-06T08:49:37.000Z',
    instant: '1994-11-06T08:49:37.000Z',
    legacy: '1994-11-06T08:49:37.000Z',
    asctime: '1994-11-06T08:49:37.000Z',
    numeric: '1994-11-06T08:49:37.000Z',
    dashed: '1994-11-06T08:49:37.000Z',
    invalid: null,
    trailing: null,
  })
})

test('AnalyzeUrl getResponse/getStrResponse 提供教程常用响应成员', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => {
    calls.push(input)
    return { body: 'url-body', status: 418, message: "I'm a teapot", headers: { 'X-Test': 'yes' }, url: 'https://b.test/', bytes: new TextEncoder().encode('raw'), errorBody: 'teapot', callTime: 12, requestUrl: 'https://a.test/' }
  } })
  const result = await host.evaluate({
    source,
    stage: 'search',
    field: 'fixture',
    rule: '@js:var response = java.getResponse(); var stringResponse = java.getStrResponse(); JSON.stringify([response.body(), response.code(), response.headers().get("x-test"), Array.from(response.bodyAsBytes()), response.errorBody(), response.callTime(), response.raw().request().url(), stringResponse.body(), stringResponse.code(), stringResponse.headers().get("x-test"), stringResponse.url(), stringResponse.callTime(), stringResponse.raw().headers().get("x-test"), stringResponse.body, stringResponse.toString()])',
    content: '',
    bindings: { __legadoUrlContext: { url: 'https://a.test/', headerMap: {} } },
  })
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['url-body', 418, 'yes', [114, 97, 119], 'teapot', 12, 'https://a.test/', 'url-body', 418, 'yes', 'https://b.test/', 12, 'yes', 'url-body', '418 I\'m a teapot'])
  assert.deepEqual(calls, [
    { kind: 'url-context-response', input: { url: 'https://a.test/', headers: {}, body: undefined, method: undefined, options: undefined, baseUrl: undefined, redirectUrl: undefined, responseKind: 'response', jsStr: undefined, sourceRegex: undefined, useWebView: true }, stage: 'search' },
    { kind: 'url-context-response', input: { url: 'https://a.test/', headers: {}, body: undefined, method: undefined, options: undefined, baseUrl: undefined, redirectUrl: undefined, responseKind: 'string', jsStr: undefined, sourceRegex: undefined, useWebView: true }, stage: 'search' },
  ])
})

test('ajaxTestAll 将单项失败转换为 Android 测试响应而不取消其他 URL', async () => {
  const host = new SourceRuleHost({ request: async (input) => {
    if (input.kind === 'network-all') return (input.urls ?? []).map((url) => String(url).endsWith('/bad') ? { body: 'connection refused', status: 200, code: 200, callTime: -4, url: String(url), headers: {}, error: true } : { body: 'ok', status: 200, code: 200, url: String(url), headers: {} })
    return ''
  } })
  const result = await evaluate(host, '@js:java.ajaxTestAll(["https://a.test/good", "https://a.test/bad"]).map((item) => item.body()).join("|")', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'ok|connection refused')
})

test('Android source 状态、文件入口和纯工具函数保持可调用', async () => {
  const fileCalls: Array<{ operation: string; input: Readonly<Record<string, unknown>> }> = []
  const host = new SourceRuleHost({ file: {
    execute: async (operation, input) => {
      fileCalls.push({ operation, input })
      if (operation === 'getFile') return { path: String(input.path), exists: true, isFile: true, isDirectory: false }
      if (operation === 'readFile') return new Uint8Array([1, 2, 3])
      return `file:${operation}`
    },
  } })
  const result = await evaluate(host, `@js:
    source.putLoginHeader(JSON.stringify({Authorization: 'Bearer test'}));
    var login = source.getLoginHeaderMap();
    var file = java.getFile('cache/a.txt');
    var locked = java.lock('one', function() { return java.tick('one'); });
    var batch = java.getBatchContext();
    var url = java.toURL('/book?q=a%20b&q=c', 'https://a.test/root');
    JSON.stringify({tag: java.getTag(), header: source.getHeaderMap(true).Authorization, login: login.Authorization, bytes: Array.from(java.readFile('cache/a.txt')), exists: file.exists(), lockedIsUndefined: locked === undefined, batch: batch, query: url.searchParams.q});`, '')
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), {
    tag: 'fixture',
    header: 'Bearer test',
    login: 'Bearer test',
    bytes: [1, 2, 3],
    exists: true,
    lockedIsUndefined: true,
    batch: null,
    query: 'c',
  })
  assert.deepEqual(fileCalls.map((item) => item.operation), ['getFile', 'readFile', 'getFile'])
})

test('File.exists/isFile/isDirectory 每次读取宿主最新元数据', async () => {
  let reads = 0
  const host = new SourceRuleHost({ file: {
    execute: async (operation) => {
      if (operation !== 'getFile') return undefined
      reads += 1
      return { path: 'cache/live.txt', exists: reads <= 3, isFile: reads <= 3, isDirectory: false }
    },
  } })
  const result = await evaluate(host, '@js:var file = java.getFile("cache/live.txt"); JSON.stringify([file.exists(), file.isFile(), file.exists(), file.isDirectory()])', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [true, true, false, false])
  assert.equal(reads, 5)
})

test('File 方法返回可调用的 Android 元数据并包装 listFiles 子项', async () => {
  const host = new SourceRuleHost({ file: {
    execute: async (operation, input) => {
      const path = String(input.path ?? '')
      if (operation === 'getFile') {
        const name = path.split('/').at(-1) ?? ''
        return { path, absolutePath: `sandbox/${path}`, name, length: path.endsWith('.txt') ? 12 : 0, lastModified: 1234, exists: true, isFile: path.endsWith('.txt'), isDirectory: !path.endsWith('.txt') }
      }
      if (operation === 'listFiles') return [
        { path: 'cache/child.txt', absolutePath: 'sandbox/cache/child.txt', name: 'child.txt', length: 7, lastModified: 1235, exists: true, isFile: true, isDirectory: false },
        { path: 'cache/sub', absolutePath: 'sandbox/cache/sub', name: 'sub', length: 0, lastModified: 1236, exists: true, isFile: false, isDirectory: true },
      ]
      return undefined
    },
  } })
  const result = await evaluate(host, `@js:
    var file = java.getFile('cache/root.txt');
    var children = file.listFiles();
    JSON.stringify({
      file: [file.getName(), file.getPath(), file.getAbsolutePath(), file.length(), file.lastModified(), file.canRead(), file.canWrite(), file.isFile(), file.isDirectory()],
      children: [children.length, children[0].getName(), children[0].getPath(), children[0].getAbsolutePath(), children[0].length(), children[0].isFile(), children[1].isDirectory(), typeof children[0].listFiles],
    })`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), {
    file: ['root.txt', 'cache/root.txt', 'sandbox/cache/root.txt', 12, 1234, true, true, true, false],
    children: [2, 'child.txt', 'cache/child.txt', 'sandbox/cache/child.txt', 12, true, true, 'function'],
  })
})

test('source 动态请求头、源变量和登录脚本沿用 Android 调用链', async () => {
  const host = new SourceRuleHost()
  host.setVariable('token', 'dynamic')
  const loginSource = {
    ...source,
    header: '@js:JSON.stringify({Authorization: "Bearer " + getVariable("token")})',
    loginUrl: '@js:function login(){ return "logged"; } function loginUi(state){ return JSON.stringify({value: state.value}); } function loginAction(action, state, form){ return JSON.stringify({action: action, form: form.value, state: state.value}); }',
    loginUi: JSON.stringify([{ name: '账号', type: 'text', default: 'guest' }]),
  } as NormalizedSource
  const result = await host.evaluate({ source: loginSource, stage: 'search', field: 'fixture', rule: '@js:source.setVariable("dynamic"); JSON.stringify([source.getHeaderMap(true).Authorization, source.getVariable(), source.login(), source.evalJS("1 + 2"), source.evalLoginUiV2(JSON.stringify({value: "state"})), source.evalLoginActionV2("submit", JSON.stringify({value: "state"}), JSON.stringify({value: "form"}))])', content: '' })
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [
    'Bearer dynamic',
    'dynamic',
    null,
    3,
    JSON.stringify({ value: 'state' }),
    JSON.stringify({ action: 'submit', form: 'form', state: 'state' }),
  ])
})

test('动态 loginUi 会生成并持久化 Android 登录信息默认值', async () => {
  const loginSource = {
    bookSourceUrl: 'https://login-ui.test',
    bookSourceName: 'login-ui',
    loginUrl: '@js:function login() { return "ok"; }',
    loginUi: '@js:JSON.stringify([{name: "user", type: "text", default: "guest"}, {name: "submit", type: "button", default: "ignored"}])',
  } as unknown as NormalizedSource
  const host = new SourceRuleHost()
  const first = await host.evaluate({ source: loginSource, stage: 'search', field: 'loginUi', rule: '@js:JSON.stringify([source.getLoginInfoMap(), source.getLoginInfo()])', content: '' })
  assert.equal(first.status, 'success')
  assert.equal(first.value, '[{"user":"guest"},"{\\"user\\":\\"guest\\"}"]')
  const second = await host.evaluate({ source: loginSource, stage: 'search', field: 'loginUi', rule: '@js:JSON.stringify(source.getLoginInfoMap())', content: '' })
  assert.equal(second.status, 'success')
  assert.equal(second.value, '{"user":"guest"}')
})

test('静态 loginUi 默认值按 Android 流程写入登录信息缓存', async () => {
  const loginSource = {
    bookSourceUrl: 'https://login-ui-static.test',
    bookSourceName: 'login-ui-static',
    loginUi: JSON.stringify([{ name: 'user', type: 'text', default: 'guest' }]),
  } as unknown as NormalizedSource
  const host = new SourceRuleHost()
  const first = await host.evaluate({ source: loginSource, stage: 'search', field: 'loginUi', rule: '@js:JSON.stringify([source.getLoginInfoMap(), source.getLoginInfo()])', content: '' })
  assert.equal(first.status, 'success')
  assert.equal(first.value, '[{"user":"guest"},"{\\"user\\":\\"guest\\"}"]')
  const second = await host.evaluate({ source: loginSource, stage: 'search', field: 'loginUi', rule: '@js:source.getLoginInfo()', content: '' })
  assert.equal(second.value, '{"user":"guest"}')
})

test('Android 非对称加密与签名工厂可以往返 RSA 数据', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:
    var encrypted = java.createAsymmetricCrypto("RSA/ECB/PKCS1Padding").setPublicKey(${JSON.stringify(publicKey)}).encryptBase64("hello");
    var plain = java.createAsymmetricCrypto("RSA/ECB/PKCS1Padding").setPrivateKey(${JSON.stringify(privateKey)}).decryptStr(encrypted, false);
    var signature = java.createSign("SHA256withRSA").setPrivateKey(${JSON.stringify(privateKey)}).signBase64("hello");
    var verified = java.createSign("SHA256withRSA").setPublicKey(${JSON.stringify(publicKey)}).verify("hello", signature);
    JSON.stringify([plain, verified]);`, '')
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), ['hello', true])
})

test('RSA-PSS 签名算法按 Java 常用别名使用摘要长度盐值', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const result = await evaluate(new SourceRuleHost(), `@js:
    var signature = java.createSign("SHA256withRSA/PSS").setPrivateKey(${JSON.stringify(privateKey)}).signBase64("hello");
    var verified = java.createSign("SHA256withRSA/PSS").setPublicKey(${JSON.stringify(publicKey)}).verify("hello", signature);
    var aliasVerified = java.createSign("SHA256withRSAandMGF1").setPublicKey(${JSON.stringify(publicKey)}).verify("hello", signature);
    JSON.stringify([signature.length > 0, verified, aliasVerified]);`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [true, true, true])
})

test('对称加密支持 Android 常用简写、十六进制输入和双密钥 3DES', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var aes = java.createSymmetricCrypto('AES', '1234567890123456');
    var aesHex = aes.encryptHex('hello');
    var triple = java.createSymmetricCrypto('DESede', '1234567890123456');
    var tripleBase64 = triple.encryptBase64('hello');
    JSON.stringify([aes.decryptStr(aesHex), triple.decryptStr(tripleBase64)]);`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['hello', 'hello'])
})

test('Java Cipher、KeySpec、KeyFactory 和 Signature 复用 Node 加密端口', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang, Packages.java.util, Packages.java.security, Packages.java.security.spec, Packages.javax.crypto, Packages.javax.crypto.spec);
    with (importer) {
      var key = new SecretKeySpec(String('1234567890123456').getBytes(), 'AES');
      var iv = new IvParameterSpec(String('abcdefghijklmnop').getBytes());
      var cipher = Cipher.getInstance('AES/CBC/PKCS5Padding');
      cipher.init(Cipher.ENCRYPT_MODE, key, iv);
      var encrypted = cipher.doFinal(String('hello').getBytes());
      cipher.init(Cipher.DECRYPT_MODE, key, iv);
      var plain = String(cipher.doFinal(encrypted));
      var privateSpec = new PKCS8EncodedKeySpec(Base64.getDecoder().decode('${privateKey.toString('base64')}'));
      var publicSpec = new X509EncodedKeySpec(Base64.getDecoder().decode('${publicKey.toString('base64')}'));
      var factory = KeyFactory.getInstance('RSA');
      var signature = Signature.getInstance('SHA256withRSA');
      signature.initSign(factory.generatePrivate(privateSpec));
      signature.update(String('hello').getBytes());
      var signed = signature.sign();
      signature.initVerify(factory.generatePublic(publicSpec));
      signature.update(String('hello').getBytes());
      JSON.stringify([plain, signature.verify(signed), encrypted.length > 0]);
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['hello', true, true])
})

test('Java Cipher 支持 GCMParameterSpec/updateAAD 和 OAEPParameterSpec 的同摘要 MGF1', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang, Packages.java.security, Packages.java.security.spec, Packages.javax.crypto, Packages.javax.crypto.spec);
    with (importer) {
      var key = new SecretKeySpec(new Uint8Array(16), 'AES');
      var gcmSpec = new GCMParameterSpec(96, new Uint8Array(12));
      var gcm = Cipher.getInstance('AES/GCM/NoPadding');
      gcm.init(Cipher.ENCRYPT_MODE, key, gcmSpec);
      gcm.updateAAD(String('header').getBytes());
      var gcmEncrypted = gcm.doFinal(String('正文').getBytes());
      gcm.init(Cipher.DECRYPT_MODE, key, gcmSpec);
      gcm.updateAAD(String('header').getBytes());
      var gcmPlain = String(gcm.doFinal(gcmEncrypted));
      var privateSpec = new PKCS8EncodedKeySpec(java.base64DecodeToByteArray('${privateKey.toString('base64')}'));
      var publicSpec = new X509EncodedKeySpec(java.base64DecodeToByteArray('${publicKey.toString('base64')}'));
      var factory = KeyFactory.getInstance('RSA');
      var oaepSpec = new OAEPParameterSpec('SHA-256', 'MGF1', new MGF1ParameterSpec('SHA-256'), new PSource.PSpecified(new Uint8Array([1, 2, 3])));
      var rsa = Cipher.getInstance('RSA/ECB/OAEPWithSHA-256AndMGF1Padding');
      rsa.init(Cipher.ENCRYPT_MODE, factory.generatePublic(publicSpec), oaepSpec);
      var rsaEncrypted = rsa.doFinal(String('hello').getBytes());
      rsa.init(Cipher.DECRYPT_MODE, factory.generatePrivate(privateSpec), oaepSpec);
      var rsaPlain = String(rsa.doFinal(rsaEncrypted));
      JSON.stringify([gcmPlain, gcmEncrypted.length, rsaPlain, rsaEncrypted.length > 0]);
    }`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['正文', 6 + 12, 'hello', true])
})

test('Java Cipher 对独立 OAEP MGF1 摘要报告 provider 能力缺口', async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const result = await evaluate(new SourceRuleHost(), `@js:
    var importer = new JavaImporter(Packages.java.lang, Packages.java.security, Packages.java.security.spec, Packages.javax.crypto, Packages.javax.crypto.spec);
    with (importer) {
      var publicSpec = new X509EncodedKeySpec(java.base64DecodeToByteArray('${publicKey.toString('base64')}'));
      var factory = KeyFactory.getInstance('RSA');
      var oaepSpec = new OAEPParameterSpec('SHA-256', 'MGF1', new MGF1ParameterSpec('SHA-1'), new PSource.PSpecified(new Uint8Array()));
      var rsa = Cipher.getInstance('RSA/ECB/OAEPWithSHA-256AndMGF1Padding');
      rsa.init(Cipher.ENCRYPT_MODE, factory.generatePublic(publicSpec), oaepSpec);
      rsa.doFinal(String('hello').getBytes());
    }`, '')
  assert.equal(result.status, 'capability-missing')
  assert.match(result.message ?? '', /runtime/iu)
})

test('对称加密工厂保持随机 key 和 setIv 状态，并支持 CTR/NoPadding', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var cipher = java.createSymmetricCrypto('AES/CBC/PKCS5Padding', null, java.strToBytes('1234567890123456'));
    var first = Array.from(cipher.getSecretKey().getEncoded());
    var second = Array.from(cipher.getSecretKey().getEncoded());
    var changed = cipher.setIv(java.strToBytes('6543210987654321')) === cipher;
    var ctr = java.createSymmetricCrypto('AES/CTR/NoPadding', '1234567890123456', '1234567890123456');
    var plain = Array.from(ctr.decrypt(ctr.encrypt('hello')));
    JSON.stringify([first.length, JSON.stringify(first) === JSON.stringify(second), changed, plain]);`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [16, true, true, [104, 101, 108, 108, 111]])
})

test('旧 AES 重载保留 Base64 文本、Base64 bytes 与 GCM tag 返回类型', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var key = '1234567890123456';
    var iv = '1234567890123456';
    var encoded = java.aesEncodeToBase64String('hello', key, 'AES/CBC/PKCS5Padding', iv);
    var decoded = java.aesBase64DecodeToString(encoded, key, 'AES/CBC/PKCS5Padding', iv);
    var encodedBytes = java.aesEncodeToBase64ByteArray('hello', key, 'AES/CBC/PKCS5Padding', iv);
    var gcm = java.createSymmetricCrypto('AES/GCM/NoPadding', new Uint8Array(16), new Uint8Array(12));
    JSON.stringify([typeof encoded, decoded, Array.isArray(Array.from(encodedBytes)), gcm.encrypt(new Uint8Array(16)).length]);`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['string', 'hello', true, 32])
})

test('规则桥接支持 provider 可用的 SM3、SM4 与 CCM 认证结果', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:
    var sm4 = java.createSymmetricCrypto('SM4/ECB/NoPadding', new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]));
    var ccm = java.createSymmetricCrypto('AES/CCM/NoPadding', new Uint8Array(16), new Uint8Array(12));
    JSON.stringify([java.digestHex('abc', 'SM3'), sm4.decrypt(sm4.encrypt(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]))).length, ccm.decrypt(ccm.encrypt(new Uint8Array(16))).length]);`, '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), ['66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0', 16, 16])
})

test('java.getString 和 java.getStringList 的 isUrl 使用重定向地址并去重', async () => {
  const host = new SourceRuleHost()
  const content = { url: '../chapter/1', missing: '', links: ['/a', '/a', 'chapter/2', 'javascript:void(0)'] }
  const result = await host.evaluate({
    source,
    stage: 'detail',
    field: 'fixture',
    rule: '@js:JSON.stringify([java.getString("$.url", result, true), java.getString("$.missing", result, true), java.getStringList("$.links", result, true)])',
    content,
    baseUrl: 'https://base.test/book/info',
    redirectUrl: 'https://redirect.test/book/page',
  })
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), [
    'https://redirect.test/chapter/1',
    'https://base.test/book/info',
    ['https://redirect.test/a', 'https://redirect.test/book/chapter/2'],
  ])
})

test('嵌套 java.getString 与外层规则共用规则步数预算', async () => {
  const host = new SourceRuleHost({ maxSteps: 9 })
  const content = JSON.stringify({ name: '书名' })
  const twoCalls = await evaluate(host, "@js:java.getString('$.name') + java.getString('$.name')", content)
  assert.equal(twoCalls.status, 'success')

  const threeCalls = await evaluate(host, "@js:java.getString('$.name') + java.getString('$.name') + java.getString('$.name')", content)
  assert.equal(threeCalls.status, 'failed')
  assert.match(threeCalls.message ?? '', /步数超过限制/u)
})

test('jsLib 支持行内库、远程缓存并按 Android 语义把映射值转成字符串', async () => {
  const inline = new SourceRuleHost()
  const inlineSource = { ...source, jsLib: 'function inlineHelper() { return "inline"; }' } as NormalizedSource
  assert.equal((await inline.evaluate({ source: inlineSource, stage: 'search', field: 'script', rule: '@js:inlineHelper()', content: '' })).value, 'inline')

  const calls: unknown[] = []
  const remote = new SourceRuleHost({ request: async (input) => { calls.push(input); return 'function remoteHelper() { return "remote"; }' } })
  const remoteSource = { ...source, jsLib: JSON.stringify({ helper: 'https://fixture.invalid/lib.js' }) } as NormalizedSource
  assert.equal((await remote.evaluate({ source: remoteSource, stage: 'search', field: 'script', rule: '@js:remoteHelper()', content: '' })).value, 'remote')
  assert.equal((await remote.evaluate({ source: remoteSource, stage: 'detail', field: 'script', rule: '@js:remoteHelper()', content: '' })).value, 'remote')
  assert.equal(calls.length, 1, '同一规则宿主应复用 jsLib 缓存')

  const mixedSource = { ...remoteSource, jsLib: JSON.stringify({ helper: 'https://fixture.invalid/lib.js', version: 1 }) } as NormalizedSource
  const mixed = await remote.evaluate({ source: mixedSource, stage: 'search', field: 'script', rule: '@js:remoteHelper()', content: '' })
  assert.equal(mixed.value, 'remote')
  assert.equal(calls.length, 2, '数字映射值按 Android Gson 规则转成字符串，其他 URL 仍然加载')

  const refreshed = await remote.evaluate({ source: remoteSource, stage: 'search', field: 'script', rule: `@js:cache.put('keep', 'value'); source.refreshJSLib(); cache.get('keep')`, content: '' })
  assert.equal(refreshed.value, 'value', 'refreshJSLib 不应清空普通缓存')
  assert.equal((await remote.evaluate({ source: remoteSource, stage: 'search', field: 'script', rule: '@js:remoteHelper()', content: '' })).value, 'remote')
  assert.equal(calls.length, 3, 'refreshJSLib 后远程 jsLib 应重新请求')
})

test('JavaScript CacheManager bridge 支持普通、内存和文件缓存', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, "@js:cache.put('disk', 'value'); cache.putMemory('memory', 'm'); cache.putFile('file', 'f'); JSON.stringify([cache.get('disk'), cache.getFromMemory('disk'), cache.get('memory'), cache.getFromMemory('memory'), cache.getFile('file')])", '')
  assert.deepEqual(JSON.parse(String(result.value)), ['value', 'value', 'm', 'm', 'f'])

  const deleted = await evaluate(host, "@js:cache.delete('disk'); cache.get('disk')", '')
  assert.equal(deleted.status, 'empty')

  const overwritten = await evaluate(host, "@js:cache.putMemory('ttl', 'stale'); cache.put('ttl', 'fresh', 60); cache.getFromMemory('ttl')", '')
  assert.equal(overwritten.status, 'empty', '带过期时间的普通缓存会清除旧的永久内存副本')
})

test('CacheManager 写入和删除保持 Android Unit 空返回值', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:JSON.stringify([cache.put("disk", "value"), cache.putMemory("memory", "value"), cache.putFile("file", "value"), cache.deleteMemory("memory"), cache.delete("disk"), cache.put("bytes", Uint8Array.from([1]))])', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [null, null, null, null, null, null])

  const hostResult = await evaluate(new SourceRuleHost({ cache: {
    get: () => undefined,
    getFromDisk: () => undefined,
    put: () => 'host-value',
    putByteArray: () => 'host-byte-value',
    delete: () => 'host-delete-value',
    getFromMemory: () => undefined,
    putMemory: () => 'host-memory-value',
    deleteMemory: () => 'host-memory-delete-value',
    getFile: () => undefined,
    putFile: () => 'host-file-value',
  } as never }), '@js:JSON.stringify([cache.put("disk", "value"), cache.putMemory("memory", "value"), cache.putFile("file", "value"), cache.deleteMemory("memory"), cache.delete("disk"), cache.put("bytes", Uint8Array.from([1]))])', '')
  assert.equal(hostResult.status, 'success', hostResult.message)
  assert.deepEqual(JSON.parse(String(hostResult.value)), [null, null, null, null, null, null])
})

test('CacheManager onlyDisk 在宿主没有磁盘端口时报告能力缺失', async () => {
  const cache = new MemorySourceScriptCache()
  Object.defineProperty(cache, 'getFromDisk', { value: undefined, configurable: true })
  const host = new SourceRuleHost({ cache })
  const result = await evaluate(host, '@js:cache.get("missing", true)', '')
  assert.equal(result.status, 'capability-missing')
})

test('CacheManager 保留对象、数字和 ByteArray 类型', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:cache.put("object", { id: 7 }); cache.put("bytes", Uint8Array.from([1, 2])); cache.put("number", 12.5); JSON.stringify([cache.get("object"), cache.get("bytes"), Array.from(cache.getByteArray("bytes")), cache.getDouble("number"), cache.getInt("missing")])', '')
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), [{ id: 7 }, null, [1, 2], 12.5, null])
})

test('CacheManager 对不可序列化对象返回稳定 cache-failed', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:var value = {}; value.self = value; cache.put("circular", value); "unreachable"', '')
  assert.equal(result.status, 'failed')
  assert.match(result.message ?? '', /cache-failed/u)
})

test('书源 JS 可读取 Cookie、时间与 UUID，设备标识能力缺失时明确报错', async () => {
  const requests: unknown[] = []
  const host = new SourceRuleHost({
    request: async (input) => { requests.push(input); return 'id=42; session=abc' },
    timeFormat: () => 'local-time',
    timeFormatUTC: (time, format, offsetMs) => `${time}:${format}:${offsetMs}`,
    randomUUID: () => 'uuid-fixture',
  })
  const result = await evaluate(host, "@js:JSON.stringify([java.getCookie('https://fixture.invalid'), java.getCookie('https://fixture.invalid', 'id'), java.timeFormat(0), java.timeFormatUTC(1, 'yyyy', 3600), java.randomUUID()])", '')
  assert.deepEqual(JSON.parse(String(result.value)), ['id=42; session=abc', '42', 'local-time', '1:yyyy:3600', 'uuid-fixture'])
  assert.equal((requests[0] as { kind: string }).kind, 'cookie-get')

  const unsupported = await evaluate(host, '@js:java.androidId()', '')
  assert.equal(unsupported.status, 'capability-missing')
  const userAgent = await evaluate(host, '@js:java.getWebViewUA()', '')
  assert.equal(userAgent.status, 'success')
  assert.match(String(userAgent.value), /^Mozilla\//u)
})

test('未实现的平台能力报告明确能力码，源登录状态可在会话内保存', async () => {
  for (const rule of [
    '@js:java.t2s("繁體")',
    '@js:java.s2t("简体")',
    '@js:java.webView(null, "https://fixture.invalid", null)',
  ]) {
    const result = await evaluate(new SourceRuleHost(), rule, '')
    assert.equal(result.status, 'capability-missing', rule)
    assert.match(result.message ?? '', /不可用|unavailable/u)
  }
  const state = await evaluate(new SourceRuleHost(), '@js:source.putLoginHeader("{}")', '')
  assert.equal(state.status, 'empty')
})

test('java.htmlFormat 使用与正文相同的图片和相对地址规则', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:java.htmlFormat(${JSON.stringify('<p>正文</p><img src="/img/a.png">')}, "https://fixture.invalid/book/1")`, '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '　　正文\n　　<img src="https://fixture.invalid/img/a.png">')

  const oneArgument = await new SourceRuleHost().evaluate({
    source,
    stage: 'detail',
    field: 'content',
    rule: `@js:java.htmlFormat(${JSON.stringify('<p>正文</p><img src="/img/a.png">')})`,
    content: '',
    baseUrl: 'https://fixture.invalid/book/1',
  })
  assert.equal(oneArgument.status, 'success')
  assert.equal(oneArgument.value, '　　正文\n　　<img src="/img/a.png">')
})

test('登录 UI v2 缺少登录脚本时返回明确错误', async () => {
  const loginSource = {
    bookSourceUrl: 'https://login-ui-missing.test',
    bookSourceName: 'login-ui-missing',
    loginUi: JSON.stringify({ version: 2, fields: [] }),
  } as unknown as NormalizedSource
  const result = await new SourceRuleHost().evaluate({
    source: loginSource,
    stage: 'search',
    field: 'loginUi',
    rule: '@js:source.evalLoginUiV2(JSON.stringify({}))',
    content: '',
  })
  assert.equal(result.status, 'failed')
  assert.match(result.message ?? '', /登录 UI v2 缺少/u)
})

test('Node 时间格式桥接遵循 Java 毫秒字段与 UTC 偏移格式', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, `@js:JSON.stringify([
    java.timeFormatUTC(978, 'S/SS/SSS X/XX/XXX MMMM', 0),
    java.timeFormatUTC(0, 'yyyy-MM-dd HH:mm XXX', 19800000)
  ])`, '')
  assert.equal(result.status, 'success')
  const month = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(new Date(978))
  assert.deepEqual(JSON.parse(String(result.value)), [
    `978/978/978 Z/Z/Z ${month}`,
    '1970-01-01 05:30 +05:30',
  ])
})

test('Node 时间格式桥接支持 Android 常用周年份、星期序号和独立月份标记', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:java.timeFormatUTC(1577836800000, "YYYY-u-LLLL", 0)`, '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '2020-3-January')
})

test('Node 时间格式桥接不把 SimpleDateFormat 未知字母静默当作字面量', async () => {
  const result = await evaluate(new SourceRuleHost(), `@js:java.timeFormatUTC(0, "yyyy-QQQ", 0)`, '')
  assert.equal(result.status, 'empty')
  assert.equal(result.value, null)
})

test('Node 日期格式处理引号、locale、时区和周年份边界', async () => {
  const host = new SourceRuleHost({ locale: 'en-US', timeZone: 'Asia/Shanghai' })
  const result = await evaluate(host, `@js:JSON.stringify([
    java.timeFormatUTC(Date.UTC(2018, 11, 31), "YYYY-w 'at' HH 'o''clock'", 0),
    java.timeFormatUTC(0, "MMMM EEEE", 0),
    java.timeFormat(0),
    java.timeFormatUTC(0, "XXXX", 0)
  ])`, '')
  assert.equal(result.status, 'success', result.message)
  const values = JSON.parse(String(result.value)) as string[]
  assert.equal(values[0], '2019-1 at 00 o\'clock')
  assert.equal(values[1], 'January Thursday')
  assert.equal(values[2], '1970/01/01 08:00')
  assert.equal(values[3], null)
})

test('source、book、chapter 变量分别写入所属 DTO，通用读取遵循 chapter 优先级', async () => {
  const host = new SourceRuleHost()
  host.setVariable('bookName', '错误的来源书名')
  host.setVariable('title', '错误的来源章节名')
  const book = { name: '书名', variable: JSON.stringify({ shared: 'book', fallback: 'book' }) }
  const chapter = { title: '章节名', variable: JSON.stringify({ shared: 'chapter', fallback: '' }) }
  const result = await host.evaluate({
    source,
    stage: 'detail',
    field: 'script',
    rule: "@js:java.put('shared', 'chapter-2'); source.put('sourceOnly', 'source'); book.putVariable('bookOnly', 'book'); book.putVariable('__proto__', 'safe-value'); JSON.stringify([getVar('shared'), getVar('fallback'), getVar('bookOnly', 'book'), getVar('title'), getVar('bookName'), source.get('sourceOnly')])",
    content: '',
    bindings: { book, chapter },
  })
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), ['chapter-2', 'book', 'book', '章节名', '书名', 'source'])
  assert.deepEqual(JSON.parse(chapter.variable ?? '{}'), { shared: 'chapter-2', fallback: '' })
  assert.deepEqual(JSON.parse(book.variable ?? '{}'), JSON.parse('{"shared":"book","fallback":"book","bookOnly":"book","__proto__":"safe-value"}'))
  assert.equal(Object.getPrototypeOf(book), Object.prototype)
  assert.deepEqual(host.snapshotVariables('source'), { bookName: '错误的来源书名', title: '错误的来源章节名' })

  const rawSourceVariable = await evaluate(host, "@js:source.setVariable('{\"raw\":true}'); source.getVariable()", '')
  assert.equal(rawSourceVariable.value, '{"raw":true}')

  const fromBookInfo = await host.evaluate({ source, stage: 'detail', field: 'script', rule: '@js:fromBookInfo === true', content: '', bindings: { isFromBookInfo: true } })
  assert.equal(fromBookInfo.value, true)

  const fallbackBook = { variable: '{}' }
  await host.evaluate({ source, stage: 'detail', field: 'script', rule: "@js:java.put('fallbackFromNull', 'yes')", content: '', bindings: { chapter: null, book: fallbackBook } })
  assert.equal(JSON.parse(fallbackBook.variable ?? '{}').fallbackFromNull, 'yes')
})

test('执行工作流脚本时同时保留 DTO 直接修改和 putVariable bridge 写入', async () => {
  const host = new SourceRuleHost()
  const chapter = { title: '第一章', variable: '{"before":"old"}' }
  const direct = await host.executeWorkflowJavaScript({
    source,
    stage: 'chapter',
    code: "chapter.title = '章节标题'; chapter.variable = '{\"direct\":\"yes\"}'; chapter",
    bindings: { chapter },
    captureMutations: ['chapter'],
  })
  assert.equal(direct.status, 'success')
  const directValue = direct.value as { __legadoWorkflowValue: { title: string }; __legadoWorkflowBindings: { chapter: { variable: string } } }
  assert.equal(directValue.__legadoWorkflowValue.title, '章节标题')
  assert.equal(directValue.__legadoWorkflowBindings.chapter.variable, '{"direct":"yes"}')

  const viaMethod = await host.executeWorkflowJavaScript({
    source,
    stage: 'chapter',
    code: "chapter.putVariable('method', 'yes'); chapter",
    bindings: { chapter: directValue.__legadoWorkflowBindings.chapter },
    captureMutations: ['chapter'],
  })
  const methodValue = viaMethod.value as { __legadoWorkflowBindings: { chapter: { variable: string } } }
  assert.deepEqual(JSON.parse(methodValue.__legadoWorkflowBindings.chapter.variable), { direct: 'yes', method: 'yes' })
})

test('书籍/章节扩展对象提供 Android 常用变量与媒体更新方法', async () => {
  const host = new SourceRuleHost()
  const chapter = { title: '章节', variable: '{}' }
  const actions: string[] = []
  const output = await host.executeWorkflowJavaScript({
    source,
    stage: 'content',
    code: "chapter.putLyric('歌词'); chapter.putDanmaku('弹幕'); chapter.putImgUrl('https://fixture.invalid/image'); chapter.update(); JSON.stringify([chapter.getVariable('lyric'), chapter.getVariable('danmaku'), chapter.imgUrl])",
    bindings: { chapter },
    captureMutations: ['chapter'],
    workflowActions: { refreshContent: async () => { actions.push('refreshContent'); return undefined } },
  })
  assert.equal(output.status, 'success')
  assert.deepEqual(JSON.parse(String((output.value as { __legadoWorkflowValue: string }).__legadoWorkflowValue)), ['歌词', '弹幕', 'https://fixture.invalid/image'])
  assert.deepEqual(actions, ['refreshContent', 'refreshContent', 'refreshContent', 'refreshContent'])
  const captured = (output.value as { __legadoWorkflowBindings: { chapter: { variable: string } } }).__legadoWorkflowBindings.chapter
  assert.deepEqual(JSON.parse(captured.variable), { lyric: '歌词', danmaku: '弹幕' })
})

test('JS 源函数对 book 和 chapter 参数的直接修改会回写到工作流 DTO', async () => {
  const host = new SourceRuleHost()
  const mutatingSource = {
    ...source,
    mainJs: `
      function getBookInfo(book) {
        book.name = '详情书名';
        book.variable = '{"direct":"book"}';
        return { intro: '详情简介' };
      }
      function getContent(chapter, book, nextChapterUrl) {
        chapter.title = '脚本章节名';
        chapter.variable = '{"direct":"chapter"}';
        book.variable = '{"direct":"content-book"}';
        return '正文';
      }
    `,
  } as NormalizedSource
  const book = { name: '搜索书名', variable: '{"before":"book"}' }
  const info = await host.executeSourceFunction({ source: mutatingSource, name: 'getBookInfo', args: [book], bindings: { book }, stage: 'book' })
  assert.equal(info.status, 'success')
  assert.deepEqual(info.value, { intro: '详情简介' })
  assert.deepEqual(book, { name: '详情书名', variable: '{"direct":"book"}' })

  const chapter = { title: '目录章节名', variable: '{"before":"chapter"}' }
  const contentBook = { variable: '{"before":"content-book"}' }
  const content = await host.executeSourceFunction({ source: mutatingSource, name: 'getContent', args: [chapter, contentBook, null], bindings: { chapter, book: contentBook }, stage: 'content' })
  assert.equal(content.value, '正文')
  assert.deepEqual(chapter, { title: '脚本章节名', variable: '{"direct":"chapter"}' })
  assert.deepEqual(contentBook, { variable: '{"direct":"content-book"}' })
})

test('非法 JavaScript 变量作用域失败且不会触碰宿主对象原型', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, "@js:setVar('polluted', 'yes', '__proto__')", '')
  assert.equal(result.status, 'failed')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('目录 JavaScript 可以读取当前响应和 URL 上下文', async () => {
  const host = new SourceRuleHost()
  const result = await host.evaluate({
    source,
    stage: 'detail',
    field: 'chapterList',
    rule: '@js:JSON.stringify({src, baseUrl, redirectUrl})',
    content: '<div>toc</div>',
    baseUrl: 'https://fixture.invalid/book/1',
    redirectUrl: 'https://cdn.fixture.invalid/toc/1',
  })
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), {
    src: '<div>toc</div>',
    baseUrl: 'https://fixture.invalid/book/1',
    redirectUrl: 'https://cdn.fixture.invalid/toc/1',
  })

  const transformed = await host.evaluate({
    source,
    stage: 'detail',
    field: 'chapterList',
    rule: '.item@js:src',
    content: '<section><div class="item">第一章</div></section>',
  })
  assert.equal(transformed.value, '<section><div class="item">第一章</div></section>')
})

test('规则宿主兼容真实书源中的 var result 和 Java 变量读取写入', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, '<js>var result = result + "-changed"; java.put("page", 2); result</js>', 'fixture')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'fixture-changed')
  const page = await evaluate(host, '@js:java.get("page")', '')
  assert.equal(page.status, 'success')
  assert.equal(page.value, '2')
})

test('InfoMap 支持 Android MutableMap 的读取、批量写入和删除', async () => {
  const result = await evaluate(new SourceRuleHost(), '@js:infoMap.put("a", "1"); infoMap.putAll({ b: 2 }); var initial = JSON.stringify(infoMap.get()); var initialValue = infoMap.get("a"); var missingValue = infoMap.get("missing"); var missingPut = infoMap.put("missing-put", "v"); var missingRemove = infoMap.remove("missing"); var initialContains = infoMap.containsValue("2"); var originalKeys = Array.from(infoMap.keys); var originalValues = Array.from(infoMap.values); var originalEntries = Array.from(infoMap.entries); var keys = infoMap.keys; var values = infoMap.values; var entries = infoMap.entries; infoMap.put("c", "3"); var live = [keys.toArray(), keys.length, values.toArray(), entries.toArray()]; var removedValue = values.remove("2"); var removedEntry = entries.remove(["c", "3"]); var importer = new JavaImporter(Packages.java.util.HashMap); with (importer) { infoMap.putAll(new HashMap({ d: 4 })); infoMap.set(new HashMap({ e: 5 })); } var removedKey = infoMap.remove("a"); JSON.stringify([JSON.parse(initial), initialValue, missingValue, missingPut, missingRemove, initialContains, originalKeys, originalValues, originalEntries, live, removedValue, removedEntry, removedKey, infoMap.get()])', '')
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [{ a: '1', b: '2' }, '1', null, null, null, true, ['a', 'b', 'missing-put'], ['1', '2', 'v'], [['a', '1'], ['b', '2'], ['missing-put', 'v']], [['a', 'b', 'missing-put', 'c'], 4, ['1', '2', 'v', '3'], [['a', '1'], ['b', '2'], ['missing-put', 'v'], ['c', '3']]], true, true, null, { e: '5' }])
})

test('InfoMap 的保存方法保持 Android 的空返回值并保留此前 save TTL', async () => {
  const calls: unknown[] = []
  const result = await new SourceRuleHost().executeWorkflowJavaScript({
    source,
    stage: 'search',
    code: 'infoMap.put("a", "1"); var save = infoMap.save(60); var now = infoMap.saveNow(); JSON.stringify([save, now])',
    content: '',
    workflowActions: { saveInfoMap: async (_signal, input) => { calls.push(input); return input } },
  })
  assert.equal(result.status, 'success', result.message)
  assert.deepEqual(JSON.parse(String(result.value)), [null, null])
  assert.deepEqual(calls, [
    { infoMap: { a: '1' }, time: 60, need: true },
    { infoMap: { a: '1' }, time: 60, need: true, now: true },
  ])
})

test('规则宿主支持任意位置 @put、JSON 内嵌规则与非空分支 %%', async () => {
  const host = new SourceRuleHost()
  assert.equal((await evaluate(host, '@get:{saved}@put:{saved:"literal:done"}', 'unused')).value, 'done')
  assert.equal((await evaluate(host, '@put:{saved:"literal:done"}literal:first&&@get:{saved}', 'unused')).value, 'first\ndone')

  const json = { book: { name: '书名' } }
  assert.equal((await evaluate(host, '@Json:book-{$.book.name}-suffix', json)).value, 'book-书名-suffix')
  assert.equal((await evaluate(host, '@Json:book-{$.missing}-suffix', json)).value, 'book--suffix')
  assert.deepEqual((await evaluate(host, '$.missing%%$.books[*].name', { books: [{ name: '甲' }, { name: '乙' }] })).value, ['甲', '乙'])
})

test('Default 位置选择器匹配 Android 离散索引、闭区间、排除和直接 children', async () => {
  const host = new SourceRuleHost()
  const html = '<div class="parent"><a data-i="0">A0</a><a data-i="1">A1</a><a data-i="2">A2</a><a data-i="3">A3</a><section><b>nested</b></section></div>'
  assert.deepEqual((await evaluate(host, 'tag.a.0:3@text', html)).value, ['A0', 'A3'])
  assert.deepEqual((await evaluate(host, 'tag.a[0:3]@text', html)).value, ['A0', 'A1', 'A2', 'A3'])
  assert.deepEqual((await evaluate(host, 'tag.a[:]@text', html)).value, ['A0', 'A1', 'A2', 'A3'])
  assert.deepEqual((await evaluate(host, 'tag.a[1:]@text', html)).value, ['A1', 'A2', 'A3'])
  assert.deepEqual((await evaluate(host, 'tag.a[data-i="0"]@text', html)).value, ['A0'])
  assert.deepEqual((await evaluate(host, 'tag.a[3:0]@text', html)).value, ['A3', 'A2', 'A1', 'A0'])
  assert.deepEqual((await evaluate(host, 'tag.a[-1]@text', html)).value, ['A3'])
  assert.deepEqual((await evaluate(host, 'tag.a[0:3:2]@text', html)).value, ['A0', 'A2'])
  assert.deepEqual((await evaluate(host, 'tag.a[!1,3]@text', html)).value, ['A0', 'A2'])
  assert.deepEqual((await evaluate(host, 'tag.a!0:3@text', html)).value, ['A1', 'A2'])

  const children = await evaluateNodes(host, 'div.parent@children', html)
  assert.equal(children.status, 'success')
  assert.equal((children.value as unknown[]).length, 5)
  const firstChild = await evaluateNodes(host, 'div.parent@children.0', html)
  assert.equal(firstChild.status, 'success')
  assert.equal((firstChild.value as unknown[]).length, 1)
})

test('规则分段可在选择器前后运行任意位置、大小写不敏感的 JS', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, 'div.item@text<JS>result[0].toUpperCase()</JS><js></js>@JS:result = result + "!"', '<div class="item">one</div>')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'ONE!')
})

test('替换正则仅在语法无效时退回字面替换，安全限制继续失败', async () => {
  const host = new SourceRuleHost()
  assert.equal((await evaluate(host, 'literal:a**b##a**##x', '')).value, 'xb')
  assert.equal((await evaluate(host, 'literal:pre-a**mid-post##a**##x##first', '')).value, 'x')
  const oversized = await evaluate(host, `literal:x##${'a'.repeat(2050)}##y`, '')
  assert.equal(oversized.status, 'failed')
  assert.match(oversized.message ?? '', /长度上限/u)
})

test('规则宿主兼容 java.ajax 的对象请求形式', async () => {
  const calls: unknown[] = []
  const host = new SourceRuleHost({ request: async (input) => { calls.push(input); return 'ok' } })
  const result = await evaluate(host, '@js:java.ajax({url: "https://fixture.invalid/api", method: "POST", body: "q=1"})', '')
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'ok')
  assert.deepEqual(calls, [{ kind: 'network', url: 'https://fixture.invalid/api', method: 'POST', body: 'q=1', stage: 'search' }])
})

test('字符串规则的末段按属性名取值，不再返回内部节点引用', async () => {
  const host = new SourceRuleHost()
  const html = '<div class="cover"><img src="a.jpg" data-original="big.jpg"></div><select><option value="/toc/2">下一页</option></select>'
  assert.deepEqual((await evaluate(host, '.cover@img@data-original', html)).value, ['big.jpg'])
  assert.deepEqual((await evaluate(host, 'option@value', html)).value, ['/toc/2'])
  assert.deepEqual((await evaluate(host, 'img@src', html)).value, ['a.jpg'])
  // 整条规则没有输出标记时按属性名处理：页面没有该属性就是空，不能把元素本身当成结果。
  assert.equal((await evaluate(host, '.cover', html)).status, 'empty')
  assert.equal((await evaluate(host, '.cover@img@alt', html)).status, 'empty')
})

test('规则主体含 {{}} 或 @get: 时返回插值文本（Android AnalyzeRule 的 Regex 分支）', async () => {
  const host = new SourceRuleHost()
  const json = JSON.stringify({ id: 42, x: '正文', category: '玄幻' })
  // 地址规则：Android 把 `{{}}` 求值后直接返回文本，不再当选择器。
  assert.equal((await evaluate(host, 'https://book.zri.moe/api/book/{{$.id}}', json)).value, 'https://book.zri.moe/api/book/42')
  assert.equal((await evaluate(host, '<p>{{$.x}}</p>', json)).value, '<p>正文</p>')
  // 表达式不是规则形态时按内联 JS 求值（makeUpRule 的 evalJS 分支）。
  assert.equal((await evaluate(host, '标签：{{java.getString("$.category")}}', json)).value, '标签：玄幻')
  assert.equal((await evaluate(host, '{{$.category}}·{{$.x}}', json)).value, '玄幻·正文')
  // `@@` 开头的表达式是规则形态，按规则对当前内容求值。
  assert.equal((await evaluate(host, '{{@@.item@text}}号', '<div class="item">第一章</div>')).value, '第一章号')
})

test('选择器 + @js: 代码里的 {{}} 先插值再执行', async () => {
  const host = new SourceRuleHost()
  const body = JSON.stringify({ response: { blogsetting: { blogId: 123 } } })
  // 语料写法：`$.response.blogsetting.blogId\n@js: ... '{{$.response.blogsetting.blogId}}' ...`
  const result = await evaluate(host, "$.response.blogsetting.blogId\n@js:\"id=\" + '{{$.response.blogsetting.blogId}}'", body)
  assert.equal(result.value, 'id=123')
})

test('空规则在字段规则里是空，在列表规则里沿用上一份内容（getString vs getStringList）', async () => {
  const host = new SourceRuleHost()
  const body = JSON.stringify({ name: '甲' })
  // 字段规则走 Android getString：插值为空 → AnalyzeByJSoup.getString("") → 空。
  assert.equal((await evaluate(host, '{{$.missing}}', body)).status, 'empty')
  assert.equal((await evaluate(host, '{{$.missing}}', '<div>正文</div>')).status, 'empty')
  assert.equal((await evaluate(host, '@put:{"savebid":"$.id"}', body)).status, 'empty')
  // 带 ## 替换的空规则是例外：Android 保留内容再应用替换（语料里 replaceRegex 常写成 `##模式`）。
  assert.equal((await evaluate(host, '##正文##', '<div>正文</div>')).value, '<div></div>')
  // 列表规则走 getStringList：`if (rule.isNotEmpty())` 不成立，result 保持整页内容。
  const list = await host.evaluate({ source, stage: 'detail', field: 'chapterList', rule: '@put:{"savebid":"$.id"}', content: '<div>目录</div>', expect: 'nodes' })
  assert.notEqual(list.status, 'empty')
  assert.ok(String(list.value).includes('目录'))
})

test('JS 规则体里的 {{}} 先插值再执行', async () => {
  const host = new SourceRuleHost()
  const json = JSON.stringify({ book_id: 99 })
  assert.equal((await evaluate(host, '@js:"https://api.test/book/{{$.book_id}}.txt"', json)).value, 'https://api.test/book/99.txt')
})

test('## 替换段里的 {{}} 参与插值', async () => {
  const host = new SourceRuleHost()
  host.setVariable('author', '张三')
  const html = '<div class="intro">《书名》是由张三写的。</div>'
  assert.equal((await evaluate(host, '.intro@text##^《.*?是由{{author}}写的。##已清洗', html)).value, '已清洗')
})

test('## 替换使用 Java Matcher 的占位符、转义和零宽匹配语义', async () => {
  const host = new SourceRuleHost()
  const named = await evaluate(host, 'literal:ab ab##(?<word>ab)##$0-' + '${word}' + '-$1', '')
  assert.equal(named.status, 'success')
  assert.equal(named.value, 'ab-ab-ab ab-ab-ab')

  const quoted = await evaluate(host, String.raw`literal:ab##ab##\$1`, '')
  assert.equal(quoted.status, 'success')
  assert.equal(quoted.value, '$1')

  const empty = await evaluate(host, 'literal:ab##$##X', '')
  assert.equal(empty.status, 'success')
  assert.equal(empty.value, 'abX')

  const first = await evaluate(host, 'literal:ab ab##(?<word>ab)##$0-' + '${word}' + '-$1###first', '')
  assert.equal(first.status, 'success')
  assert.equal(first.value, 'ab-ab-ab')
})

test('源可控正则按形态守卫：未锚定的嵌套量词一律拒绝，语料写法放行', async () => {
  const host = new SourceRuleHost()
  // 语料里有 4 条 `##` 匹配串合法使用「有字面量锚定」的嵌套量词（如 `(\n.*)+`），任何输入规模都放行；普通 Jsoup 文本会先把换行归一化为空格，因此该模式不命中。
  const short = await evaluate(host, 'p@text##(\\n.*)+##', '<p>a\nb\nc</p>')
  assert.equal(short.status, 'success')
  assert.equal(short.value, 'a b c')
  const large = await evaluate(host, 'p@text##(\\n.*)+##', `<p>${'a\n'.repeat(40000)}</p>`)
  assert.notEqual(large.status, 'failed')

  // 未锚定的嵌套量词是灾难回溯形态，短输入上就拒绝，不用等输入变大。
  const catastrophic = await evaluate(host, 'p@text##(a+)+$##', '<p>aaaa</p>')
  assert.equal(catastrophic.status, 'failed')
  assert.match(String(catastrophic.message), /嵌套量词/)

  const oversized = await evaluate(host, `p@text##${'x'.repeat(3000)}##`, '<p>x</p>')
  assert.equal(oversized.status, 'failed')
  assert.match(String(oversized.message), /长度上限/)
})

test('JSON 解包只作用于确定路径，通配路径保持 Android 的嵌套结构', async () => {
  const host = new SourceRuleHost()
  const body = JSON.stringify({ single: [[1, 2]], data: { books: [{ name: '甲' }, { name: '乙' }] } })
  // 确定路径指向数组：Android 的 JsonPath.read 直接返回数组本身，解包后条目数不变。
  assert.deepEqual((await evaluate(host, '$.data.books', body)).value, [{ name: '甲' }, { name: '乙' }])
  // 通配路径的结果是「元素列表」，数组元素就是条目本身，不能再拆成 2 项。
  assert.deepEqual((await evaluate(host, '$.single[*]', body)).value, [[1, 2]])
})

test('JSON 响应下无模式前缀的规则按 JSON 求值（Android isJSON 语义）', async () => {
  const host = new SourceRuleHost()
  const body = JSON.stringify({ data: { books: [{ name: '甲', url: '/a' }] }, userInfo: { username: '作者' } })
  const books = await evaluate(host, 'data.books', body)
  assert.equal(books.status, 'success')
  assert.deepEqual(books.value, [{ name: '甲', url: '/a' }])
  assert.deepEqual((await evaluate(host, 'userInfo.username', body)).value, ['作者'])
  // JSON 列表项自身也是 JSON 内容。
  assert.deepEqual((await evaluate(host, 'name', { name: '乙' })).value, ['乙'])
  // HTML 内容不受影响，仍按 CSS/属性名解析。
  assert.equal((await evaluate(host, 'data.books', '<data class="books">x</data>')).status, 'empty')
  assert.deepEqual((await evaluate(host, 'div@text', '<div>正文</div>')).value, ['正文'])
})
