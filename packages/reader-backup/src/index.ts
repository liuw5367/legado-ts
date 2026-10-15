import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

export const BACKUP_FORMAT = 'legado-reader-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_MAX_ENTRIES = 30_000
export const BACKUP_MAX_FILE_BYTES = 64 * 1024 * 1024
export const BACKUP_MAX_TOTAL_BYTES = 128 * 1024 * 1024
export const BACKUP_MAX_COMPRESSION_RATIO = 1_000

export const BACKUP_CATEGORIES = ['bookshelf', 'reading', 'search', 'sources', 'settings'] as const
export type BackupCategory = typeof BACKUP_CATEGORIES[number]

export interface BackupFileDescriptor {
  path: string
  bytes: number
  sha256: string
  category: BackupCategory
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: typeof BACKUP_FORMAT_VERSION
  storageVersion: 1
  createdAt: string
  producer: { name: 'reader-cli' | 'reader-web'; version: string }
  counts: Record<BackupCategory, number>
  files: BackupFileDescriptor[]
}

export interface BackupFile {
  path: string
  data: Uint8Array
  category: BackupCategory
}

export interface BackupArchive {
  manifest: BackupManifest
  files: Map<string, Uint8Array>
}

export interface BackupLimits {
  maxEntries?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxCompressionRatio?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * 将与 CLI 数据文件同构的 JSON 文件写入 ZIP。文件内容由调用方提供，避免
 * 备份层重新解释每个业务对象的字段，跨端只共享路径和校验规则。
 */
export function createBackupZip(files: readonly BackupFile[], options: { producer: BackupManifest['producer']; now?: Date }): Uint8Array {
  const checked = validateFiles(files)
  const counts = emptyCounts()
  for (const file of checked) counts[file.category] += 1
  const descriptors = checked.map((file) => ({ path: file.path, bytes: file.data.byteLength, sha256: sha256Bytes(file.data), category: file.category }))
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    storageVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    producer: options.producer,
    counts,
    files: descriptors,
  }
  const manifestFile: BackupFile = { path: 'backup.json', data: jsonBytes(manifest), category: 'settings' }
  return writeStoredZip([manifestFile, ...checked])
}

/** 解析、校验并返回 ZIP 中的 JSON 文件，调用方仍需按类别决定覆盖范围。 */
export async function readBackupZip(input: Uint8Array, limits: BackupLimits = {}): Promise<BackupArchive> {
  const entries = extractZip(input, limits)
  const files = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (files.has(entry.path)) throw new Error(`备份包含重复文件：${entry.path}`)
    files.set(entry.path, entry.data)
  }
  const manifestBytes = files.get('backup.json')
  if (manifestBytes === undefined) throw new Error('备份缺少 backup.json')
  const manifest = parseManifest(manifestBytes)
  if (manifest.files.length > (limits.maxEntries ?? BACKUP_MAX_ENTRIES)) throw new Error('备份文件数量超过限制')
  if (manifest.files.length + 1 !== files.size) throw new Error('备份文件清单与 ZIP 内容不一致')
  for (const descriptor of manifest.files) {
    const data = files.get(descriptor.path)
    if (data === undefined) throw new Error(`备份缺少文件：${descriptor.path}`)
    if (data.byteLength !== descriptor.bytes || sha256Bytes(data) !== descriptor.sha256) throw new Error(`备份文件校验失败：${descriptor.path}`)
  }
  return { manifest, files }
}

export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

export function parseJson<T>(archive: BackupArchive, path: string): T {
  const data = archive.files.get(path)
  if (data === undefined) throw new Error(`备份缺少文件：${path}`)
  try {
    return JSON.parse(decoder.decode(data)) as T
  } catch {
    throw new Error(`备份文件不是有效 JSON：${path}`)
  }
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function categoryForPath(path: string): BackupCategory {
  if (path === 'bookshelf.json' || path.startsWith('books/')) return 'bookshelf'
  if (path === 'reading-history.json') return 'reading'
  if (path === 'search-history.json') return 'search'
  if (path === 'sources.json' || path === 'source-state.json' || path === 'source-check-config.json') return 'sources'
  if (path === 'reader-settings.json') return 'settings'
  throw new Error(`备份路径不属于用户数据：${path}`)
}

function validateFiles(files: readonly BackupFile[]): BackupFile[] {
  if (files.length === 0 || files.length > BACKUP_MAX_ENTRIES) throw new Error('备份文件数量无效')
  const paths = new Set<string>()
  let total = 0
  return files.map((file) => {
    if (file.path === 'backup.json' || !/^[-a-zA-Z0-9_.]+(?:\/[-a-zA-Z0-9_.]+)*$/u.test(file.path)) throw new Error(`备份路径无效：${file.path}`)
    if (paths.has(file.path)) throw new Error(`备份包含重复文件：${file.path}`)
    paths.add(file.path)
    if (file.data.byteLength > BACKUP_MAX_FILE_BYTES || (total += file.data.byteLength) > BACKUP_MAX_TOTAL_BYTES) throw new Error('备份大小超过限制')
    if (categoryForPath(file.path) !== file.category) throw new Error(`备份类别与路径不匹配：${file.path}`)
    return { path: file.path, data: Uint8Array.from(file.data), category: file.category }
  })
}

function parseManifest(data: Uint8Array): BackupManifest {
  let value: unknown
  try { value = JSON.parse(decoder.decode(data)) as unknown } catch { throw new Error('backup.json 不是有效 JSON') }
  if (!isRecord(value) || value.format !== BACKUP_FORMAT || value.formatVersion !== BACKUP_FORMAT_VERSION || value.storageVersion !== 1 || !Array.isArray(value.files) || !isRecord(value.producer) || !isBackupProducer(value.producer.name) || typeof value.producer.version !== 'string') throw new Error('备份格式或版本不受支持')
  const files = value.files.map((item) => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256) || !isBackupCategory(item.category)) throw new Error('backup.json 文件清单无效')
    if (item.path === 'backup.json') throw new Error('backup.json 不能出现在自身文件清单中')
    if (categoryForPath(item.path) !== item.category) throw new Error(`backup.json 文件类别无效：${item.path}`)
    return { path: item.path, bytes: item.bytes, sha256: item.sha256, category: item.category }
  })
  const counts = emptyCounts()
  for (const descriptor of files) counts[descriptor.category] += 1
  const rawCounts = value.counts
  if (!isRecord(rawCounts) || BACKUP_CATEGORIES.some((category) => rawCounts[category] !== counts[category])) throw new Error('backup.json 统计信息无效')
  return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, storageVersion: 1, createdAt: String(value.createdAt ?? ''), producer: { name: value.producer.name as BackupManifest['producer']['name'], version: value.producer.version }, counts, files }
}

function emptyCounts(): Record<BackupCategory, number> { return { bookshelf: 0, reading: 0, search: 0, sources: 0, settings: 0 } }
function isBackupCategory(value: unknown): value is BackupCategory { return typeof value === 'string' && (BACKUP_CATEGORIES as readonly string[]).includes(value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isBackupProducer(value: unknown): value is BackupManifest['producer']['name'] { return value === 'reader-cli' || value === 'reader-web' }

function writeStoredZip(files: readonly BackupFile[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.path)
    const crc = crc32(file.data)
    const local = new Uint8Array(30 + name.byteLength + file.data.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x800, true)
    localView.setUint16(8, 0, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, file.data.byteLength, true)
    localView.setUint32(22, file.data.byteLength, true)
    localView.setUint16(26, name.byteLength, true)
    local.set(name, 30)
    local.set(file.data, 30 + name.byteLength)
    locals.push(local)
    const central = new Uint8Array(46 + name.byteLength)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, file.data.byteLength, true)
    centralView.setUint32(24, file.data.byteLength, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)
    offset += local.byteLength
  }
  const centralOffset = offset
  const centralBytes = centrals.reduce((total, item) => total + item.byteLength, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralBytes, true)
  endView.setUint32(16, centralOffset, true)
  const output = new Uint8Array(centralOffset + centralBytes + end.byteLength)
  let cursor = 0
  for (const local of locals) { output.set(local, cursor); cursor += local.byteLength }
  for (const central of centrals) { output.set(central, cursor); cursor += central.byteLength }
  output.set(end, cursor)
  return output
}

function extractZip(input: Uint8Array, limits: BackupLimits): Array<{ path: string; data: Uint8Array }> {
  const maxEntries = limits.maxEntries ?? BACKUP_MAX_ENTRIES
  const maxFileBytes = limits.maxFileBytes ?? BACKUP_MAX_FILE_BYTES
  const maxTotalBytes = limits.maxTotalBytes ?? BACKUP_MAX_TOTAL_BYTES
  const maxCompressionRatio = limits.maxCompressionRatio ?? BACKUP_MAX_COMPRESSION_RATIO
  const end = findEndOfCentralDirectory(input)
  const count = readU16(input, end + 10)
  const directorySize = readU32(input, end + 12)
  const directoryOffset = readU32(input, end + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('备份不支持 ZIP64')
  ensureRange(input, directoryOffset, directorySize, 'ZIP 中央目录不完整')
  if (directoryOffset + directorySize > end) throw new Error('ZIP 中央目录无效')
  const result: Array<{ path: string; data: Uint8Array }> = []
  let cursor = directoryOffset
  let total = 0
  for (let index = 0; index < count; index += 1) {
    ensureRange(input, cursor, 46, 'ZIP 中央目录不完整')
    if (readU32(input, cursor) !== 0x02014b50) throw new Error('ZIP 中央目录无效')
    const flags = readU16(input, cursor + 8)
    const method = readU16(input, cursor + 10)
    const expectedCrc = readU32(input, cursor + 16)
    const compressedSize = readU32(input, cursor + 20)
    const uncompressedSize = readU32(input, cursor + 24)
    const nameLength = readU16(input, cursor + 28)
    const extraLength = readU16(input, cursor + 30)
    const commentLength = readU16(input, cursor + 32)
    const localOffset = readU32(input, cursor + 42)
    ensureRange(input, cursor + 46, nameLength + extraLength + commentLength, 'ZIP 中央目录不完整')
    const path = safeArchivePath(decoder.decode(input.slice(cursor + 46, cursor + 46 + nameLength)))
    cursor += 46 + nameLength + extraLength + commentLength
    if ((flags & 1) !== 0) throw new Error('备份不支持加密 ZIP')
    if (path === '' || path.endsWith('/')) continue
    if (result.length >= maxEntries) throw new Error('备份文件数量超过限制')
    if (uncompressedSize > maxFileBytes || total + uncompressedSize > maxTotalBytes) throw new Error('备份大小超过限制')
    if (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > maxCompressionRatio) throw new Error('备份压缩比超过限制')
    ensureRange(input, localOffset, 30, 'ZIP 本地文件头不完整')
    if (readU32(input, localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头无效')
    const localNameLength = readU16(input, localOffset + 26)
    const localExtraLength = readU16(input, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    ensureRange(input, dataStart, compressedSize, 'ZIP 文件数据不完整')
    const compressed = input.slice(dataStart, dataStart + compressedSize)
    let data: Uint8Array
    if (method === 0) data = Uint8Array.from(compressed)
    else if (method === 8) {
      try { data = Uint8Array.from(inflateRawSync(compressed, { maxOutputLength: maxFileBytes })) } catch { throw new Error('ZIP 文件解压失败') }
    } else throw new Error(`ZIP 压缩方式不支持：${method}`)
    if (data.byteLength !== uncompressedSize || crc32(data) !== expectedCrc) throw new Error('ZIP 文件完整性校验失败')
    total += data.byteLength
    result.push({ path, data })
  }
  return result
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 0xffff - 22)
  for (let index = bytes.length - 22; index >= start; index -= 1) if (readU32(bytes, index) === 0x06054b50) return index
  throw new Error('ZIP 缺少结束目录')
}

function readU16(bytes: Uint8Array, offset: number): number { ensureRange(bytes, offset, 2, 'ZIP 数据不完整'); return bytes[offset]! | (bytes[offset + 1]! << 8) }
function readU32(bytes: Uint8Array, offset: number): number { ensureRange(bytes, offset, 4, 'ZIP 数据不完整'); return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0 }
function ensureRange(bytes: Uint8Array, offset: number, length: number, message: string): void { if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) throw new Error(message) }
function safeArchivePath(raw: string): string { const value = raw.replaceAll('\\', '/'); if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) throw new Error('备份路径必须是相对路径'); const parts = value.split('/').filter(Boolean); if (parts.some((part) => part === '..' || part === '.')) throw new Error('备份路径不允许穿越'); return parts.join('/') }

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of input) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
