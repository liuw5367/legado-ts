import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParserNode } from '@legado/source-core'
import { HtmlParserAdapter, JsonPathParserAdapter, NodeCharsetCodec, NodeCookieStore, XPathParserAdapter } from '../src/index.ts'

test('HTML adapter 保留节点身份并支持 CSS、属性、文本和子文档', () => {
  const document = new HtmlParserAdapter().parse('<div class="book"><a href="/a">A<span>B</span></a><script>x</script></div>')
  const nodes = document.select('div.book a')
  assert.equal(nodes.length, 1)
  assert.equal(document.attr(nodes[0]!, 'href'), '/a')
  assert.equal(document.read(nodes[0]!, 'text'), 'AB')
  assert.equal(document.child(nodes[0]!).select('span').length, 1)
  assert.equal(document.child(nodes[0]!).children().length, 1)
  assert.equal(document.read(nodes[0]!, 'html'), '<a href="/a">A<span>B</span></a>')
})

test('HTML adapter 的 html 输出保留当前元素并移除脚本和样式', () => {
  const document = new HtmlParserAdapter().parse('<div class="book"><a>A</a><script>bad()</script><style>.bad{}</style></div>')
  const node = document.select('div.book')[0]!

  assert.equal(document.read(node, 'html'), '<div class="book"><a>A</a></div>')
  assert.equal(document.read(node, 'all'), '<div class="book"><a>A</a><script>bad()</script><style>.bad{}</style></div>')
})

test('HTML adapter 支持 Jsoup 位置、ownText 和正则伪类', () => {
  const document = new HtmlParserAdapter().parse('<main><p class="book">前<b>甲</b></p><p class="book">中<b>乙</b></p><p class="book">后<b>丙</b></p></main>')
  assert.equal(document.select('p.book:eq(1) b')[0] !== undefined, true)
  assert.equal(document.select('p.book:lt(2)').length, 2)
  assert.equal(document.select('p.book:gt(1)').length, 1)
  assert.equal(document.select('p.book:eq(-1)').length, 0)
  assert.equal(document.select('p.book:lt(-1)').length, 0)
  assert.equal(document.select('p.book:gt(-1)').length, 3)
  assert.equal(document.select('p:containsOwn(中)').length, 1)
  assert.equal(document.select('p:matchesOwn(/^中/u)').length, 1)
  assert.equal(document.read(document.select('main')[0]!, 'text'), '前甲 中乙 后丙')
})

test('HTML adapter 支持 Jsoup 文本正则、属性正则和常见组合选择器', () => {
  const document = new HtmlParserAdapter().parse('<main><div class="content" data-x="abc"><a href="/one">One</a></div><div class="head" data-x="xbc"><a href="/two">Two</a></div><p>Three</p></main>')
  assert.equal(document.select('div:matches(/One/)').length, 1)
  assert.equal(document.select('[data-x~=(?i)^a]').length, 1)
  assert.equal(document.select('main > div:has(a):not(.content)').length, 1)
  assert.equal(document.select('div:is(.content,.head)').length, 2)
})

test('HTML adapter 的 XML 模式保留大小写并报告无效选择器', () => {
  const document = new HtmlParserAdapter().parse('<Root><Item ID="x">Hi</Item></Root>', 'xml')
  assert.equal(document.select('Item').length, 1)
  assert.equal(document.select('item').length, 0)
  assert.equal(document.select('[ID="x"]').length, 1)
  assert.throws(
    () => document.select('Item['),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unsupported-selector',
  )
})

test('HTML/XPath textNodes 去除每个文本节点首尾 ASCII 控制空白并忽略空白节点', () => {
  const html = new HtmlParserAdapter().parse('<div>  A \n <span>nested</span> \t B \r\n</div>')
  const htmlNode = html.select('div')[0]!
  assert.equal(html.read(htmlNode, 'textNodes'), 'A\nB')

  const xpath = new XPathParserAdapter()
  const xml = xpath.parse('<root><item>  A \n <span>nested</span> \t B \r\n</item></root>')
  const xmlNode = xpath.evaluate(xml, '//item') as ParserNode[]
  assert.equal(xml.read(xmlNode[0]!, 'textNodes'), 'A\nB')
})

test('JSONPath adapter 保留列表和空选择', () => {
  const parser = new JsonPathParserAdapter()
  assert.deepEqual(parser.evaluate({ books: [{ name: 'A' }, { name: 'B' }] }, '$.books[*].name'), ['A', 'B'])
  assert.deepEqual(parser.evaluate({ books: [] }, '$.books[*].name'), [])
})

test('JSONPath adapter 支持书源常用的安全条件筛选', () => {
  const parser = new JsonPathParserAdapter()
  const value = {
    books: [
      { name: '免费', vip: false, score: 4 },
      { name: '会员', vip: true, score: 5 },
      { name: '低分', vip: false, score: 2 },
    ],
  }

  assert.deepEqual(
    parser.evaluate(value, '$.books[?(@.vip == false && @.score >= 3)].name'),
    ['免费'],
  )
})

test('JSONPath adapter 支持 Jayway 聚合函数和正则过滤的安全转换', () => {
  const parser = new JsonPathParserAdapter()
  const value = { items: [{ name: 'alpha', score: 2 }, { name: 'beta', score: 5 }, { name: '中文', score: 1 }] }
  assert.deepEqual(parser.evaluate(value, '$.items.length()'), [3])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.name =~ /a.*/i)].name'), ['alpha', 'beta'])
  assert.deepEqual(parser.evaluate(value, '$.items[*].score.sum()'), [8])
})

test('JSONPath adapter 转换 Jayway 过滤运算并拒绝无法安全降级的集合运算', () => {
  const parser = new JsonPathParserAdapter()
  const value = {
    items: [
      { value: 'a', tags: ['a'] },
      { value: 'b', tags: ['b'] },
      { value: 'c', tags: ['c'] },
      { value: 'empty', tags: [] },
      { value: 'null', tags: null },
      { value: 'missing' },
    ],
  }
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.value in ["a","c"])].value'), ['a', 'c'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.value nin ["a"])].value'), ['b', 'c', 'empty', 'null', 'missing'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags size 1)].value'), ['a', 'b', 'c'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags anyof ["b","c"])].value'), ['b', 'c'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags noneof ["b","c"])].value'), ['a', 'empty'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags empty true)].value'), ['empty'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags subsetof ["a","b"])].value'), ['a', 'b', 'empty'])
  assert.throws(
    () => parser.evaluate(value, '$.items[?(@.tags subsetof [{"value":1}])].value'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unsupported-jsonpath',
  )

  const typed = {
    items: [
      { value: 'number', tags: [1] },
      { value: 'duplicate-number', tags: [1, 1] },
      { value: 'string', tags: ['1'] },
      { value: 'mixed', tags: [1, '1'] },
      { value: 'empty', tags: [] },
    ],
  }
  assert.deepEqual(parser.evaluate(typed, '$.items[?(@.tags subsetof [1])].value'), ['number', 'duplicate-number', 'string', 'mixed', 'empty'])
  assert.deepEqual(parser.evaluate(typed, '$.items[?(@.tags subsetof ["1"])].value'), ['number', 'duplicate-number', 'string', 'mixed', 'empty'])
  assert.deepEqual(parser.evaluate(typed, '$.items[?(@.tags subsetof [1,"1"])].value'), ['number', 'duplicate-number', 'string', 'mixed', 'empty'])
})

test('JSONPath adapter 对齐 Jayway 的集合等价、空值和聚合函数语义', () => {
  const parser = new JsonPathParserAdapter()
  const value = {
    items: [
      { id: 'number', value: 1, tags: [1] },
      { id: 'string', value: '1', tags: ['1'] },
      { id: 'boolean', value: true, tags: [true] },
      { id: 'empty', value: null, tags: [] },
      { id: 'missing' },
    ],
    numbers: [1, '2', null],
    text: 'abc',
  }

  assert.deepEqual(parser.evaluate(value, '$.items[?(@.value in [1])].id'), ['number', 'string'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags anyof [1])].id'), ['number', 'string'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags noneof [1])].id'), ['boolean', 'empty'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags subsetof [1])].id'), ['number', 'string', 'empty'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.tags empty true)].id'), ['empty'])
  assert.deepEqual(parser.evaluate(value, '$.numbers.sum()'), [1])
  assert.deepEqual(parser.evaluate(value, '$.numbers.stddev()'), [0])
  assert.deepEqual(parser.evaluate(value, '$.numbers.first()'), [1])
  assert.deepEqual(parser.evaluate(value, '$.numbers.last()'), [null])
  assert.deepEqual(parser.evaluate(value, '$.numbers.index(1)'), ['2'])
  assert.deepEqual(parser.evaluate(value, '$.text.length()'), [null])
  assert.throws(
    () => parser.evaluate(value, '$.missing.length()'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unsupported-jsonpath',
  )
})

test('JSONPath adapter 对齐 Jayway 的标量 empty、空聚合和文本函数边界', () => {
  const parser = new JsonPathParserAdapter()
  const value = {
    items: [
      { id: 'null', value: null },
      { id: 'false', value: false },
      { id: 'number', value: 3 },
      { id: 'empty-string', value: '' },
      { id: 'text', value: 'abc' },
      { id: 'empty-array', value: [] },
      { id: 'empty-object', value: {} },
      { id: 'array', value: [1] },
      { id: 'object', value: { key: 1 } },
      { id: 'missing' },
    ],
    numbers: [],
    text: 'abc',
  }

  assert.deepEqual(parser.evaluate(value, '$.items[?(@.value empty true)].id'), ['empty-string', 'empty-array', 'empty-object'])
  assert.deepEqual(parser.evaluate(value, '$.items[?(@.value empty false)].id'), ['null', 'false', 'number', 'text', 'array', 'object'])
  assert.throws(() => parser.evaluate(value, '$.numbers.avg()'), /没有可聚合的数字/u)
  assert.throws(() => parser.evaluate(value, '$.numbers.stddev()'), /没有可聚合的数字/u)
  assert.throws(() => parser.evaluate(value, '$.numbers.sum()'), /没有可聚合的数字/u)
  assert.deepEqual(parser.evaluate(value, '$.text.concat("!", 2, true, ["?"])'), ['!2true?'])
  assert.deepEqual(parser.evaluate(value, '$.text.concat([{key:1}, [2, {flag:true}], null])'), ['{key=1}[2, {flag=true}]'])
  assert.deepEqual(parser.evaluate(value, '$.text.append(1)'), ['abc'])
})

test('JSONPath adapter 不执行条件表达式中的原生构造器', () => {
  const parser = new JsonPathParserAdapter()

  assert.throws(
    () => parser.evaluate({ books: [{ name: 'A' }] }, '$.books[?(@.constructor.constructor("return process")())]'),
  )
})

test('XPath adapter 返回 XML 节点结果', () => {
  const parser = new XPathParserAdapter()
  const document = parser.parse('<root><item id="a">A</item><item id="b">B</item></root>')
  const result = parser.evaluate(document, '//item')
  assert.equal(Array.isArray(result), true)
  assert.equal((result as Array<{ kind: string }>).length, 2)
  const first = (result as ParserNode[])[0]!
  assert.equal(document.attr(first, 'id'), 'a')
  assert.equal(document.read(first, 'text'), 'A')
  assert.equal(document.read(first, 'ownText'), 'A')
  assert.equal(document.read(first, 'all'), '<item id="a">A</item>')
  assert.equal(document.children().length, 1)
})

test('XPath XML 属性名保持大小写敏感', () => {
  const parser = new XPathParserAdapter()
  const document = parser.parse('<?xml version="1.0"?><root><item ID="upper" id="lower">A</item></root>')
  const node = (parser.evaluate(document, '//item') as ParserNode[])[0]!
  assert.equal(document.attr(node, 'ID'), 'upper')
  assert.equal(document.attr(node, 'id'), 'lower')
  assert.equal(document.select('[ID="upper"]').length, 1)
  assert.equal(document.select('[id="lower"]').length, 1)
  assert.equal(document.select('[id="upper"]').length, 0)
})

test('XPath XML 文档的 CSS 选择器保留 Jsoup 常用位置和文本伪类', () => {
  const parser = new XPathParserAdapter()
  const document = parser.parse('<?xml version="1.0"?><root><item>A<b>甲</b></item><item>B<b>乙</b></item></root>')
  assert.equal(document.select('item:eq(1)').length, 1)
  assert.equal(document.select('item:eq(-1)').length, 0)
  assert.equal(document.select('item:lt(-1)').length, 0)
  assert.equal(document.select('item:gt(-1)').length, 2)
  assert.equal(document.select('item:containsOwn(B)').length, 1)
  assert.equal(document.select('item:matchesOwn(/^B/u)').length, 1)
  assert.equal(document.select('item:matches(/乙/)').length, 1)
})

test('XPath adapter 先修复常见 HTML，再返回可继续查询的节点', () => {
  const parser = new XPathParserAdapter()
  const document = parser.parse('<ul><li class=chapter href=/c/1><a>第一章</a><img src=x><li class=chapter href=/c/2>第二章</ul>')
  const result = parser.evaluate(document, '//li[@class="chapter"]') as ParserNode[]
  assert.equal(result.length, 2)
  assert.equal(document.attr(result[0]!, 'href'), '/c/1')
  assert.equal(document.read(result[0]!, 'text'), '第一章')
})

test('XPath adapter 为表格片段补容器并规范 XML 文本空白', () => {
  const parser = new XPathParserAdapter()
  const document = parser.parse('<td>  A \n <b>B</b> \t C </td>')
  const node = parser.evaluate(document, '//td') as ParserNode[]
  assert.equal(node.length, 1)
  assert.equal(document.read(node[0]!, 'text'), 'A B C')
  assert.equal(document.read(node[0]!, 'ownText'), 'A C')
  assert.equal(document.read(node[0]!, 'textNodes'), 'A\nC')
})

test('Cookie、字符集 adapter 保持会话和字节语义', async () => {
  const cookies = new NodeCookieStore()
  await cookies.set('https://example.test/path', 'sid=abc; Path=/')
  assert.equal(await cookies.get('https://example.test/path'), 'sid=abc')
  assert.equal(await cookies.get('https://example.test/other'), 'sid=abc')
  const codec = new NodeCharsetCodec()
  const bytes = codec.encode('中文', 'gbk')
  assert.equal(codec.decode(bytes, 'gbk'), '中文')
})
