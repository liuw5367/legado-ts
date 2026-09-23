import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSource, WorkflowRuleRequest } from '../../source-core/src/public/index.ts'
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

test('规则宿主的 JavaScript 可以使用书源 bridge 的编码能力', async () => {
  const host = new SourceRuleHost()
  const result = await evaluate(host, '@js:java.base64Encode(result)', '我本无意成仙')
  assert.equal(result.status, 'success')
  assert.equal(result.value, '5oiR5pys5peg5oSP5oiQ5LuZ')
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

test('插值为空时保留上一份内容（Android 的空规则语义）', async () => {
  const host = new SourceRuleHost()
  const body = JSON.stringify({ name: '甲' })
  // 字段缺失 → 插值为空 → Android 的 rule 变空串，result 仍是分析前的整页内容。
  assert.equal((await evaluate(host, '{{$.missing}}', body)).value, body)
  assert.equal((await evaluate(host, '{{$.missing}}', '<div>正文</div>')).value, '<div>正文</div>')
  // 只剩 @put 的空规则串同样不进模式分支（语料里 lastChapter/kind 这类字段会这么写）。
  assert.equal((await evaluate(host, '@put:{"savebid":"$.id"}', body)).value, body)
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

test('源可控正则命中守卫时明确失败，短输入的合法写法不受影响', async () => {
  const host = new SourceRuleHost()
  // 语料里有 4 条 `##` 匹配串合法使用嵌套量词（如 `(\n.*)+`），短输入必须照常替换。
  const short = await evaluate(host, 'p@text##(\\n.*)+##', '<p>a\nb\nc</p>')
  assert.equal(short.status, 'success')
  assert.equal(short.value, 'a')

  const large = await evaluate(host, 'p@text##(\\n.*)+##', `<p>${'a\n'.repeat(40000)}</p>`)
  assert.equal(large.status, 'failed')
  assert.match(String(large.message), /嵌套量词/)

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
