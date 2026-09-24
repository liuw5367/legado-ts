import assert from 'node:assert/strict'
import test from 'node:test'
import type { FontMapping } from '../src/index.ts'
import { replaceFont } from '../src/index.ts'

function mapping(): FontMapping {
  return {
    glyphIdByUnicode: (unicode) => unicode === 0xe001 ? 1 : 0,
    glyphByUnicode: (unicode) => unicode === 0xe001 ? 'outline-1' : undefined,
    unicodeByGlyph: (glyph) => glyph === 'outline-1' ? 0x4e00 : 0,
    isBlankUnicode: (unicode) => unicode === 0x20,
  }
}

test('核心字体替换按轮廓映射并保留空白字符', () => {
  const error = mapping()
  const correct = mapping()
  assert.equal(replaceFont('\ue001 \ue002', error, correct), '一 \ue002')
  assert.equal(replaceFont('\ue001 \ue002', error, correct, true), '一 ')
  assert.equal(replaceFont('普通文本', null, correct), '普通文本')
})
