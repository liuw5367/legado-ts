import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverBooks, loadBookDetails, searchBooks } from '../src/public/index.ts'
import type { BookCandidate, NormalizedSource, WorkflowPorts } from '../src/public/index.ts'

const source = {
  bookSourceUrl: 'https://source.test',
  bookSourceName: 'Source',
  exploreUrl: '/explore?page={{page}}',
  searchUrl: '/search?q={{keyword}}&page={{page}}',
  explorePageStart: 1,
  ruleExplore: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', nextPage: 'next' },
  ruleSearch: { bookList: 'list', bookName: 'name', bookUrl: 'url' },
  ruleBookInfo: { name: 'detail-name', author: 'detail-author', intro: 'detail-intro', tocUrl: 'detail-toc' },
} as unknown as NormalizedSource

function ports(calls: string[]): WorkflowPorts {
  return {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode(plan.url), redirected: false }
      },
    },
    rules: {
      evaluate: async ({ rule, content, stage }) => {
        if (rule === 'list') return { status: 'success', value: stage === 'search' ? [{ name: 'Search A', url: '/book/search' }] : [{ name: 'A', url: '/book/a', author: 'Author' }, { name: 'A duplicate', url: '/book/a', author: 'Author' }, { name: 'No URL' }] }
        if (rule === 'next') return { status: 'success', value: 'next-token' }
        if (rule === 'name') return { status: 'success', value: (content as { name?: string }).name }
        if (rule === 'url') return { status: 'success', value: (content as { url?: string }).url }
        if (rule === 'author') return { status: 'success', value: (content as { author?: string }).author }
        if (rule === 'detail-name') return { status: 'success', value: 'A detail' }
        if (rule === 'detail-author') return { status: 'empty', value: '' }
        if (rule === 'detail-intro') return { status: 'failed', value: null, message: 'detail parser failed' }
        if (rule === 'detail-toc') return { status: 'success', value: '/toc/a' }
        return { status: 'empty', value: null }
      },
    },
  }
}

test('发现工作流保留书源内身份、页码起点、去重和 partial 诊断', async () => {
  const calls: string[] = []
  const result = await discoverBooks(ports(calls), { source })
  const items = result.value?.items ?? []
  // 两条候选：同地址的第二条按 Android SearchBook.equals（只比 bookUrl）折叠；
  // 缺少地址规则的候选按 isUrl 语义回退为响应地址，不再被丢弃。
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    sourceId: 'https://source.test',
    bookUrl: 'https://source.test/book/a',
    name: 'A',
    author: 'Author',
    rawFields: { name: 'A', bookUrl: '/book/a', author: 'Author' },
    traceRef: 'discover:0',
  })
  assert.equal(items[1]?.name, 'No URL')
  assert.equal(items[1]?.bookUrl, 'https://source.test/explore?page=1')
  assert.equal(result.value?.cursor.index, 1)
  assert.equal(result.value?.nextCursor?.token, 'next-token')
  assert.equal(result.status, 'success')
  assert.equal(calls[0], 'https://source.test/explore?page=1')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-item'))
  assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === 'identity-missing'))
})

test('搜索工作流按 Android 首页页码展开关键词并区分空关键词', async () => {
  const calls: string[] = []
  const result = await searchBooks(ports(calls), { source, keyword: '中文 test' })
  assert.equal(result.status, 'success')
  // {{keyword}} 注入原值，非 ASCII 由请求层编码；首页页码与 Android SearchModel 一致从 1 开始。
  assert.equal(calls[0], 'https://source.test/search?q=%E4%B8%AD%E6%96%87%20test&page=1')

  const empty = await searchBooks(ports(calls), { source, keyword: '' })
  assert.equal(empty.status, 'empty')
  assert.equal(calls.length, 1)
})

test('搜索和详情工作流保留最新章节与更新时间字段', async () => {
  const calls: string[] = []
  const latestSource = {
    ...source,
    ruleSearch: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookLastChapter: 'last-chapter', bookUpdateTime: 'updated-at' },
    ruleBookInfo: { name: 'detail-name', author: 'detail-author', intro: 'detail-intro', tocUrl: 'detail-toc', lastChapter: 'detail-last-chapter', updateTime: 'detail-updated-at' },
  } as unknown as NormalizedSource
  const base = ports(calls)
  base.rules = {
    evaluate: async (request) => {
      if (request.rule === 'last-chapter') return { status: 'success', value: '列表最新章' }
      if (request.rule === 'updated-at') return { status: 'success', value: '2026-09-22' }
      if (request.rule === 'detail-last-chapter') return { status: 'success', value: '详情最新章' }
      if (request.rule === 'detail-updated-at') return { status: 'success', value: '2026-09-23' }
      return ports(calls).rules.evaluate(request)
    },
  }
  const searched = await searchBooks(base, { source: latestSource, keyword: '中文' })
  assert.equal(searched.value?.items[0]?.lastChapter, '列表最新章')
  assert.equal(searched.value?.items[0]?.updateTime, '2026-09-22')
  const detailed = await loadBookDetails(base, { source: latestSource, candidates: [searched.value!.items[0]!] })
  assert.equal(detailed.value?.items[0]?.lastChapter, '详情最新章')
  assert.equal(detailed.value?.items[0]?.updateTime, '2026-09-23')
})

test('搜索 URL 模板支持书源地址和安全页码算术表达式', async () => {
  const calls: string[] = []
  const templated = { ...source, searchPageStart: 1, searchUrl: '/search?start={{(page-1)*10}}&source={{source.bookSourceUrl}}&q={{key}}' } as unknown as NormalizedSource
  const result = await searchBooks(ports(calls), { source: templated, keyword: '中文' })
  assert.equal(result.status, 'success')
  assert.equal(calls[0], 'https://source.test/search?start=0&source=https://source.test&q=%E4%B8%AD%E6%96%87')
})

test('详情工作流只覆盖有值字段，记录明确空值和字段失败', async () => {
  const calls: string[] = []
  const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl: '/book/a', name: 'A', rawFields: { name: 'A', bookUrl: '/book/a' }, traceRef: 'discover:0' }
  const result = await loadBookDetails(ports(calls), { source, candidates: [candidate] })
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.items[0]?.name, 'A detail')
  assert.deepEqual(result.value?.items[0]?.emptyFields, ['author'])
  assert.equal(result.value?.items[0]?.fieldErrors.intro, 'detail parser failed')
  assert.equal(result.value?.items[0]?.tocUrl, 'https://source.test/toc/a')
  assert.equal(calls[0], 'https://source.test/book/a')
})

test('空目录规则回退详情响应地址并保留同页内容', async () => {
  const calls: string[] = []
  const emptyTocSource = {
    ...source,
    ruleBookInfo: { name: 'detail-name', tocUrl: '' },
  } as unknown as NormalizedSource
  const workflowPorts = ports(calls)
  workflowPorts.network = {
    request: async (plan) => {
      calls.push(plan.url)
      return { url: 'https://redirect.test/book/a', status: 200, headers: {}, bytes: new TextEncoder().encode('<div class="chapters">toc</div>'), redirected: true }
    },
  }
  const evaluated: string[] = []
  const baseEvaluate = workflowPorts.rules.evaluate
  workflowPorts.rules = {
    evaluate: async (request) => {
      evaluated.push(request.rule)
      return baseEvaluate(request)
    },
  }
  const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl: '/book/a', name: 'A', rawFields: {}, traceRef: 'search:0' }
  const result = await loadBookDetails(workflowPorts, { source: emptyTocSource, candidates: [candidate] })
  assert.equal(result.value?.items[0]?.tocUrl, 'https://redirect.test/book/a')
  assert.equal(result.value?.items[0]?.tocHtml, '<div class="chapters">toc</div>')
  assert.equal(evaluated.includes(''), false)
})

test('目录地址规则误返回 HTML 时回退详情响应地址', async () => {
  const calls: string[] = []
  const workflowPorts = ports(calls)
  const baseEvaluate = workflowPorts.rules.evaluate
  workflowPorts.rules = {
    evaluate: async (request) => request.rule === 'detail-toc'
      ? { status: 'success', value: '<!doctype html><html></html>' }
      : baseEvaluate(request),
  }
  const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl: '/book/a', name: 'A', rawFields: {}, traceRef: 'search:0' }
  const result = await loadBookDetails(workflowPorts, { source, candidates: [candidate] })
  assert.equal(result.value?.items[0]?.tocUrl, 'https://source.test/book/a')
  assert.equal(result.value?.items[0]?.tocHtml, 'https://source.test/book/a')
})

test('工作流取消不会继续发起下一次请求', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  controller.abort()
  const result = await discoverBooks(ports(calls), { source, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(calls.length, 0)
})

test('列表字段规则执行期间取消会返回 cancelled', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const workflowPorts = ports(calls)
  workflowPorts.rules = {
    evaluate: async (request) => {
      if (request.field === 'bookName') controller.abort()
      return { status: 'cancelled', value: null }
    },
  }
  const result = await discoverBooks(workflowPorts, { source, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'cancelled'))
})

test('URL 表达式求值被取消时保持 cancelled，不折叠成 failed', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const workflowPorts = ports(calls)
  workflowPorts.rules = {
    evaluate: async () => {
      controller.abort()
      return { status: 'cancelled', value: null, message: '规则已取消' }
    },
  }
  const templated = { ...source, searchUrl: '/search?q={{java.ajax("x")}}' } as unknown as NormalizedSource
  const result = await searchBooks(workflowPorts, { source: templated, keyword: 'A', signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'cancelled'))
  assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === 'rule-failed'))
  assert.equal(calls.length, 0)
})

test('详情页回退解析被取消时保持 cancelled，不折叠成 empty', async () => {
  const controller = new AbortController()
  const fallbackSource = { ...source, searchUrl: '/book/empty' } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      if (request.field === 'bookList') return { status: 'empty', value: null }
      if (request.field === 'name') {
        controller.abort()
        return { status: 'cancelled', value: null }
      }
      return { status: 'empty', value: null }
    },
  }
  const result = await searchBooks(workflowPorts, { source: fallbackSource, keyword: 'A', signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'cancelled'))
})

test('explore 空列表在已配置 bookUrlPattern 时不再回退详情页', async () => {
  const evaluated: string[] = []
  const patterned = { ...source, bookUrlPattern: 'https://other\\.test/.*' } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      evaluated.push(request.rule)
      if (request.field === 'bookList') return { status: 'empty', value: null }
      return ports([]).rules.evaluate(request)
    },
  }
  const result = await discoverBooks(workflowPorts, { source: patterned })
  assert.equal(result.status, 'empty')
  assert.equal(result.value?.items.length, 0)
  assert.ok(!evaluated.includes('detail-name'))
})

test('没有页码占位符的列表地址不产生下一页游标', async () => {
  const fixedSource = {
    ...source,
    exploreUrl: '/explore',
    ruleExplore: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author' },
  } as unknown as NormalizedSource
  const fixed = await discoverBooks(ports([]), { source: fixedSource })
  assert.equal(fixed.value?.nextCursor, undefined)

  // nextPage 规则命中时游标由规则决定，与地址模板无关。
  const withNextPage = {
    ...fixedSource,
    ruleExplore: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', nextPage: 'next' },
  } as unknown as NormalizedSource
  const ruleDriven = await discoverBooks(ports([]), { source: withNextPage })
  assert.equal(ruleDriven.value?.nextCursor?.index, 2)
  assert.equal(ruleDriven.value?.nextCursor?.token, 'next-token')

  // 地址模板引用页码时按页递增。
  const templated = { ...fixedSource, exploreUrl: '/explore?page={{page}}' } as unknown as NormalizedSource
  const pageDriven = await discoverBooks(ports([]), { source: templated })
  assert.equal(pageDriven.value?.nextCursor?.index, 2)
  assert.equal(pageDriven.value?.nextCursor?.token, undefined)
})

test('URL 内联表达式数量超过上限时以配置诊断失败，且不求值', async () => {
  const calls: string[] = []
  let evaluations = 0
  const workflowPorts = ports(calls)
  workflowPorts.rules = { evaluate: async () => { evaluations += 1; return { status: 'empty', value: null } } }
  const overLimit = Array.from({ length: 2049 }, (_, index) => `{{x${index}}}`).join('')
  const templated = { ...source, searchUrl: `/search?q=${overLimit}` } as unknown as NormalizedSource
  const result = await searchBooks(workflowPorts, { source: templated, keyword: 'A' })
  assert.equal(result.status, 'failed')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-config'))
  assert.equal(evaluations, 0)
  assert.equal(calls.length, 0)

  // 真实语料里数百个页码算术表达式仍走快速路径，不触发上限、不进 JS。
  const numeric = Array.from({ length: 400 }, (_, index) => `{{page*${index + 1}}}`).join('&p=')
  const manyNumeric = { ...source, searchUrl: `/search?q={{keyword}}&p=${numeric}` } as unknown as NormalizedSource
  const expanded = await searchBooks(ports(calls), { source: manyNumeric, keyword: 'A' })
  assert.equal(expanded.status, 'success')
  assert.ok(calls[0]?.includes('p=1&p=2&p=3'))
})

test('深嵌套数值表达式不再抛出逃逸异常', async () => {
  const deep = `${'('.repeat(5000)}page${')'.repeat(5000)}`
  const templated = { ...source, searchUrl: `/search?q={{${deep}}}` } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = { evaluate: async () => ({ status: 'failed', value: null, message: '表达式无法求值' }) }
  const result = await searchBooks(workflowPorts, { source: templated, keyword: 'A' })
  assert.equal(result.status, 'failed')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'rule-failed'))
})

test('病态或超长 bookUrlPattern 被守卫拒绝并给出诊断', async () => {
  const evaluated: string[] = []
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      evaluated.push(request.rule)
      return ports([]).rules.evaluate(request)
    },
  }
  const started = Date.now()
  const pathological = { ...source, searchUrl: '/book/one', bookUrlPattern: '(a+)+$' } as unknown as NormalizedSource
  const result = await searchBooks(workflowPorts, { source: pathological, keyword: 'A' })
  // 命中守卫按「不匹配」处理，仍走列表解析；旧版在这里会做指数级回溯。
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-config' && diagnostic.field === 'bookUrlPattern'))
  assert.ok(evaluated.includes('list'))
  assert.ok(Date.now() - started < 1000)

  const oversized = { ...source, searchUrl: '/book/one', bookUrlPattern: 'x'.repeat(3000) } as unknown as NormalizedSource
  const long = await searchBooks(workflowPorts, { source: oversized, keyword: 'A' })
  assert.ok(long.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-config' && diagnostic.message.includes('长度上限')))

  // 正常 pattern 不受影响：命中时仍整页按详情页解析。
  const normal = { ...source, searchUrl: '/book/one', bookUrlPattern: 'https://source\\.test/book/.*' } as unknown as NormalizedSource
  const matched = await searchBooks(workflowPorts, { source: normal, keyword: 'A' })
  assert.equal(matched.value?.items[0]?.name, 'A detail')
})

test('列表规则 - 前缀反转、+ 前缀只剥离（Android BookList 语义）', async () => {
  const reversedSource = { ...source, ruleExplore: { bookList: '-list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', nextPage: 'next' } } as unknown as NormalizedSource
  const reversed = await discoverBooks(ports([]), { source: reversedSource })
  assert.deepEqual(reversed.value?.items.map((item) => item.name), ['No URL', 'A'])

  const strippedSource = { ...source, ruleExplore: { bookList: '+list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', nextPage: 'next' } } as unknown as NormalizedSource
  const stripped = await discoverBooks(ports([]), { source: strippedSource })
  assert.deepEqual(stripped.value?.items.map((item) => item.name), ['A', 'No URL'])
  assert.equal(stripped.status, 'success')
})

test('搜索响应命中 bookUrlPattern 时整页按详情页解析', async () => {
  const evaluated: string[] = []
  const base = ports([])
  base.rules = {
    evaluate: async (request) => {
      evaluated.push(request.rule)
      return ports([]).rules.evaluate(request)
    },
  }
  const patterned = { ...source, searchUrl: '/book/one', bookUrlPattern: 'https://source\\.test/book/.*' } as unknown as NormalizedSource
  const result = await searchBooks(base, { source: patterned, keyword: 'A' })
  // 详情解析里 detail-intro 规则失败，按字段级诊断返回 partial。
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.items.length, 1)
  assert.equal(result.value?.items[0]?.name, 'A detail')
  assert.equal(result.value?.items[0]?.bookUrl, 'https://source.test/book/one')
  assert.ok(!evaluated.includes('list'))
})

test('列表为空且没有 bookUrlPattern 时回退详情页解析', async () => {
  const fallbackSource = { ...source, searchUrl: '/book/empty' } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      if (request.field === 'bookList') return { status: 'empty', value: null }
      return ports([]).rules.evaluate(request)
    },
  }
  const result = await searchBooks(workflowPorts, { source: fallbackSource, keyword: 'A' })
  assert.equal(result.status, 'partial')
  assert.equal(result.value?.items[0]?.name, 'A detail')
  assert.equal(result.value?.items[0]?.bookUrl, 'https://source.test/book/empty')

  // bookUrlPattern 存在但不匹配时不再回退。
  const patterned = { ...fallbackSource, bookUrlPattern: 'https://other\\.test/.*' } as unknown as NormalizedSource
  const noFallback = await searchBooks(workflowPorts, { source: patterned, keyword: 'A' })
  assert.equal(noFallback.status, 'empty')
  assert.equal(noFallback.value?.items.length, 0)
})

test('候选缺少书名时按身份缺失丢弃并给出正例诊断', async () => {
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      if (request.field === 'bookList') return { status: 'success', value: [{ name: '有书名', url: '/book/a' }, { name: '   ', url: '/book/b' }] }
      if (request.field === 'bookName') return { status: 'success', value: (request.content as { name: string }).name }
      if (request.field === 'bookUrl') return { status: 'success', value: (request.content as { url: string }).url }
      return { status: 'empty', value: null }
    },
  }
  const result = await discoverBooks(workflowPorts, { source })
  // 正例：书名清洗后为空的那条被丢弃并报告身份缺失，另一条保留。
  assert.deepEqual(result.value?.items.map((item) => item.name), ['有书名'])
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'identity-missing' && diagnostic.message.includes('书名')))
})

test('搜索字段解析分类、字数并清洗书名作者', async () => {
  const richSource = {
    ...source,
    ruleSearch: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', bookKind: 'kind', bookWordCount: 'words' },
  } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      if (request.rule === 'list') return { status: 'success', value: [{ name: '我本无意成仙 作者：张三', url: '/book/a', author: ' 张三 著', kind: ['玄幻', '仙侠'], words: '1234567' }] }
      if (request.rule === 'name') return { status: 'success', value: (request.content as { name: string }).name }
      if (request.rule === 'url') return { status: 'success', value: (request.content as { url: string }).url }
      if (request.rule === 'author') return { status: 'success', value: (request.content as { author: string }).author }
      if (request.rule === 'kind') return { status: 'success', value: (request.content as { kind: string[] }).kind }
      if (request.rule === 'words') return { status: 'success', value: (request.content as { words: string }).words }
      return { status: 'empty', value: null }
    },
  }
  const result = await searchBooks(workflowPorts, { source: richSource, keyword: 'A' })
  const candidate = result.value?.items[0]
  assert.equal(candidate?.name, '我本无意成仙')
  assert.equal(candidate?.author, '张三')
  assert.equal(candidate?.kind, '玄幻,仙侠')
  assert.equal(candidate?.wordCount, '123.5万字')
})

test('书名作者清洗用 Java 的 ASCII 空白，字数按 HALF_EVEN 舍入', async () => {
  const edgeSource = {
    ...source,
    ruleSearch: { bookList: 'list', bookName: 'name', bookUrl: 'url', bookAuthor: 'author', bookWordCount: 'words' },
  } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      const item = request.content as { name?: string; url?: string; author?: string; words?: string }
      if (request.field === 'bookList') {
        return {
          status: 'success',
          value: [
            // 全角空格（U+3000）：Java `\s` 不匹配，Android 不会清洗掉「作者」尾巴。
            { name: '我本无意成仙　作者：张三', url: '/book/full', words: '10500' },
            { name: '我本无意成仙 作者：张三', url: '/book/half', words: '10501' },
          ],
        }
      }
      if (request.field === 'bookName') return { status: 'success', value: item.name }
      if (request.field === 'bookUrl') return { status: 'success', value: item.url }
      if (request.field === 'bookWordCount') return { status: 'success', value: item.words }
      return { status: 'empty', value: null }
    },
  }
  const result = await searchBooks(workflowPorts, { source: edgeSource, keyword: 'A' })
  const items = result.value?.items ?? []
  assert.equal(items[0]?.name, '我本无意成仙　作者：张三')
  assert.equal(items[0]?.wordCount, '1万字')
  assert.equal(items[1]?.name, '我本无意成仙')
  // 10501 → 1.0501 → HALF_EVEN 到一位小数 → 1.1
  assert.equal(items[1]?.wordCount, '1.1万字')
})

test('详情 init 规则先执行并把结果作为后续字段的内容基准', async () => {
  const candidate: BookCandidate = { sourceId: source.bookSourceUrl, bookUrl: '/book/a', name: 'A', rawFields: {}, traceRef: 'discover:0' }
  const seen: Array<{ rule: string; content: unknown }> = []
  const initSource = { ...source, ruleBookInfo: { init: 'detail-init', name: 'detail-name', author: 'detail-author' } } as unknown as NormalizedSource
  const workflowPorts = ports([])
  workflowPorts.rules = {
    evaluate: async (request) => {
      seen.push({ rule: request.rule, content: request.content })
      if (request.rule === 'detail-init') return { status: 'success', value: { name: '子对象书名' } }
      if (request.rule === 'detail-name') return { status: 'success', value: (request.content as { name: string }).name }
      return { status: 'empty', value: null }
    },
  }
  const result = await loadBookDetails(workflowPorts, { source: initSource, candidates: [candidate] })
  assert.equal(result.status, 'success')
  assert.equal(result.value?.items[0]?.name, '子对象书名')
  const nameCall = seen.find((item) => item.rule === 'detail-name')
  assert.deepEqual(nameCall?.content, { name: '子对象书名' })
})
