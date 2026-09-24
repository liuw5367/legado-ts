import assert from 'node:assert/strict'
import test from 'node:test'
import { chapterIndexForSelection, detailLineCount, filterChapterIndices, footer, formatDuration, helpLines, homeAreaLabel, navigationIndex, navigationPage, normalizeChapterTitle, popNavigationFrame, previousPage, pushNavigationFrame, readerNavigation, refreshOnHomeEntry, searchHeaderStatus } from '../src/ui-model.ts'
import { layoutContextLine, terminalWidth } from '../src/ui-actions.ts'
import type { NavigationFrame } from '../src/ui-model.ts'

test('界面模型保持列表导航在有效范围内', () => {
  assert.equal(navigationIndex(0, 0, 'j', { downArrow: true }, 4), 0)
  assert.equal(navigationIndex(1, 5, 'j', {}, 3), 2)
  assert.equal(navigationIndex(4, 5, 'j', {}, 3), 4)
  assert.equal(navigationPage(0, 20, '', { pageDown: true }, 5), 4)
  assert.equal(navigationPage(19, 20, '', { pageDown: true }, 5), 15)
})

test('界面模型格式化稳定的显示值与返回路径', () => {
  assert.equal(formatDuration(999), '999ms')
  assert.equal(formatDuration(1000), '1.0s')
  assert.equal(formatDuration(-1), '未知')
  assert.equal(normalizeChapterTitle(' 第一章： 你好！ '), '第一章你好')
  assert.equal(previousPage('reader'), 'toc')
  assert.equal(previousPage('help'), 'home')
})

test('搜索页标题在窄终端优先显示实时进度与耗时，并保留完成耗时', () => {
  const progress = { total: 6, completed: 2, activeSources: ['书源一'], candidates: 12, elapsedMs: 0, success: 0, partial: 0, empty: 0, failed: 0, capabilityMissing: 0, cancelled: 0 }
  const status = searchHeaderStatus('running', progress, 1234, 0, '正在搜索')
  const line = layoutContextLine('搜索 · 三国', status, 40)
  assert.match(line, /搜索 · 三国/u)
  assert.match(line, /2\/6源/u)
  assert.match(line, /1\.2s/u)
  assert.ok(terminalWidth(line) <= 40)
  assert.equal(searchHeaderStatus('complete', undefined, 2345, 3, ''), '3本 · 2.3s')
  assert.equal(searchHeaderStatus('complete', undefined, 2345, 3, '正在加载书籍详情…'), '正在加载书籍详情… · 3本 · 2.3s')
  assert.equal(searchHeaderStatus('running', undefined, 300, 0, ''), '搜索中 · 300ms')
})

test('返回首页时刷新当前数据，其他页面和已过期的进入请求不触发刷新', async () => {
  let homeData = '旧数据'
  let refreshCalls = 0
  await refreshOnHomeEntry('detail', async () => { refreshCalls += 1 }, () => true)
  assert.equal(refreshCalls, 0)
  await refreshOnHomeEntry('home', async () => { refreshCalls += 1; homeData = '最新数据' }, () => true)
  assert.equal(refreshCalls, 1)
  assert.equal(homeData, '最新数据')
  await refreshOnHomeEntry('home', async () => { refreshCalls += 1 }, () => false)
  assert.equal(refreshCalls, 1)
})

test('目录标题按 NFKC 和大小写不敏感匹配，导航栈按最近进入顺序返回', () => {
  assert.deepEqual(filterChapterIndices([{ title: 'ＣＨAPTER １' }, { title: '第一章 开始' }, { title: 'chapter 2' }], 'chapter 1'), [0])
  assert.deepEqual(filterChapterIndices([{ title: '第一章 开始' }, { title: '第二章 结束' }], '章节'), [])
  assert.equal(chapterIndexForSelection([{ title: '第一章' }, { title: '第二章' }, { title: '第三章' }], '第三', 0), 2)
  assert.equal(detailLineCount(undefined, 80), 8)
  const home = { page: 'home' as const, selected: 2, listStart: 1, pageScroll: 0, homeArea: 1, query: '', readerLine: 0 }
  const search = { ...home, page: 'search' as const }
  const results = { ...search, page: 'results' as const }
  const stack = pushNavigationFrame(pushNavigationFrame([home], search), results)
  assert.equal(popNavigationFrame(stack).at(-1)?.page, 'search')
  assert.equal(popNavigationFrame(popNavigationFrame(stack)).at(-1)?.page, 'home')
  // 阅读页帧比 NavigationFrame 多带 toc；显式写 `| undefined` 才能在 exactOptionalPropertyTypes 下清空它。
  type RefreshableFrame = NavigationFrame & { bookId: string; editionKey: string; toc?: string | undefined }
  const detail: RefreshableFrame = { ...home, page: 'detail' as const, bookId: 'book', editionKey: 'old', toc: 'old-toc' }
  const sources: RefreshableFrame = { ...detail, page: 'sources' as const }
  const refreshedDetail = popNavigationFrame([detail, sources], (frame) => ({ ...frame, editionKey: 'new', toc: undefined }))
  assert.equal(refreshedDetail.at(-1)?.page, 'detail')
  assert.equal(refreshedDetail.at(-1)?.editionKey, 'new')
  assert.equal(refreshedDetail.at(-1)?.toc, undefined)
})

test('阅读页帮助保留翻页和章节切换键位，底部省略这两项', () => {
  const readerHelp = helpLines('reader', 0).join(' ')
  assert.match(readerHelp, /↑\/↓ 或 j\/k 翻页，←\/→ 或 h\/l 切换章节/u)
  assert.doesNotMatch(readerHelp, /逐行|\[ \]/u)
  const readerFooter = footer('reader', false, 100, 'idle', 'idle', false, 0)
  assert.doesNotMatch(readerFooter, /\[j\/k\] 翻页/u)
  assert.doesNotMatch(readerFooter, /\[h\/l\] 切章节/u)
  assert.match(readerFooter, /\[t\] 目录/u)
  assert.doesNotMatch(readerFooter, /↑\/↓|←\/→/u)
  assert.doesNotMatch(readerFooter, /\[ \]/u)
  assert.doesNotMatch(readerFooter, /上下章/u)
  assert.deepEqual([0, 1, 2].map(homeAreaLabel), ['书架', '最近阅读', '搜索记录'])
})

test('阅读页把方向键映射到等效字母快捷键，详情动作使用精简名称', () => {
  assert.equal(readerNavigation('j', {}), 'next-page')
  assert.equal(readerNavigation('', { downArrow: true }), 'next-page')
  assert.equal(readerNavigation('k', {}), 'previous-page')
  assert.equal(readerNavigation('', { upArrow: true }), 'previous-page')
  assert.equal(readerNavigation('h', {}), 'previous-chapter')
  assert.equal(readerNavigation('', { leftArrow: true }), 'previous-chapter')
  assert.equal(readerNavigation('l', {}), 'next-chapter')
  assert.equal(readerNavigation('', { rightArrow: true }), 'next-chapter')
  const detailFooter = footer('detail', false, 100, 'idle', 'idle', false, 0)
  assert.match(detailFooter, /\[↵\] 阅读/u)
  assert.match(detailFooter, /\[a\] 书架/u)
  assert.doesNotMatch(detailFooter, /开始|继续阅读|加入\/移出/u)
})
