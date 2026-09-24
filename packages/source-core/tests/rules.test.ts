import assert from 'node:assert/strict'
import test from 'node:test'
import { compileRule, evaluateRule, inspectRuleCapabilities, MemoryVariableView } from '../src/index.ts'
import type { CompiledRule, NormalizedSource, RuleContext } from '../src/index.ts'

const source = { bookSourceUrl: 'https://example.test', bookSourceName: 'Example' } as NormalizedSource

function context(content: unknown, variables = new MemoryVariableView()): RuleContext {
  return { requestId: 'test', content, source, variables }
}

function compiled(text: string): CompiledRule {
  const result = compileRule(text)
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.rule)
  return result.rule
}

test('顶层组合符避开括号、方括号、字符串和模板插值', () => {
  const result = compileRule('@Json:$.a[?(@.value=="x&&y")]&&{{name}}')
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.rule?.kind, 'sequence')
  assert.equal(result.rule?.kind === 'sequence' ? result.rule.children.length : 0, 2)
})

test('模式识别按前缀大小写和 allInOne 规则工作', () => {
  assert.equal((compiled('@xPaTh://div') as Extract<CompiledRule, { kind: 'atom' }>).mode, 'XPath')
  assert.equal((compiled('@JSON:$.book') as Extract<CompiledRule, { kind: 'atom' }>).mode, 'Json')
  assert.equal((compiled('@webjs:document.title') as Extract<CompiledRule, { kind: 'atom' }>).mode, 'WebJs')
  assert.equal((compiled(':title=(.+)') as Extract<CompiledRule, { kind: 'atom' }>).mode, 'Regex')
  const literal = compileRule(':title=(.+)', { allInOne: false })
  assert.equal((literal.rule as Extract<CompiledRule, { kind: 'atom' }>).mode, 'Default')
})

test('Regex 返回完整匹配和缺失捕获组空字符串', () => {
  const result = evaluateRule(compiled(':(a)(b)?'), context('ab a'))
  assert.equal(result.status, 'success')
  assert.deepEqual(result.value, [['ab', 'a', 'b'], ['a', 'a', '']])
})

test('变量优先级、@put、@get 和模板插值可观察', () => {
  const variables = new MemoryVariableView({ initial: { source: { key: 'source', empty: '' }, book: { key: 'book' }, local: { local: '' } } })
  const result = evaluateRule(compiled('@put:{"saved":"literal:value"}@get:{saved}-{{key}}-{{local}}'), context('unused', variables))
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'value-book-')
  assert.deepEqual(result.variableChanges, [{ scope: 'chapter', name: 'saved', after: 'value' }])
})

test('&&、||、%% 维持空结果和交错顺序', () => {
  assert.equal(evaluateRule(compiled('literal:a&&literal:b'), context('x')).value, 'a\nb')
  assert.equal(evaluateRule(compiled('literal:&&literal:b'), context('x')).value, 'b')
  assert.equal(evaluateRule(compiled('literal:a||literal:b'), context('x')).value, 'a')
  assert.deepEqual(evaluateRule(compiled(':a|b%%:1|2'), context('a 1 b 2')).value, [['a'], ['1'], ['b'], ['2']])
})

test('替换表达式支持全量和首匹配片段语义', () => {
  assert.equal(evaluateRule(compiled('literal:a-b-a##a##x'), context('')).value, 'x-b-x')
  assert.equal(evaluateRule(compiled('literal:pre-a-post##a##x##first'), context('')).value, 'x')
})

test('解析器和脚本模式只报告能力缺失，不静默降级为文本', () => {
  const rule = compiled('@CSS:div.book')
  assert.deepEqual(inspectRuleCapabilities(rule), ['text', 'variables', 'parser:html'])
  const result = evaluateRule(rule, context('<div class="book">x</div>'))
  assert.equal(result.status, 'capability-missing')
  assert.equal(result.diagnostics[0]?.code, 'capability-unavailable')
})

test('兼容书源中的替换正则、插值和宽松 @put 语法', () => {
  for (const rule of [
    '.note@text##.*文案：　|\\(所属栏目：.*',
    '{{@@.book@text##更新：|T.*}}',
    ':正文卷[\\s\\S]*?/dl&&href ="([^"]+)">([^<]+)',
    '@put:{id:$.id}\nhttps://fixture.invalid/book/@get:{id}.html',
    '<js>const value = /[\\s\\S]*/; value</js>',
  ]) {
    const result = compileRule(rule)
    assert.deepEqual(result.diagnostics, [], rule)
    assert.ok(result.rule, rule)
  }
})

test('非法规则、取消和预算耗尽均有可判别结果', () => {
  assert.equal(compileRule('tag.a[0').diagnostics[0]?.code, 'unbalanced-rule')
  const controller = new AbortController()
  controller.abort()
  const cancelled = evaluateRule(compiled('literal:x'), { ...context('x'), signal: controller.signal })
  assert.equal(cancelled.status, 'cancelled')
  const limited = evaluateRule(compiled('literal:x&&literal:y'), context('x'), { maxSteps: 1 })
  assert.equal(limited.status, 'budget-exceeded')
})
