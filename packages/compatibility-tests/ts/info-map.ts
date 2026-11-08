import { discoverBooks, executeExploreAction, parseExploreKinds } from '../../source-core/src/index.ts'
import type { NormalizedSource } from '../../source-core/src/index.ts'
import { createNodeSourceSession } from '../../source-node/src/source-session.ts'
import { FlowFixtureError } from './book-flow.ts'

export async function executeInfoMap(input: Record<string, unknown>) {
  const source: NormalizedSource = {
    bookSourceUrl: 'https://infomap.fixture.invalid', bookSourceName: '发现状态夹具',
    exploreUrl: `@js:JSON.stringify([{title: 'fixture', url: (${String(input.category)})}])`,
    ruleExplore: { bookList: 'a', name: 'text', bookUrl: 'href' },
  }
  const initial = input.initial as Record<string, string>
  const requests: string[] = []
  const session = createNodeSourceSession(source, {
    network: { request: async (plan) => {
      requests.push(plan.url)
      return { url: plan.url, status: 200, headers: {}, bytes: Buffer.from('<a href="/book">fixture</a>'), redirected: false }
    } },
  })
  try {
    return await session.run(async (ports) => {
      const result = await executeExploreAction(ports, source, String(input.action), { infoMap: initial })
      if (result.diagnostics.length !== 0) throw new FlowFixtureError(JSON.stringify(result.diagnostics))
      const request = result.saveRequest
      const needSave = request?.now === false && request.need
      // 这里仅按保存意图重放快照。实际租约与过期恢复由 reader-web 测试执行。
      const beforeCommit = request?.now === true ? request.infoMap : initial
      const afterCommit = needSave ? result.infoMap : beforeCommit
      const savedSeconds = needSave || request?.now === true ? request!.time : 0
      const categories = await parseExploreKinds(ports, source, { infoMap: result.infoMap })
      const url = categories.kinds[0]?.url
      if (!url) throw new FlowFixtureError('缺少发现分类地址')
      const page = await discoverBooks(ports, { source, url, infoMap: result.infoMap })
      if (page.status !== 'success' || requests.length !== 1) throw new FlowFixtureError('发现请求轨迹无效')
      return {
        live: result.infoMap, beforeCommit, needSave, afterCommit, beforeExpiry: afterCommit,
        afterExpiry: savedSeconds > 0 ? {} : afterCommit, savedSeconds, requestUrl: requests[0],
      }
    })
  } finally {
    session.close()
  }
}
