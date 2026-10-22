import assert from 'node:assert/strict'
import test from 'node:test'
import { compileRule, compileSourcePattern, evaluateRule, inspectRuleCapabilities, MemoryVariableView } from '../src/index.ts'
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

test('@put 可在规则中段提取，并按出现顺序更新变量', () => {
  const result = evaluateRule(compiled('@get:{saved}@put:{saved:"literal:first"}@put:{saved:"literal:last"}'), context('unused'))
  assert.equal(result.status, 'success')
  assert.equal(result.value, 'last')
})

test('&&、||、%% 维持空结果和交错顺序', () => {
  assert.equal(evaluateRule(compiled('literal:a&&literal:b'), context('x')).value, 'a\nb')
  assert.equal(evaluateRule(compiled('literal:&&literal:b'), context('x')).value, 'b')
  assert.equal(evaluateRule(compiled('literal:a||literal:b'), context('x')).value, 'a')
  assert.deepEqual(evaluateRule(compiled(':a|b%%:1|2'), context('a 1 b 2')).value, [['a'], ['1'], ['b'], ['2']])
  assert.deepEqual(evaluateRule(compiled(':missing%%:a'), context('a')).value, [['a']])
})

test('替换表达式支持全量和首匹配片段语义', () => {
  assert.equal(evaluateRule(compiled('literal:a-b-a##a##x'), context('')).value, 'x-b-x')
  assert.equal(evaluateRule(compiled('literal:pre-a-post##a##x##first'), context('')).value, 'x')
  assert.equal(evaluateRule(compiled('literal:a**b##a**##x'), context('')).value, 'xb')
  assert.equal(evaluateRule(compiled('literal:pre-a**mid-post##a**##x##first'), context('')).value, 'x')
  assert.equal(evaluateRule(compiled('literal:aaaa##(a+)+$##x'), context('')).status, 'failed')
  assert.equal(evaluateRule(compiled(`literal:x##${'a'.repeat(2050)}##y`), context('')).status, 'failed')
})

test('纯求值器也会插值替换表达式中的变量', () => {
  const variables = new MemoryVariableView({ initial: { chapter: { pattern: 'token', replacement: '替换' } } })
  const result = evaluateRule(compiled('literal:token-token##{{pattern}}##{{replacement}}'), context('', variables))
  assert.equal(result.status, 'success')
  assert.equal(result.value, '替换-替换')
})

test('解析器和脚本模式只报告能力缺失，不静默降级为文本', () => {
  const rule = compiled('@CSS:div.book')
  assert.deepEqual(inspectRuleCapabilities(rule), ['text', 'variables', 'parser:html'])
  const result = evaluateRule(rule, context('<div class="book">x</div>'))
  assert.equal(result.status, 'capability-missing')
  assert.equal(result.diagnostics[0]?.code, 'capability-unavailable')
  const mixed = compileRule('tag.a@text<js>result</js>')
  assert.deepEqual(mixed.diagnostics, [])
  assert.ok(mixed.rule?.capabilities.includes('parser:html'))
  assert.ok(mixed.rule?.capabilities.includes('javascript'))
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

test('Java 正则的常见边界、引用块和占有量词进入受控转换', () => {
  const quoted = compileSourcePattern(String.raw`\Q[a-z]+\E`, { flags: 'g' })
  assert.ok('regex' in quoted)
  assert.equal('regex' in quoted ? quoted.regex.test('[a-z]+') : false, true)
  const inline = compileSourcePattern('(?i)^abc$', { flags: '' })
  assert.ok('regex' in inline)
  assert.equal('regex' in inline ? inline.regex.test('ABC') : false, true)
  const inlineDisabled = compileSourcePattern('(?i-m)^abc$', { flags: 'm' })
  assert.ok('regex' in inlineDisabled)
  assert.equal('regex' in inlineDisabled ? inlineDisabled.regex.flags.includes('i') : false, true)
  assert.equal('regex' in inlineDisabled ? inlineDisabled.regex.flags.includes('m') : true, false)
  const possessive = compileSourcePattern('a++b', { flags: '' })
  assert.ok('regex' in possessive)
  assert.equal('regex' in possessive ? possessive.regex.test('aaab') : false, true)
  assert.equal('regex' in possessive ? possessive.regex.test('aaac') : true, false)
  const boundedPossessive = compileSourcePattern('^a{1,3}+b$', { flags: '' })
  assert.ok('regex' in boundedPossessive)
  assert.equal('regex' in boundedPossessive ? boundedPossessive.regex.test('aaab') : false, true)
  const boundedNoBacktrack = compileSourcePattern('^a{1,3}+ab$', { flags: '' })
  assert.ok('regex' in boundedNoBacktrack)
  assert.equal('regex' in boundedNoBacktrack ? boundedNoBacktrack.regex.test('aaab') : true, false)
  const classPossessive = compileSourcePattern('[ab]++c', { flags: '' })
  assert.ok('regex' in classPossessive)
  assert.equal('regex' in classPossessive ? classPossessive.regex.test('aaac') : false, true)
  const escapedPossessive = compileSourcePattern(String.raw`\d++X`, { flags: '' })
  assert.ok('regex' in escapedPossessive)
  assert.equal('regex' in escapedPossessive ? escapedPossessive.regex.test('123X') : false, true)
  const zeroWidthPossessive = compileSourcePattern(String.raw`\b++`, { flags: '' })
  assert.equal('error' in zeroWidthPossessive ? zeroWidthPossessive.error.code : 'regex', 'unsupported-pattern')
  const groupPossessive = compileSourcePattern('(?:a)++b', { flags: '' })
  assert.equal('error' in groupPossessive ? groupPossessive.error.code : 'regex', 'unsupported-pattern')
  const repeatedPossessive = compileSourcePattern('a++?', { flags: '' })
  assert.equal('error' in repeatedPossessive ? repeatedPossessive.error.code : 'regex', 'invalid-pattern')
  const atomic = compileSourcePattern('(?>a+)b', { flags: '' })
  assert.ok('regex' in atomic)
  assert.equal('regex' in atomic ? atomic.regex.test('aaab') : false, true)
  assert.equal('regex' in atomic ? atomic.regex.test('aaac') : true, false)
  const atomicClass = compileSourcePattern('(?>[ab]+)c', { flags: '' })
  assert.ok('regex' in atomicClass)
  assert.equal('regex' in atomicClass ? atomicClass.regex.test('aaac') : false, true)
  const atomicLazy = compileSourcePattern('(?>a+?)b', { flags: '' })
  assert.equal('error' in atomicLazy ? atomicLazy.error.code : 'regex', 'unsupported-pattern')
  const atomicComplex = compileSourcePattern('(?>ab|a)b', { flags: '' })
  assert.equal('error' in atomicComplex ? atomicComplex.error.code : 'regex', 'unsupported-pattern')
  const subtraction = compileSourcePattern('^[a-z&&[^b]]+$', { flags: '' })
  assert.ok('regex' in subtraction)
  assert.equal('regex' in subtraction ? subtraction.regex.test('acd') : false, true)
  assert.equal('regex' in subtraction ? subtraction.regex.test('bad') : true, false)
  const intersection = compileSourcePattern('^[a-z&&[def]]+$', { flags: '' })
  assert.ok('regex' in intersection)
  assert.equal('regex' in intersection ? intersection.regex.test('def') : false, true)
  assert.equal('regex' in intersection ? intersection.regex.test('abc') : true, false)
  const chained = compileSourcePattern('^[a-z&&[^b]&&[a-c]]+$', { flags: '' })
  assert.ok('regex' in chained)
  assert.equal('regex' in chained ? chained.regex.test('ac') : false, true)
  assert.equal('regex' in chained ? chained.regex.test('bd') : true, false)
  const unsupported = compileSourcePattern('[a-z&&b]', { flags: '' })
  assert.equal('error' in unsupported ? unsupported.error.code : 'regex', 'unsupported-pattern')
})

test('Java 正则 POSIX/Unicode 属性映射到受控 ECMAScript 属性转义', () => {
  const lower = compileSourcePattern(String.raw`\p{Lower}+`, { flags: '' })
  assert.ok('regex' in lower)
  assert.equal('regex' in lower ? lower.regex.test('abc') : false, true)
  assert.equal('regex' in lower ? lower.regex.test('中文') : true, false)

  const alpha = compileSourcePattern(String.raw`\p{Alpha}+`, { flags: '' })
  assert.ok('regex' in alpha)
  assert.equal('regex' in alpha ? alpha.regex.test('中文') : false, true)

  const unicodeFlag = compileSourcePattern('(?U)\\p{javaWhitespace}+', { flags: '' })
  assert.ok('regex' in unicodeFlag)
  assert.equal('regex' in unicodeFlag ? unicodeFlag.regex.test('  ') : false, true)

  const unsupported = compileSourcePattern(String.raw`\C`, { flags: '' })
  assert.equal('error' in unsupported ? unsupported.error.code : 'regex', 'unsupported-pattern')
  const unsupportedFlag = compileSourcePattern('abc', { flags: 'U' })
  assert.equal('error' in unsupportedFlag ? unsupportedFlag.error.code : 'regex', 'unsupported-pattern')
})

test('Java 正则作用域 flags 展开 i/m/s 并保留嵌套禁用语义', () => {
  const scopedCase = compileSourcePattern('(?i:abc)-(?-i:DEF)', { flags: '' })
  assert.ok('regex' in scopedCase)
  assert.equal('regex' in scopedCase ? scopedCase.regex.test('AbC-DEF') : false, true)
  assert.equal('regex' in scopedCase ? scopedCase.regex.test('AbC-def') : true, false)

  const inheritedCase = compileSourcePattern('a(?-i:b)c', { flags: 'i' })
  assert.ok('regex' in inheritedCase)
  assert.equal('regex' in inheritedCase ? inheritedCase.regex.test('AbC') : false, true)
  assert.equal('regex' in inheritedCase ? inheritedCase.regex.test('ABC') : true, false)

  const scopedClass = compileSourcePattern('(?i:[a-z]+)', { flags: '' })
  assert.ok('regex' in scopedClass)
  assert.equal('regex' in scopedClass ? scopedClass.regex.test('AbZ') : false, true)

  const scopedDot = compileSourcePattern('a(?s:.)b', { flags: '' })
  assert.ok('regex' in scopedDot)
  assert.equal('regex' in scopedDot ? scopedDot.regex.test('a\nb') : false, true)

  const scopedAnchor = compileSourcePattern('(?m:^foo$)', { flags: '' })
  assert.ok('regex' in scopedAnchor)
  assert.equal('regex' in scopedAnchor ? scopedAnchor.regex.test('before\nfoo\nafter') : false, true)

  const nested = compileSourcePattern('(?i:ab(?-i:CD)(?s:.))', { flags: '' })
  assert.ok('regex' in nested)
  assert.equal('regex' in nested ? nested.regex.test('ABCD\n') : false, true)

  const unsupportedScoped = compileSourcePattern('(?x:^ a $)', { flags: '' })
  assert.equal('error' in unsupportedScoped ? unsupportedScoped.error.code : 'regex', 'regex')
  assert.equal('regex' in unsupportedScoped ? unsupportedScoped.regex.test('a') : false, true)
  assert.equal('regex' in unsupportedScoped ? unsupportedScoped.regex.test(' a ') : true, false)

  const comments = compileSourcePattern('(?x:a # ignored\n b)', { flags: '' })
  assert.ok('regex' in comments)
  assert.equal('regex' in comments ? comments.regex.test('ab') : false, true)
  const swallowedGroup = compileSourcePattern('(?x:a# ignored)', { flags: '' })
  assert.equal('error' in swallowedGroup ? swallowedGroup.error.code : 'regex', 'invalid-pattern')

  const globalComments = compileSourcePattern('(?x)^ a # ignored\n b $', { flags: '' })
  assert.ok('regex' in globalComments)
  assert.equal('regex' in globalComments ? globalComments.regex.test('ab') : false, true)

  const classComments = compileSourcePattern('(?x:[a # ignored\n b])', { flags: '' })
  assert.ok('regex' in classComments)
  assert.equal('regex' in classComments ? classComments.regex.test('a') : false, true)
  assert.equal('regex' in classComments ? classComments.regex.test('b') : false, true)
  assert.equal('regex' in classComments ? classComments.regex.test(' ') : true, false)

  const escaped = compileSourcePattern('(?x:a\\ b\\#c)', { flags: '' })
  assert.ok('regex' in escaped)
  assert.equal('regex' in escaped ? escaped.regex.test('a b#c') : false, true)

  const disabled = compileSourcePattern('(?x:a(?-x: b )c)', { flags: '' })
  assert.ok('regex' in disabled)
  assert.equal('regex' in disabled ? disabled.regex.test('a b c') : false, true)
  assert.equal('regex' in disabled ? disabled.regex.test('abc') : true, false)

  const unsupportedScopedFlag = compileSourcePattern('(?d: a )', { flags: '' })
  assert.equal('error' in unsupportedScopedFlag ? unsupportedScopedFlag.error.code : 'regex', 'unsupported-pattern')
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

test('组合规则的最终输出也遵守 UTF-8 字节预算', () => {
  assert.equal(evaluateRule(compiled('literal:abc'), context(''), { maxOutputBytes: 3 }).status, 'success')
  assert.equal(evaluateRule(compiled('literal:中文'), context(''), { maxOutputBytes: 5 }).status, 'budget-exceeded')

  const chunk = 'x'.repeat(200_000)
  const joined = evaluateRule(compiled(`literal:${chunk}&&literal:${chunk}`), context(''), { maxOutputBytes: 300_000 })
  assert.equal(joined.status, 'budget-exceeded')
  const interleaved = evaluateRule(compiled(`literal:${chunk}%%literal:${chunk}`), context(''), { maxOutputBytes: 300_000 })
  assert.equal(interleaved.status, 'budget-exceeded')
})
