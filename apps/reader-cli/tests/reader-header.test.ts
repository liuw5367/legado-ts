import assert from 'node:assert/strict'
import test from 'node:test'
import { compactReaderStatus, formatReaderHeader } from '../src/reader-header.ts'
import { READER_SETTINGS_DEFAULTS } from '../src/reader-settings.ts'

const baseInput = {
  bookName: '三体',
  chapterName: '红岸基地',
  chapterIndex: 2,
  chapterTotal: 12,
  pageCurrent: 3,
  pageTotal: 12,
  chapterCharacters: 1234,
  message: '已加载 · 已加载进度',
  settings: READER_SETTINGS_DEFAULTS,
}

test('阅读页头部默认显示六个项目并使用圆点分隔', () => {
  const header = formatReaderHeader(baseInput)
  assert.equal(header.left, '三体 · 红岸基地 · 3/12章')
  assert.equal(header.right, '3/12 · 1,234字 · 已加载')
  assert.deepEqual(header.leftParts, ['三体', '红岸基地', '3/12章'])
  assert.deepEqual(header.rightParts, ['3/12', '1,234字', '已加载'])
})

test('隐藏分隔符时项目之间只有一个空格', () => {
  const header = formatReaderHeader({ ...baseInput, bookName: ' 三体 ', chapterName: ' 红岸基地 ', settings: { ...READER_SETTINGS_DEFAULTS, readerHeaderSeparator: 'hidden' } })
  assert.equal(header.left, '三体 红岸基地 3/12章')
  assert.equal(header.right, '3/12 1,234字 已加载')
  assert.doesNotMatch(`${header.left} ${header.right}`, / {2,}/u)
})

test('可以隐藏任意顶部项目，全部隐藏时不留下分隔符', () => {
  const header = formatReaderHeader({
    ...baseInput,
    settings: {
      ...READER_SETTINGS_DEFAULTS,
      showReaderBookTitle: false,
      showReaderChapterTitle: false,
      showReaderChapterIndex: false,
      showReaderPageProgress: false,
      showReaderWordCount: false,
      showReaderStatus: false,
    },
  })
  assert.equal(header.left, '')
  assert.equal(header.right, '')
  assert.deepEqual(header.leftParts, [])
  assert.deepEqual(header.rightParts, [])
})

test('横杠分隔符使用两侧空格，状态文案压缩到短标签', () => {
  const header = formatReaderHeader({ ...baseInput, message: '正在刷新当前章节…', settings: { ...READER_SETTINGS_DEFAULTS, readerHeaderSeparator: 'dash' } })
  assert.equal(header.left, '三体 — 红岸基地 — 3/12章')
  assert.equal(header.right, '3/12 — 1,234字 — 刷新中')
})

test('常见状态使用稳定短标签，未知状态按完整字符簇截短', () => {
  assert.equal(compactReaderStatus('正在加载第 4 章…'), '加载中')
  assert.equal(compactReaderStatus('阅读位置已保存，书籍信息待同步'), '待同步')
  assert.equal(compactReaderStatus('章节内容为空 · 进度已保存'), '内容为空')
  assert.equal(compactReaderStatus('网络请求失败：连接被拒绝'), '失败')
  assert.equal(compactReaderStatus('状态文案超长内容'), '状态文案超长')
  assert.equal(compactReaderStatus(''), '')
})
