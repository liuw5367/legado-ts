import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildBackupPreview, categoryForPath, createBackupZip, editionKey, jsonBytes, parseBackupManifest, parseJson, readBackupZip } from '../src/index.ts'

test('备份 ZIP 使用共享清单并校验每个文件', async () => {
  const zip = createBackupZip([
    { path: 'bookshelf.json', data: new TextEncoder().encode('{"data":[]}'), category: 'bookshelf' },
    { path: 'reader-settings.json', data: new TextEncoder().encode('{"data":{"theme":"light"}}'), category: 'settings' },
  ], { producer: { name: 'reader-cli', version: 'test' }, now: new Date('2026-10-15T00:00:00.000Z') })
  const archive = await readBackupZip(zip)
  assert.equal(archive.manifest.format, 'legado-reader-backup')
  assert.equal(archive.manifest.counts.bookshelf, 1)
  assert.equal(archive.manifest.counts.settings, 1)
  assert.deepEqual(parseJson<{ data: { theme: string } }>(archive, 'reader-settings.json'), { data: { theme: 'light' } })
})

test('备份路径只能映射到定义好的用户数据类别', () => {
  assert.equal(categoryForPath('books/abc/book.json'), 'bookshelf')
  assert.throws(() => categoryForPath('books/abc/cache.json'), /不属于定义好的用户数据|不属于用户数据/)
  assert.throws(() => categoryForPath('cache/content.json'), /不属于用户数据/)
})

test('篡改 ZIP 中的文件会在读取阶段失败', async () => {
  const zip = createBackupZip([{ path: 'search-history.json', data: new TextEncoder().encode('[]'), category: 'search' }], { producer: { name: 'reader-web', version: 'test' } })
  const changed = Uint8Array.from(zip)
  const marker = new TextEncoder().encode('search-history.json')
  const index = findBytes(changed, marker)
  assert.ok(index >= 0)
  changed[index + marker.byteLength + 30] = 0x7b
  await assert.rejects(readBackupZip(changed), /完整性|校验|JSON/)
})

test('第一版 manifest 拒绝重复清单、非法时间和非法统计', () => {
  const descriptor = { path: 'bookshelf.json', bytes: 2, sha256: 'a'.repeat(64), category: 'bookshelf' as const }
  const manifest = {
    format: 'legado-reader-backup',
    formatVersion: 1,
    storageVersion: 1,
    createdAt: '2026-10-15T00:00:00.000Z',
    producer: { name: 'reader-cli', version: 'test' },
    counts: { bookshelf: 1, reading: 0, search: 0, sources: 0, settings: 0 },
    files: [descriptor],
  }
  assert.equal(parseBackupManifest(jsonBytes(manifest)).createdAt, manifest.createdAt)
  assert.throws(() => parseBackupManifest(jsonBytes({ ...manifest, createdAt: 'invalid' })), /创建时间无效/u)
  assert.throws(() => parseBackupManifest(jsonBytes({ ...manifest, files: [descriptor, descriptor], counts: { ...manifest.counts, bookshelf: 2 } })), /重复路径/u)
  assert.throws(() => parseBackupManifest(jsonBytes({ ...manifest, counts: { ...manifest.counts, bookshelf: -1 } })), /统计信息无效/u)
})

test('预览数量与清单文件数量分别计算', async () => {
  const zip = createBackupZip([
    { path: 'bookshelf.json', data: jsonBytes({ schemaVersion: 1, data: [{ bookId: 'book-1' }] }), category: 'bookshelf' },
    { path: 'books/book-1/book.json', data: jsonBytes({ schemaVersion: 1, data: { bookId: 'book-1' } }), category: 'bookshelf' },
    { path: 'books/book-1/sources.json', data: jsonBytes({ schemaVersion: 1, data: [] }), category: 'bookshelf' },
    { path: 'reading-history.json', data: jsonBytes({ schemaVersion: 1, data: [{ bookId: 'book-1', positions: { one: {}, two: {} } }] }), category: 'reading' },
    { path: 'search-history.json', data: jsonBytes({ schemaVersion: 1, data: [{ keyword: '关键词' }] }), category: 'search' },
    { path: 'sources.json', data: jsonBytes({ schemaVersion: 1, data: [{ sourceId: 'source-1' }] }), category: 'sources' },
    { path: 'reader-settings.json', data: jsonBytes({ schemaVersion: 1, data: {} }), category: 'settings' },
  ], { producer: { name: 'reader-cli', version: 'test' } })
  const archive = await readBackupZip(zip)
  const preview = buildBackupPreview(archive)
  assert.deepEqual(preview.recordCounts, { bookshelf: 1, reading: 2, search: 1, sources: 1, settings: 1 })
  assert.equal(preview.fileCounts.bookshelf, 3)
})

test('跨端 editionKey 使用 CLI 第一版规则', () => {
  const expected = createHash('sha256').update('source\u0000book').digest('hex')
  assert.equal(editionKey('source', 'book'), expected)
  assert.notEqual(editionKey('source', 'book'), editionKey('source', 'other-book'))
})

function findBytes(input: Uint8Array, needle: Uint8Array): number {
  for (let index = 0; index <= input.length - needle.length; index += 1) {
    if (needle.every((value, offset) => input[index + offset] === value)) return index
  }
  return -1
}
