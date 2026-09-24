import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { importSources, searchBooks } from '../../source-core/src/index.ts'
import type { JsonValue, NormalizedSource, ParserNode, WorkflowRuleOutput, WorkflowPorts } from '../../source-core/src/index.ts'
import { HtmlParserAdapter, JsonPathParserAdapter, QuickJSJavaScriptHost, XPathParserAdapter } from '../src/index.ts'

const sourceFile = new URL('../../../fixtures/source/collection/14328_c803e1b071690d18ce7acb5184727058.json', import.meta.url)
const allSourceFiles = [
  new URL('../../../fixtures/source/collection/13655_c5880332228edeffa2ce977a525a6b21.json', import.meta.url),
  sourceFile,
  new URL('../../../fixtures/source/single/1790039793-起点.json', import.meta.url),
  new URL('../../../fixtures/source/single/1790040141-豆瓣.json', import.meta.url),
]

type UnknownRecord = Record<string, unknown>

async function fixtureCandidates() {
  const candidates = [] as Awaited<ReturnType<typeof importSources>>
  for (const file of allSourceFiles) candidates.push(...await importSources(await readFile(file, 'utf8')))
  return candidates
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

function sourceWithRule(candidates: Awaited<ReturnType<typeof importSources>>, group: string, field: string, expected: string): NormalizedSource {
  const source = candidates.find((candidate) => candidate.source !== undefined && ruleOf(candidate.source, group, field) === expected)?.source
  assert.ok(source, `未找到规则 ${group}.${field}: ${expected}`)
  return source
}

function sourceNamed(candidates: Awaited<ReturnType<typeof importSources>>, name: string): NormalizedSource {
  const source = candidates.find((candidate) => candidate.source?.bookSourceName === name)?.source
  assert.ok(source, `未找到书源: ${name}`)
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
  if (rule.includes('##')) return { status: 'capability-missing', value: null, message: 'smoke port 未实现规则替换' }
  if (rule.includes('{{')) {
    // 匹配书源中的 JSONPath 模板插值，并保留插值内部的路径文本。
    const value = rule.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => textValue(parser.evaluate(input, expression.trim())))
    return value.length === 0 ? { status: 'empty', value: null } : { status: 'success', value }
  }
  if (!rule.startsWith('$')) return { status: 'capability-missing', value: null, message: 'smoke port 只执行 JSONPath 规则' }
  const value = parser.evaluate(input, rule)
  return value === null || (Array.isArray(value) && value.length === 0) ? { status: 'empty', value: null } : { status: 'success', value }
}

test('07-B 真实 JSON 书源通过本地响应进入搜索工作流', async () => {
  const candidates = await fixtureCandidates()
  const source = sourceNamed(candidates, '猫眼看书')
  assert.equal(ruleOf(source, 'ruleSearch', 'bookList'), '$.data[*]')

  const response = {
    data: [{
      novelId: 'local-book',
      novelName: '本地测试书',
      authorName: '本地作者',
      cover: '/cover.jpg',
      summary: '本地简介',
    }],
  }
  const parser = new JsonPathParserAdapter()
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
  // 详情地址按响应地址转绝对（Android isUrl 语义），首页页码与 Android SearchModel 一致为 1。
  assert.deepEqual(result.value?.items.map((item) => ({ name: item.name, author: item.author, bookUrl: item.bookUrl })), [{ name: '本地测试书', author: '本地作者', bookUrl: 'http://api.lemiyigou.com/novel/local-book?isSearch=1' }])
  assert.deepEqual(calls, ['http://api.lemiyigou.com/search?page=1&keyword=%E6%9C%AC%E5%9C%B0%E6%B5%8B%E8%AF%95'])
})

test('07-B 真实 HTML 书源规则使用本地响应选择正文节点', async () => {
  const source = sourceWithRule(await fixtureCandidates(), 'ruleContent', 'content', 'class.font_max@html')
  // 将 Android 的 class.foo 兼容写法转换为 CSS 的 .foo 选择器。
  const selector = ruleOf(source, 'ruleContent', 'content')!.split('@', 1)[0]!.replace(/^class\./, '.')
  const document = new HtmlParserAdapter().parse('<div class="font_max"><p>本地正文</p></div>')
  const nodes = document.select(selector)
  assert.equal(nodes.length, 1)
  assert.equal(document.read(nodes[0]!, 'text'), '本地正文')
})

test('07-B 真实 XPath 书源规则使用本地 XML 响应', async () => {
  const source = sourceWithRule(await fixtureCandidates(), 'ruleContent', 'content', "//div[@class='text']/text()")
  const parser = new XPathParserAdapter()
  const document = parser.parse('<root><div class="text">本地 XPath 正文</div></root>')
  const result = parser.evaluate(document, ruleOf(source, 'ruleContent', 'content')!)
  assert.ok(Array.isArray(result))
  const node = (result as ParserNode[])[0]
  assert.ok(node)
  assert.equal(document.read(node, 'text'), '本地 XPath 正文')
})

test('07-B 真实 JS 规则在 QuickJS 中使用本地输入执行', async () => {
  const source = sourceWithRule(await fixtureCandidates(), 'ruleSearch', 'bookList', '<js>["ONE·阅读"]</js>')
  const rule = ruleOf(source, 'ruleSearch', 'bookList')!
  const code = rule.slice('<js>'.length, -'</js>'.length).trim()
  const result = await new QuickJSJavaScriptHost().execute({ code: `return (${code})`, stage: 'search', bindings: { result: [] } })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value, ['ONE·阅读'])
})
