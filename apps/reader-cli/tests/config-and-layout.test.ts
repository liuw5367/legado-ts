import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutContent, lineAtParagraphOffset, paragraphOffsetAtLine, sanitizeTerminalText } from '../src/content-layout.ts'
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

test('恢复阅读位置时按段落偏移计算终端行，并过滤控制序列', () => {
  const value = sanitizeTerminalText('第一\u001b[31m段\u001b[0m\n\n第二段')
  assert.equal(value, '第一段\n\n第二段')
  const layout = layoutContent(value, 8)
  const line = lineAtParagraphOffset(layout, 1, 1, 8)
  assert.ok(line >= 2)
  assert.equal(paragraphOffsetAtLine(layout, line, 8).paragraphIndex, 1)
})
