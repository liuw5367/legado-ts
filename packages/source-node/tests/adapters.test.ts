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
  assert.equal(document.read(nodes[0]!, 'html'), 'A<span>B</span>')
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
})

test('XPath adapter 先修复常见 HTML，再返回可继续查询的节点', () => {
  const parser = new XPathParserAdapter()
  const document = parser.parse('<ul><li class=chapter href=/c/1><a>第一章</a><img src=x><li class=chapter href=/c/2>第二章</ul>')
  const result = parser.evaluate(document, '//li[@class="chapter"]') as ParserNode[]
  assert.equal(result.length, 2)
  assert.equal(document.attr(result[0]!, 'href'), '/c/1')
  assert.equal(document.read(result[0]!, 'text'), '第一章')
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
