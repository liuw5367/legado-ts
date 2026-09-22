import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutFooter } from '../src/ui-actions.ts'

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

test('页脚按终端显示宽度计算中文标签，不产生隐式换行', () => {
  const line = layoutFooter([
    { keys: 'Enter', label: '开始/继续阅读', priority: 0 },
    { keys: 'Esc', label: '返回', priority: 0 },
  ], 22)
  assert.equal(line, '[Enter] 开始/继续阅读')
  assert.equal(line.includes('\n'), false)
})
