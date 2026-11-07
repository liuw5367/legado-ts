import { loadChapterContent, type NetworkHost, type NormalizedSource } from '../../source-core/src/index.ts'
import { SourceRequestHost } from '../../source-node/src/source-request-host.ts'
import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'
import { FlowFixtureError } from './book-flow.ts'

export async function executeContentLifecycle(input: Record<string, unknown>) {
  const source: NormalizedSource = {
    bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'content-lifecycle', bookSourceType: 1,
    ruleContent: { content: '@js:result', subContent: `@js:${JSON.stringify(input.auxUrl)}`, title: `@js:${JSON.stringify(input.title)}` },
  }
  const chapterUrl = 'https://fixture.invalid/chapter'
  const controller = new AbortController()
  const requests: string[] = []
  let active = 0
  let titleEvaluated = false
  let fixtureFault: FlowFixtureError | undefined
  const network: NetworkHost = {
    request: async (plan) => {
      const chapter = plan.url === chapterUrl
      if (!chapter && plan.url !== input.auxUrl) {
        fixtureFault ??= new FlowFixtureError(`正文生命周期遇到未声明的请求: ${plan.url}`)
        throw fixtureFault
      }
      requests.push(chapter ? 'chapter' : 'lyrics')
      active++
      try {
        if (!chapter && input.fault === 'auxiliary-failure') throw new Error('离线副文请求失败')
        if (!chapter || input.fault === 'primary-cancel') {
          const signal = plan.budget.signal
          if (signal === undefined) {
            fixtureFault ??= new FlowFixtureError('离线请求没有收到取消信号')
            throw fixtureFault
          }
          const pending = new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          controller.abort()
          return await pending
        }
        return { url: plan.url, status: 200, headers: {}, bytes: Buffer.from(String(input.chapterBody)), redirected: false }
      } finally {
        active--
      }
    },
  }
  const request = new SourceRequestHost({ network })
  const rules = new SourceRuleHost()
  const result = await loadChapterContent({
    network,
    request: (item) => request.request(item),
    decodeResponse: (item) => request.decodeResponse(item),
    rules: {
      evaluate: async (item) => {
        if (item.field === 'title') titleEvaluated = true
        return rules.evaluate(item)
      },
    },
  }, {
    source, chapter: { sourceId: source.bookSourceUrl, bookUrl: 'https://fixture.invalid/book', chapterUrl, index: 0 },
    signal: controller.signal,
  })
  if (fixtureFault !== undefined) throw fixtureFault
  return {
    status: result.status,
    delivered: result.value?.cleaned ?? null,
    requests,
    active,
    titleEvaluated,
    auxiliarySaved: result.value?.auxiliary !== undefined,
    auxiliaryFailure: result.diagnostics.some(({ field, code }) => field === 'subContent' && (code === 'cancelled' || code === 'request-failed')),
  }
}
