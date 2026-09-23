import assert from 'node:assert/strict'
import test from 'node:test'
import { clipTerminalText, layoutCommandLine, layoutContextLine, layoutFooter, tailTerminalText, terminalWidth } from '../src/ui-actions.ts'

test('页脚只输出一行并优先保留关键动作', () => {
  const line = layoutFooter([
    { keys: 'Enter', label: '详情', priority: 0 },
    { keys: 'j/k ↑/↓', label: '移动', priority: 1 },
    { keys: '←/→ PgUp/PgDn', label: '翻页', priority: 2 },
    { keys: 'Home/End', label: '首尾', priority: 3 },
    { keys: 'Esc', label: '返回', priority: 0 },
  ], 48)
  assert.equal(line.includes('\n'), false)
  assert.ok(line.length <= 48)
  assert.match(line, /\[Enter\] 详情/)
  assert.match(line, /\[Esc\] 返回/)
  assert.match(line, /\[j\/k ↑\/↓\] 移动/)
})

test('窄终端省略放不下的低优先级动作且不拆分快捷键 token', () => {
  const line = layoutFooter([
    { keys: 'Enter', label: '确认', priority: 0 },
    { keys: '←/→', label: '翻页', priority: 1 },
    { keys: 'Esc', label: '返回', priority: 0 },
  ], 24)
  assert.equal(line.includes('\n'), false)
  assert.ok(line.length <= 24)
  assert.match(line, /\[Enter\] 确认/)
  assert.match(line, /\[Esc\] 返回/)
  assert.equal(line.includes('[←\/→] 翻页'), false)
})

test('已经带括号的方括号按键不会重复包裹', () => {
  assert.equal(layoutFooter([{ keys: '[ ]', label: '上下章', priority: 0 }], 20), '[ ] 上下章')
})

test('页脚按终端显示宽度计算中文标签，不产生隐式换行', () => {
  const line = layoutFooter([
    { keys: 'Enter', label: '阅读', priority: 0 },
    { keys: 'Esc', label: '返回', priority: 0 },
  ], 22)
  assert.equal(line, '[Enter] 阅读')
  assert.equal(line.includes('\n'), false)
})

test('上下文栏保留标题，命令栏不拆分快捷键并把输入光标留在尾部', () => {
  const context = layoutContextLine('Legado Reader · 很长的章节标题', '加载中…', 40)
  assert.ok(terminalWidth(context) <= 40)
  assert.ok(context.startsWith('Legado Reader'))
  const footer = '[Enter] 完成  [Esc] 清除'
  const inputLabel = '章节 › '
  const inputWidth = Math.max(0, 40 - terminalWidth(footer) - 1 - terminalWidth(inputLabel) - 1)
  const command = layoutCommandLine(`${inputLabel}${tailTerminalText('第二十章', inputWidth)}█`, footer, 40)
  assert.ok(terminalWidth(command) <= 40)
  assert.ok(command.includes('章节 ›'))
  assert.ok(command.includes('█'))
  assert.ok(command.endsWith(footer))
  assert.equal(tailTerminalText('前缀很多 Second章', 8), 'Second章')
  assert.equal(clipTerminalText('👨‍👩‍👧‍👦abc', 2), '👨‍👩‍👧‍👦')
  assert.equal(terminalWidth('👨‍👩‍👧‍👦'), 2)
})
