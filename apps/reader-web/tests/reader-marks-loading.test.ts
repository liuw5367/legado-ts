import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { textFingerprint } from '../shared/reading-text.ts'

const code = ts.transpileModule(readFileSync(new URL('../src/lib/use-reader-marks.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

test('缓存正文先到时不查询标记，版本激活与阅读初始化完成后再查询', async () => {
  const requests: string[] = []
  let load!: (settle: () => void) => void | (() => void)
  const module = { exports: {} as { useReaderMarks: (input: any) => unknown } }
  runInNewContext(code, { AbortController, console, performance, require: (name: string) => {
    if (name === 'react') return { useEffect() {}, useLayoutEffect() {}, useMemo: (fn: () => unknown) => fn(), useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => {}] }
    if (name === 'react-router-dom') return { useSearchParams: () => [new URLSearchParams()] }
    if (name.includes('use-page-resource')) return { usePageActivity: () => ({ active: true, id: 'reader', location: { key: 'reading' } }), usePageNavigation: () => ({ userId: 'user' }), usePageLoadEffect: (effect: typeof load) => { load = effect } }
    if (name.includes('api.ts')) return { apiFetch: async (path: string) => { requests.push(path); return { items: [] } } }
    if (name.includes('reader-annotations')) return { textFingerprint }
    return {}
  }, module, exports: module.exports })
  const input = { bookId: 'book', editionKey: 'edition', chapterId: 'chapter', content: { cleaned: '缓存正文', chapter: { chapterId: 'chapter', chapterUrl: '/chapter' } }, toc: { sourceFingerprint: 'fp', revision: 'rev' }, texts: ['缓存正文'], articleRef: { current: null }, layout: { pageWidth: 0, pageCount: 0 }, positionReady: false }
  module.exports.useReaderMarks(input); load(() => {})
  await Promise.resolve()
  assert.equal(requests.length, 0, '不能在初始化和版本激活完成前读取标记')
  module.exports.useReaderMarks({ ...input, positionReady: true }); load(() => {})
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.deepEqual(requests.map((path) => path.split('?')[0]), ['/api/books/book/annotations', '/api/books/book/bookmarks'])
})

test('书架恢复时等待离页写入，失效通知只重建等待任务而不取消重发 HTTP', async () => {
  const { ReadingPositionQueue } = await import('../src/lib/reading-position-queue.ts')
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let invalidate = () => {}
  const queue = new ReadingPositionQueue(async (input) => { await hold; invalidate(); return { ...input, tocRevision: input.tocRevision ?? '', userId: 'user', lastReadAt: '' } })
  const requests: string[] = []
  let load!: (settle: () => void) => () => void
  const module = { exports: {} as { useHomeResource: (path: string, domain: string) => unknown } }
  const homeCode = ts.transpileModule(readFileSync(new URL('../src/lib/use-home-resource.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(homeCode, { AbortController, module, exports: module.exports, require: (name: string) => {
    if (name === 'react') return { useEffect() {}, useRef: (value: unknown) => ({ current: value }), useState: (value: any) => [typeof value === 'function' ? value() : value, () => {}], useCallback: (fn: unknown) => fn }
    if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
    if (name === 'react-router-dom') return { useLocation: () => ({ state: null }), useNavigate: () => () => {} }
    if (name.includes('settings-context')) return { useReaderSettings: () => ({ settings: { general: {} }, settingsLoadStatus: 'ready' }) }
    if (name.includes('auth-context')) return { useAuth: () => ({ user: { id: 'user' } }) }
    if (name.includes('use-page-resource')) return { usePageNavigation: () => ({ positions: queue }), usePageVersion: () => '0', usePageLoadEffect: (effect: typeof load) => { load = effect } }
    if (name.includes('api.ts')) return { apiFetch: async (path: string) => { requests.push(path); return path === '/api/bookshelf' ? { bookshelf: [], reading: [], searchHistory: [] } : { groups: [] } } }
    return {}
  } })
  const saving = queue.enqueue({ bookId: 'book', editionKey: 'edition', chapterId: 'chapter', chapterUrl: '/chapter', chapterIndex: 0, title: '章节', paragraphIndex: 1, offset: 0, version: 1 })
  module.exports.useHomeResource('/api/bookshelf', 'bookshelf')
  const cleanup = load(() => {})
  invalidate = () => { cleanup(); load(() => {}) }
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(requests.length, 0)
  release(); await saving
  for (let i = 0; i < 16; i++) await Promise.resolve()
  assert.deepEqual(requests, ['/api/bookshelf'])
})
