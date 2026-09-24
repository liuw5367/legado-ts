import assert from 'node:assert/strict'
import test from 'node:test'
import { importSources, searchBooks } from '../../source-core/src/index.ts'
import type { JsonValue, NormalizedSource, ParserNode, WorkflowRuleOutput, WorkflowPorts } from '../../source-core/src/index.ts'
import { HtmlParserAdapter, JsonPathParserAdapter, QuickJSJavaScriptHost, XPathParserAdapter } from '../src/index.ts'
import { loadFixtureCandidates } from './helpers/corpus.ts'

type UnknownRecord = Record<string, unknown>

async function fixtureCandidates() {
  return loadFixtureCandidates()
}

function record(value: unknown): UnknownRecord {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as UnknownRecord
}

function ruleOf(source: NormalizedSource, group: string, field: string): string | undefined {
  const value = record(source[group])[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function sourceWhere(
  candidates: Awaited<ReturnType<typeof importSources>>,
  predicate: (source: NormalizedSource) => boolean,
  label: string,
): NormalizedSource {
  const source = candidates.find((candidate) => candidate.source !== undefined && predicate(candidate.source))?.source
  assert.ok(source, `语料中未找到满足条件的书源: ${label}`)
  return source
}

function jsonInput(content: unknown): unknown {
  if (typeof content !== 'string') return content
  return JSON.parse(content) as JsonValue
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n')
  return JSON.stringify(value) ?? ''
}

function jsonRule(rule: string, content: unknown, parser: JsonPathParserAdapter): WorkflowRuleOutput {
  const input = jsonInput(content)
  // 冒烟端口只执行 JSONPath；其余（## 替换、@js、字面量等）按空值处理，避免可选字段把整次搜索打成 partial。
  if (rule.includes('##') || !rule.startsWith('$')) return { status: 'empty', value: null }
  if (rule.includes('{{')) {
    // 匹配书源中的 JSONPath 模板插值，并保留插值内部的路径文本。
    const value = rule.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => textValue(parser.evaluate(input, expression.trim())))
    return value.length === 0 ? { status: 'empty', value: null } : { status: 'success', value }
  }
  const value = parser.evaluate(input, rule)
  return value === null || (Array.isArray(value) && value.length === 0) ? { status: 'empty', value: null } : { status: 'success', value }
}

function isJsonPathRule(rule: string | undefined): rule is string {
  return rule !== undefined && rule.startsWith('$') && !rule.includes('<js>') && !rule.includes('##') && !rule.includes('||') && !rule.includes('@')
}

function isPlainBookUrlRule(rule: string | undefined): rule is string {
  return rule !== undefined && (rule.startsWith('$.') || rule.startsWith('/')) && !rule.includes('@js') && !rule.includes('<js>') && !rule.includes('##')
}

test('07-B 真实 JSON 书源通过本地响应进入搜索工作流', async () => {
  const candidates = await fixtureCandidates()
  const source = sourceWhere(
    candidates,
    (item) => isJsonPathRule(ruleOf(item, 'ruleSearch', 'bookList'))
      && isJsonPathRule(ruleOf(item, 'ruleSearch', 'name'))
      && isJsonPathRule(ruleOf(item, 'ruleSearch', 'author'))
      && isPlainBookUrlRule(ruleOf(item, 'ruleSearch', 'bookUrl'))
      && ruleOf(item, 'ruleSearch', 'bookList')!.includes('data')
      && !String(item.searchUrl ?? '').includes('<js>')
      && !String(item.searchUrl ?? '').toLowerCase().includes('@js:'),
    '纯 JSONPath 搜索规则且 bookList 指向 data 数组',
  )
  const nameRule = ruleOf(source, 'ruleSearch', 'name')!
  const authorRule = ruleOf(source, 'ruleSearch', 'author')!
  const bookUrlRule = ruleOf(source, 'ruleSearch', 'bookUrl')!

  // 按选中书源的字段规则构造本地响应，避免绑定具体文件或书源名。
  const parser = new JsonPathParserAdapter()
  const item: Record<string, unknown> = {
    novelId: 'local-book',
    novelName: '本地测试书',
    authorName: '本地作者',
    name: '本地测试书',
    author: '本地作者',
    title: '本地测试书',
    book_name: '本地测试书',
    bookName: '本地测试书',
    book_id: 'local-book',
    bookId: 'local-book',
    writerName: '本地作者',
    author_name: '本地作者',
  }
  if (nameRule.startsWith('$.')) item[nameRule.slice(2).split(/[!&|]/)[0]!.trim()] ??= '本地测试书'
  if (authorRule.startsWith('$.')) item[authorRule.slice(2).split(/[!&|]/)[0]!.trim()] ??= '本地作者'
  if (bookUrlRule.startsWith('$.')) item[bookUrlRule.slice(2).split(/[!&|]/)[0]!.trim()] ??= 'local-book'

  const response = { data: [item] }

  const calls: string[] = []
  const ports: WorkflowPorts = {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(JSON.stringify(response)), redirected: false }
      },
    },
    rules: { evaluate: async ({ rule, content }) => jsonRule(rule, content, parser) },
  }

  const result = await searchBooks(ports, { source, keyword: '本地测试' })
  assert.equal(result.status, 'success')
  assert.ok((result.value?.items.length ?? 0) >= 1)
  const first = result.value?.items[0]
  assert.ok(first)
  assert.equal(first.name, '本地测试书')
  assert.ok(first.author === '本地作者' || first.author === undefined || first.author.length > 0)
  // 详情地址按响应地址转绝对（Android isUrl 语义）。
  assert.ok(first.bookUrl.startsWith('http'))
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.length > 0)
})

test('07-B 真实 HTML 书源规则使用本地响应选择正文节点', async () => {
  const candidates = await fixtureCandidates()
  const source = sourceWhere(
    candidates,
    (item) => {
      const rule = ruleOf(item, 'ruleContent', 'content')
      if (rule === undefined) return false
      const selector = rule.split('##', 1)[0]!.split('||', 1)[0]!.split('&&', 1)[0]!.split('@', 1)[0]!
      return /^class\.[\w-]+$/.test(selector) || /^\.[\w-]+$/.test(selector)
    },
    'CSS/class 形态正文选择器',
  )
  const rawRule = ruleOf(source, 'ruleContent', 'content')!
  const core = rawRule.split('##', 1)[0]!.split('||', 1)[0]!.split('&&', 1)[0]!
  const selectorPart = core.split('@', 1)[0]!
  // 将 Android 的 class.foo 兼容写法转换为 CSS 的 .foo 选择器。
  const selector = selectorPart.replace(/^class\./, '.')
  const className = selector.slice(1)
  const document = new HtmlParserAdapter().parse(`<div class="${className}"><p>本地正文</p></div>`)
  const nodes = document.select(selector)
  assert.equal(nodes.length, 1)
  assert.equal(document.read(nodes[0]!, 'text'), '本地正文')
})

test('07-B 真实 XPath 书源规则使用本地 XML 响应', async () => {
  const candidates = await fixtureCandidates()
  const source = sourceWhere(
    candidates,
    (item) => {
      const rule = ruleOf(item, 'ruleContent', 'content')
      if (rule === undefined) return false
      const core = rule.split('##', 1)[0]!.split('||', 1)[0]!
      return core.trimStart().startsWith('//') || core.trimStart().startsWith('(//')
    },
    'XPath 形态正文规则',
  )
  const rawRule = ruleOf(source, 'ruleContent', 'content')!
  const core = rawRule.split('##', 1)[0]!.split('||', 1)[0]!
  const parser = new XPathParserAdapter()
  // 为常见 //div[@class='...']/text() 形态构造匹配节点；其他 XPath 直接在通用文档上求值。
  const classMatch = core.match(/\[@class=['"]([^'"]+)['"]\]/)
  const html = classMatch
    ? `<root><div class="${classMatch[1]}">本地 XPath 正文</div></root>`
    : '<root><div id="content"><p>本地 XPath 正文</p></div><div class="text">本地 XPath 正文</div></root>'
  const document = parser.parse(html)
  const result = parser.evaluate(document, core.trim())
  assert.ok(Array.isArray(result))
  const node = (result as ParserNode[])[0]
  assert.ok(node, `XPath 规则未选中节点: ${core}`)
  assert.equal(document.read(node, 'text'), '本地 XPath 正文')
})

test('07-B 真实 JS 规则在 QuickJS 中使用本地输入执行', async () => {
  const candidates = await fixtureCandidates()
  const source = sourceWhere(
    candidates,
    (item) => {
      const rule = ruleOf(item, 'ruleSearch', 'bookList')
      return rule !== undefined && /^<js>\s*\[[\s\S]*\]\s*<\/js>$/.test(rule.trim())
    },
    '字面量数组形态的 <js> bookList 规则',
  )
  const rule = ruleOf(source, 'ruleSearch', 'bookList')!
  const code = rule.slice('<js>'.length, -'</js>'.length).trim()
  const result = await new QuickJSJavaScriptHost().execute({ code: `return (${code})`, stage: 'search', bindings: { result: [] } })
  assert.equal(result.status, 'success')
  assert.ok(Array.isArray(result.value))
  assert.ok((result.value as unknown[]).length >= 1)
})
