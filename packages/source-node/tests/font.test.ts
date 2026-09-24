import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeFontHost } from '../src/index.ts'

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}

function simpleGlyph(): Uint8Array {
  const result = new Uint8Array(20)
  const view = new DataView(result.buffer)
  view.setInt16(0, 1, false)
  view.setUint16(10, 0, false)
  view.setUint16(12, 0, false)
  result[14] = 1
  view.setInt16(15, 0, false)
  view.setInt16(17, 0, false)
  return result
}

function makeCmap(codePoint: number, format: 4 | 6): Uint8Array {
  if (format === 6) {
    const cmap = new Uint8Array(24)
    const cmapView = new DataView(cmap.buffer)
    cmapView.setUint16(0, 0, false)
    cmapView.setUint16(2, 1, false)
    cmapView.setUint16(4, 3, false)
    cmapView.setUint16(6, 1, false)
    cmapView.setUint32(8, 12, false)
    cmapView.setUint16(12, 6, false)
    cmapView.setUint16(14, 12, false)
    cmapView.setUint16(18, codePoint, false)
    cmapView.setUint16(20, 1, false)
    cmapView.setUint16(22, 1, false)
    return cmap
  }
  const cmap = new Uint8Array(44)
  const cmapView = new DataView(cmap.buffer)
  cmapView.setUint16(0, 0, false)
  cmapView.setUint16(2, 1, false)
  cmapView.setUint16(4, 3, false)
  cmapView.setUint16(6, 1, false)
  cmapView.setUint32(8, 12, false)
  cmapView.setUint16(12, 4, false)
  cmapView.setUint16(14, 32, false)
  cmapView.setUint16(18, 4, false)
  cmapView.setUint16(20, 4, false)
  cmapView.setUint16(22, 1, false)
  cmapView.setUint16(26, codePoint, false)
  cmapView.setUint16(28, 0xffff, false)
  cmapView.setUint16(32, codePoint, false)
  cmapView.setUint16(34, 0xffff, false)
  cmapView.setInt16(36, 1 - codePoint, false)
  cmapView.setInt16(38, 1, false)
  return cmap
}

function makeFont(codePoint: number, format: 4 | 6 = 6): Uint8Array {
  const head = new Uint8Array(54)
  new DataView(head.buffer).setInt16(50, 0, false)

  const maxp = new Uint8Array(32)
  const maxpView = new DataView(maxp.buffer)
  maxpView.setUint32(0, 0x00010000, false)
  maxpView.setUint16(4, 3, false)
  maxpView.setUint16(6, 1, false)
  maxpView.setUint16(8, 1, false)

  const glyph = simpleGlyph()
  const glyf = concat(glyph, glyph)
  const loca = new Uint8Array(8)
  const locaView = new DataView(loca.buffer)
  locaView.setUint16(0, 0, false)
  locaView.setUint16(2, 0, false)
  locaView.setUint16(4, glyph.byteLength / 2, false)
  locaView.setUint16(6, glyf.byteLength / 2, false)

  const cmap = makeCmap(codePoint, format)

  const tables: Array<[string, Uint8Array]> = [['head', head], ['maxp', maxp], ['loca', loca], ['glyf', glyf], ['cmap', cmap]]
  const directoryEnd = 12 + tables.length * 16
  let offset = (directoryEnd + 3) & ~3
  const tableOffsets = tables.map(([name, data]) => {
    const result = { name, data, offset }
    offset = (offset + data.byteLength + 3) & ~3
    return result
  })
  const result = new Uint8Array(offset)
  const view = new DataView(result.buffer)
  view.setUint32(0, 0x00010000, false)
  view.setUint16(4, tables.length, false)
  for (const [index, table] of tableOffsets.entries()) {
    const position = 12 + index * 16
    for (let char = 0; char < 4; char++) result[position + char] = table.name.charCodeAt(char)
    view.setUint32(position + 8, table.offset, false)
    view.setUint32(position + 12, table.data.byteLength, false)
    result.set(table.data, table.offset)
  }
  return result
}

test('字体宿主映射字形轮廓并替换混淆 Unicode', () => {
  const host = new NodeFontHost()
  const errorBytes = makeFont(0xe001)
  const correctBytes = makeFont(0x4e00)
  const error = host.queryTTF(errorBytes)
  const correct = host.queryBase64TTF(Buffer.from(correctBytes).toString('base64'))

  assert.equal(error.glyphIdByUnicode(0xe001), 1)
  assert.equal(error.glyphByUnicode(0xe001), correct.glyphByUnicode(0x4e00))
  const format4 = host.queryTTF(makeFont(0xe001, 4), { useCache: false })
  assert.equal(host.replaceFont('\ue001', format4, correct), '\u4e00')
  assert.equal(host.replaceFont('\ue001 \ue002', error, correct), '\u4e00 \ue002')
  assert.equal(host.replaceFont('\ue001 \ue002', error, correct, true), '\u4e00 ')
  assert.equal(host.replaceFont('普通文本', null, correct), '普通文本')
  assert.equal(host.queryTTF(errorBytes), host.queryTTF(errorBytes))
  assert.notEqual(host.queryTTF(errorBytes, { useCache: false }), error)
})

test('字体宿主强制输入预算、取消与非法字体错误', () => {
  const host = new NodeFontHost()
  const bytes = makeFont(0xe001)
  assert.throws(() => host.queryTTF(bytes, { maxBytes: bytes.byteLength - 1 }), /byte budget/)
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => host.queryTTF(bytes, { signal: controller.signal }), { name: 'AbortError' })
  assert.throws(() => host.queryTTF(Uint8Array.of(0, 1, 2)), /invalid TTF/)
})
