import { createHash } from 'node:crypto'
import { replaceFont } from '@legado/source-core'
import type { FontHost, FontMapping, FontQueryOptions } from '@legado/source-core'
import { NodeEncodingHost } from './encoding.ts'

interface TableDirectory {
  offset: number
  length: number
}

function fail(message: string): never {
  throw new Error(`invalid TTF: ${message}`)
}

function ensureRange(bytes: Uint8Array, offset: number, length: number, message: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > bytes.byteLength - length) fail(message)
}

function u8(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 1, 'truncated byte')
  return bytes[offset]!
}

function u16(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 2, 'truncated uint16')
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function i16(bytes: Uint8Array, offset: number): number {
  const value = u16(bytes, offset)
  return value & 0x8000 ? value - 0x10000 : value
}

function i8(bytes: Uint8Array, offset: number): number {
  const value = u8(bytes, offset)
  return value & 0x80 ? value - 0x100 : value
}

function u32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4, 'truncated uint32')
  return bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
}

function tag(bytes: Uint8Array, offset: number): string {
  ensureRange(bytes, offset, 4, 'truncated table tag')
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

const blankUnicodes = new Set([0x0009, 0x0020, 0x00a0, 0x2002, 0x2003, 0x2007, 0x200a, 0x200b, 0x200c, 0x200d, 0x202f, 0x205f])

class TtfReader {
  public readonly tables = new Map<string, TableDirectory>()
  public readonly unicodeToGlyphId = new Map<number, number>()
  public readonly glyphSignatures: Array<string | undefined>
  private readonly bytes: Uint8Array

  public constructor(bytes: Uint8Array) {
    this.bytes = bytes
    if (bytes.byteLength < 12) fail('header is truncated')
    const version = u32(bytes, 0)
    if (version !== 0x00010000 && version !== 0x74727565) fail('unsupported sfnt version')
    const numTables = u16(bytes, 4)
    ensureRange(bytes, 12, numTables * 16, 'table directory is truncated')
    for (let index = 0; index < numTables; index++) {
      const position = 12 + index * 16
      const name = tag(bytes, position)
      const offset = u32(bytes, position + 8)
      const length = u32(bytes, position + 12)
      ensureRange(bytes, offset, length, `${name} table is truncated`)
      this.tables.set(name, { offset, length })
    }
    const head = this.table('head', 54)
    const maxp = this.table('maxp', 6)
    const loca = this.table('loca', 2)
    const glyf = this.table('glyf', 0)
    const cmap = this.table('cmap', 4)
    const indexToLocFormat = i16(bytes, head.offset + 50)
    const numGlyphs = u16(bytes, maxp.offset + 4)
    const maxContours = maxp.length >= 10 ? u16(bytes, maxp.offset + 8) : 0
    const locaValues = this.readLoca(loca, indexToLocFormat, numGlyphs)
    this.glyphSignatures = Array.from({ length: numGlyphs }, (_, index) => this.readGlyph(glyf, locaValues, index, maxContours))
    this.readCmap(cmap)
    if (this.unicodeToGlyphId.size === 0) fail('no supported cmap subtable')
  }

  private table(name: string, minLength: number): TableDirectory {
    const result = this.tables.get(name)
    if (result === undefined || result.length < minLength) fail(`${name} table is missing or truncated`)
    return result
  }

  private readLoca(table: TableDirectory, indexToLocFormat: number, numGlyphs: number): number[] {
    const count = numGlyphs + 1
    const itemSize = indexToLocFormat === 0 ? 2 : indexToLocFormat === 1 ? 4 : 0
    if (itemSize === 0 || table.length < count * itemSize) fail('loca table format is unsupported')
    return Array.from({ length: count }, (_, index) => indexToLocFormat === 0 ? u16(this.bytes, table.offset + index * 2) * 2 : u32(this.bytes, table.offset + index * 4))
  }

  private readGlyph(table: TableDirectory, loca: number[], glyphId: number, maxContours: number): string | undefined {
    const start = loca[glyphId]!
    const end = loca[glyphId + 1]!
    if (start === end) return undefined
    if (start > end || end > table.length) fail('glyph offset is invalid')
    const base = table.offset + start
    const length = end - start
    ensureRange(this.bytes, base, length, 'glyph data is truncated')
    if (length < 10) fail('glyph header is truncated')
    const contours = i16(this.bytes, base)
    if (contours === 0 || contours > maxContours || contours < -1) return undefined
    if (contours > 0) return this.readSimpleGlyph(base, length, contours)
    return this.readCompositeGlyph(base, length)
  }

  private readSimpleGlyph(base: number, length: number, contours: number): string | undefined {
    let cursor = base + 10
    const endPoints: number[] = []
    for (let index = 0; index < contours; index++) {
      endPoints.push(u16(this.bytes, cursor))
      cursor += 2
    }
    const pointCount = (endPoints.at(-1) ?? -1) + 1
    if (pointCount <= 0) return undefined
    const instructionLength = u16(this.bytes, cursor)
    cursor += 2
    ensureRange(this.bytes, cursor, instructionLength, 'glyph instructions are truncated')
    cursor += instructionLength
    const flags: number[] = []
    while (flags.length < pointCount) {
      const flag = u8(this.bytes, cursor)
      cursor += 1
      flags.push(flag)
      if ((flag & 0x08) !== 0) {
        const repeat = u8(this.bytes, cursor)
        cursor += 1
        if (flags.length + repeat > pointCount) fail('glyph flag repeat exceeds point count')
        for (let count = 0; count < repeat; count++) flags.push(flag)
      }
    }
    const xCoordinates: number[] = []
    for (const flag of flags) {
      const mode = flag & 0x12
      if (mode === 0x02) xCoordinates.push(-u8(this.bytes, cursor++))
      else if (mode === 0x12) xCoordinates.push(u8(this.bytes, cursor++))
      else if (mode === 0x10) xCoordinates.push(0)
      else { xCoordinates.push(i16(this.bytes, cursor)); cursor += 2 }
    }
    const yCoordinates: number[] = []
    for (const flag of flags) {
      const mode = flag & 0x24
      if (mode === 0x04) yCoordinates.push(-u8(this.bytes, cursor++))
      else if (mode === 0x24) yCoordinates.push(u8(this.bytes, cursor++))
      else if (mode === 0x20) yCoordinates.push(0)
      else { yCoordinates.push(i16(this.bytes, cursor)); cursor += 2 }
    }
    if (cursor > base + length) fail('glyph outline is truncated')
    return xCoordinates.map((x, index) => `${x},${yCoordinates[index]!}`).join('|')
  }

  private readCompositeGlyph(base: number, length: number): string | undefined {
    const components: string[] = []
    let cursor = base + 10
    const end = base + length
    for (let count = 0; count < 1024; count++) {
      if (cursor + 4 > end) fail('composite glyph is truncated')
      const flags = u16(this.bytes, cursor); cursor += 2
      const glyphIndex = u16(this.bytes, cursor); cursor += 2
      let argument1: number
      let argument2: number
      switch (flags & 0x03) {
        case 0x00: argument1 = u8(this.bytes, cursor); argument2 = u8(this.bytes, cursor + 1); cursor += 2; break
        case 0x02: argument1 = i8(this.bytes, cursor); argument2 = i8(this.bytes, cursor + 1); cursor += 2; break
        case 0x01: argument1 = u16(this.bytes, cursor); argument2 = u16(this.bytes, cursor + 2); cursor += 4; break
        default: argument1 = i16(this.bytes, cursor); argument2 = i16(this.bytes, cursor + 2); cursor += 4; break
      }
      let xScale = 0
      let scale01 = 0
      let scale10 = 0
      let yScale = 0
      switch (flags & 0xc8) {
        case 0x08: xScale = yScale = u16(this.bytes, cursor) / 16384; cursor += 2; break
        case 0x40: xScale = u16(this.bytes, cursor) / 16384; yScale = u16(this.bytes, cursor + 2) / 16384; cursor += 4; break
        case 0x80: xScale = u16(this.bytes, cursor) / 16384; scale01 = u16(this.bytes, cursor + 2) / 16384; scale10 = u16(this.bytes, cursor + 4) / 16384; yScale = u16(this.bytes, cursor + 6) / 16384; cursor += 8; break
      }
      components.push(`{flags:${flags},glyphIndex:${glyphIndex},arg1:${argument1},arg2:${argument2},xScale:${xScale},scale01:${scale01},scale10:${scale10},yScale:${yScale}}`)
      if ((flags & 0x20) === 0) return `[${components.join(',')}]`
    }
    fail('composite glyph has too many components')
  }

  private readCmap(table: TableDirectory): void {
    const version = u16(this.bytes, table.offset)
    if (version !== 0) fail('cmap version is unsupported')
    const count = u16(this.bytes, table.offset + 2)
    ensureRange(this.bytes, table.offset + 4, count * 8, 'cmap records are truncated')
    let supported = false
    for (let index = 0; index < count; index++) {
      const record = table.offset + 4 + index * 8
      const subtableOffset = u32(this.bytes, record + 4)
      if (subtableOffset >= table.length) fail('cmap subtable offset is invalid')
      const base = table.offset + subtableOffset
      const format = u16(this.bytes, base)
      const length = u16(this.bytes, base + 2)
      if (subtableOffset > table.length - length) fail('cmap subtable is truncated')
      ensureRange(this.bytes, base, length, 'cmap subtable is truncated')
      if (format === 0) { this.readCmap0(base, length); supported = true }
      else if (format === 4) { this.readCmap4(base, length); supported = true }
      else if (format === 6) { this.readCmap6(base, length); supported = true }
    }
    if (!supported) fail('cmap format is unsupported')
  }

  private readCmap0(base: number, length: number): void {
    if (length < 6) fail('cmap format 0 is truncated')
    for (let unicode = 0; unicode < length - 6; unicode++) {
      const glyphId = u8(this.bytes, base + 6 + unicode)
      if (glyphId !== 0) this.unicodeToGlyphId.set(unicode, glyphId)
    }
  }

  private readCmap4(base: number, length: number): void {
    if (length < 16) fail('cmap format 4 is truncated')
    const segments = u16(this.bytes, base + 6) / 2
    if (!Number.isInteger(segments) || segments === 0) fail('cmap format 4 segment count is invalid')
    const endCodes = base + 14
    const startCodes = endCodes + segments * 2 + 2
    const idDeltas = startCodes + segments * 2
    const idRangeOffsets = idDeltas + segments * 2
    ensureRange(this.bytes, endCodes, segments * 8 + 2, 'cmap format 4 arrays are truncated')
    const glyphArray = idRangeOffsets + segments * 2
    const glyphArrayLength = Math.floor((length - (glyphArray - base)) / 2)
    if (glyphArrayLength < 0) fail('cmap format 4 glyph array is invalid')
    for (let segment = 0; segment < segments; segment++) {
      const start = u16(this.bytes, startCodes + segment * 2)
      const end = u16(this.bytes, endCodes + segment * 2)
      const delta = i16(this.bytes, idDeltas + segment * 2)
      const rangeOffset = u16(this.bytes, idRangeOffsets + segment * 2)
      if (start > end) fail('cmap format 4 segment range is invalid')
      for (let unicode = start; unicode <= end; unicode++) {
        let glyphId = 0
        if (rangeOffset === 0) glyphId = (unicode + delta) & 0xffff
        else {
          const glyphIndex = rangeOffset / 2 + (unicode - start) + segment - segments
          if (glyphIndex >= 0 && glyphIndex < glyphArrayLength) glyphId = (u16(this.bytes, glyphArray + glyphIndex * 2) + delta) & 0xffff
        }
        if (glyphId !== 0) this.unicodeToGlyphId.set(unicode, glyphId)
      }
    }
  }

  private readCmap6(base: number, length: number): void {
    if (length < 10) fail('cmap format 6 is truncated')
    const firstCode = u16(this.bytes, base + 6)
    const entryCount = u16(this.bytes, base + 8)
    if (length < 10 + entryCount * 2) fail('cmap format 6 glyph array is truncated')
    for (let index = 0; index < entryCount; index++) this.unicodeToGlyphId.set(firstCode + index, u16(this.bytes, base + 10 + index * 2))
  }
}

class NodeFontMapping implements FontMapping {
  private readonly glyphToUnicode: Map<string, number>
  private readonly reader: TtfReader

  public constructor(reader: TtfReader) {
    this.reader = reader
    this.glyphToUnicode = new Map()
    for (const [unicode, glyphId] of reader.unicodeToGlyphId) {
      const glyph = reader.glyphSignatures[glyphId]
      if (glyph !== undefined) this.glyphToUnicode.set(glyph, unicode)
    }
  }

  public glyphIdByUnicode(unicode: number): number {
    return this.reader.unicodeToGlyphId.get(unicode) ?? 0
  }

  public glyphByUnicode(unicode: number): string | undefined {
    const glyphId = this.glyphIdByUnicode(unicode)
    return glyphId >= 0 && glyphId < this.reader.glyphSignatures.length ? this.reader.glyphSignatures[glyphId] : undefined
  }

  public unicodeByGlyph(glyph: string | undefined): number {
    return glyph === undefined ? 0 : this.glyphToUnicode.get(glyph) ?? 0
  }

  public isBlankUnicode(unicode: number): boolean {
    return blankUnicodes.has(unicode)
  }
}

export class NodeFontHost implements FontHost {
  private readonly cache = new Map<string, NodeFontMapping>()
  private readonly encoding: NodeEncodingHost
  private readonly maxCacheEntries: number

  public constructor(options: { encoding?: NodeEncodingHost; maxCacheEntries?: number } = {}) {
    this.encoding = options.encoding ?? new NodeEncodingHost()
    this.maxCacheEntries = options.maxCacheEntries ?? 4
    if (!Number.isInteger(this.maxCacheEntries) || this.maxCacheEntries < 1) throw new Error('font cache limit is invalid')
  }

  public queryTTF(input: Uint8Array, options: FontQueryOptions = {}): FontMapping {
    this.checkOptions(input, options)
    const key = createHash('sha256').update(Buffer.from(input)).digest('hex')
    if (options.useCache !== false) {
      const cached = this.cache.get(key)
      if (cached !== undefined) { this.cache.delete(key); this.cache.set(key, cached); return cached }
    }
    const mapping = new NodeFontMapping(new TtfReader(input))
    if (options.useCache !== false) {
      this.cache.set(key, mapping)
      while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!)
    }
    return mapping
  }

  public queryBase64TTF(input: string, options: FontQueryOptions = {}): FontMapping {
    return this.queryTTF(this.encoding.base64Decode(input), options)
  }

  public replaceFont(text: string, error: FontMapping | null, correct: FontMapping | null, filter = false): string {
    return replaceFont(text, error, correct, filter)
  }

  private checkOptions(input: Uint8Array, options: FontQueryOptions): void {
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('font byte budget is invalid')
    if (input.byteLength > maxBytes) throw new Error('font input exceeds byte budget')
    if (options.signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
  }
}
