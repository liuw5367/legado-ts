import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutFooter } from '../src/ui-actions.ts'

test('页脚优先保留完整动作并在宽屏拆成两行', () => {
  const lines = layoutFooter([
    { keys: 'Enter', label: '详情', priority: 0 },
    { keys: 'j/k ↑/↓', label: '移动', priority: 1 },
    { keys: '←/→ PgUp/PgDn', label: '翻页', priority: 2 },
    { keys: 'Home/End', label: '首尾', priority: 3 },
    { keys: 'Esc', label: '返回', priority: 0 },
  ], 48)
  assert.ok(lines.length <= 2)
  assert.ok(lines.every((line) => !line.endsWith('[')))
  assert.ok(lines.some((line) => line.includes('[Enter] 详情')))
  assert.ok(lines.some((line) => line.includes('[Esc] 返回')))
})

test('窄终端不拆分快捷键 token', () => {
  const lines = layoutFooter([
    { keys: 'Enter', label: '确认', priority: 0 },
    { keys: '←/→', label: '翻页', priority: 1 },
    { keys: 'Esc', label: '返回', priority: 0 },
  ], 20)
  assert.ok(lines.every((line) => line.includes('[') === line.includes(']')))
})
