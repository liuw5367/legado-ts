import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { importSources, loadBookDetails, loadChapterContent, loadTableOfContents, searchBooks } from '../../source-core/src/public/index.ts'
import type { NormalizedSource, WorkflowPorts } from '../../source-core/src/public/index.ts'

const sourceFile = new URL('../../../fixtures/source/collection/14328_c803e1b071690d18ce7acb5184727058.json', import.meta.url)

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as UnknownRecord
}

function hasRule(source: NormalizedSource, group: string, field: string): boolean {
  const value = record(source[group])[field]
  return typeof value === 'string' && value.length > 0
}

function supportsFlow(source: NormalizedSource): boolean {
  const searchUrl = source.searchUrl
  if (typeof searchUrl !== 'string' || searchUrl.length === 0) return false
  try {
    new URL(source.bookSourceUrl)
  } catch {
    return false
  }
  const requiredRules: Array<[string, string]> = [
    ['ruleSearch', 'bookList'],
    ['ruleSearch', 'name'],
    ['ruleSearch', 'author'],
    ['ruleSearch', 'bookUrl'],
    ['ruleBookInfo', 'name'],
    ['ruleBookInfo', 'author'],
    ['ruleBookInfo', 'intro'],
    ['ruleBookInfo', 'tocUrl'],
    ['ruleToc', 'chapterList'],
    ['ruleToc', 'chapterName'],
    ['ruleToc', 'chapterUrl'],
    ['ruleContent', 'content'],
  ]
  return requiredRules.every(([group, field]) => hasRule(source, group, field))
}

async function fixtureSources(): Promise<NormalizedSource[]> {
  const imported = await importSources(await readFile(sourceFile, 'utf8'))
  return imported.flatMap((candidate) => candidate.source === undefined ? [] : [candidate.source])
}

function flowPorts(calls: string[], rulesSeen: string[]): WorkflowPorts {
  return {
    network: {
      request: async (plan) => {
        calls.push(plan.url)
        return {
          url: plan.url,
          status: 200,
          headers: { 'content-type': 'application/json' },
          bytes: new TextEncoder().encode('{}'),
          redirected: false,
        }
      },
    },
    rules: {
      evaluate: async ({ source, field, rule }) => {
        assert.ok(rule.length > 0)
        rulesSeen.push(`${source.bookSourceUrl}:${field}`)
        if (field === 'bookList') return { status: 'success', value: [{ id: 'local-book' }] }
        if (field === 'bookName') return { status: 'success', value: `${source.bookSourceName} 本地测试书` }
        if (field === 'bookAuthor') return { status: 'success', value: '本地作者' }
        if (field === 'bookUrl') return { status: 'success', value: '/books/local-book' }
        if (field === 'bookIntro') return { status: 'success', value: '本地简介' }
        if (field === 'bookCoverUrl') return { status: 'success', value: '/images/local-book.jpg' }
        if (field === 'name') return { status: 'success', value: `${source.bookSourceName} 本地详情书` }
        if (field === 'author') return { status: 'success', value: '本地详情作者' }
        if (field === 'intro') return { status: 'success', value: '本地详情简介' }
        if (field === 'coverUrl') return { status: 'success', value: '/images/local-detail.jpg' }
        if (field === 'tocUrl') return { status: 'success', value: '/books/local-book/toc' }
        if (field === 'chapterList') return { status: 'success', value: [{ id: 'local-chapter' }] }
        if (field === 'chapterName') return { status: 'success', value: '第一章 本地测试' }
        if (field === 'chapterUrl') return { status: 'success', value: '/chapters/local-chapter' }
        if (field === 'content') return { status: 'success', value: '正文内容：书源文件流程测试通过。' }
        return { status: 'empty', value: null }
      },
    },
  }
}

test('07-B 真实书源文件可贯通解析、搜索、切换、详情、目录和正文', async () => {
  const sources = await fixtureSources()
  const sourceA = sources.find((source) => source.bookSourceName === '猫眼看书' && supportsFlow(source))
  const sourceB = sources.find((source) => source.bookSourceName === '笔趣阁成人版' && supportsFlow(source))
  if (sourceA === undefined || sourceB === undefined) throw new Error('真实书源 corpus 中至少需要两个可运行完整流程的书源')

  const calls: string[] = []
  const rulesSeen: string[] = []
  const ports = flowPorts(calls, rulesSeen)

  const firstSearch = await searchBooks(ports, { source: sourceA, keyword: '本地测试' })
  assert.equal(firstSearch.status, 'success')
  assert.equal(firstSearch.value?.items[0]?.sourceId, sourceA.bookSourceUrl)

  // “切换书源”在核心层体现为选择另一个 source 快照，并用它重新搜索/加载后续数据。
  const secondSearch = await searchBooks(ports, { source: sourceB, keyword: '本地测试' })
  assert.equal(secondSearch.status, 'success')
  assert.equal(secondSearch.value?.items[0]?.sourceId, sourceB.bookSourceUrl)
  assert.notEqual(firstSearch.value?.items[0]?.sourceId, secondSearch.value?.items[0]?.sourceId)

  const selected = secondSearch.value?.items[0]
  assert.ok(selected)
  const details = await loadBookDetails(ports, { source: sourceB, candidates: [selected] })
  assert.equal(details.status, 'success')
  const book = details.value?.items[0]
  assert.ok(book)
  assert.equal(book.tocUrl, '/books/local-book/toc')

  const toc = await loadTableOfContents(ports, { source: sourceB, book })
  assert.equal(toc.status, 'success')
  const chapter = toc.value?.items[0]
  assert.ok(chapter)
  assert.equal(chapter.title, '第一章 本地测试')

  const content = await loadChapterContent(ports, { source: sourceB, chapter })
  assert.equal(content.status, 'success')
  assert.equal(content.value?.cleaned, '正文内容：书源文件流程测试通过。')

  assert.equal(calls.length, 5)
  assert.ok(calls[0]?.startsWith(sourceA.bookSourceUrl))
  assert.ok(calls[1]?.startsWith(sourceB.bookSourceUrl))
  assert.match(calls[3] ?? '', /\/books\/local-book\/toc$/)
  assert.match(calls[4] ?? '', /\/chapters\/local-chapter$/)
  assert.ok(rulesSeen.some((item) => item.endsWith(':bookList')))
  assert.ok(rulesSeen.some((item) => item.endsWith(':name')))
  assert.ok(rulesSeen.some((item) => item.endsWith(':chapterList')))
  assert.ok(rulesSeen.some((item) => item.endsWith(':content')))
})
