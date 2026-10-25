import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function functionSource(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL('../src/pages/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  assert.ok(found, name)
  return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

test('page actions notify only at book boundaries and preserve normal chapter navigation', () => {
  const notices: string[] = []; const pages: number[] = []; const links: string[] = []
  const context = { controlsVisible: false, pageLayout: { pageCount: 3 }, pageIndex: 0, currentIndex: 0, siblings: [{ chapterId: 'first' }, { chapterId: 'last' }], previous: undefined as { chapterId: string } | undefined, next: { chapterId: 'last' } as { chapterId: string } | undefined, previousChapterEndRef: { current: '' }, bookId: 'book', editionKey: 'edition', location: { state: null }, chapterLink: (_book: string, chapter: { chapterId: string }) => chapter.chapterId, setControlsVisible() {}, setBoundaryNotice: (value: { text: string }) => notices.push(value.text), turnPage: (page: number) => pages.push(page), navigate: (link: string) => links.push(link) }
  const source = functionSource('reader.tsx', 'handlePageAction')
  const action = runInNewContext(source + '\nhandlePageAction', context) as (action: string) => void
  action('previous'); assert.deepEqual(notices, ['当前已经是第一章']); assert.deepEqual(pages, [])
  action('next'); assert.deepEqual(pages, [1])
  context.pageIndex = 2; action('next'); assert.deepEqual(links, ['last'])
  context.currentIndex = 1; context.next = undefined; context.previous = { chapterId: 'first' }
  action('next'); assert.equal(notices.at(-1), '当前已是最后一章')
  context.pageIndex = 0; action('previous'); assert.equal(links.at(-1), 'first#last-page')
  assert.equal(notices.length, 2)
})

test('about sharing passes the selected URL to native share, supports copy fallback and ignores cancellation', async () => {
  const shares: unknown[] = []; const copies: string[] = []; const messages: string[] = []
  const context = { sharing: false, navigator: { share: async (data: unknown) => { shares.push(data) }, clipboard: { writeText: async (url: string) => { copies.push(url) } } } as { share?: (data: unknown) => Promise<void>; clipboard: { writeText: (url: string) => Promise<void> } }, setSharing() {}, setMessage: (value: string) => messages.push(value), Error }
  const share = runInNewContext(functionSource('about-app.tsx', 'share') + '\nshare', context) as (title: string, url: string) => Promise<void>
  await share('repository', 'https://github.com/liuw5367/legado-ts')
  await share('app', 'https://reader.example')
  assert.equal(JSON.stringify(shares), JSON.stringify([{ title: 'repository', url: 'https://github.com/liuw5367/legado-ts' }, { title: 'app', url: 'https://reader.example' }]))
  delete context.navigator.share
  await share('app', 'https://reader.example'); assert.deepEqual(copies, ['https://reader.example']); assert.match(messages.at(-1)!, /链接已复制/u)
  context.navigator.share = async () => { const error = new Error('cancel'); error.name = 'AbortError'; throw error }
  await share('app', 'https://reader.example'); assert.equal(messages.at(-1), '')
})
