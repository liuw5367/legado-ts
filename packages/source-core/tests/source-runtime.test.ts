import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CryptoHost,
  EncodingHost,
  FontHost,
  HtmlDocument,
  HtmlParser,
  JavaScriptHost,
  JsonPathParser,
  NormalizedSource,
  ParserNode,
  XPathParser,
} from '../src/index.ts'
import { SourceRuleRuntime } from '../src/index.ts'

test('source-core 规则运行时通过注入的 parser 执行 Default 属性规则', async () => {
  const node = { id: 'anchor-1', kind: 'element' } satisfies ParserNode
  const document: HtmlDocument = {
    select: (selector) => selector === 'a' ? [node] : [],
    attr: (_selected, name) => name === 'href' ? '/book/1' : undefined,
    read: () => '',
    child: () => document,
  }
  const html: HtmlParser = { parse: () => document }
  const xpath: XPathParser = { parse: () => document, evaluate: () => null }
  const json: JsonPathParser = { evaluate: () => null }
  const source = { bookSourceUrl: 'https://source.test', bookSourceName: 'test' } as NormalizedSource
  const runtime = new SourceRuleRuntime({
    encoding: {} as EncodingHost,
    crypto: {} as CryptoHost,
    font: {} as FontHost,
    html,
    json,
    xpath,
    javascript: {} as JavaScriptHost,
  })

  const result = await runtime.evaluate({ source, stage: 'search', field: 'bookUrl', rule: 'tag.a@href', content: '<a href="/book/1">书</a>' })
  assert.deepEqual(result, { status: 'success', value: ['/book/1'] })
})
