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

test('Cookie、字符集 adapter 保持会话和字节语义', async () => {
  const cookies = new NodeCookieStore()
  await cookies.set('https://example.test/path', 'sid=abc; Path=/')
  assert.equal(await cookies.get('https://example.test/path'), 'sid=abc')
  assert.equal(await cookies.get('https://example.test/other'), 'sid=abc')
  const codec = new NodeCharsetCodec()
  const bytes = codec.encode('中文', 'gbk')
  assert.equal(codec.decode(bytes, 'gbk'), '中文')
})
