import { gunzipSync, inflateRawSync } from 'node:zlib'
import type { ArchiveEntry, ArchiveFormat, ArchiveHost, ArchiveLimits } from '@legado/source-core'

const defaults: ArchiveLimits = { maxEntries: 64, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxCompressionRatio: 1000 }

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}

function ensureRange(bytes: Uint8Array, offset: number, length: number, message: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > bytes.byteLength - length) throw new Error(message)
}

function safePath(raw: string): string {
  const value = raw.replaceAll('\\', '/')
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) throw new Error('archive entry path is not relative')
  const parts = value.split('/').filter((part) => part !== '')
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('archive entry path traversal is not allowed')
  return parts.join('/')
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of input) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function inflateLimited(input: Uint8Array, maxOutputLength: number): Uint8Array {
  try {
    return Uint8Array.from(inflateRawSync(input, { maxOutputLength }))
  } catch (error) {
    if (error instanceof RangeError) throw new Error('archive output exceeds byte budget')
    throw error
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 0xffff - 22)
  for (let index = bytes.length - 22; index >= start; index--) if (u32(bytes, index) === 0x06054b50) return index
  throw new Error('zip end of central directory is missing')
}

function extractZip(input: Uint8Array, limits: ArchiveLimits): ArchiveEntry[] {
  const end = findEndOfCentralDirectory(input)
  ensureRange(input, end, 22, 'zip end of central directory is truncated')
  const count = u16(input, end + 10)
  const directorySize = u32(input, end + 12)
  const directoryOffset = u32(input, end + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('zip64 is not supported')
  ensureRange(input, directoryOffset, directorySize, 'zip central directory is truncated')
  if (directoryOffset + directorySize > end) throw new Error('zip central directory is invalid')
  const result: ArchiveEntry[] = []
  let cursor = directoryOffset
  let total = 0
  let entryCount = 0
  for (let index = 0; index < count; index++) {
    ensureRange(input, cursor, 46, 'zip central directory is truncated')
    if (u32(input, cursor) !== 0x02014b50) throw new Error('zip central directory is invalid')
    const flags = u16(input, cursor + 8)
    const method = u16(input, cursor + 10)
    const expectedCrc = u32(input, cursor + 16)
    const compressedSize = u32(input, cursor + 20)
    const uncompressedSize = u32(input, cursor + 24)
    const nameLength = u16(input, cursor + 28)
    const extraLength = u16(input, cursor + 30)
    const commentLength = u16(input, cursor + 32)
    const localOffset = u32(input, cursor + 42)
    ensureRange(input, cursor + 46, nameLength + extraLength + commentLength, 'zip central directory is truncated')
    const name = new TextDecoder('utf-8', { fatal: false }).decode(input.slice(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
    if ((flags & 1) !== 0) throw new Error('encrypted zip entries are not supported')
    const path = safePath(name)
    if (path === '' || name.endsWith('/')) continue
    entryCount += 1
    if (entryCount > limits.maxEntries) throw new Error('archive entry count exceeds budget')
    if (uncompressedSize > limits.maxEntryBytes || total + uncompressedSize > limits.maxTotalBytes) throw new Error('archive output exceeds byte budget')
    if (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > limits.maxCompressionRatio) throw new Error('archive compression ratio exceeds budget')
    ensureRange(input, localOffset, 30, 'zip local header is truncated')
    if (u32(input, localOffset) !== 0x04034b50) throw new Error('zip local header is invalid')
    const localNameLength = u16(input, localOffset + 26)
    const localExtraLength = u16(input, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    ensureRange(input, dataStart, compressedSize, 'zip entry data is truncated')
    const compressed = input.slice(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Uint8Array.from(compressed) : method === 8 ? inflateLimited(compressed, limits.maxEntryBytes) : (() => { throw new Error(`zip compression method is unsupported: ${method}`) })()
    if (data.byteLength !== uncompressedSize || crc32(data) !== expectedCrc) throw new Error('zip entry integrity check failed')
    total += data.byteLength
    result.push({ path, data })
  }
  return result
}

export class NodeArchiveHost implements ArchiveHost {
  public async extract(input: Uint8Array, format: ArchiveFormat, partial: Partial<ArchiveLimits> = {}): Promise<ArchiveEntry[]> {
    const limits = { ...defaults, ...partial }
    if (!Number.isInteger(limits.maxEntries) || Object.values(limits).some((value) => !Number.isFinite(value) || value < 0)) throw new Error('archive limits are invalid')
    if (format === 'gzip') {
      let data: Uint8Array
      try {
        data = Uint8Array.from(gunzipSync(Buffer.from(input), { maxOutputLength: limits.maxEntryBytes }))
      } catch (error) {
        if (error instanceof RangeError) throw new Error('archive output exceeds byte budget')
        throw error
      }
      if (data.byteLength > limits.maxEntryBytes || data.byteLength > limits.maxTotalBytes) throw new Error('archive output exceeds byte budget')
      if (input.byteLength === 0 ? data.byteLength > 0 : data.byteLength / input.byteLength > limits.maxCompressionRatio) throw new Error('archive compression ratio exceeds budget')
      return [{ path: 'content', data }]
    }
    if (format === 'zip') return extractZip(input, limits)
    throw new Error(`archive format is unsupported: ${format}`)
  }
}
