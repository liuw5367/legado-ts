import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutContent, layoutFormattedContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from '../src/content-layout.ts'
import { terminalWidth } from '../src/ui-actions.ts'
import { formatChapterContent } from '../src/content-format.ts'
import { parseReaderArgs } from '../src/config.ts'

test('参数遵循命令行优先于环境变量', () => {
  assert.equal(parseReaderArgs([], { LEGADO_READER_SOURCE: './env.json' }).source, './env.json')
  assert.equal(parseReaderArgs(['--source', './arg.json'], { LEGADO_READER_SOURCE: './env.json' }).source, './arg.json')
  assert.equal(parseReaderArgs(['--help'], {}).help, true)
})

test('正文按终端宽度切行并保留段落锚点', () => {
  const layout = layoutContent('第一段内容\n\n第二段内容', 6)
  assert.deepEqual(layout.paragraphs, ['第一段内容', '第二段内容'])
  assert.ok(layout.lines.length >= 4)
  const anchor = paragraphOffsetAtLine(layout, 2, 6)
  assert.equal(anchor.paragraphIndex, 1)
})

test('窄终端折行不会让中文闭合标点单独出现在行首', () => {
  const layout = layoutContent('甲乙丙丁戊己庚辛壬癸，后续', 20)
  assert.equal(layout.lines.some((line) => /^[，。！？；：、）》」』】〕］｝…]/u.test(line)), false)
  assert.ok(layout.lines.every((line) => terminalWidth(line) <= 20))
})

test('恢复阅读位置时按段落偏移计算终端行，并过滤控制序列', () => {
  const value = sanitizeTerminalText('第一\u001b[31m段\u001b[0m\n\n第二段')
  assert.equal(value, '第一段\n\n第二段')
  const layout = layoutContent(value, 8)
  const line = lineAtParagraphOffset(layout, 1, 1, 8)
  assert.ok(line >= 2)
  assert.equal(paragraphOffsetAtLine(layout, line, 8).paragraphIndex, 1)
})

test('结构化正文布局保留块类型和预格式空白', () => {
  const formatted = formatChapterContent('<h2>标题</h2><blockquote>引用</blockquote><pre>  code\n next</pre><hr>', 'html')
  const layout = layoutFormattedContent(formatted, 40)
  assert.deepEqual(layout.paragraphs, ['## 标题', '│ 引用', '  code\n next', '────'])
  assert.equal(layout.lines[4], '  code')
  assert.equal(layout.lines[5], ' next')
  assert.equal(layout.lineKinds?.[0], 'heading')
  assert.equal(layout.lineKinds?.[4], 'preformatted')
  assert.equal(layout.lineKinds?.at(-1), 'separator')
  const line = lineAtParagraphOffset(layout, 2, 2, 40)
  assert.equal(paragraphOffsetAtLine(layout, line, 40).paragraphIndex, 2)
})

test('连续 HTML 段落先铺满视口再分页，纯文本显式空行仍保留', () => {
  const html = Array.from({ length: 30 }, (_, index) => `<p>第${index + 1}段</p>`).join('')
  const layout = layoutFormattedContent(formatChapterContent(html, 'html'), 80)
  assert.equal(layout.lines.length, 30)
  assert.equal(layout.lines.slice(0, 27).filter(Boolean).length, 27)
  assert.equal(lineAtParagraphOffset(layout, 27, 0, 80), 27)
  assert.deepEqual(paragraphOffsetAtLine(layout, 27, 80), { paragraphIndex: 27, offset: 0 })
  const plain = layoutFormattedContent(formatChapterContent('第一段\n\n第二段', 'text'), 80)
  assert.deepEqual(plain.lines, ['第一段', '', '第二段'])
})
