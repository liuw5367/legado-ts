import assert from 'node:assert/strict'
import test from 'node:test'
import { categoryForPath, createBackupZip, parseJson, readBackupZip } from '../src/index.ts'

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

function findBytes(input: Uint8Array, needle: Uint8Array): number {
  for (let index = 0; index <= input.length - needle.length; index += 1) {
    if (needle.every((value, offset) => input[index + offset] === value)) return index
  }
  return -1
}
