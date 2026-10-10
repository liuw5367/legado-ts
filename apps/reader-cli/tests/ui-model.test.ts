import assert from 'node:assert/strict'
import test from 'node:test'
import { chapterIndexForSelection, detailLineCount, filterChapterIndices, footer, footerLayout, formatDuration, helpLines, homeAreaLabel, navigationIndex, navigationPage, normalizeChapterTitle, previousPage, readableChapterMatchIndex, readerNavigation, refreshOnHomeEntry, reverseTocEntries, searchHeaderStatus } from '../src/ui-model.ts'
import { layoutContextLine, terminalWidth } from '../src/ui-actions.ts'

test('界面模型保持列表导航在有效范围内', () => {
  assert.equal(navigationIndex(0, 0, 'j', { downArrow: true }, 4), 0)
  assert.equal(navigationIndex(1, 5, 'j', {}, 3), 2)
  assert.equal(navigationIndex(4, 5, 'j', {}, 3), 4)
  assert.equal(navigationPage(0, 20, '', { pageDown: true }, 5), 4)
  assert.equal(navigationPage(19, 20, '', { pageDown: true }, 5), 15)
  assert.equal(navigationIndex(2, 5, 'a', { ctrl: true }, 3), 0)
  assert.equal(navigationIndex(2, 5, 'e', { ctrl: true }, 3), 4)
  assert.equal(navigationPage(5, 20, 'a', { ctrl: true }, 5), 0)
  assert.equal(navigationPage(5, 20, 'e', { ctrl: true }, 5), 15)
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

test('目录标题按 NFKC 和大小写不敏感匹配', () => {
  assert.deepEqual(filterChapterIndices([{ title: 'ＣＨAPTER １' }, { title: '第一章 开始' }, { title: 'chapter 2' }], 'chapter 1'), [0])
  assert.deepEqual(filterChapterIndices([{ title: '第一章 开始' }, { title: '第二章 结束' }], '章节'), [])
  assert.equal(chapterIndexForSelection([{ title: '第一章' }, { title: '第二章' }, { title: '第三章' }], '第三', 0), 2)
  assert.equal(detailLineCount(undefined, 80), 8)
})

test('目录卷节点不可阅读，倒序时保留卷与章节分组', () => {
  const entries = [{ title: '卷一', isVolume: true }, { title: '一', isVolume: false }, { title: '二', isVolume: false }, { title: '卷二', isVolume: true }, { title: '三', isVolume: false }]
  assert.deepEqual(filterChapterIndices(entries, ''), [1, 2, 4])
  assert.equal(readableChapterMatchIndex(entries, 2), 1)
  assert.equal(readableChapterMatchIndex(entries, 0), 0)
  assert.deepEqual(reverseTocEntries(entries).map((entry) => entry.title), ['卷二', '三', '卷一', '二', '一'])
})

test('阅读页帮助保留翻页和章节切换键位，底部省略这两项', () => {
  const readerHelp = helpLines('reader', 0).join(' ')
  assert.match(readerHelp, /↑\/↓\s+j\/k\s+翻页/u)
  assert.match(readerHelp, /←\/→\s+h\/l\s+切换章节/u)
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

test('通用页脚固定在右侧，任务取消保留在左侧且不重复 Esc', () => {
  const home = footerLayout('home', false, 80, 'idle', 'idle', false, 0)
  assert.match(home.right, /\[\?\] 帮助/u)
  assert.match(home.right, /\[q\] 退出/u)
  assert.doesNotMatch(home.right, /\[⎋\]/u)
  const searching = footerLayout('results', false, 80, 'running', 'idle', false, 0)
  assert.match(searching.left, /\[⎋\] 取消搜索/u)
  assert.doesNotMatch(searching.right, /\[⎋\]/u)
  assert.match(searching.right, /\[\?\] 帮助/u)
  const filtering = footerLayout('toc', false, 80, 'idle', 'idle', false, 0, false, true)
  assert.match(filtering.left, /\[⎋\] 清除筛选/u)
  assert.doesNotMatch(filtering.right, /\[⎋\]/u)
  const mapping = footerLayout('mapping', false, 80, 'idle', 'idle', false, 0)
  assert.match(mapping.left, /\[⎋\] 取消/u)
  assert.doesNotMatch(mapping.right, /\[⎋\]/u)
  const menu = footerLayout('home', false, 80, 'idle', 'idle', true, 0)
  assert.equal(menu.right, '[⎋] 关闭')
  assert.doesNotMatch(menu.right, /\[\?\]|\[q\]/u)
  const input = footerLayout('search', false, 80, 'idle', 'idle', false, 0, false, false, false, { textInput: true })
  assert.doesNotMatch(input.right, /\[\?\]|\[q\]/u)
  assert.match(input.right, /\[⎋\] 返回/u)
  const tocInput = footerLayout('toc', false, 80, 'idle', 'idle', false, 0, true, false, false, { textInput: true })
  assert.equal(tocInput.right, '[⎋] 清除')
  const editing = footerLayout('settings', false, 80, 'idle', 'idle', false, 0, false, false, false, { settingsEditing: true })
  assert.equal(editing.left, '[↵] 保存  [⎋] 取消')
  assert.equal(editing.right, '')
})

test('帮助页使用分组分割线，窄终端仍保留快捷键和完整说明行', () => {
  const lines = helpLines('debug', 0, 40)
  assert.ok(lines.some((line) => line.includes('全局导航')))
  assert.ok(lines.some((line) => line.includes('请求与解析查看')))
  assert.ok(lines.some((line) => line.includes('复制当前面板')))
  assert.ok(lines.every((line) => terminalWidth(line) <= 40))
  assert.doesNotMatch(footer('diagnostics', false, 80, 'idle', 'idle', false, 0), /\[d\]|\[g\]|\[r\]/u)
  assert.doesNotMatch(footer('debug', false, 80, 'idle', 'idle', false, 0), /\[v\]|\[g\]|\[y\]|\[e\]/u)
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
