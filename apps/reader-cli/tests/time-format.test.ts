import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDisplayTime, formatSourceTime } from '../src/time-format.ts'

test('时间显示统一转换为上海时区并保留秒', () => {
  assert.equal(formatDisplayTime('2025-01-02T02:12:23.456Z'), '2025-01-02 10:12:23')
  assert.equal(formatDisplayTime('2025-01-02T10:12:23+08:00'), '2025-01-02 10:12:23')
})

test('无效时间和无时区书源时间不会被错误猜测', () => {
  assert.equal(formatDisplayTime('not-a-time'), '未知')
  assert.equal(formatSourceTime('2025-01-02 10:12:23'), '2025-01-02 10:12:23')
  assert.equal(formatSourceTime('2025-01-02T10:12:23.456'), '2025-01-02 10:12:23')
  assert.equal(formatSourceTime('2025/01/02 10:12'), '2025-01-02 10:12:00')
  assert.equal(formatSourceTime('2025-01-02T02:12:23Z'), '2025-01-02 10:12:23')
})
