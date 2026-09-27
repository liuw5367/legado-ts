import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSource, WorkflowRuleRequest } from '../../source-core/src/index.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const source = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'fixture' } as NormalizedSource

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

test('没有会话限流写端时 source.putConcurrent 显式报告缺失能力', async () => {
  const output = await evaluate(new SourceRuleHost(), '@js:source.putConcurrent("1/100")', '')
  assert.equal(output.status, 'capability-missing')
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
  assert.deepEqual(calls, [{ kind: 'network-all', urls: ['https://a.test', 'https://b.test'], skipRateLimit: false }])
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
    { kind: 'network-response', url: 'https://a.test', method: 'GET', options: {} },
    { kind: 'network-response', url: 'https://a.test', method: 'GET', options: undefined },
  ])
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
    { kind: 'network-response', url: 'https://a.test/post', method: 'POST', body: 'q=1', headers: { 'X-Test': 'yes' }, options: { timeout: 123 } },
    { kind: 'network-response', url: 'https://a.test/head', method: 'HEAD', headers: { 'X-Test': 'yes' }, options: undefined },
    { kind: 'network-all', urls: ['https://a.test/one', 'https://a.test/two'], skipRateLimit: true, options: { timeout: 456 } },
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
  const missingWebView = await evaluate(host, '@js:java.getWebViewUA()', '')
  assert.equal(missingWebView.status, 'capability-missing')
})

test('Android 状态、词库和交互 bridge 缺失时报告明确能力码', async () => {
  for (const rule of [
    '@js:java.t2s("繁體")',
    '@js:java.s2t("简体")',
    '@js:java.webView(null, "https://fixture.invalid", null)',
    '@js:source.putLoginHeader("{}")',
  ]) {
    const result = await evaluate(new SourceRuleHost(), rule, '')
    assert.equal(result.status, 'capability-missing', rule)
    assert.match(result.message ?? '', /不可用|unavailable/u)
  }
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
    rule: "@js:java.put('shared', 'chapter-2'); source.put('sourceOnly', 'source'); book.putVariable('bookOnly', 'book'); book.putVariable('__proto__', 'safe-value'); JSON.stringify([getVar('shared'), getVar('fallback'), getVar('bookOnly', 'book'), getVar('title'), getVar('bookName')])",
    content: '',
    bindings: { book, chapter },
  })
  assert.equal(result.status, 'success')
  assert.deepEqual(JSON.parse(String(result.value)), ['chapter-2', 'book', 'book', '章节名', '书名'])
  assert.deepEqual(JSON.parse(chapter.variable ?? '{}'), { shared: 'chapter-2', fallback: '' })
  assert.deepEqual(JSON.parse(book.variable ?? '{}'), JSON.parse('{"shared":"book","fallback":"book","bookOnly":"book","__proto__":"safe-value"}'))
  assert.equal(Object.getPrototypeOf(book), Object.prototype)
  assert.deepEqual(host.snapshotVariables('source'), { bookName: '错误的来源书名', title: '错误的来源章节名', sourceOnly: 'source' })

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
  assert.deepEqual(calls, [{ kind: 'network', url: 'https://fixture.invalid/api', method: 'POST', body: 'q=1' }])
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

test('源可控正则按形态守卫：未锚定的嵌套量词一律拒绝，语料写法放行', async () => {
  const host = new SourceRuleHost()
  // 语料里有 4 条 `##` 匹配串合法使用「有字面量锚定」的嵌套量词（如 `(\n.*)+`），任何输入规模都放行。
  const short = await evaluate(host, 'p@text##(\\n.*)+##', '<p>a\nb\nc</p>')
  assert.equal(short.status, 'success')
  assert.equal(short.value, 'a')
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
