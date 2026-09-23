import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSource, WorkflowRuleRequest } from '../../source-core/src/public/index.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

const source = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'fixture' } as NormalizedSource

async function evaluate(host: SourceRuleHost, rule: string, content: unknown, stage: WorkflowRuleRequest['stage'] = 'search') {
  return host.evaluate({ source, stage, field: 'fixture', rule, content })
}

test('规则宿主支持 HTML 列表节点继续提取文本和属性', async () => {
  const host = new SourceRuleHost()
  const html = '<section><ul><li class="book" href="/book/1"><h2 class="title">我本无意成仙</h2><span class="author">作者</span></li></ul></section>'
  const list = await evaluate(host, 'section@.book', html)
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
