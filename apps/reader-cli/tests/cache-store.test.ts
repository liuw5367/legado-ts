import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { cacheEntryPath, cachePath, normalizeCacheRelativePath } from '../src/cache-store.ts'
import { sha256 } from '../src/storage-model.ts'

test('cache paths accept only validated SHA-256 entries', () => {
  const key = sha256('cache-key')
  const valid = `${key}.json`
  assert.equal(normalizeCacheRelativePath(`content/${valid}`), `content/${valid}`)
  assert.equal(normalizeCacheRelativePath(`../content/${valid}`), undefined)
  assert.equal(normalizeCacheRelativePath(`content/${key.toUpperCase()}.json`), undefined)
  assert.equal(cachePath('/tmp/cache-v1', 'content', key), join('/tmp/cache-v1', 'content', valid))
  assert.equal(cacheEntryPath('/tmp/cache-v1', { relativePath: `content/${valid}`, category: 'content', bytes: 4, lastAccessedAt: '2026-01-01T00:00:00.000Z' }), join('/tmp/cache-v1', 'content', valid))
  assert.equal(cacheEntryPath('/tmp/cache-v1', { relativePath: `toc/${valid}`, category: 'content', bytes: 4, lastAccessedAt: '2026-01-01T00:00:00.000Z' }), undefined)
})
