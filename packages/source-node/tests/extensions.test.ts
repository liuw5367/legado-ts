import assert from 'node:assert/strict'
import { deflateRawSync, gzipSync } from 'node:zlib'
import test from 'node:test'
import { NodeArchiveHost, NodeCryptoHost, NodeEncodingHost, KeyedConcurrencyHost } from '../src/index.ts'

function zipEntry(name: string, data: Uint8Array, method = 0): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const compressed = method === 0 ? data : Uint8Array.from(deflateRawSync(data))
  const crc = crc32(data)
  const local = new Uint8Array(30 + nameBytes.length + compressed.length)
  const central = new Uint8Array(46 + nameBytes.length)
  const view = new DataView(local.buffer)
  view.setUint32(0, 0x04034b50, true); view.setUint16(8, 0, true); view.setUint16(18, method, true); view.setUint32(14, crc, true); view.setUint32(18, compressed.length, true); view.setUint32(22, data.length, true); view.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30); local.set(compressed, 30 + nameBytes.length)
  const centralView = new DataView(central.buffer)
  centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(8, 20, true); centralView.setUint16(10, method, true); centralView.setUint32(16, crc, true); centralView.setUint32(20, compressed.length, true); centralView.setUint32(24, data.length, true); centralView.setUint16(28, nameBytes.length, true); centralView.setUint32(42, 0, true); central.set(nameBytes, 46)
  const end = new Uint8Array(22); const endView = new DataView(end.buffer); endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, 1, true); endView.setUint16(10, 1, true); endView.setUint32(12, central.length, true); endView.setUint32(16, local.length, true)
  const result = new Uint8Array(local.length + central.length + end.length); result.set(local); result.set(central, local.length); result.set(end, local.length + central.length); return result
}

function zipStored(name: string, data: Uint8Array): Uint8Array {
  return zipEntry(name, data)
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of input) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}

test('Node encoding host preserves charset, binary and URL boundaries', () => {
  const host = new NodeEncodingHost()
  const bytes = host.encode('中文', 'utf-8')
  assert.equal(host.decode(bytes, 'utf-8'), '中文')
  assert.equal(host.base64Encode(Uint8Array.from([0, 255, 3])), 'AP8D')
  assert.deepEqual(host.base64Decode('AP8D'), Uint8Array.from([0, 255, 3]))
  assert.equal(host.hexEncode(Uint8Array.from([0, 255, 3])), '00ff03')
  assert.deepEqual(host.hexDecode('00ff03'), Uint8Array.from([0, 255, 3]))
  assert.equal(host.decodeUri(host.encodeUri('https://a.test/中文?q=a b')), 'https://a.test/中文?q=a b')
  assert.throws(() => host.hexDecode('0'), /hexadecimal/)
})

test('Node crypto host supports digest, HMAC and AES text round trip', () => {
  const host = new NodeCryptoHost()
  assert.equal(host.digestHex('abc', 'md5'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(host.hmacHex('abc', 'key', 'sha256'), '9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab')
  const crypto = host.createSymmetricCrypto('AES/CBC/PKCS5Padding', new TextEncoder().encode('1234567890123456'), new Uint8Array(16))
  const encrypted = crypto.encryptText('中文')
  assert.equal(crypto.decryptText(encrypted), '中文')
})

test('Node archive host limits gzip and zip output', async () => {
  const host = new NodeArchiveHost()
  const gzip = await host.extract(Uint8Array.from(gzipSync(Buffer.from('hello'))), 'gzip')
  assert.deepEqual(gzip[0]?.data, new TextEncoder().encode('hello'))
  const zipBytes = zipStored('a.txt', new TextEncoder().encode('hello'))
  const zip = await host.extract(zipBytes, 'zip')
  assert.equal(zip[0]?.path, 'a.txt')
  assert.equal(new TextDecoder().decode(zip[0]!.data), 'hello')
  const deflated = await host.extract(zipEntry('compressed.txt', new TextEncoder().encode('hello'.repeat(20)), 8), 'zip')
  assert.equal(new TextDecoder().decode(deflated[0]!.data), 'hello'.repeat(20))
  await assert.rejects(host.extract(zipStored('../escape.txt', new TextEncoder().encode('bad')), 'zip'), /path traversal/)
  await assert.rejects(host.extract(zipBytes.slice(0, -1), 'zip'), /end of central directory/)
  await assert.rejects(host.extract(Uint8Array.from(gzipSync(Buffer.from('hello'))), 'gzip', { maxEntryBytes: 2 }), /byte budget/)
  await assert.rejects(host.extract(Uint8Array.from(gzipSync(Buffer.from('a'.repeat(1000)))), 'gzip', { maxCompressionRatio: 10 }), /compression ratio/)
})

test('keyed concurrency preserves per-key order and cancels queued work', async () => {
  const host = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const events: string[] = []
  const first = host.run('source', async () => { events.push('first:start'); await new Promise((resolve) => setTimeout(resolve, 5)); events.push('first:end'); return 1 })
  const controller = new AbortController()
  const cancelled = host.run('source', async () => { events.push('cancelled:start'); return 2 }, controller.signal)
  const cancelledResult = assert.rejects(cancelled, { name: 'AbortError' })
  controller.abort()
  const second = host.run('source', async () => { events.push('second:start'); return 3 })
  assert.equal(await first, 1)
  await cancelledResult
  assert.equal(await second, 3)
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
})
