import {
  discoverBooks, importSources, loadBookDetails, loadChapterContent, loadTableOfContents, nextChapterUrlFor, searchBooks,
} from '../../source-core/src/index.ts'
import type { BookCandidate, RuntimeResult, WorkflowPage } from '../../source-core/src/index.ts'
import { createNodeSourceSession } from '../../source-node/src/source-session.ts'
import { FlowFixtureError } from './book-flow.ts'

interface MainJsResponse {
  method: string
  url: string
  body: string | null
  response: { status: number; url: string; headers: Record<string, string>; base64: string }
}

export async function executeMainJsFlow(input: Record<string, unknown>) {
  const source = (await importSources(JSON.stringify(input.source)))[0]?.source
  if (!source) throw new FlowFixtureError('整源 JS 夹具无法导入')
  const responses = Object.values(input.responses as Record<string, MainJsResponse>)
  const requests: unknown[] = []
  const stages: Record<string, unknown> = {}
  const output = { stages, requests }
  let fault: FlowFixtureError | undefined
  const session = createNodeSourceSession(source, {
    network: { request: async (plan) => {
      const match = responses.filter((fixture) => fixture.method === plan.method && fixture.url === plan.url
        && fixture.body === (plan.body ?? null))
      if (match.length !== 1 || requests.length >= Number(input.requestLimit)) {
        fault ??= new FlowFixtureError(`整源 JS 缺少请求夹具: ${plan.method} ${plan.url}`)
        throw fault
      }
      const { response } = match[0]!
      requests.push({ method: plan.method, url: plan.url })
      return { ...response, bytes: Buffer.from(response.base64, 'base64'), redirected: response.url !== plan.url }
    } },
  })
  const variables = (value: string | undefined) => value === undefined ? null : JSON.parse(value)
  function stage(name: string, status: string, value: unknown) {
    if (fault) throw fault
    stages[name] = { status, value }
  }
  try {
    return await session.run(async (ports) => {
      const search = await searchBooks(ports, { source, keyword: String(input.keyword) })
      // Android 返回书籍列表。保留交付的条目和继续条件，TS 额外诊断由本端回归验证。
      function delivered(name: string, result: RuntimeResult<WorkflowPage<BookCandidate>>) {
        stage(name, result.value?.items.length ? 'delivered' : result.status, result.value?.items.map((book) => {
          const value: Record<string, unknown> = {
            name: book.name, bookUrl: book.bookUrl, type: book.type, variable: book.variable ?? null,
          }
          if (input.searchBookEvidence === true) Object.assign(value, {
            author: book.author ?? '', kind: book.kind ?? null, intro: book.intro ?? null,
            coverUrl: book.coverUrl ?? null, wordCount: book.wordCount ?? null,
            latestChapterTitle: book.lastChapter ?? null, tocUrl: book.tocUrl ?? '',
          })
          return value
        }) ?? null)
      }
      delivered('search', search)
      const first = search.value?.items[0]
      if (!first) return output
      const found = await discoverBooks(ports, { source, url: '/category' })
      delivered('discover', found)
      if (!found.value) return output
      const detail = await loadBookDetails(ports, { source, candidates: [first], canReName: false })
      const book = detail.value?.items[0]
      stage('detail', detail.status, book ? {
        name: book.name, bookUrl: book.bookUrl, tocUrl: book.tocUrl, type: book.type, intro: book.intro ?? null,
        variable: variables(book.variable),
      } : null)
      if (!book) return output
      const toc = await loadTableOfContents(ports, { source, book })
      const chapters = toc.value?.items
      stage('toc', toc.status, chapters?.map((chapter) => ({
        title: chapter.title, url: chapter.url, index: chapter.index,
        volume: chapter.isVolume === true, vip: chapter.isVip === true, pay: chapter.isPay === true,
      })) ?? null)
      if (!chapters) return output
      const chapter = chapters[Number(input.chapterIndex)]
      if (!chapter) throw new FlowFixtureError('整源 JS 缺少指定章节')
      const nextChapterUrl = nextChapterUrlFor(chapters, chapter)
      const content = await loadChapterContent(ports, {
        source, book: toc.value?.bookAfter ?? book, chapter, ...(nextChapterUrl === undefined ? {} : { nextChapterUrl }),
      })
      stage('content', content.status, content.value?.raw ?? null)
      return { ...output, variableAfterContent: variables((toc.value?.bookAfter ?? book).variable) }
    })
  } finally {
    session.close()
  }
}
